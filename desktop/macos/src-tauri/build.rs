// Команды оболочки, которые может вызывать страница Mantis (она открыта с http://127.0.0.1 – для Tauri это
// «удалённый» адрес, поэтому каждую команду нужно перечислить и разрешить в capabilities/default.json).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "app_info",
            "keep_awake",
            "set_autostart",
            "quit_app",
            "pilot_state",
        ])),
    )
    .expect("tauri-build");
}
