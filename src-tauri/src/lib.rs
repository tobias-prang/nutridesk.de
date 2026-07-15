#[cfg(desktop)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use std::sync::Mutex;
use tauri::Manager;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, WindowEvent,
};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

// Ersetzt die frueheren Electron-window.nutridesk-Funktionen. Der Renderer ruft diese Commands
// ueber den JS-Shim (assets/tauri-bridge.js) auf. Desktop-only-Teile (Tray, Autostart, Updater)
// sind per cfg(desktop) ausgeklammert, damit iOS/Android sauber kompilieren.

// Heruntergeladenes, noch nicht installiertes Update (zwei-Schritt: pruefen/laden -> installieren).
#[cfg(desktop)]
struct PendingUpdate {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
}
#[cfg(desktop)]
#[derive(Default)]
struct Pending(Mutex<Option<PendingUpdate>>);

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn notify_items(app: tauri::AppHandle, items: Vec<serde_json::Value>) -> u32 {
    let mut shown = 0u32;
    for it in items.iter().take(8) {
        let title = it
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("NutriDesk");
        let body = it.get("body").and_then(|v| v.as_str()).unwrap_or("");
        if app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .is_ok()
        {
            shown += 1;
        }
    }
    shown
}

#[cfg(desktop)]
#[tauri::command]
fn autostart_get(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(desktop)]
#[tauri::command]
fn autostart_set(app: tauri::AppHandle, on: bool) -> bool {
    let mgr = app.autolaunch();
    let _ = if on { mgr.enable() } else { mgr.disable() };
    mgr.is_enabled().unwrap_or(false)
}

// ---------- Updater (stable / ptb), nur Desktop ----------
// Kanal wird lokal in einer Datei persistiert; der PTB-Feed ist nur fuer Entwickler.
#[cfg(desktop)]
fn channel_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("channel.txt"))
}
#[cfg(desktop)]
fn read_channel(app: &tauri::AppHandle) -> String {
    if let Some(p) = channel_path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if s.trim() == "ptb" {
                return "ptb".to_string();
            }
        }
    }
    "stable".to_string()
}
#[cfg(desktop)]
fn write_channel(app: &tauri::AppHandle, ch: &str) {
    if let Some(p) = channel_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, if ch == "ptb" { "ptb" } else { "stable" });
    }
}
#[cfg(desktop)]
fn endpoint_for(ch: &str) -> String {
    if ch == "ptb" {
        "https://nutridesk.de/updates/ptb/tauri.json".to_string()
    } else {
        "https://nutridesk.de/updates/tauri.json".to_string()
    }
}

#[cfg(desktop)]
#[tauri::command]
async fn upd_check(app: tauri::AppHandle) -> serde_json::Value {
    let _ = app.emit("upd", serde_json::json!({ "status": "checking" }));
    let ch = read_channel(&app);
    let url = match url::Url::parse(&endpoint_for(&ch)) {
        Ok(u) => u,
        Err(_) => {
            let _ = app.emit(
                "upd",
                serde_json::json!({ "status": "error", "message": "bad endpoint" }),
            );
            return serde_json::json!({ "ok": false });
        }
    };
    let updater = match app.updater_builder().endpoints(vec![url]).and_then(|b| b.build()) {
        Ok(u) => u,
        Err(e) => {
            let _ = app.emit(
                "upd",
                serde_json::json!({ "status": "error", "message": e.to_string() }),
            );
            return serde_json::json!({ "ok": false });
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let _ = app.emit(
                "upd",
                serde_json::json!({ "status": "available", "version": version }),
            );
            let app2 = app.clone();
            let downloaded = AtomicU64::new(0);
            let dl = update
                .download(
                    move |chunk: usize, total: Option<u64>| {
                        let d = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                        let pct = match total {
                            Some(t) if t > 0 => ((d * 100) / t) as u32,
                            _ => 0,
                        };
                        let _ = app2
                            .emit("upd", serde_json::json!({ "status": "progress", "percent": pct }));
                    },
                    || {},
                )
                .await;
            match dl {
                Ok(bytes) => {
                    let _ = app.emit(
                        "upd",
                        serde_json::json!({ "status": "downloaded", "version": version }),
                    );
                    let state = app.state::<Pending>();
                    *state.0.lock().unwrap() = Some(PendingUpdate { update, bytes });
                    serde_json::json!({ "ok": true, "available": true, "version": version })
                }
                Err(e) => {
                    let _ = app.emit(
                        "upd",
                        serde_json::json!({ "status": "error", "message": e.to_string() }),
                    );
                    serde_json::json!({ "ok": false })
                }
            }
        }
        Ok(None) => {
            let _ = app.emit("upd", serde_json::json!({ "status": "none" }));
            serde_json::json!({ "ok": true, "available": false })
        }
        Err(e) => {
            let _ = app.emit(
                "upd",
                serde_json::json!({ "status": "error", "message": e.to_string() }),
            );
            serde_json::json!({ "ok": false })
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
async fn upd_install(app: tauri::AppHandle) -> serde_json::Value {
    let pending = {
        let state = app.state::<Pending>();
        let mut g = state.0.lock().unwrap();
        g.take()
    };
    match pending {
        Some(p) => match p.update.install(p.bytes) {
            Ok(_) => serde_json::json!({ "ok": true }),
            Err(e) => {
                let _ = app.emit(
                    "upd",
                    serde_json::json!({ "status": "error", "message": e.to_string() }),
                );
                serde_json::json!({ "ok": false })
            }
        },
        None => serde_json::json!({ "ok": false, "reason": "no-update" }),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn upd_get_channel(app: tauri::AppHandle) -> String {
    read_channel(&app)
}

#[cfg(desktop)]
#[tauri::command]
fn upd_set_channel(app: tauri::AppHandle, ch: String) -> serde_json::Value {
    let ch = if ch == "ptb" { "ptb" } else { "stable" };
    write_channel(&app, ch);
    serde_json::json!({ "ok": true, "channel": ch })
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_notification::init());

    // Desktop-only Plugins + State + Commands (Tray, Autostart, Single-Instance, Updater).
    #[cfg(desktop)]
    let builder = builder
        .manage(Pending::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_version,
            notify_items,
            autostart_get,
            autostart_set,
            upd_check,
            upd_install,
            upd_get_channel,
            upd_set_channel
        ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![app_version, notify_items]);

    let builder = builder.setup(|app| {
        let version = app.package_info().version.to_string();
        #[cfg(desktop)]
        {
            if let Some(win) = app.get_webview_window("main") {
                let suffix = if app.config().identifier.ends_with(".dev") { " · DEV" } else { "" };
                let _ = win.set_title(&format!("NutriDesk · v{}{}", version, suffix));
            }
            // Infobereich (Tray): Oeffnen / Beenden, Linksklick holt das Fenster zurueck.
            let open_i = MenuItem::with_id(app, "open", "Öffnen", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("NutriDesk")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
        }
        let _ = version;
        #[cfg(debug_assertions)]
        {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
        }
        Ok(())
    });

    // X schliesst nicht, sondern versteckt ins Tray (Desktop; Beenden nur ueber das Tray-Menue).
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let _ = window.hide();
            api.prevent_close();
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
