// Mantis для Windows: окно приложения + встроенный Агент. Устроено как Mantis для macOS (desktop/macos).
//
// Агент (agent/agent.ts, собран Bun-ом в один .exe) – вспомогательная программа внутри приложения:
// отдаёт страницу Mantis на 127.0.0.1 с заголовками для многопоточной нейросети и подключает IP-камеры.
// Приложение запускает его, ждёт строку «MANTIS_READY port=N» и открывает страницу в своём окне (WebView2).
// Страница вызывает команды оболочки (src/desktop.ts): app_info, keep_awake, set_autostart, quit_app, pilot_state.
//
// Отличия от Mac: установщик сам кладёт приложение на место (подготовка «перенести в Программы» не нужна),
// запрет сна – SetThreadExecutionState, автозапуск – реестр (плагин autostart), второй запуск открывает
// уже запущенное окно, закрытие окна во время подсчёта сворачивает его.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::mpsc::Sender;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Порт встроенного Агента. Отдельный от обычного Mantis Агента (8787), чтобы они не мешали друг другу.
const AGENT_PORT: &str = "8797";
/// Страница Mantis в режиме приложения для Windows (src/desktop.ts).
const HOME: &str = "?desktop=windows";

/// WebView2 по умолчанию замедляет таймеры и страницу в свёрнутом или закрытом другими окнами окне –
/// подсчёт бы почти останавливался. Первые флаги – те, что Tauri ставит сам (их нужно повторить).
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

#[derive(Default)]
struct Shell {
    agent: Mutex<Option<CommandChild>>,
    /// Пока Some – компьютер и экран не засыпают (поток с SetThreadExecutionState)
    awake: Mutex<Option<Sender<()>>>,
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

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let info = os_info::get();
    AppInfo {
        version: app.package_info().version.to_string(),
        hostname: std::env::var("COMPUTERNAME").unwrap_or_default(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        os: format!("Windows {} ({})", info.version(), std::env::consts::ARCH),
    }
}

/// Запрет сна держит отдельный поток: флаг SetThreadExecutionState действует, пока жив поток, который его поставил.
/// Поток ждёт, пока не уберут Sender, и возвращает обычный режим.
fn hold_awake() -> Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        }
        let _ = rx.recv();
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    });
    tx
}

#[tauri::command]
fn keep_awake(state: tauri::State<'_, Shell>, on: bool) {
    let mut awake = state.awake.lock().unwrap();
    if on && awake.is_none() {
        *awake = Some(hold_awake());
    } else if !on {
        awake.take();
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
                        open_page(&app, HOME);
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
    let home = MenuItem::with_id(app, "home", "Главная", true, Some("Ctrl+Shift+H"))?;
    let reload = MenuItem::with_id(app, "reload", "Обновить страницу", true, Some("F5"))?;
    let check = MenuItem::with_id(app, "check", "Проверка компьютера", true, Some("Ctrl+Shift+D"))?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sub = Submenu::with_items(app, "Mantis", true, &[&home, &reload, &sep, &check, &sep2, &quit])?;
    Menu::with_items(app, &[&sub])
}

fn main() {
    tauri::Builder::default()
        // второй запуск (ярлык, автозапуск) – показать уже открытое окно, а не запускать вторую копию
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![app_info, keep_awake, set_autostart, quit_app, pilot_state])
        .menu(build_menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "home" => open_page(app, HOME),
            "check" => open_page(app, "desktop-check.html?desktop=windows"),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.reload()");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let opener = handle.clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mantis")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .additional_browser_args(BROWSER_ARGS)
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
            // Пока идёт подсчёт, закрытие окна только сворачивает его: подсчёт продолжается
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
                let state = app.state::<Shell>();
                let agent = state.agent.lock().unwrap().take();
                if let Some(child) = agent {
                    let _ = child.kill();
                }
                state.awake.lock().unwrap().take();
            }
        });
}
