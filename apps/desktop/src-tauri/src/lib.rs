//! AtlasEngine Desktop - Native Tauri wrapper for AtlasEngine
//!
//! This is a thin WebView wrapper that loads the AtlasEngine UI.
//! In development mode, it connects to the Vite dev server.
//! In production mode, it serves bundled web assets and starts
//! the Node.js backend automatically.

mod backend;
mod discovery;
mod updater;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Runtime, Size,
    WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const MIN_WINDOW_WIDTH: f64 = 1100.0;
const MIN_WINDOW_HEIGHT: f64 = 700.0;
const DEFAULT_WINDOW_WIDTH: f64 = 1400.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 900.0;
const DEFAULT_WINDOW_WIDTH_RATIO: f64 = 0.9;
const DEFAULT_WINDOW_HEIGHT_RATIO: f64 = 0.85;
const MONITOR_EDGE_MARGIN: f64 = 80.0;
/// Extra vertical margin to account for OS taskbar/dock that monitor.size() doesn't exclude
const TASKBAR_MARGIN: f64 = 60.0;
const ABSOLUTE_MIN_WIDTH: f64 = 720.0;
const ABSOLUTE_MIN_HEIGHT: f64 = 540.0;
const WINDOW_STATE_FILENAME: &str = "window-state.json";
const CHECK_FOR_UPDATES_MENU_ID: &str = "check_for_updates";
const ABOUT_MENU_ID: &str = "about_atlasengine";
const MCP_SETUP_MENU_ID: &str = "mcp_setup";
const AI_PROVIDERS_MENU_ID: &str = "ai_providers";
const GITHUB_SETTINGS_MENU_ID: &str = "github_settings";
const CLOUD_SETTINGS_MENU_ID: &str = "cloud_settings";
const WEBSITE_MENU_ID: &str = "atlasengine_website";
const DOCUMENTATION_MENU_ID: &str = "atlasengine_documentation";
const DISCORD_MENU_ID: &str = "atlasengine_discord";
const ATLASENGINE_WEBSITE_URL: &str = "https://www.atlasengine.dev/";
const ATLASENGINE_DOCUMENTATION_URL: &str = "https://docs.atlasengine.dev/";
const ATLASENGINE_DISCORD_URL: &str = "https://discord.gg/tyMsmCnf";

fn set_menu_item_enabled_recursive<R: Runtime>(
    menu: &Menu<R>,
    target_id: &str,
    enabled: bool,
) -> Result<bool, String> {
    let items = menu
        .items()
        .map_err(|e| format!("Failed to read menu items: {}", e))?;

    for item in items {
        if set_menu_item_kind_enabled_recursive(&item, target_id, enabled)? {
            return Ok(true);
        }
    }

    Ok(false)
}

fn set_menu_item_kind_enabled_recursive<R: Runtime>(
    item: &MenuItemKind<R>,
    target_id: &str,
    enabled: bool,
) -> Result<bool, String> {
    if item.id() == target_id {
        if let Some(menu_item) = item.as_menuitem() {
            menu_item
                .set_enabled(enabled)
                .map_err(|e| format!("Failed to update menu item state: {}", e))?;
            return Ok(true);
        }
        return Err(format!(
            "Menu item '{}' is not a standard menu item",
            target_id
        ));
    }

    if let Some(submenu) = item.as_submenu() {
        let items = submenu
            .items()
            .map_err(|e| format!("Failed to read submenu items: {}", e))?;
        for child in items {
            if set_menu_item_kind_enabled_recursive(&child, target_id, enabled)? {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

#[tauri::command]
fn set_check_for_updates_menu_enabled<R: Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let menu = app
        .menu()
        .ok_or_else(|| "Application menu is not available".to_string())?;

    if set_menu_item_enabled_recursive(&menu, CHECK_FOR_UPDATES_MENU_ID, enabled)? {
        Ok(())
    } else {
        Err(format!(
            "Could not find menu item '{}'",
            CHECK_FOR_UPDATES_MENU_ID
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedWindowState {
    width: f64,
    height: f64,
    maximized: bool,
}

fn current_monitor_logical_size(window: &WebviewWindow) -> Option<(f64, f64)> {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let monitor_size = monitor.size();
        return Some((
            monitor_size.width as f64 / scale,
            monitor_size.height as f64 / scale,
        ));
    }
    None
}

fn clamp_window_size(
    width: f64,
    height: f64,
    monitor_logical_size: Option<(f64, f64)>,
) -> (f64, f64) {
    let (max_width, max_height) = monitor_logical_size
        .map(|(w, h)| {
            (
                (w - MONITOR_EDGE_MARGIN).max(ABSOLUTE_MIN_WIDTH),
                (h - MONITOR_EDGE_MARGIN - TASKBAR_MARGIN).max(ABSOLUTE_MIN_HEIGHT),
            )
        })
        .unwrap_or((f64::MAX, f64::MAX));

    let min_width = MIN_WINDOW_WIDTH.min(max_width);
    let min_height = MIN_WINDOW_HEIGHT.min(max_height);

    (
        width.max(min_width).min(max_width),
        height.max(min_height).min(max_height),
    )
}

fn window_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {}", e))?;
    if let Err(e) = fs::create_dir_all(&config_dir) {
        return Err(format!(
            "Failed to create app config directory {}: {}",
            config_dir.display(),
            e
        ));
    }
    Ok(config_dir.join(WINDOW_STATE_FILENAME))
}

fn load_window_state(app: &AppHandle) -> Option<PersistedWindowState> {
    let path = window_state_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let state: PersistedWindowState = serde_json::from_str(&raw).ok()?;
    Some(PersistedWindowState {
        width: state.width,
        height: state.height,
        maximized: state.maximized,
    })
}

fn save_window_state(window: &WebviewWindow) -> Result<(), String> {
    let outer_size = window
        .outer_size()
        .map_err(|e| format!("Failed to read window outer size: {}", e))?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("Failed to read window scale factor: {}", e))?;

    let (width, height) = clamp_window_size(
        outer_size.width as f64 / scale,
        outer_size.height as f64 / scale,
        current_monitor_logical_size(window),
    );
    let maximized = window
        .is_maximized()
        .map_err(|e| format!("Failed to read window maximized state: {}", e))?;

    let state = PersistedWindowState {
        width,
        height,
        maximized,
    };

    let app_handle = window.app_handle();
    let path = window_state_path(&app_handle)?;
    let payload = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize window state: {}", e))?;
    fs::write(&path, payload)
        .map_err(|e| format!("Failed to write window state {}: {}", path.display(), e))?;

    Ok(())
}

fn calculate_default_window_size(window: &WebviewWindow) -> (f64, f64) {
    if let Some((logical_width, logical_height)) = current_monitor_logical_size(window) {
        return clamp_window_size(
            (logical_width * DEFAULT_WINDOW_WIDTH_RATIO).floor(),
            (logical_height * DEFAULT_WINDOW_HEIGHT_RATIO).floor(),
            Some((logical_width, logical_height)),
        );
    }

    clamp_window_size(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT, None)
}

fn open_settings_section(app: &AppHandle, section: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let script = format!(
            "if (window.__atlasOpenGlobalSettings) {{ window.__atlasOpenGlobalSettings({section:?}); }} else if (window.__atlasNavigate) {{ window.__atlasNavigate('settings'); }}"
        );
        let _ = window.eval(&script);
    }
}

fn center_window_on_current_monitor(
    window: &WebviewWindow,
    logical_width: f64,
    logical_height: f64,
) -> Result<(), String> {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();

        let window_width_px = (logical_width * scale).round().max(1.0) as i32;
        let window_height_px = (logical_height * scale).round().max(1.0) as i32;
        let available_width = monitor_size.width as i32;
        // Reserve space for OS taskbar/dock (not included in monitor.size())
        let taskbar_px = (TASKBAR_MARGIN * scale).round() as i32;
        let available_height = monitor_size.height as i32 - taskbar_px;

        let x = monitor_pos.x + ((available_width - window_width_px) / 2);
        let y = monitor_pos.y + ((available_height - window_height_px) / 2).max(0);

        window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|e| format!("Failed to position window: {}", e))?;
        return Ok(());
    }

    window
        .center()
        .map_err(|e| format!("Failed to center window: {}", e))
}

fn restore_or_initialize_window(window: &WebviewWindow) -> Result<(), String> {
    let app_handle = window.app_handle();
    let saved = load_window_state(&app_handle);
    let (width, height, maximize_after_resize) = if let Some(state) = saved {
        let (w, h) = clamp_window_size(
            state.width,
            state.height,
            current_monitor_logical_size(window),
        );
        (w, h, state.maximized)
    } else {
        let (default_width, default_height) = calculate_default_window_size(window);
        (default_width, default_height, false)
    };

    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| format!("Failed to set initial window size: {}", e))?;

    if maximize_after_resize {
        window
            .maximize()
            .map_err(|e| format!("Failed to maximize restored window: {}", e))?;
    } else {
        center_window_on_current_monitor(window, width, height)?;

        // On some systems the first position request can race with initial show.
        // Re-apply centering shortly after startup for deterministic first-launch placement.
        let retry_window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            let _ = center_window_on_current_monitor(&retry_window, width, height);
        });
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_keyring::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(Mutex::new(backend::BackendState::default())))
        .menu(|app| {
            // -- File submenu --
            let file_menu = if cfg!(target_os = "macos") {
                SubmenuBuilder::new(app, "File")
                    .item(&MenuItemBuilder::with_id(MCP_SETUP_MENU_ID, "MCP Setup").build(app)?)
                    .item(
                        &MenuItemBuilder::with_id(AI_PROVIDERS_MENU_ID, "AI Providers")
                            .build(app)?,
                    )
                    .item(&MenuItemBuilder::with_id(GITHUB_SETTINGS_MENU_ID, "GitHub").build(app)?)
                    .item(
                        &MenuItemBuilder::with_id(CLOUD_SETTINGS_MENU_ID, "Cloud Settings")
                            .build(app)?,
                    )
                    .separator()
                    .item(&PredefinedMenuItem::close_window(
                        app,
                        Some("Close Window"),
                    )?)
                    .build()?
            } else {
                SubmenuBuilder::new(app, "File")
                    .item(&MenuItemBuilder::with_id(MCP_SETUP_MENU_ID, "MCP Setup").build(app)?)
                    .item(
                        &MenuItemBuilder::with_id(AI_PROVIDERS_MENU_ID, "AI Providers")
                            .build(app)?,
                    )
                    .item(&MenuItemBuilder::with_id(GITHUB_SETTINGS_MENU_ID, "GitHub").build(app)?)
                    .item(
                        &MenuItemBuilder::with_id(CLOUD_SETTINGS_MENU_ID, "Cloud Settings")
                            .build(app)?,
                    )
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("settings_file", "Settings...")
                            .accelerator("CmdOrCtrl+,")
                            .build(app)?,
                    )
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id(
                            CHECK_FOR_UPDATES_MENU_ID,
                            "Check for Updates...",
                        )
                        .build(app)?,
                    )
                    .separator()
                    .item(&MenuItemBuilder::with_id(ABOUT_MENU_ID, "About AtlasEngine").build(app)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, Some("Quit Atlas"))?)
                    .build()?
            };

            // -- Edit submenu (standard text editing) --
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            // -- View submenu --
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;

            // -- Window submenu --
            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(
                    app,
                    Some("Close Window"),
                )?)
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&MenuItemBuilder::with_id(DOCUMENTATION_MENU_ID, "Documentation").build(app)?)
                .item(&MenuItemBuilder::with_id(WEBSITE_MENU_ID, "AtlasEngine Website").build(app)?)
                .item(&MenuItemBuilder::with_id(DISCORD_MENU_ID, "Join Discord").build(app)?)
                .build()?;

            if cfg!(target_os = "macos") {
                let app_menu = SubmenuBuilder::new(app, "AtlasEngine")
                    .item(&PredefinedMenuItem::about(
                        app,
                        Some("About AtlasEngine"),
                        None,
                    )?)
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id(
                            CHECK_FOR_UPDATES_MENU_ID,
                            "Check for Updates...",
                        )
                        .build(app)?,
                    )
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("settings", "Settings...")
                            .accelerator("CmdOrCtrl+,")
                            .build(app)?,
                    )
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, Some("Hide AtlasEngine"))?)
                    .item(&PredefinedMenuItem::hide_others(app, Some("Hide Others"))?)
                    .item(&PredefinedMenuItem::show_all(app, Some("Show All"))?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, Some("Quit AtlasEngine"))?)
                    .build()?;

                Menu::with_items(
                    app,
                    &[
                        &app_menu,
                        &file_menu,
                        &edit_menu,
                        &view_menu,
                        &window_menu,
                        &help_menu,
                    ],
                )
            } else {
                Menu::with_items(
                    app,
                    &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
                )
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            CHECK_FOR_UPDATES_MENU_ID => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("menu-check-for-updates", ());
                }
            }
            MCP_SETUP_MENU_ID => open_settings_section(app, "mcp"),
            AI_PROVIDERS_MENU_ID => open_settings_section(app, "review"),
            GITHUB_SETTINGS_MENU_ID => open_settings_section(app, "github"),
            CLOUD_SETTINGS_MENU_ID => open_settings_section(app, "cloud"),
            "settings" | "settings_file" => {
                open_settings_section(app, "review");
            }
            WEBSITE_MENU_ID => {
                if let Err(err) = app.opener().open_url(ATLASENGINE_WEBSITE_URL, None::<&str>) {
                    log::warn!("Failed to open AtlasEngine website: {}", err);
                }
            }
            ABOUT_MENU_ID => {
                let version = app.package_info().version.to_string();
                app.dialog()
                    .message(format!(
                        "AtlasEngine\nVersion {}\nhttps://www.atlasengine.dev/",
                        version
                    ))
                    .title("About AtlasEngine")
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
            DOCUMENTATION_MENU_ID => {
                if let Err(err) = app
                    .opener()
                    .open_url(ATLASENGINE_DOCUMENTATION_URL, None::<&str>)
                {
                    log::warn!("Failed to open AtlasEngine documentation: {}", err);
                }
            }
            DISCORD_MENU_ID => {
                if let Err(err) = app.opener().open_url(ATLASENGINE_DISCORD_URL, None::<&str>) {
                    log::warn!("Failed to open AtlasEngine Discord: {}", err);
                }
            }
            _ => {}
        })
        .setup(|app| {
            {
                let log_builder =
                    tauri_plugin_log::Builder::default().level(log::LevelFilter::Info);
                let log_builder = if cfg!(debug_assertions) {
                    log_builder
                } else {
                    // In release builds, write logs to AppData so startup failures
                    // are diagnosable even when no console is attached.
                    log_builder
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Folder {
                                path: app.path().app_data_dir().unwrap_or_default(),
                                file_name: Some("atlasengine".into()),
                            },
                        ))
                        .max_file_size(2_000_000) // 2 MB per log file
                        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                };
                app.handle().plugin(log_builder.build())?;
            }

            // Open devtools for debugging
            #[cfg(feature = "devtools")]
            {
                // Try to get any webview window and open devtools
                for (label, window) in app.webview_windows() {
                    log::info!("Opening devtools for window: {}", label);
                    window.open_devtools();
                }
            }

            // Start the bundled backend (both dev and production for testing)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                log::info!("Starting bundled backend...");
                match backend::start_backend(&app_handle) {
                    Ok(port) => {
                        log::info!("Backend started successfully on port {}", port);
                    }
                    Err(e) => {
                        log::error!("Failed to start backend: {}", e);
                        // The app will still launch but won't function properly
                        // Frontend will show an error state
                    }
                }
            });

            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(e) = restore_or_initialize_window(&main_window) {
                    log::warn!(
                        "Failed to restore window state; using config defaults: {}",
                        e
                    );
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Handle window close button: hide instead of quit (like Slack, ChatGPT).
            // The user must explicitly quit via Cmd+Q / menu to actually exit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the default close behavior
                api.prevent_close();

                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    if let Err(e) = save_window_state(&webview_window) {
                        log::warn!("Failed to persist window state: {}", e);
                    }
                    // Hide window - backend keeps running in the background
                    let _ = webview_window.hide();
                }
                log::info!("Window hidden (close button). App stays running in background.");
            }
        })
        .invoke_handler(tauri::generate_handler![
            updater::check_for_update,
            updater::download_and_install,
            set_check_for_updates_menu_enabled,
            backend::get_backend_port,
            backend::backend_health,
            backend::restart_backend,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // Keep running when all windows are closed (macOS dock icon stays active)
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if cfg!(target_os = "macos") {
                        api.prevent_exit();
                    }
                }
                // Re-show window when user clicks dock icon or reactivates the app
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                // Actual quit (Cmd+Q / menu quit): stop backend and clean up
                tauri::RunEvent::Exit => {
                    log::info!("App quitting, stopping backend...");
                    if let Err(e) = backend::stop_backend(app_handle) {
                        log::warn!("Error stopping backend on quit: {}", e);
                    }
                }
                _ => {}
            }
        });
}
