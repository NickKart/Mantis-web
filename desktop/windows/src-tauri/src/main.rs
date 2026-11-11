// Mantis для Windows: окно приложения + встроенный Агент.
//
// Агент (agent/agent.ts, собран Bun-ом в один .exe) – вспомогательная программа внутри приложения:
// отдаёт страницу Mantis на 127.0.0.1 с заголовками для многопоточной нейросети и подключает IP-камеры.
// Приложение запускает его, ждёт строку «MANTIS_READY port=N» и открывает страницу в своём окне (WebView2).
// Страница вызывает команды оболочки (src/desktop.ts): app_info, keep_awake, set_autostart, quit_app, pilot_state,
// а для «Подготовки компьютера» (desktop-setup.html) – open_settings, setup_done.
//
// Первый запуск: вместо главной страницы открывается «Подготовка компьютера» (камера, автозапуск, сон).
// Значок в области уведомлений (у часов): открыть окно, проверка компьютера, подготовка, выход.
// Пока идёт подсчёт, крестик сворачивает окно на панель задач – подсчёт продолжается.

// без чёрного окна консоли рядом с приложением
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Порт встроенного Агента. Отдельный от обычного Mantis Агента (8787), чтобы они не мешали друг другу.
/// Тот же, что у приложения для Mac: адрес страницы (и её данные в WebView2) не меняется между запусками.
const AGENT_PORT: &str = "8797";
/// Файл-отметка «Подготовка компьютера пройдена» в %APPDATA%\ru.rcmit.mantis
const SETUP_FLAG: &str = "setup-done";

/// Ключи для движка WebView2 (Chromium). Без них свёрнутое окно Chromium притормаживает: таймеры страницы
/// срабатывают раз в секунду, а через 5 минут – раз в минуту, и подсчёт почти останавливается.
/// Первые три – значения WebView2 по умолчанию в Tauri (без мини-меню и SmartScreen для своей страницы).
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling \
--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
--autoplay-policy=no-user-gesture-required";

/// CREATE_NO_WINDOW: служебные команды (ver) без мелькающего окна консоли
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Shell {
    agent: Mutex<Option<CommandChild>>,
    /// Запрет сна: пока true, отдельный поток раз в 30 секунд напоминает Windows, что компьютер занят
    awake: Arc<AtomicBool>,
    awake_thread: Mutex<bool>,
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

fn quiet(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(NO_WINDOW);
    }
    let out = c.output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// «Windows 11 (сборка 26100, x64)»: номер сборки из `ver` – «Microsoft Windows [Version 10.0.26100.2033]».
fn os_name() -> String {
    let arch = std::env::consts::ARCH.replace("x86_64", "x64").replace("aarch64", "arm64");
    let ver = quiet("cmd", &["/c", "ver"]).unwrap_or_default();
    let build: Option<u32> = ver
        .split("10.0.")
        .nth(1)
        .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|s| s.parse().ok());
    match build {
        Some(b) => format!("Windows {} (сборка {b}, {arch})", if b >= 22000 { "11" } else { "10" }),
        None => format!("Windows ({arch})"),
    }
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        hostname: std::env::var("COMPUTERNAME").unwrap_or_default(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        os: os_name(),
    }
}

/// Не давать компьютеру и экрану засыпать, пока идёт подсчёт. SetThreadExecutionState без ES_CONTINUOUS
/// сбрасывает таймер простоя один раз, поэтому поток повторяет вызов каждые 30 секунд, пока подсчёт идёт.
#[tauri::command]
fn keep_awake(state: tauri::State<'_, Shell>, on: bool) {
    state.awake.store(on, Ordering::SeqCst);
    let mut started = state.awake_thread.lock().unwrap();
    if on && !*started {
        *started = true;
        let flag = state.awake.clone();
        std::thread::spawn(move || loop {
            if flag.load(Ordering::SeqCst) {
                ping_awake();
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
    }
    if on {
        ping_awake();
    }
}

#[cfg(windows)]
fn ping_awake() {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    unsafe {
        SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
    }
}

#[cfg(not(windows))]
fn ping_awake() {}

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
fn pilot_state(app: AppHandle, state: tauri::State<'_, Shell>, running: bool) {
    *state.pilot.lock().unwrap() = running;
    if let Some(tray) = app.tray_by_id("mantis") {
        let _ = tray.set_tooltip(Some(if running { "Mantis – идёт подсчёт" } else { "Mantis" }));
    }
}

// ---------------------------------------------------------------- «Подготовка компьютера»

/// Открыть раздел «Параметров Windows»: только известные разделы.
#[tauri::command]
fn open_settings(app: AppHandle, pane: String) -> bool {
    let url = match pane.as_str() {
        "camera" => "ms-settings:privacy-webcam",
        "login-items" | "startup" => "ms-settings:startupapps",
        "power" => "ms-settings:powersleep",
        "network" | "local-network" => "ms-settings:network-status",
        _ => return false,
    };
    app.opener().open_url(url, None::<&str>).is_ok()
}

fn setup_flag(app: &AppHandle) -> Option<std::path::PathBuf> {
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

/// Сведения об установке для «Подготовки»: на Windows приложение всегда ставится установщиком.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    in_applications: bool,
    path: String,
}

#[tauri::command]
fn install_state() -> InstallState {
    InstallState {
        in_applications: true,
        path: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// Первая страница после запуска: «Подготовка компьютера», пока её не прошли, иначе – Mantis.
fn first_page(app: &AppHandle) -> &'static str {
    match setup_flag(app) {
        Some(f) if f.exists() => "?desktop=windows",
        _ => "desktop-setup.html?desktop=windows",
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

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_page(app: &AppHandle, path: &str) {
    let Some(win) = app.get_webview_window("main") else { return };
    let base = app.state::<Shell>().page.lock().unwrap().clone();
    if let Some(base) = base {
        if let Ok(url) = Url::parse(&format!("{base}{path}")) {
            let _ = win.navigate(url);
        }
    }
    show_window(app);
}

fn start_agent(app: &AppHandle) -> Result<(), String> {
    let cmd = app
        .shell()
        .sidecar("mantis-agent")
        .map_err(|e| e.to_string())?
        .args(["--no-browser"])
        .env("MANTIS_SHELL", "windows")
        .env("MANTIS_PARENT_PID", std::process::id().to_string())
        .env("MANTIS_PORT", AGENT_PORT)
        // Агент и его ffmpeg – в одном задании Windows (Job Object): при выходе закрываются вместе
        .set_process_group(true)
        .kill_on_drop(true);
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

fn stop_agent(app: &AppHandle) {
    let agent = app.state::<Shell>().agent.lock().unwrap().take();
    if let Some(child) = agent {
        let _ = child.kill();
    }
}

/// Значок у часов: окно, проверка, подготовка, выход. Клик по значку – показать окно.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть Mantis", true, None::<&str>)?;
    let home = MenuItem::with_id(app, "home", "Главная Mantis", true, None::<&str>)?;
    let setup = MenuItem::with_id(app, "setup", "Подготовка компьютера…", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Проверка компьютера", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти из Mantis", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &home, &sep1, &setup, &check, &sep2, &quit])?;
    let mut tray = TrayIconBuilder::with_id("mantis")
        .tooltip("Mantis")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_window(app),
            "home" => open_page(app, "?desktop=windows"),
            "check" => open_page(app, "desktop-check.html?desktop=windows"),
            "setup" => open_page(app, "desktop-setup.html?desktop=windows"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // повторный запуск (ярлык, автозапуск) не открывает второе окно, а показывает уже открытое
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
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
            open_settings,
            setup_done
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let opener = handle.clone();
            let opener2 = handle.clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mantis")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .additional_browser_args(BROWSER_ARGS)
                // своя страница с этого компьютера получает камеру без вопроса WebView2
                // (доступ к камере для приложений по-прежнему решают «Параметры Windows» → «Конфиденциальность»)
                .on_permission_request(|webview, kind| {
                    let local = webview.url().map(|u| is_app_url(&u)).unwrap_or(false);
                    match kind {
                        PermissionKind::Camera if local => PermissionResponse::Allow,
                        _ => PermissionResponse::Default,
                    }
                })
                // ссылки «в новом окне» – тоже в браузере по умолчанию
                .on_new_window(move |url, _| {
                    let _ = opener2.opener().open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .build()?;
            build_tray(&handle)?;
            if let Err(e) = start_agent(&handle) {
                show_error(&win, &format!("Не удалось запустить Агент: {e}"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Пока идёт подсчёт, крестик сворачивает окно на панель задач: подсчёт продолжается
            if let WindowEvent::CloseRequested { api, .. } = event {
                let running = *window.app_handle().state::<Shell>().pilot.lock().unwrap();
                if running {
                    api.prevent_close();
                    let _ = window.minimize();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Mantis: не удалось создать приложение")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_agent(app);
                app.state::<Shell>().awake.store(false, Ordering::SeqCst);
            }
        });
}
