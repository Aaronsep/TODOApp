use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PRIMARY_SHORTCUT_LABEL: &str = "Ctrl+M";
const FALLBACK_SHORTCUT_LABEL: &str = "Alt+Space";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    text: String,
    created_at: String,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    important: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredWindowPosition {
    x: i32,
    y: i32,
}

#[derive(Default)]
struct AppState {
    active_shortcut: Mutex<String>,
    last_toggle_at: Mutex<Option<Instant>>,
}

fn can_toggle_window(state: &AppState) -> bool {
    let mut last_toggle_at = state
        .last_toggle_at
        .lock()
        .expect("toggle state poisoned");
    let now = Instant::now();

    if let Some(last) = *last_toggle_at {
        if now.duration_since(last) < Duration::from_millis(220) {
            return false;
        }
    }

    *last_toggle_at = Some(now);
    true
}

fn tasks_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    Ok(dir.join("tasks.json"))
}

fn window_position_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    Ok(dir.join("window-position.json"))
}

fn save_window_position(app: &AppHandle, x: i32, y: i32) -> Result<(), String> {
    let path = window_position_path(app)?;
    let content =
        serde_json::to_string(&StoredWindowPosition { x, y }).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn restore_window_position(app: &AppHandle) -> Result<(), String> {
    let path = window_position_path(app)?;
    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let position: StoredWindowPosition =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;

    if let Some(window) = app.get_webview_window("main") {
        window
            .set_position(PhysicalPosition::new(position.x, position.y))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::AssetNotFound("main window not found".into()))?;

    let _ = window.unminimize();
    window.show()?;
    window.set_focus()?;
    window.emit("quick-focus", ())?;
    Ok(())
}

fn toggle_main_window(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    if !can_toggle_window(&state) {
        return Ok(());
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::AssetNotFound("main window not found".into()))?;

    if window.is_visible()? {
        window.hide()?;
    } else {
        show_main_window(app)?;
    }

    Ok(())
}

fn register_shortcut(app: &AppHandle) -> Result<String, String> {
    let manager = app.global_shortcut();
    let primary = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyM);
    let fallback = Shortcut::new(Some(Modifiers::ALT), Code::Space);

    match manager.register(primary) {
        Ok(_) => Ok(PRIMARY_SHORTCUT_LABEL.to_string()),
        Err(_) => {
            manager
                .register(fallback)
                .map_err(|error| error.to_string())?;
            Ok(FALLBACK_SHORTCUT_LABEL.to_string())
        }
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("toggle", "Mostrar / ocultar")
        .text("quit", "Salir")
        .build()?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default icon not found".into()))?
        .clone();

    TrayIconBuilder::with_id("quicktodo-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = toggle_main_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = toggle_main_window(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[tauri::command]
fn load_tasks(app: AppHandle) -> Result<Vec<Task>, String> {
    let path = tasks_path(&app)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_tasks(app: AppHandle, tasks: Vec<Task>) -> Result<(), String> {
    let path = tasks_path(&app)?;
    let content = serde_json::to_string_pretty(&tasks).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn active_shortcut(state: State<'_, AppState>) -> Result<String, String> {
    state
        .active_shortcut
        .lock()
        .map(|value| value.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(AppState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = toggle_main_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            restore_window_position(app.handle()).map_err(std::io::Error::other)?;
            create_tray(app.handle())?;

            let active = register_shortcut(app.handle()).map_err(std::io::Error::other)?;
            let state = app.state::<AppState>();
            *state
                .active_shortcut
                .lock()
                .expect("shortcut state poisoned") = active;

            if !cfg!(debug_assertions) && !app.handle().autolaunch().is_enabled()? {
                app.handle().autolaunch().enable()?;
            }

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Moved(position) = event {
                        let _ = save_window_position(&app_handle, position.x, position.y);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_tasks,
            save_tasks,
            active_shortcut,
            hide_current_window,
            start_window_drag
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
