use crate::{
    locales::{self, Locale},
    services::notes::{default_store, AppConfig, AppError},
};
use serde::Deserialize;
use std::{
    error::Error,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder, Window, WindowEvent, Wry,
};
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const NOTEPAD_WINDOW_LABEL: &str = "notepad";
const TRAY_ID: &str = "notepad-tray";
const TRAY_SHOW_NOTEPAD_ID: &str = "show-notepad";
const TRAY_QUICK_NOTE_ID: &str = "quick-note";
const TRAY_TOGGLE_CLOSE_TO_TRAY_ID: &str = "toggle-close-to-tray";
const TRAY_TOGGLE_AUTOSTART_ID: &str = "toggle-autostart";
const TRAY_QUIT_ID: &str = "quit";

/// Stores the file path passed as a command-line argument on cold start.
/// The frontend retrieves and clears this value after initialization via
/// the `take_startup_file` command, avoiding a race condition with the
/// previous approach of emitting an event after a hardcoded delay.
static STARTUP_FILE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuAction {
    ShowNotepad,
    QuickNote,
    ToggleCloseToTray,
    ToggleAutostart,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrayMenuSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub checked: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutKey {
    Letter(char),
    Digit(u8),
    Function(u8),
    Punctuation(char),
    Space,
    Tab,
    Enter,
    Backspace,
    Delete,
    Escape,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    PageUp,
    PageDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeConfigChanges {
    pub autostart_changed: bool,
    pub global_shortcut_changed: bool,
    pub toggle_visibility_shortcut_changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortcutSpec {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    pub key: ShortcutKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DynamicWindowVisualOptions {
    pub transparent: bool,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutCheckResult {
    pub available: bool,
    pub conflict_type: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellCloseAction {
    AllowClose,
    HideToTray,
    ExitApp,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct WindowSizeSpec {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

struct WindowOpenOptions {
    url: String,
    title: String,
    specs: WindowSizeSpec,
    decorations: bool,
    always_on_top: bool,
    shadow: bool,
    skip_taskbar: bool,
    bounds: Option<WindowBounds>,
}

#[derive(Default)]
struct RuntimeState {
    is_exiting: AtomicBool,
    windows_hidden: AtomicBool,
    /// Armed when the notepad is closed via Esc; the next global-shortcut open
    /// then keeps the window's last position/size instead of resetting to the
    /// default bounds. One-shot: consumed on the next open.
    resume_bounds: AtomicBool,
    hidden_window_labels: Mutex<Vec<String>>,
    #[cfg(desktop)]
    shortcut_bindings: Mutex<ShortcutBindings>,
}

#[cfg(desktop)]
#[derive(Clone, Default)]
struct ShortcutBindings {
    open_notepad: Option<Shortcut>,
    toggle_visibility: Option<Shortcut>,
}

#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutAction {
    OpenNotepad,
    ToggleVisibility,
}

impl RuntimeState {
    fn allow_exit(&self) {
        self.is_exiting.store(true, Ordering::SeqCst);
    }

    fn is_exiting(&self) -> bool {
        self.is_exiting.load(Ordering::SeqCst)
    }

    fn set_resume_bounds(&self, resume: bool) {
        self.resume_bounds.store(resume, Ordering::SeqCst);
    }

    fn take_resume_bounds(&self) -> bool {
        self.resume_bounds.swap(false, Ordering::SeqCst)
    }

    fn clear_hidden_windows(&self) {
        if !self.windows_hidden.swap(false, Ordering::SeqCst) {
            return;
        }

        if let Ok(mut guard) = self.hidden_window_labels.lock() {
            guard.clear();
        }
    }

    fn take_hidden_window_labels(&self) -> Option<Vec<String>> {
        if !self.windows_hidden.swap(false, Ordering::SeqCst) {
            return None;
        }

        self.hidden_window_labels
            .lock()
            .map(|mut guard| guard.drain(..).collect())
            .ok()
    }

    fn hide_windows(&self, labels: Vec<String>) {
        if labels.is_empty() {
            self.clear_hidden_windows();
            return;
        }

        if let Ok(mut guard) = self.hidden_window_labels.lock() {
            *guard = labels;
            self.windows_hidden.store(true, Ordering::SeqCst);
        }
    }

    #[cfg(desktop)]
    fn set_shortcut_bindings(&self, bindings: ShortcutBindings) {
        if let Ok(mut guard) = self.shortcut_bindings.lock() {
            *guard = bindings;
        }
    }

    #[cfg(desktop)]
    fn shortcut_action(&self, shortcut: &Shortcut) -> ShortcutAction {
        self.shortcut_bindings
            .lock()
            .ok()
            .and_then(|bindings| bindings.action_for(shortcut))
            .unwrap_or(ShortcutAction::OpenNotepad)
    }
}

#[cfg(desktop)]
impl ShortcutBindings {
    fn action_for(&self, shortcut: &Shortcut) -> Option<ShortcutAction> {
        if self
            .toggle_visibility
            .as_ref()
            .is_some_and(|s| s == shortcut)
        {
            Some(ShortcutAction::ToggleVisibility)
        } else if self.open_notepad.as_ref().is_some_and(|s| s == shortcut) {
            Some(ShortcutAction::OpenNotepad)
        } else {
            None
        }
    }
}

pub fn tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        TRAY_SHOW_NOTEPAD_ID => Some(TrayMenuAction::ShowNotepad),
        TRAY_QUICK_NOTE_ID => Some(TrayMenuAction::QuickNote),
        TRAY_TOGGLE_CLOSE_TO_TRAY_ID => Some(TrayMenuAction::ToggleCloseToTray),
        TRAY_TOGGLE_AUTOSTART_ID => Some(TrayMenuAction::ToggleAutostart),
        TRAY_QUIT_ID => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

pub fn tray_menu_specs(locale: Locale, close_to_tray: bool, autostart: bool) -> Vec<TrayMenuSpec> {
    let _ = close_to_tray;
    vec![
        TrayMenuSpec {
            id: TRAY_QUICK_NOTE_ID,
            label: locales::tray_quick_note_label(locale),
            checked: None,
        },
        TrayMenuSpec {
            id: TRAY_TOGGLE_AUTOSTART_ID,
            label: locales::tray_toggle_autostart_label(locale),
            checked: Some(autostart),
        },
        TrayMenuSpec {
            id: TRAY_QUIT_ID,
            label: locales::tray_quit_label(locale),
            checked: None,
        },
    ]
}

fn locale_from_config(config: &AppConfig) -> Locale {
    Locale::from_tag(&config.locale)
}

fn configured_locale() -> Locale {
    load_config()
        .map(|config| locale_from_config(&config))
        .unwrap_or_default()
}

fn build_tray_menu(app: &AppHandle, config: &AppConfig) -> Result<Menu<Wry>, Box<dyn Error>> {
    let locale = locale_from_config(config);
    let autostart = autostart_enabled(app, config.autostart);
    let specs = tray_menu_specs(locale, config.close_to_tray, autostart);

    let quick_note = MenuItem::with_id(app, specs[0].id, specs[0].label, true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        specs[1].id,
        specs[1].label,
        true,
        specs[1].checked.unwrap_or(false),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, specs[2].id, specs[2].label, true, None::<&str>)?;

    Ok(Menu::with_items(
        app,
        &[&quick_note, &autostart, &separator, &quit],
    )?)
}

fn refresh_tray_menu(app: &AppHandle, config: &AppConfig) -> Result<(), Box<dyn Error>> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    let menu = build_tray_menu(app, config)?;
    tray.set_menu(Some(menu))?;
    tray.set_tooltip(Some(locales::tray_tooltip(locale_from_config(config))))?;
    Ok(())
}

fn refresh_window_titles(app: &AppHandle, config: &AppConfig) -> Result<(), AppError> {
    let locale = locale_from_config(config);

    for (label, window) in app.webview_windows() {
        if is_notepad_window_label(&label) {
            window.set_title(locales::notepad_window_title(locale))?;
        } else if label.starts_with("tile-") {
            window.set_title(locales::tile_window_title(locale))?;
        }
    }

    Ok(())
}

pub fn refresh_shell_state(app: &AppHandle, config: &AppConfig) -> Result<(), Box<dyn Error>> {
    refresh_window_titles(app, config)?;
    refresh_tray_menu(app, config)?;
    Ok(())
}

pub fn shortcut_from_config(value: &str) -> Option<ShortcutSpec> {
    let parts: Vec<_> = value
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect();

    if parts.len() < 2 {
        return None;
    }

    let (modifier_parts, key_part) = parts.split_at(parts.len() - 1);

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;

    for m in modifier_parts {
        match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "cmdorctrl" | "commandorcontrol" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "meta" | "cmd" | "command" | "super" => meta = true,
            _ => return None,
        }
    }

    if !ctrl && !alt && !meta {
        return None;
    }

    let key = parse_shortcut_key(key_part[0])?;

    Some(ShortcutSpec {
        ctrl,
        alt,
        shift,
        meta,
        key,
    })
}

fn parse_shortcut_key(key: &str) -> Option<ShortcutKey> {
    if key.len() == 1 {
        let c = key.chars().next()?;
        if c.is_ascii_alphabetic() {
            return Some(ShortcutKey::Letter(c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(ShortcutKey::Digit(c.to_digit(10)? as u8));
        }
        if c.is_ascii_punctuation() {
            return Some(ShortcutKey::Punctuation(c));
        }
    }

    if let Some(rest) = key.strip_prefix('F').or_else(|| key.strip_prefix('f')) {
        if let Ok(num) = rest.parse::<u8>() {
            if (1..=12).contains(&num) {
                return Some(ShortcutKey::Function(num));
            }
        }
    }

    match key.to_ascii_lowercase().as_str() {
        "space" => Some(ShortcutKey::Space),
        "tab" => Some(ShortcutKey::Tab),
        "enter" => Some(ShortcutKey::Enter),
        "backspace" => Some(ShortcutKey::Backspace),
        "delete" => Some(ShortcutKey::Delete),
        "escape" => Some(ShortcutKey::Escape),
        "arrowup" => Some(ShortcutKey::ArrowUp),
        "arrowdown" => Some(ShortcutKey::ArrowDown),
        "arrowleft" => Some(ShortcutKey::ArrowLeft),
        "arrowright" => Some(ShortcutKey::ArrowRight),
        "home" => Some(ShortcutKey::Home),
        "end" => Some(ShortcutKey::End),
        "pageup" => Some(ShortcutKey::PageUp),
        "pagedown" => Some(ShortcutKey::PageDown),
        _ => None,
    }
}

pub fn runtime_config_changes(previous: &AppConfig, next: &AppConfig) -> RuntimeConfigChanges {
    RuntimeConfigChanges {
        autostart_changed: previous.autostart != next.autostart,
        global_shortcut_changed: previous.global_shortcut != next.global_shortcut,
        toggle_visibility_shortcut_changed: previous.toggle_visibility_shortcut
            != next.toggle_visibility_shortcut,
    }
}

fn clear_hidden_window_state(app: &AppHandle) {
    let labels = app
        .try_state::<RuntimeState>()
        .and_then(|state| state.take_hidden_window_labels());

    let Some(labels) = labels else {
        return;
    };

    for label in &labels {
        if is_notepad_window_label(&label) || label.starts_with("tile-") {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
    }
}

fn toggle_app_visibility(app: &AppHandle) {
    let Some(state) = app.try_state::<RuntimeState>() else {
        return;
    };

    if let Some(labels) = state.take_hidden_window_labels() {
        let mut focus_target = None;
        for label in &labels {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.unminimize();
                let _ = window.show();
                if focus_target.is_none() || label == NOTEPAD_WINDOW_LABEL {
                    focus_target = Some(label.clone());
                }
            }
        }

        if let Some(label) = focus_target {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.set_focus();
            }
        }
        return;
    }

    let mut labels = Vec::new();
    for (label, window) in app.webview_windows() {
        if window.is_visible().unwrap_or(false) {
            labels.push(label.clone());
            let _ = window.hide();
        }
    }
    state.hide_windows(labels);
}

pub fn apply_runtime_config(
    app: &AppHandle,
    previous: &AppConfig,
    next: &AppConfig,
) -> Result<(), Box<dyn Error>> {
    let changes = runtime_config_changes(previous, next);

    if changes.global_shortcut_changed || changes.toggle_visibility_shortcut_changed {
        apply_global_shortcut_config(app, next)?;
    }

    if changes.autostart_changed {
        apply_autostart(app, next.autostart)?;
    }

    Ok(())
}

pub async fn open_notepad_window(
    app: AppHandle,
    note_id: Option<String>,
    bounds: Option<WindowBounds>,
) -> Result<String, AppError> {
    open_notepad_window_now(&app, note_id.as_deref(), bounds, true)
}

pub async fn open_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<WindowBounds>,
) -> Result<String, AppError> {
    open_tile_window_now(&app, &note_id, bounds)
}

pub async fn toggle_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<WindowBounds>,
) -> Result<bool, AppError> {
    toggle_tile_window_now(&app, &note_id, bounds)
}

pub fn extract_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .find(|arg| {
            let lower = arg.to_lowercase();
            lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
        })
        .cloned()
}

/// Takes the startup file path stored during cold start, consuming it so
/// subsequent calls return `None`. Called by the frontend after it finishes
/// initializing to deterministically load the file without any timing risk.
pub fn take_startup_file() -> Option<String> {
    STARTUP_FILE.lock().ok()?.take()
}

pub fn setup_desktop(app: &mut App) -> Result<(), Box<dyn Error>> {
    app.manage(RuntimeState::default());
    setup_autostart_plugin(app.handle())?;
    setup_global_shortcut_plugin(app.handle())?;
    sync_autostart_to_config(app.handle());
    register_configured_global_shortcut(app.handle());
    setup_tray(app)?;

    if !std::env::args().any(|a| a == "--silent") {
        if let Err(error) = show_notepad_window(app.handle()) {
            eprintln!("failed to show main window on startup: {error}");
        }
    }

    let args: Vec<String> = std::env::args().collect();
    if let Some(file_path) = extract_file_arg(&args) {
        if let Ok(mut guard) = STARTUP_FILE.lock() {
            *guard = Some(file_path);
        }
    }

    Ok(())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        if let Some(note_id) = window.label().strip_prefix("tile-") {
            let _ = window
                .app_handle()
                .emit("tile-window-closed", note_id.to_string());
        }
        return;
    }

    if window.label() != NOTEPAD_WINDOW_LABEL {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    match shell_close_action(app_is_exiting(window.app_handle()), close_to_tray_enabled()) {
        ShellCloseAction::AllowClose => {}
        ShellCloseAction::HideToTray => {
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("failed to hide main window to tray: {error}");
            }
        }
        ShellCloseAction::ExitApp => {
            api.prevent_close();
            mark_app_exiting(window.app_handle());
            window.app_handle().exit(0);
        }
    }
}

fn shell_close_action(app_is_exiting: bool, close_to_tray: bool) -> ShellCloseAction {
    if app_is_exiting {
        ShellCloseAction::AllowClose
    } else if close_to_tray {
        ShellCloseAction::HideToTray
    } else {
        ShellCloseAction::ExitApp
    }
}

fn setup_tray(app: &mut App) -> Result<(), Box<dyn Error>> {
    let config = load_config()?;
    let menu = build_tray_menu(app.handle(), &config)?;
    let locale = locale_from_config(&config);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .expect("missing default window icon")
                .clone(),
        )
        .tooltip(locales::tray_tooltip(locale))
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| {
            if let Err(error) = handle_tray_menu_event(app, event.id.as_ref()) {
                eprintln!("failed to handle tray menu event {:?}: {error}", event.id);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = open_notepad_window_now(tray.app_handle(), None, None, true) {
                    eprintln!("failed to show notepad from tray: {error}");
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn handle_tray_menu_event(app: &AppHandle, id: &str) -> Result<(), Box<dyn Error>> {
    match tray_menu_action(id) {
        Some(TrayMenuAction::ShowNotepad) => show_notepad_window(app)?,
        Some(TrayMenuAction::QuickNote) => {
            open_notepad_window_now(app, None, None, true)?;
        }
        Some(TrayMenuAction::ToggleCloseToTray) => {
            let config = toggle_close_to_tray(app)?;
            if let Err(error) = refresh_shell_state(app, &config) {
                eprintln!("failed to refresh desktop shell state after tray toggle: {error}");
            }
            let _ = app.emit("config-changed", &config);
        }
        Some(TrayMenuAction::ToggleAutostart) => {
            let config = toggle_autostart(app)?;
            if let Err(error) = refresh_shell_state(app, &config) {
                eprintln!("failed to refresh desktop shell state after tray toggle: {error}");
            }
            let _ = app.emit("config-changed", &config);
        }
        Some(TrayMenuAction::Quit) => {
            mark_app_exiting(app);
            app.exit(0);
        }
        None => {}
    }

    Ok(())
}

fn toggle_close_to_tray(_app: &AppHandle) -> Result<AppConfig, Box<dyn Error>> {
    let store = default_store()?;
    let mut config = store.load_config()?;
    config.close_to_tray = !config.close_to_tray;
    store.save_config(config.clone())?;
    Ok(config)
}

pub fn show_notepad_window(app: &AppHandle) -> Result<(), AppError> {
    open_notepad_window_now(app, None, None, true)?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotepadActivatePayload {
    label: String,
    /// When true the frontend always resets to a blank draft (tray / quick note /
    /// startup). When false the frontend may resume the last interface if it was
    /// closed via Esc (global shortcut path only).
    fresh: bool,
}

fn open_notepad_window_now(
    app: &AppHandle,
    note_id: Option<&str>,
    bounds: Option<WindowBounds>,
    force_fresh: bool,
) -> Result<String, AppError> {
    // Consume the Esc-close flag on every open; only honor it for the global
    // shortcut path (force_fresh == false), so tray / quick note / restart still
    // get the default bounds.
    let resume_armed = app
        .try_state::<RuntimeState>()
        .map(|state| state.take_resume_bounds())
        .unwrap_or(false);
    let keep_bounds = resume_armed && !force_fresh;
    let effective_bounds = if keep_bounds {
        None
    } else {
        bounds.or_else(fixed_notepad_bounds)
    };
    if let Some(reused) =
        activate_existing_notepad(app, note_id, effective_bounds, force_fresh, keep_bounds)?
    {
        clear_hidden_window_state(app);
        return Ok(reused);
    }

    let locale = configured_locale();
    let label = notepad_window_label();
    let specs = notepad_window_specs();
    let url = match note_id {
        Some(id) => format!("index.html?view=notepad&noteId={id}"),
        None => "index.html?view=notepad".to_string(),
    };

    open_or_focus_window(
        app,
        &label,
        WindowOpenOptions {
            url,
            title: locales::notepad_window_title(locale).to_string(),
            specs,
            decorations: false,
            always_on_top: true,
            shadow: false,
            skip_taskbar: true,
            bounds: effective_bounds,
        },
    )
}

fn activate_existing_notepad(
    app: &AppHandle,
    note_id: Option<&str>,
    bounds: Option<WindowBounds>,
    force_fresh: bool,
    keep_bounds: bool,
) -> Result<Option<String>, AppError> {
    let label = notepad_window_label();
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(None);
    };

    let locale = configured_locale();
    let was_visible = window.is_visible().unwrap_or(false);

    window.set_title(locales::notepad_window_title(locale))?;
    // When resuming an Esc-closed note, leave the window's preserved geometry
    // untouched so its last position/size are restored.
    if !keep_bounds {
        if !was_visible && bounds.is_none() {
            let specs = notepad_window_specs();
            window.set_size(tauri::LogicalSize::new(specs.width, specs.height))?;
        }
        apply_window_bounds(&window, bounds)?;
    }
    window.show()?;
    window.set_focus()?;

    if let Some(note_id) = note_id {
        let _ = window.emit("notepad:open-note", note_id.to_string());
    } else if !was_visible {
        let _ = window.emit(
            "notepad:activate",
            NotepadActivatePayload {
                label: label.clone(),
                fresh: force_fresh,
            },
        );
    }

    Ok(Some(label))
}

pub fn recycle_notepad_window(app: &AppHandle, label: &str, resume: bool) -> Result<(), AppError> {
    // Esc close arms resume so the next global-shortcut open keeps this geometry;
    // × close passes false so the next open resets to the default bounds.
    if let Some(state) = app.try_state::<RuntimeState>() {
        state.set_resume_bounds(resume);
    }

    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };

    window.hide()?;

    Ok(())
}

fn notepad_window_specs() -> WindowSizeSpec {
    WindowSizeSpec {
        width: 350.0,
        height: 300.0,
        min_width: 320.0,
        min_height: 180.0,
    }
}

#[cfg(target_os = "windows")]
#[allow(clippy::upper_case_acronyms)]
fn fixed_notepad_bounds() -> Option<WindowBounds> {
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        dw_flags: u32,
    }
    type HMONITOR = isize;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    extern "system" {
        fn MonitorFromPoint(pt: POINT, dw_flags: u32) -> HMONITOR;
        fn GetMonitorInfoW(h_monitor: HMONITOR, lpmi: *mut MONITORINFO) -> i32;
        fn GetDpiForSystem() -> u32;
    }
    let specs = notepad_window_specs();
    let scale = unsafe { GetDpiForSystem() } as f64 / 96.0;
    let w = (specs.width * scale) as i32;
    let h = (specs.height * scale) as i32;
    let mut x = 24;
    let mut y = 24;

    let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTONEAREST) };
    if hmon != 0 {
        let mut mi = MONITORINFO {
            cb_size: std::mem::size_of::<MONITORINFO>() as u32,
            rc_monitor: RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            rc_work: RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            dw_flags: 0,
        };
        if unsafe { GetMonitorInfoW(hmon, &mut mi) } != 0 {
            let work = &mi.rc_work;
            x = work.right - w - 24;
            y = work.top + 24;
        }
    }

    Some(WindowBounds {
        x,
        y,
        width: w as u32,
        height: h as u32,
    })
}

#[cfg(not(target_os = "windows"))]
fn fixed_notepad_bounds() -> Option<WindowBounds> {
    let specs = notepad_window_specs();
    Some(WindowBounds {
        x: 24,
        y: 24,
        width: specs.width.round() as u32,
        height: specs.height.round() as u32,
    })
}

fn visible_tile_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find(|(label, window)| label.starts_with("tile-") && window.is_visible().unwrap_or(false))
        .map(|(_, window)| window)
}

fn visible_notepad_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find(|(label, window)| {
            is_notepad_window_label(label) && window.is_visible().unwrap_or(false)
        })
        .map(|(_, window)| window)
}

fn open_tile_window_now(
    app: &AppHandle,
    note_id: &str,
    bounds: Option<WindowBounds>,
) -> Result<String, AppError> {
    let locale = configured_locale();
    let label = tile_window_label(note_id);
    let url = format!("index.html?view=tile&noteId={note_id}");

    let specs = notepad_window_specs();

    open_or_focus_window(
        app,
        &label,
        WindowOpenOptions {
            url,
            title: locales::tile_window_title(locale).to_string(),
            specs,
            decorations: false,
            always_on_top: true,
            shadow: false,
            skip_taskbar: true,
            bounds,
        },
    )
}

fn toggle_tile_window_now(
    app: &AppHandle,
    note_id: &str,
    bounds: Option<WindowBounds>,
) -> Result<bool, AppError> {
    let label = tile_window_label(note_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.close()?;
        return Ok(false);
    }

    open_tile_window_now(app, note_id, bounds)?;
    Ok(true)
}

fn open_or_focus_window(
    app: &AppHandle,
    label: &str,
    opts: WindowOpenOptions,
) -> Result<String, AppError> {
    clear_hidden_window_state(app);

    let visual_options = dynamic_window_visual_options(label);

    if let Some(window) = app.get_webview_window(label) {
        window.set_title(&opts.title)?;
        apply_window_bounds(&window, opts.bounds)?;
        window.set_shadow(opts.shadow)?;
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(label.to_string());
    }

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(opts.url.into()))
        .title(opts.title)
        .inner_size(opts.specs.width, opts.specs.height)
        .min_inner_size(opts.specs.min_width, opts.specs.min_height)
        .resizable(true)
        .decorations(opts.decorations)
        .transparent(visual_options.transparent)
        .always_on_top(opts.always_on_top)
        .shadow(opts.shadow)
        .skip_taskbar(opts.skip_taskbar)
        .visible(false)
        .build()?;

    apply_window_bounds(&window, opts.bounds)?;

    Ok(label.to_string())
}

fn apply_window_bounds(
    window: &tauri::WebviewWindow,
    bounds: Option<WindowBounds>,
) -> Result<(), AppError> {
    if let Some(bounds) = bounds {
        window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
        window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
    }

    Ok(())
}

fn notepad_window_label() -> String {
    NOTEPAD_WINDOW_LABEL.to_string()
}

fn is_notepad_window_label(label: &str) -> bool {
    label == NOTEPAD_WINDOW_LABEL || label.starts_with("notepad-")
}

fn tile_window_label(note_id: &str) -> String {
    format!("tile-{}", sanitize_label_part(note_id))
}

fn dynamic_window_visual_options(label: &str) -> DynamicWindowVisualOptions {
    let _ = label;

    // Transparent so the CSS rounded surface gets anti-aliased corners (the area
    // outside --app-window-radius is see-through). Pairs with shadow disabled.
    DynamicWindowVisualOptions { transparent: true }
}

fn sanitize_label_part(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();

    sanitized.trim_matches('-').to_string()
}

fn load_config() -> Result<AppConfig, AppError> {
    default_store()?.load_config()
}

fn close_to_tray_enabled() -> bool {
    true
}

fn app_is_exiting(app: &AppHandle) -> bool {
    app.try_state::<RuntimeState>()
        .map(|state| state.is_exiting())
        .unwrap_or(false)
}

fn mark_app_exiting(app: &AppHandle) {
    if let Some(state) = app.try_state::<RuntimeState>() {
        state.allow_exit();
    }
}

#[cfg(desktop)]
fn setup_autostart_plugin(app: &AppHandle) -> tauri::Result<()> {
    app.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec!["--silent"]),
    ))
}

#[cfg(not(desktop))]
fn setup_autostart_plugin(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
fn setup_global_shortcut_plugin(app: &AppHandle) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }

                let action = app
                    .try_state::<RuntimeState>()
                    .map(|state| state.shortcut_action(shortcut))
                    .unwrap_or(ShortcutAction::OpenNotepad);

                let app_for_closure = app.clone();
                match action {
                    ShortcutAction::ToggleVisibility => {
                        if let Err(error) = app.run_on_main_thread(move || {
                            toggle_app_visibility(&app_for_closure);
                        }) {
                            eprintln!("failed to dispatch visibility toggle action: {error}");
                        }
                    }
                    ShortcutAction::OpenNotepad => {
                        if let Some(tile) = visible_tile_window(&app_for_closure) {
                            let _ = tile.emit("surface-action", "switchToPad");
                            return;
                        }
                        if let Some(notepad) = visible_notepad_window(&app_for_closure) {
                            let _ = notepad.emit("surface-action", "switchToPad");
                            return;
                        }
                        let bounds = fixed_notepad_bounds();
                        if let Err(error) = app.run_on_main_thread(move || {
                            if let Err(error) =
                                open_notepad_window_now(&app_for_closure, None, bounds, false)
                            {
                                eprintln!("failed to open notepad from global shortcut: {error}");
                            }
                        }) {
                            eprintln!("failed to dispatch global shortcut action: {error}");
                        }
                    }
                }
            })
            .build(),
    )
}

#[cfg(not(desktop))]
fn setup_global_shortcut_plugin(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
fn register_configured_global_shortcut(app: &AppHandle) {
    let Ok(config) = load_config() else {
        return;
    };

    if let Err(error) = install_global_shortcut_bindings(app, &config, false) {
        let msg = format!("蹇嵎閿敞鍐屽け璐ワ細{error}");
        eprintln!("{msg}");
        let _ = app.emit("shortcut-register-failed", &msg);
    }
}

pub fn check_global_shortcut(
    app: &AppHandle,
    shortcut_config: &str,
) -> Result<ShortcutCheckResult, AppError> {
    let Some(shortcut) = shortcut_from_config(shortcut_config).and_then(to_tauri_shortcut) else {
        return Ok(shortcut_check_result(
            false,
            "invalid",
            format!("蹇嵎閿?{shortcut_config} 涓嶅彈鏀寔"),
        ));
    };

    if let Some(conflict) = system_shortcut_conflict(shortcut_config) {
        return Ok(conflict);
    }

    if app.global_shortcut().is_registered(shortcut) {
        return Ok(shortcut_check_result(
            true,
            "current",
            format!("蹇嵎閿?{shortcut_config} 褰撳墠姝ｅ湪浣跨敤"),
        ));
    }

    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            if let Err(error) = app.global_shortcut().unregister(shortcut) {
                return Ok(shortcut_check_result(
                    false,
                    "unknown",
                    format!(
                        "shortcut check completed, but temporary shortcut release failed: {error}"
                    ),
                ));
            }

            Ok(shortcut_check_result(
                true,
                "none",
                format!("蹇嵎閿?{shortcut_config} 鏈娴嬪埌鍐茬獊"),
            ))
        }
        Err(error) => Ok(shortcut_check_result(
            false,
            "registered",
            format!(
                "shortcut {shortcut_config} registration failed, possibly already in use: {error}"
            ),
        )),
    }
}

fn shortcut_check_result(
    available: bool,
    conflict_type: impl Into<String>,
    message: impl Into<String>,
) -> ShortcutCheckResult {
    ShortcutCheckResult {
        available,
        conflict_type: conflict_type.into(),
        message: message.into(),
    }
}

#[cfg(target_os = "macos")]
fn system_shortcut_conflict(shortcut_config: &str) -> Option<ShortcutCheckResult> {
    let spec = shortcut_from_config(shortcut_config)?;
    let message = if shortcut_matches(&spec, false, false, false, true, ShortcutKey::Space) {
        Some("涓?macOS 绯荤粺蹇嵎閿?Spotlight 鍐茬獊")
    } else if shortcut_matches(&spec, false, true, false, true, ShortcutKey::Space) {
        Some("涓?macOS 绯荤粺蹇嵎閿?Finder 鎼滅储绐楀彛鍐茬獊")
    } else if shortcut_matches(&spec, true, false, false, false, ShortcutKey::Space)
        || shortcut_matches(&spec, true, true, false, false, ShortcutKey::Space)
    {
        Some("涓?macOS 杈撳叆娉曞垏鎹㈠揩鎹烽敭鍐茬獊")
    } else if shortcut_matches(&spec, false, true, false, false, ShortcutKey::Space) {
        Some("Option+Space 瀹规槗涓庤緭鍏ユ硶鎴栫郴缁熸湇鍔″揩鎹烽敭鍐茬獊")
    } else {
        None
    }?;

    Some(shortcut_check_result(false, "system", message))
}

#[cfg(not(target_os = "macos"))]
fn system_shortcut_conflict(_shortcut_config: &str) -> Option<ShortcutCheckResult> {
    None
}

#[cfg(target_os = "macos")]
fn shortcut_matches(
    spec: &ShortcutSpec,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    key: ShortcutKey,
) -> bool {
    spec.ctrl == ctrl
        && spec.alt == alt
        && spec.shift == shift
        && spec.meta == meta
        && spec.key == key
}

#[cfg(not(desktop))]
fn register_configured_global_shortcut(_app: &AppHandle) {}

#[cfg(desktop)]
fn parse_configured_shortcut(field: &str, value: &str) -> Result<Shortcut, Box<dyn Error>> {
    if let Some(conflict) = system_shortcut_conflict(value) {
        return Err(Box::new(AppError {
            code: "shortcutConflict".into(),
            message: conflict.message,
            details: [
                ("field".to_string(), field.to_string()),
                ("shortcut".to_string(), value.to_string()),
            ]
            .into_iter()
            .collect(),
        }));
    }

    shortcut_from_config(value)
        .and_then(to_tauri_shortcut)
        .ok_or_else(|| {
            Box::new(AppError {
                code: "unsupportedShortcut".into(),
                message: format!("unsupported {field} shortcut config: {value}"),
                details: [("field".to_string(), field.to_string())]
                    .into_iter()
                    .collect(),
            }) as Box<dyn Error>
        })
}

#[cfg(desktop)]
fn shortcut_bindings_from_config(config: &AppConfig) -> Result<ShortcutBindings, Box<dyn Error>> {
    let open_notepad = parse_configured_shortcut("globalShortcut", &config.global_shortcut)?;

    Ok(ShortcutBindings {
        open_notepad: Some(open_notepad),
        toggle_visibility: None,
    })
}

#[cfg(desktop)]
fn install_global_shortcut_bindings(
    app: &AppHandle,
    config: &AppConfig,
    replace_existing: bool,
) -> Result<(), Box<dyn Error>> {
    let bindings = shortcut_bindings_from_config(config)?;

    if replace_existing {
        app.global_shortcut().unregister_all()?;
    }

    if let Some(shortcut) = &bindings.open_notepad {
        app.global_shortcut().register(*shortcut)?;
    }
    if let Some(shortcut) = &bindings.toggle_visibility {
        app.global_shortcut().register(*shortcut)?;
    }

    if let Some(state) = app.try_state::<RuntimeState>() {
        state.set_shortcut_bindings(bindings);
    }

    Ok(())
}

#[cfg(desktop)]
fn apply_global_shortcut_config(app: &AppHandle, config: &AppConfig) -> Result<(), Box<dyn Error>> {
    install_global_shortcut_bindings(app, config, true)
}

#[cfg(not(desktop))]
fn apply_global_shortcut_config(
    _app: &AppHandle,
    _config: &AppConfig,
) -> Result<(), Box<dyn Error>> {
    Ok(())
}

#[cfg(desktop)]
fn to_tauri_shortcut(spec: ShortcutSpec) -> Option<Shortcut> {
    let mut modifiers = Modifiers::empty();
    if spec.ctrl {
        modifiers |= Modifiers::CONTROL;
    }
    if spec.alt {
        modifiers |= Modifiers::ALT;
    }
    if spec.shift {
        modifiers |= Modifiers::SHIFT;
    }
    if spec.meta {
        modifiers |= Modifiers::META;
    }

    let code = shortcut_key_to_code(spec.key)?;
    let mod_opt = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };
    Some(Shortcut::new(mod_opt, code))
}

#[cfg(desktop)]
fn shortcut_key_to_code(key: ShortcutKey) -> Option<Code> {
    Some(match key {
        ShortcutKey::Letter(c) => match c {
            'A' => Code::KeyA,
            'B' => Code::KeyB,
            'C' => Code::KeyC,
            'D' => Code::KeyD,
            'E' => Code::KeyE,
            'F' => Code::KeyF,
            'G' => Code::KeyG,
            'H' => Code::KeyH,
            'I' => Code::KeyI,
            'J' => Code::KeyJ,
            'K' => Code::KeyK,
            'L' => Code::KeyL,
            'M' => Code::KeyM,
            'N' => Code::KeyN,
            'O' => Code::KeyO,
            'P' => Code::KeyP,
            'Q' => Code::KeyQ,
            'R' => Code::KeyR,
            'S' => Code::KeyS,
            'T' => Code::KeyT,
            'U' => Code::KeyU,
            'V' => Code::KeyV,
            'W' => Code::KeyW,
            'X' => Code::KeyX,
            'Y' => Code::KeyY,
            'Z' => Code::KeyZ,
            _ => return None,
        },
        ShortcutKey::Digit(d) => match d {
            0 => Code::Digit0,
            1 => Code::Digit1,
            2 => Code::Digit2,
            3 => Code::Digit3,
            4 => Code::Digit4,
            5 => Code::Digit5,
            6 => Code::Digit6,
            7 => Code::Digit7,
            8 => Code::Digit8,
            9 => Code::Digit9,
            _ => return None,
        },
        ShortcutKey::Function(n) => match n {
            1 => Code::F1,
            2 => Code::F2,
            3 => Code::F3,
            4 => Code::F4,
            5 => Code::F5,
            6 => Code::F6,
            7 => Code::F7,
            8 => Code::F8,
            9 => Code::F9,
            10 => Code::F10,
            11 => Code::F11,
            12 => Code::F12,
            _ => return None,
        },
        ShortcutKey::Punctuation(c) => match c {
            '[' => Code::BracketLeft,
            ']' => Code::BracketRight,
            ';' => Code::Semicolon,
            '\'' => Code::Quote,
            '`' => Code::Backquote,
            ',' => Code::Comma,
            '.' => Code::Period,
            '/' => Code::Slash,
            '\\' => Code::Backslash,
            '-' => Code::Minus,
            '=' => Code::Equal,
            _ => return None,
        },
        ShortcutKey::Space => Code::Space,
        ShortcutKey::Tab => Code::Tab,
        ShortcutKey::Enter => Code::Enter,
        ShortcutKey::Backspace => Code::Backspace,
        ShortcutKey::Delete => Code::Delete,
        ShortcutKey::Escape => Code::Escape,
        ShortcutKey::ArrowUp => Code::ArrowUp,
        ShortcutKey::ArrowDown => Code::ArrowDown,
        ShortcutKey::ArrowLeft => Code::ArrowLeft,
        ShortcutKey::ArrowRight => Code::ArrowRight,
        ShortcutKey::Home => Code::Home,
        ShortcutKey::End => Code::End,
        ShortcutKey::PageUp => Code::PageUp,
        ShortcutKey::PageDown => Code::PageDown,
    })
}

#[cfg(desktop)]
fn sync_autostart_to_config(app: &AppHandle) {
    let Ok(config) = load_config() else {
        return;
    };

    if !config.autostart && !autostart_enabled(app, false) {
        return;
    }

    if let Err(error) = apply_autostart(app, config.autostart) {
        eprintln!("failed to sync autostart config: {error}");
    }
}

#[cfg(not(desktop))]
fn sync_autostart_to_config(_app: &AppHandle) {}

#[cfg(desktop)]
fn autostart_enabled(app: &AppHandle, fallback: bool) -> bool {
    app.autolaunch().is_enabled().unwrap_or(fallback)
}

#[cfg(not(desktop))]
fn autostart_enabled(_app: &AppHandle, fallback: bool) -> bool {
    fallback
}

fn toggle_autostart(app: &AppHandle) -> Result<AppConfig, Box<dyn Error>> {
    let store = default_store()?;
    let mut config = store.load_config()?;
    let next_enabled = !config.autostart;
    apply_autostart(app, next_enabled)?;
    config.autostart = next_enabled;
    store.save_config(config.clone())?;
    Ok(config)
}

#[cfg(desktop)]
fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), Box<dyn Error>> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()?;
    } else if manager.is_enabled().unwrap_or(false) {
        manager.disable()?;
    }
    Ok(())
}

#[cfg(not(desktop))]
fn apply_autostart(_app: &AppHandle, _enabled: bool) -> Result<(), Box<dyn Error>> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_tray_menu_ids_to_actions() {
        assert_eq!(
            tray_menu_action("show-notepad"),
            Some(TrayMenuAction::ShowNotepad)
        );
        assert_eq!(
            tray_menu_action("quick-note"),
            Some(TrayMenuAction::QuickNote)
        );
        assert_eq!(
            tray_menu_action("toggle-close-to-tray"),
            Some(TrayMenuAction::ToggleCloseToTray)
        );
        assert_eq!(
            tray_menu_action("toggle-autostart"),
            Some(TrayMenuAction::ToggleAutostart)
        );
        assert_eq!(tray_menu_action("quit"), Some(TrayMenuAction::Quit));
        assert_eq!(tray_menu_action("unknown"), None);
    }

    #[test]
    fn builds_tray_menu_specs_with_configured_checked_state() {
        let specs = tray_menu_specs(Locale::ZhCn, true, false);
        let ids: Vec<_> = specs.iter().map(|spec| spec.id).collect();

        assert_eq!(ids, vec!["quick-note", "toggle-autostart", "quit"]);
        assert_eq!(specs[1].checked, Some(false));
    }

    #[test]
    fn parses_shortcut_config_values() {
        assert_eq!(
            shortcut_from_config("Ctrl+Space"),
            Some(ShortcutSpec {
                ctrl: true,
                alt: false,
                shift: false,
                meta: false,
                key: ShortcutKey::Space,
            })
        );
        assert_eq!(
            shortcut_from_config("CommandOrControl + Space"),
            Some(ShortcutSpec {
                ctrl: true,
                alt: false,
                shift: false,
                meta: false,
                key: ShortcutKey::Space,
            })
        );
        assert_eq!(
            shortcut_from_config("Alt+Space"),
            Some(ShortcutSpec {
                ctrl: false,
                alt: true,
                shift: false,
                meta: false,
                key: ShortcutKey::Space,
            })
        );
        assert_eq!(
            shortcut_from_config("Ctrl+Shift+K"),
            Some(ShortcutSpec {
                ctrl: true,
                alt: false,
                shift: true,
                meta: false,
                key: ShortcutKey::Letter('K'),
            })
        );
        assert_eq!(
            shortcut_from_config("Alt+F2"),
            Some(ShortcutSpec {
                ctrl: false,
                alt: true,
                shift: false,
                meta: false,
                key: ShortcutKey::Function(2),
            })
        );
        assert_eq!(
            shortcut_from_config("Ctrl+Alt+3"),
            Some(ShortcutSpec {
                ctrl: true,
                alt: true,
                shift: false,
                meta: false,
                key: ShortcutKey::Digit(3),
            })
        );
        assert_eq!(
            shortcut_from_config("Command+K"),
            Some(ShortcutSpec {
                ctrl: false,
                alt: false,
                shift: false,
                meta: true,
                key: ShortcutKey::Letter('K'),
            })
        );
        assert_eq!(
            shortcut_from_config("Meta+Shift+P"),
            Some(ShortcutSpec {
                ctrl: false,
                alt: false,
                shift: true,
                meta: true,
                key: ShortcutKey::Letter('P'),
            })
        );
    }

    #[test]
    fn rejects_invalid_shortcut_config_values() {
        assert_eq!(shortcut_from_config(""), None);
        assert_eq!(shortcut_from_config("Space"), None);
        assert_eq!(shortcut_from_config("Shift+K"), None);
        assert_eq!(shortcut_from_config("Ctrl+Unknown"), None);
    }

    #[cfg(desktop)]
    #[test]
    fn ignores_visibility_shortcut_bindings() {
        let config = AppConfig {
            locale: "zh-CN".into(),
            notes_dir: "D:\\notes".into(),
            global_shortcut: "Ctrl+Shift+K".into(),
            close_to_tray: true,
            autostart: false,
            default_view_mode: "split".into(),
            note_auto_save: true,
            note_surface_auto_save: true,
            tile_color: "#f6f3ec".into(),
            tile_color_mode: "system".into(),
            theme: "light".into(),
            font_size: 14,
            surface_font_size: 14,
            surface_zoom: 1.0,
            tab_indent_size: 2,
            external_file_auto_save: true,
            background_image_path: String::new(),
            background_fit: "cover".into(),
            background_dim: 0.25,
            background_blur: 0.0,
            background_scale: 1.0,
            background_position_x: 50.0,
            background_position_y: 50.0,
            remember_surface_size: true,
            tile_ctrl_close: true,
            tile_render_markdown: false,
            render_html_markdown: false,
            open_at_cursor: true,
            surface_width: None,
            surface_height: None,
            surface_x: None,
            surface_y: None,
            toggle_visibility_shortcut: "Ctrl+Shift+K".into(),
        };

        let bindings = shortcut_bindings_from_config(&config).expect("shortcut bindings");

        assert!(bindings.open_notepad.is_some());
        assert!(bindings.toggle_visibility.is_none());
    }

    #[test]
    fn chooses_exit_when_notepad_closes_without_close_to_tray() {
        assert_eq!(shell_close_action(false, false), ShellCloseAction::ExitApp);
    }

    #[test]
    fn detects_runtime_config_changes() {
        let previous = AppConfig {
            locale: "zh-CN".into(),
            notes_dir: "D:\\notes".into(),
            global_shortcut: "Ctrl+Space".into(),
            close_to_tray: true,
            autostart: false,
            default_view_mode: "split".into(),
            note_auto_save: true,
            note_surface_auto_save: true,
            tile_color: "#f6f3ec".into(),
            tile_color_mode: "system".into(),
            theme: "light".into(),
            font_size: 14,
            surface_font_size: 14,
            surface_zoom: 1.0,
            tab_indent_size: 2,
            external_file_auto_save: true,
            background_image_path: String::new(),
            background_fit: "cover".into(),
            background_dim: 0.25,
            background_blur: 0.0,
            background_scale: 1.0,
            background_position_x: 50.0,
            background_position_y: 50.0,
            remember_surface_size: true,
            tile_ctrl_close: true,
            tile_render_markdown: false,
            render_html_markdown: false,
            open_at_cursor: true,
            surface_width: None,
            surface_height: None,
            surface_x: None,
            surface_y: None,
            toggle_visibility_shortcut: String::new(),
        };
        let next = AppConfig {
            locale: "en-US".into(),
            notes_dir: "D:\\other-notes".into(),
            global_shortcut: "Alt+Space".into(),
            close_to_tray: false,
            autostart: true,
            default_view_mode: "preview".into(),
            note_auto_save: false,
            note_surface_auto_save: false,
            tile_color: "#efe8dc".into(),
            tile_color_mode: "custom".into(),
            theme: "dark".into(),
            font_size: 16,
            surface_font_size: 16,
            surface_zoom: 1.0,
            tab_indent_size: 4,
            external_file_auto_save: true,
            background_image_path: String::new(),
            background_fit: "cover".into(),
            background_dim: 0.25,
            background_blur: 0.0,
            background_scale: 1.0,
            background_position_x: 50.0,
            background_position_y: 50.0,
            remember_surface_size: true,
            tile_ctrl_close: true,
            tile_render_markdown: false,
            render_html_markdown: false,
            open_at_cursor: true,
            surface_width: None,
            surface_height: None,
            surface_x: None,
            surface_y: None,
            toggle_visibility_shortcut: "Ctrl+Shift+H".into(),
        };

        assert_eq!(
            runtime_config_changes(&previous, &next),
            RuntimeConfigChanges {
                autostart_changed: true,
                global_shortcut_changed: true,
                toggle_visibility_shortcut_changed: true,
            }
        );
        assert_eq!(
            runtime_config_changes(&previous, &previous),
            RuntimeConfigChanges {
                autostart_changed: false,
                global_shortcut_changed: false,
                toggle_visibility_shortcut_changed: false,
            }
        );
    }

    #[test]
    fn builds_stable_dynamic_window_labels() {
        assert_eq!(notepad_window_label(), "notepad");
        assert_eq!(tile_window_label("note-1"), "tile-note-1");
    }

    #[test]
    fn keeps_notepad_initial_window_compact() {
        let specs = notepad_window_specs();

        assert_eq!(specs.width, 350.0);
        assert_eq!(specs.height, 300.0);
        assert_eq!(specs.min_width, 320.0);
        assert_eq!(specs.min_height, 180.0);
    }

    #[test]
    fn keeps_note_surfaces_transparent() {
        assert_eq!(
            dynamic_window_visual_options("notepad"),
            DynamicWindowVisualOptions { transparent: true }
        );
        assert_eq!(
            dynamic_window_visual_options("tile-note-1"),
            DynamicWindowVisualOptions { transparent: true }
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detects_known_macos_system_shortcut_conflicts() {
        let conflict = system_shortcut_conflict("Command+Space").expect("conflict");

        assert_eq!(conflict.conflict_type, "system");
        assert!(conflict.message.contains("Spotlight"));
    }

    #[test]
    fn capability_allows_frontend_window_focus_for_notepad_surfaces() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability should be valid json");
        let windows = capability["windows"]
            .as_array()
            .expect("capability should define windows");
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability should define permissions");

        assert!(windows
            .iter()
            .any(|window| window.as_str() == Some("notepad")));
        assert!(permissions
            .iter()
            .any(|permission| permission.as_str() == Some("core:window:allow-set-focus")));
    }
}
