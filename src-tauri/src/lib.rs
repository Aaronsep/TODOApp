use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_runtime::ResizeDirection;

const PRIMARY_SHORTCUT_LABEL: &str = "Ctrl+Space";
const FALLBACK_SHORTCUT_LABEL: &str = "Alt+Space";
const TASK_METADATA_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskMetadata {
    #[serde(default = "default_task_metadata_schema_version")]
    schema_version: u8,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    last_completed_at: Option<String>,
    #[serde(default)]
    last_reopened_at: Option<String>,
    #[serde(default)]
    last_importance_change_at: Option<String>,
    #[serde(default)]
    last_reordered_at: Option<String>,
}

impl Default for TaskMetadata {
    fn default() -> Self {
        Self {
            schema_version: TASK_METADATA_SCHEMA_VERSION,
            updated_at: String::new(),
            last_completed_at: None,
            last_reopened_at: None,
            last_importance_change_at: None,
            last_reordered_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    text: String,
    #[serde(default)]
    description: String,
    created_at: String,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    important: bool,
    #[serde(default)]
    metadata: TaskMetadata,
}

impl Task {
    fn ensure_metadata(mut self) -> Self {
        self.metadata.schema_version = TASK_METADATA_SCHEMA_VERSION;

        if self.metadata.updated_at.is_empty() {
            self.metadata.updated_at = self.created_at.clone();
        }

        if self.completed && self.metadata.last_completed_at.is_none() {
            self.metadata.last_completed_at = Some(self.created_at.clone());
        }

        if self.important && self.metadata.last_importance_change_at.is_none() {
            self.metadata.last_importance_change_at = Some(self.created_at.clone());
        }

        self
    }
}

fn default_task_metadata_schema_version() -> u8 {
    TASK_METADATA_SCHEMA_VERSION
}

fn write_tasks(path: &PathBuf, tasks: &[Task]) -> Result<(), String> {
    let content = serde_json::to_string_pretty(tasks).map_err(|error| error.to_string())?;

    // Respaldo del ultimo bueno antes de sobrescribir.
    if path.exists() {
        let backup = path.with_extension("bak");
        let _ = fs::copy(path, backup);
    }

    // Escritura atomica: escribir a un temporal y renombrar (atomico en el mismo volumen),
    // asi un corte a mitad de escritura nunca deja el JSON a medias.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

/// Normaliza metadatos y reescribe el archivo si hubo migracion.
fn finalize_tasks(path: &PathBuf, stored_tasks: Vec<Task>) -> Vec<Task> {
    let tasks: Vec<Task> = stored_tasks
        .clone()
        .into_iter()
        .map(Task::ensure_metadata)
        .collect();

    if tasks != stored_tasks {
        let _ = write_tasks(path, &tasks);
    }

    tasks
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredWindowPosition {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    hide_on_blur: bool,
    autostart: bool,
    shortcut: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hide_on_blur: true,
            autostart: true,
            shortcut: PRIMARY_SHORTCUT_LABEL.to_string(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings_inner(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Settings::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_settings_inner(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

/// Mapea una etiqueta de atajo a un Shortcut concreto (presets soportados).
fn shortcut_from_label(label: &str) -> Option<Shortcut> {
    match label {
        "Ctrl+Space" => Some(Shortcut::new(Some(Modifiers::CONTROL), Code::Space)),
        "Alt+Space" => Some(Shortcut::new(Some(Modifiers::ALT), Code::Space)),
        "Cmd+Shift+Space" => Some(Shortcut::new(
            Some(Modifiers::SUPER | Modifiers::SHIFT),
            Code::Space,
        )),
        "Ctrl+M" => Some(Shortcut::new(Some(Modifiers::CONTROL), Code::KeyM)),
        _ => None,
    }
}

struct AppState {
    active_shortcut: Mutex<String>,
    last_toggle_at: Mutex<Option<Instant>>,
    hide_on_blur: Mutex<bool>,
    suppress_blur_until: Mutex<Option<Instant>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_shortcut: Mutex::new(String::new()),
            last_toggle_at: Mutex::new(None),
            hide_on_blur: Mutex::new(true),
            suppress_blur_until: Mutex::new(None),
        }
    }
}

/// Evita que un blur transitorio (al mostrar la ventana o abrir el menu nativo)
/// dispare el auto-ocultado.
fn suppress_blur(state: &AppState, ms: u64) {
    if let Ok(mut guard) = state.suppress_blur_until.lock() {
        *guard = Some(Instant::now() + Duration::from_millis(ms));
    }
}

fn blur_is_suppressed(state: &AppState) -> bool {
    state
        .suppress_blur_until
        .lock()
        .map(|guard| guard.map(|until| Instant::now() < until).unwrap_or(false))
        .unwrap_or(false)
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

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
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

    // Margen para que el blur inicial al mostrar no la oculte de inmediato.
    suppress_blur(&app.state::<AppState>(), 300);

    let _ = window.unminimize();
    window.show()?;
    window.set_focus()?;
    window.emit("quick-focus", ())?;
    Ok(())
}

/// Oculta la ventana con una animacion: avisa al frontend para que haga el fade-out
/// y oculta la ventana nativa cuando la animacion termina.
fn animated_hide(app: &AppHandle) {
    let _ = app.emit("animate-hide", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(window) = inner.get_webview_window("main") {
                let _ = window.hide();
            }
        });
    });
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
        animated_hide(app);
    } else {
        show_main_window(app)?;
    }

    Ok(())
}

fn register_shortcut(app: &AppHandle) -> Result<String, String> {
    let manager = app.global_shortcut();
    let primary = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
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

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;

    let stored_tasks: Vec<Task> = match serde_json::from_str(&content) {
        Ok(tasks) => tasks,
        Err(parse_error) => {
            // Respalda el archivo danado para no perderlo.
            let corrupt = path.with_extension("corrupt.json");
            let _ = fs::copy(&path, &corrupt);

            // Intenta recuperar desde el ultimo respaldo bueno.
            let backup = path.with_extension("bak");
            if let Ok(backup_content) = fs::read_to_string(&backup) {
                if let Ok(tasks) = serde_json::from_str::<Vec<Task>>(&backup_content) {
                    log::warn!("tasks.json corrupto; recuperado desde tasks.bak");
                    let recovered = finalize_tasks(&path, tasks);
                    return Ok(recovered);
                }
            }

            // Sin respaldo valido: NO devolver vacio para que el frontend no pise el
            // archivo con un save vacio. Los datos quedan en tasks.corrupt.json.
            return Err(format!(
                "tasks.json corrupto y sin respaldo valido: {parse_error}"
            ));
        }
    };

    Ok(finalize_tasks(&path, stored_tasks))
}

#[tauri::command]
fn save_tasks(app: AppHandle, tasks: Vec<Task>) -> Result<(), String> {
    let path = tasks_path(&app)?;
    let tasks: Vec<Task> = tasks.into_iter().map(Task::ensure_metadata).collect();
    write_tasks(&path, &tasks)
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
fn hide_current_window(app: AppHandle) -> Result<(), String> {
    animated_hide(&app);
    Ok(())
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_window_resize(window: Window, direction: String) -> Result<(), String> {
    let resize_direction = match direction.as_str() {
        "north" => ResizeDirection::North,
        "south" => ResizeDirection::South,
        "east" => ResizeDirection::East,
        "west" => ResizeDirection::West,
        "north-east" => ResizeDirection::NorthEast,
        "north-west" => ResizeDirection::NorthWest,
        "south-east" => ResizeDirection::SouthEast,
        "south-west" => ResizeDirection::SouthWest,
        _ => return Err("Direccion de resize desconocida".to_string()),
    };

    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
    window
        .start_resize_dragging(resize_direction)
        .map_err(|error| error.to_string())
}

/// Construye y muestra el menu contextual NATIVO (NSMenu) para una tarea.
/// El popup debe ocurrir en el hilo principal en macOS.
fn popup_task_menu(
    app: &AppHandle,
    task_id: &str,
    is_completed: bool,
    is_important: bool,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let mut builder = MenuBuilder::new(app)
        .text(format!("task::edit::{task_id}"), "Editar tarea")
        .text(format!("task::copy::{task_id}"), "Copiar");

    if !is_completed {
        let label = if is_important {
            "Quitar importante"
        } else {
            "Marcar importante"
        };
        builder = builder.text(format!("task::important::{task_id}"), label);
    }

    let toggle_label = if is_completed {
        "Marcar incompleta"
    } else {
        "Marcar completada"
    };

    let menu = builder
        .text(format!("task::toggle::{task_id}"), toggle_label)
        .separator()
        .text(format!("task::delete::{task_id}"), "Eliminar tarea")
        .build()?;

    window.popup_menu(&menu)?;
    Ok(())
}

fn popup_completed_menu(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let menu = MenuBuilder::new(app)
        .text("section::restore-all", "Marcar todas incompletas")
        .separator()
        .text("section::delete-completed", "Eliminar completadas")
        .build()?;

    window.popup_menu(&menu)?;
    Ok(())
}

#[tauri::command]
fn show_task_context_menu(
    app: AppHandle,
    task_id: String,
    is_completed: bool,
    is_important: bool,
) -> Result<(), String> {
    suppress_blur(&app.state::<AppState>(), 700);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = popup_task_menu(&handle, &task_id, is_completed, is_important) {
            log::error!("Failed to show task context menu: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn show_completed_context_menu(app: AppHandle) -> Result<(), String> {
    suppress_blur(&app.state::<AppState>(), 700);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = popup_completed_menu(&handle) {
            log::error!("Failed to show completed context menu: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_hide_on_blur(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    *state.hide_on_blur.lock().map_err(|error| error.to_string())? = enabled;
    let mut settings = load_settings_inner(&app);
    settings.hide_on_blur = enabled;
    let _ = save_settings_inner(&app, &settings);
    Ok(())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(load_settings_inner(&app))
}

/// Suprime el auto-ocultado por `ms` (p. ej. mientras hay un dialogo nativo abierto).
#[tauri::command]
fn suppress_autohide(state: State<'_, AppState>, ms: u64) {
    suppress_blur(&state, ms);
}

#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<String, String> {
    let shortcut = shortcut_from_label(&label).ok_or_else(|| "Atajo desconocido".to_string())?;
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    manager.register(shortcut).map_err(|error| error.to_string())?;

    *state
        .active_shortcut
        .lock()
        .map_err(|error| error.to_string())? = label.clone();

    let mut settings = load_settings_inner(&app);
    settings.shortcut = label.clone();
    let _ = save_settings_inner(&app, &settings);

    Ok(label)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    let mut settings = load_settings_inner(&app);
    settings.autostart = enabled;
    let _ = save_settings_inner(&app, &settings);
    Ok(())
}

fn tasks_to_markdown(tasks: &[Task]) -> String {
    let mut out = String::from("# TODO\n\n");
    for task in tasks {
        let mark = if task.completed { "x" } else { " " };
        out.push_str(&format!("- [{mark}] {}\n", task.text));
        if !task.description.is_empty() {
            for line in task.description.lines() {
                out.push_str(&format!("  {line}\n"));
            }
        }
    }
    out
}

#[tauri::command]
fn export_tasks(app: AppHandle, path: String, format: String) -> Result<(), String> {
    let tasks = load_tasks(app.clone())?;
    let content = if format == "markdown" {
        tasks_to_markdown(&tasks)
    } else {
        serde_json::to_string_pretty(&tasks).map_err(|error| error.to_string())?
    };
    fs::write(&path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn import_tasks(app: AppHandle, path: String) -> Result<Vec<Task>, String> {
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let imported: Vec<Task> = serde_json::from_str(&content)
        .map_err(|_| "El archivo no tiene un formato de tareas valido".to_string())?;
    let tasks: Vec<Task> = imported.into_iter().map(Task::ensure_metadata).collect();
    let target = tasks_path(&app)?;
    write_tasks(&target, &tasks)?;
    Ok(tasks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_liquid_glass::init());

    builder
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_menu_event(|app, event| {
            // Enruta la seleccion del menu contextual nativo de vuelta al frontend.
            let id = event.id().as_ref();
            if let Some(rest) = id.strip_prefix("task::") {
                if let Some((action, task_id)) = rest.split_once("::") {
                    let _ = app.emit(
                        "task-menu-action",
                        serde_json::json!({ "action": action, "taskId": task_id }),
                    );
                }
            } else if let Some(action) = id.strip_prefix("section::") {
                let _ = app.emit(
                    "task-menu-action",
                    serde_json::json!({ "action": format!("section-{action}"), "taskId": null }),
                );
            }
        })
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

            let settings = load_settings_inner(app.handle());

            // Atajo: usa el guardado (preset) si registra; si no, el registro por defecto.
            let active = shortcut_from_label(&settings.shortcut)
                .and_then(|shortcut| {
                    app.handle()
                        .global_shortcut()
                        .register(shortcut)
                        .ok()
                        .map(|_| settings.shortcut.clone())
                })
                .unwrap_or_else(|| {
                    register_shortcut(app.handle())
                        .unwrap_or_else(|_| FALLBACK_SHORTCUT_LABEL.to_string())
                });

            let state = app.state::<AppState>();
            *state
                .active_shortcut
                .lock()
                .expect("shortcut state poisoned") = active;
            *state
                .hide_on_blur
                .lock()
                .expect("hide_on_blur state poisoned") = settings.hide_on_blur;

            if !cfg!(debug_assertions) {
                let manager = app.handle().autolaunch();
                if settings.autostart {
                    let _ = manager.enable();
                } else {
                    let _ = manager.disable();
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Moved(position) => {
                        let _ = save_window_position(&app_handle, position.x, position.y);
                    }
                    WindowEvent::Focused(false) => {
                        let state = app_handle.state::<AppState>();
                        let hide = state.hide_on_blur.lock().map(|g| *g).unwrap_or(true);
                        if hide && !blur_is_suppressed(&state) {
                            animated_hide(&app_handle);
                        }
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_tasks,
            save_tasks,
            active_shortcut,
            hide_current_window,
            start_window_drag,
            start_window_resize,
            show_task_context_menu,
            show_completed_context_menu,
            set_hide_on_blur,
            load_settings,
            suppress_autohide,
            set_shortcut,
            set_autostart,
            export_tasks,
            import_tasks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
