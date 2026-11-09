// Mantis для macOS: окно приложения + встроенный Агент.
//
// Агент (agent/agent.ts, собран Bun-ом в один файл) – вспомогательная программа внутри приложения:
// отдаёт страницу Mantis на 127.0.0.1 с заголовками для многопоточной нейросети и подключает IP-камеры.
// Приложение запускает его, ждёт строку «MANTIS_READY port=N» и открывает страницу в своём окне.
// Страница вызывает команды оболочки (src/desktop.ts): app_info, keep_awake, set_autostart, quit_app, pilot_state,
// а для «Подготовки Mac» (desktop-setup.html) – install_state, move_to_applications, open_settings, setup_done.
//
// Первый запуск: вместо главной страницы открывается «Подготовка Mac» (разрешения по шагам). Если приложение
// запущено не из «Программ» (прямо из образа .dmg или «Загрузок»), та же страница открывается при каждом
// запуске – первым шагом «Перенести в «Программы»».

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Порт встроенного Агента. Отдельный от обычного Mantis Агента (8787), чтобы они не мешали друг другу.
const AGENT_PORT: &str = "8797";

#[derive(Default)]
struct Shell {
    agent: Mutex<Option<CommandChild>>,
    /// caffeinate – не даёт Mac и экрану засыпать, пока идёт подсчёт
    awake: Mutex<Option<Child>>,
    pilot: Mutex<bool>,
    /// Адрес страницы у Агента, когда он готов
    page: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    hostname: String,
    autostart: bool,
    os: String,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let os = run("sw_vers", &["-productVersion"]).unwrap_or_default();
    AppInfo {
        version: app.package_info().version.to_string(),
        hostname: run("scutil", &["--get", "ComputerName"]).or_else(|| run("hostname", &[])).unwrap_or_default(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        os: format!("macOS {os} ({})", std::env::consts::ARCH),
    }
}

#[tauri::command]
fn keep_awake(state: tauri::State<'_, Shell>, on: bool) {
    let mut awake = state.awake.lock().unwrap();
    if on && awake.is_none() {
        // -d экран, -i простой, -m диск, -s сон (при питании от сети); -w – выйти вместе с приложением
        let pid = std::process::id().to_string();
        *awake = Command::new("/usr/bin/caffeinate").args(["-dims", "-w", &pid]).spawn().ok();
    } else if !on {
        if let Some(mut c) = awake.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn pilot_state(state: tauri::State<'_, Shell>, running: bool) {
    *state.pilot.lock().unwrap() = running;
}

// ---------------------------------------------------------------- установка в «Программы»

const APPLICATIONS_APP: &str = "/Applications/Mantis.app";
/// Файл-отметка «Подготовка Mac пройдена» в ~/Library/Application Support/ru.rcmit.mantis
const SETUP_FLAG: &str = "setup-done";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// Папка Mantis.app, из которой запущено приложение (…/Mantis.app/Contents/MacOS/mantis). None – запуск не из .app.
fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let b = exe.ancestors().nth(3)?.to_path_buf();
    (b.extension().and_then(|e| e.to_str()) == Some("app")).then_some(b)
}

fn in_applications(p: &Path) -> bool {
    p.starts_with("/Applications") || p.starts_with(home().join("Applications"))
}

/// Приложение, скачанное из интернета и запущенное не из «Программ», macOS запускает из временной копии
/// (App Translocation, …/AppTranslocation/…). Тогда ищем оригинал: в подключённом образе или в «Загрузках».
fn original_bundle(p: &Path) -> PathBuf {
    if !p.to_string_lossy().contains("/AppTranslocation/") {
        return p.to_path_buf();
    }
    let Some(name) = p.file_name() else { return p.to_path_buf() };
    let mut candidates: Vec<PathBuf> = std::fs::read_dir("/Volumes")
        .map(|d| d.flatten().map(|e| e.path().join(name)).collect())
        .unwrap_or_default();
    for d in ["Downloads", "Desktop", "Documents"] {
        candidates.push(home().join(d).join(name));
    }
    // не нашли – копируем из временной копии: это тот же образ, только для чтения
    candidates.into_iter().find(|c| c.join("Contents/Info.plist").exists()).unwrap_or_else(|| p.to_path_buf())
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn trash_path(name: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    home().join(".Trash").join(format!("{name} {stamp}.app"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    in_applications: bool,
    path: String,
}

#[tauri::command]
fn install_state() -> InstallState {
    let p = bundle_path();
    InstallState {
        in_applications: p.as_deref().map(in_applications).unwrap_or(false),
        path: p.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

fn stop_agent(app: &AppHandle) {
    let agent = app.state::<Shell>().agent.lock().unwrap().take();
    if let Some(child) = agent {
        let _ = child.kill();
    }
}

/// Скопировать приложение в /Applications (старую версию – в Корзину), снять отметку «скачано из интернета»
/// с копии (запуск уже разрешён пользователем – иначе мы бы сейчас не работали), убрать оригинал
/// из «Загрузок» или отключить образ, перезапуститься из «Программ».
fn move_to_applications_now(app: &AppHandle) -> Result<(), String> {
    let cur = bundle_path().ok_or("не удалось определить, откуда запущено приложение")?;
    if in_applications(&cur) {
        return Ok(());
    }
    let src = original_bundle(&cur);
    let dst = PathBuf::from(APPLICATIONS_APP);
    let old = trash_path("Mantis (старая версия)");
    let script = format!(
        "set -e; if [ -e {d} ]; then mv {d} {old}; fi; /usr/bin/ditto {s} {d}; /usr/bin/xattr -dr com.apple.quarantine {d} || true",
        d = sh_quote(APPLICATIONS_APP),
        old = sh_quote(&old.to_string_lossy()),
        s = sh_quote(&src.to_string_lossy()),
    );
    let ok = Command::new("/bin/sh").args(["-c", &script]).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        // нет прав на «Программы» (пользователь без прав администратора) – системный запрос пароля
        let osa = format!("do shell script {} with administrator privileges", applescript_quote(&script));
        let out = Command::new("/usr/bin/osascript").args(["-e", &osa]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(if err.contains("-128") { "перенос отменён".into() } else { format!("нет прав на папку «Программы» ({})", err.trim()) });
        }
    }
    if !dst.join("Contents/Info.plist").exists() {
        return Err("копия в «Программах» не появилась".into());
    }
    // оригинал: из «Загрузок» и т. п. – в Корзину, образ .dmg – отключить после перезапуска
    let src_s = src.to_string_lossy().into_owned();
    let volume = src_s.starts_with("/Volumes/").then(|| src.parent().map(|v| v.to_string_lossy().into_owned())).flatten();
    if volume.is_none() && src.starts_with(home()) {
        let _ = std::fs::rename(&src, trash_path("Mantis"));
    }
    stop_agent(app);
    let detach = volume.map(|v| format!("; sleep 2; /usr/bin/hdiutil detach -quiet {} || true", sh_quote(&v))).unwrap_or_default();
    Command::new("/bin/sh")
        .args(["-c", &format!("sleep 1; /usr/bin/open -n {}{}", sh_quote(APPLICATIONS_APP), detach)])
        .spawn()
        .map_err(|e| e.to_string())?;
    // выход – из главного потока (команда и проверка в CI вызывают перенос из других потоков)
    let h = app.clone();
    let _ = app.run_on_main_thread(move || h.exit(0));
    Ok(())
}

#[tauri::command]
async fn move_to_applications(app: AppHandle) -> Result<(), String> {
    move_to_applications_now(&app)
}

// ---------------------------------------------------------------- «Подготовка Mac»

/// Открыть раздел «Системных настроек»: только известные разделы.
#[tauri::command]
fn open_settings(pane: String) -> bool {
    let url = match pane.as_str() {
        "local-network" => "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
        "camera" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        "login-items" => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        "security" => "x-apple.systempreferences:com.apple.preference.security?Security",
        _ => return false,
    };
    Command::new("/usr/bin/open").arg(url).status().map(|s| s.success()).unwrap_or(false)
}

fn setup_flag(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETUP_FLAG))
}

#[tauri::command]
fn setup_done(app: AppHandle) {
    if let Some(f) = setup_flag(&app) {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, b"1");
    }
}

/// Первая страница после запуска: «Подготовка Mac», пока её не прошли или пока приложение запущено
/// не из «Программ» (там первый шаг – «Перенести в «Программы»»), иначе – Mantis.
fn first_page(app: &AppHandle) -> &'static str {
    let outside = bundle_path().map(|p| !in_applications(&p)).unwrap_or(false);
    match setup_flag(app) {
        Some(f) if f.exists() && !outside => "?desktop=macos",
        _ => "desktop-setup.html?desktop=macos",
    }
}

/// Адреса, которые открываются в окне приложения. Всё остальное (сайты, оплата) – в браузере по умолчанию.
fn is_app_url(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob")
        || matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost"))
}

fn show_error(win: &WebviewWindow, text: &str) {
    let js = format!("window.showError && window.showError({})", serde_json::to_string(text).unwrap_or_default());
    let _ = win.eval(&js);
}

fn open_page(app: &AppHandle, path: &str) {
    let Some(win) = app.get_webview_window("main") else { return };
    let base = app.state::<Shell>().page.lock().unwrap().clone();
    if let Some(base) = base {
        if let Ok(url) = Url::parse(&format!("{base}{path}")) {
            let _ = win.navigate(url);
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
}

fn start_agent(app: &AppHandle) -> Result<(), String> {
    let cmd = app
        .shell()
        .sidecar("mantis-agent")
        .map_err(|e| e.to_string())?
        .args(["--no-browser"])
        .env("MANTIS_SHELL", "macos")
        .env("MANTIS_PARENT_PID", std::process::id().to_string())
        .env("MANTIS_PORT", AGENT_PORT);
    let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
    *app.state::<Shell>().agent.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let s = String::from_utf8_lossy(&line).trim().to_string();
                    if let Some(port) = s.strip_prefix("MANTIS_READY port=") {
                        let page = format!("http://127.0.0.1:{}/", port.trim());
                        *app.state::<Shell>().page.lock().unwrap() = Some(page);
                        open_page(&app, first_page(&app));
                    } else if !s.is_empty() {
                        tail.push(s);
                        if tail.len() > 20 {
                            tail.remove(0);
                        }
                    }
                }
                CommandEvent::Terminated(p) => {
                    let ready = app.state::<Shell>().page.lock().unwrap().is_some();
                    if !ready {
                        if let Some(win) = app.get_webview_window("main") {
                            show_error(&win, &format!("Агент завершился (код {:?}).\n{}", p.code, tail.join("\n")));
                        }
                    }
                    break;
                }
                CommandEvent::Error(e) => tail.push(e),
                _ => {}
            }
        }
    });
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let home = MenuItem::with_id(app, "home", "Главная Mantis", true, Some("CmdOrCtrl+Shift+H"))?;
    let reload = MenuItem::with_id(app, "reload", "Обновить страницу", true, Some("CmdOrCtrl+R"))?;
    let setup = MenuItem::with_id(app, "setup", "Подготовка Mac…", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Проверка компьютера", true, Some("CmdOrCtrl+Shift+D"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sub = Submenu::with_items(app, "Mantis", true, &[&home, &reload, &sep, &setup, &check])?;
    menu.append(&sub)?;
    Ok(menu)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            keep_awake,
            set_autostart,
            quit_app,
            pilot_state,
            install_state,
            move_to_applications,
            open_settings,
            setup_done
        ])
        .menu(build_menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "home" => open_page(app, "?desktop=macos"),
            "check" => open_page(app, "desktop-check.html?desktop=macos"),
            "setup" => open_page(app, "desktop-setup.html?desktop=macos"),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.reload()");
                }
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let opener = handle.clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mantis")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                // подсчёт не должен замедляться, когда окно свёрнуто или закрыто другим приложением
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .build()?;
            if let Err(e) = start_agent(&handle) {
                show_error(&win, &format!("Не удалось запустить Агент: {e}"));
            }
            if std::env::var_os("MANTIS_AUTOMOVE").is_some() {
                // проверка в CI: перенос без вопроса (окно вопроса там не нажать)
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if let Err(e) = move_to_applications_now(&h) {
                        eprintln!("MANTIS_AUTOMOVE: {e}");
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Пока идёт подсчёт, закрытие окна только прячет его: подсчёт продолжается, окно – по клику на значок в Dock
            if let WindowEvent::CloseRequested { api, .. } = event {
                let running = *window.app_handle().state::<Shell>().pilot.lock().unwrap();
                if running {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Mantis: не удалось создать приложение")
        .run(|app, event| match event {
            RunEvent::Reopen { .. } => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            RunEvent::Exit => {
                let state = app.state::<Shell>();
                let agent = state.agent.lock().unwrap().take();
                if let Some(child) = agent {
                    let _ = child.kill();
                }
                let awake = state.awake.lock().unwrap().take();
                if let Some(mut c) = awake {
                    let _ = c.kill();
                }
            }
            _ => {}
        });
}
