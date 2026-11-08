// Mantis для macOS: окно приложения + встроенный Агент.
//
// Агент (agent/agent.ts, собран Bun-ом в один файл) – вспомогательная программа внутри приложения:
// отдаёт страницу Mantis на 127.0.0.1 с заголовками для многопоточной нейросети и подключает IP-камеры.
// Приложение запускает его, ждёт строку «MANTIS_READY port=N» и открывает страницу в своём окне.
// Страница вызывает команды оболочки (src/desktop.ts): app_info, keep_awake, set_autostart, quit_app, pilot_state.

use std::process::{Child, Command};
use std::sync::Mutex;

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
                        open_page(&app, "?desktop=macos");
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
    let check = MenuItem::with_id(app, "check", "Проверка компьютера", true, Some("CmdOrCtrl+Shift+D"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sub = Submenu::with_items(app, "Mantis", true, &[&home, &reload, &sep, &check])?;
    menu.append(&sub)?;
    Ok(menu)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![app_info, keep_awake, set_autostart, quit_app, pilot_state])
        .menu(build_menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "home" => open_page(app, "?desktop=macos"),
            "check" => open_page(app, "desktop-check.html?desktop=macos"),
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
