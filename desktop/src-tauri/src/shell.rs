//! The Tauri layer: windows, the menu, and the commands. Everything with a rule in it lives
//! in `address`, `bridge`, `portable`, `webui`, `workspaces` and the `qoop-claude-driver`,
//! `qoop-runner` and `qoop-server` crates; this file only connects them to Tauri.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use qoop_claude_driver::{AiEvent, Cancel, Driver, Status};
use qoop_runner::{ApprovalView, DecideError, Runner, SettingsView};
use qoop_server::local::{
    LocalOptions, LocalServer, PortError, Preset, export_workspace, import_workspace, start_local,
};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{CapabilityBuilder, Channel};
use tauri::menu::{
    MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, State, Url, Webview, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};

use crate::address::{self, Navigation};
use crate::bridge::{
    self, EditItem, MAIN_WINDOW, SETTINGS_WINDOW, SETUP_WINDOW, SendRequest, Step, UndoSteps,
};
use crate::portable::{self, MAX_SAVE_BYTES, WORKSPACE_EXTENSION};
use crate::webui;
use crate::workspaces::{self, Entry, Kind, Registry};

const SWITCH_WORKSPACE: &str = "switch-workspace";
const RUNNER_SETTINGS: &str = "runner-settings";
#[cfg(target_os = "linux")]
const QUIT: &str = "quit";
const UNDO: &str = "undo";
const REDO: &str = "redo";

/// How long quitting waits for Runs, `claude` and the embedded server to stop.
const EXIT_BUDGET: Duration = Duration::from_secs(4);

/// Whether the Runner settings window is open, for those who wait for it to close.
#[derive(Default)]
struct SettingsWindow {
    open: Mutex<bool>,
    changed: Condvar,
}

impl SettingsWindow {
    fn set(&self, open: bool) {
        *self.open.lock().unwrap() = open;
        self.changed.notify_all();
    }

    /// Returns when the window is closed, or when `cancel` is set.
    fn wait_closed(&self, cancel: Option<&qoop_runner::Cancel>) {
        let mut open = self.open.lock().unwrap();
        while *open && !cancel.is_some_and(|c| c.is_cancelled()) {
            open = self
                .changed
                .wait_timeout(open, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }
}

/// The run in progress, if any: one at a time per window, and there is one window.
#[derive(Default, Clone)]
struct ActiveRun(Arc<Mutex<Option<(String, Cancel)>>>);

impl ActiveRun {
    fn cancel(&self) {
        if let Some((_, cancel)) = self.0.lock().unwrap().as_ref() {
            cancel.cancel();
        }
    }

    fn is_idle(&self) -> bool {
        self.0.lock().unwrap().is_none()
    }
}

/// Frees the slot when the run's thread is done, however it ends.
struct RunSlot(ActiveRun);

impl Drop for RunSlot {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap() = None;
    }
}

/// The Workspace the main window shows.
struct OpenWorkspace {
    id: String,
    /// Which main window shows it: a window closed earlier must not end what a later one
    /// shows when its last event comes in late.
    generation: u64,
    /// What its Run approvals are remembered under, and how the approval window names it.
    approvals: qoop_runner::Workspace,
}

/// The server of the open Local Workspace, and the one still stopping, if any.
#[derive(Default)]
struct Embedded {
    server: Option<LocalServer>,
    stopping: Option<JoinHandle<()>>,
}

struct AppState {
    /// The origin the bridge is granted to, in this run of the app: set once, never
    /// changed. A grant cannot be taken back, so a Workspace on another origin is opened by
    /// starting the app again (see `open_workspace`).
    granted: Mutex<Option<String>>,
    /// Held only by the bridge script; see `bridge::check_caller`.
    bridge_key: String,
    run: ActiveRun,
    /// When a blocked navigation last opened the system browser (ms since the epoch).
    last_external: AtomicU64,
    runner_settings: Arc<SettingsWindow>,
    /// The Workspace the main window shows (see `open_main`).
    open: Mutex<Option<OpenWorkspace>>,
    main_windows: AtomicU64,
    /// Held while a Workspace is being opened: one at a time.
    opening: tauri::async_runtime::Mutex<()>,
    embedded: Mutex<Embedded>,
    /// Said once on the start screen: why the app came back to it.
    notice: Mutex<Option<String>>,
    /// The automatic backups being made, by Workspace id (see `back_up`).
    backups: Mutex<HashMap<String, JoinHandle<()>>>,
    /// Whether a save or open dialog is showing: one at a time.
    dialog: AtomicBool,
}

impl AppState {
    /// Starts stopping the embedded server, if one runs; `stopped` waits for it.
    fn begin_stop(&self) {
        let mut embedded = self.embedded.lock().unwrap();
        if let Some(server) = embedded.server.take() {
            let previous = embedded.stopping.take();
            embedded.stopping = Some(tauri::async_runtime::spawn(async move {
                if let Some(previous) = previous {
                    let _ = previous.await;
                }
                server.stop().await;
            }));
        }
    }

    async fn stopped(&self) {
        let stopping = self.embedded.lock().unwrap().stopping.take();
        if let Some(stopping) = stopping {
            let _ = stopping.await;
        }
    }

    fn open_id(&self) -> Option<String> {
        self.open
            .lock()
            .unwrap()
            .as_ref()
            .map(|open| open.id.clone())
    }
}

/// The Runner. Managed on its own because it needs the app's config directory, which is
/// only known once the app is being set up.
type RunnerState = Arc<Runner>;

fn runner(app: &AppHandle) -> RunnerState {
    app.state::<RunnerState>().inner().clone()
}

/// The list of Workspaces. Managed on its own for the same reason; the lock keeps two
/// changes to the file from overlapping.
struct Workspaces {
    registry: Mutex<Registry>,
    data_dir: PathBuf,
    /// The unpacked web UI, once a Local Workspace has needed it.
    web_dir: OnceLock<PathBuf>,
}

fn workspaces(app: &AppHandle) -> State<'_, Workspaces> {
    app.state::<Workspaces>()
}

fn random_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system provides random bytes");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState {
            granted: Mutex::new(None),
            bridge_key: random_key(),
            run: ActiveRun::default(),
            last_external: AtomicU64::new(0),
            runner_settings: Arc::default(),
            open: Mutex::new(None),
            main_windows: AtomicU64::new(0),
            opening: tauri::async_runtime::Mutex::new(()),
            embedded: Mutex::default(),
            notice: Mutex::new(None),
            backups: Mutex::default(),
            dialog: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            start_view,
            workspace_create,
            workspace_connect,
            workspace_open,
            workspace_rename,
            workspace_remove,
            workspace_export,
            workspace_import,
            workspace_reveal,
            claude_status,
            claude_send,
            claude_cancel,
            switch_workspace,
            save_file,
            print_page,
            undo_state,
            runner_status,
            runner_configure,
            runner_run,
            runner_cancel,
            approval_view,
            approval_decide,
            runner_settings_view,
            runner_settings_save,
            runner_settings_forget,
            runner_settings_close
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // The Runner keeps its settings and the remembered approvals in the app's own
            // config directory, and the list of Workspaces is kept there too; Local
            // Workspaces live in the data directory. Without them there is nowhere safe to
            // keep any of it: no fallback.
            let config = handle
                .path()
                .app_config_dir()
                .map_err(|_| "the app has no config directory")?;
            let data = handle
                .path()
                .app_data_dir()
                .map_err(|_| "the app has no data directory")?;
            app.manage::<RunnerState>(Arc::new(Runner::new(
                qoop_runner::Options::from_process_env(config.clone()),
            )));
            app.manage(Workspaces {
                registry: Mutex::new(Registry::new(config, data.clone())),
                data_dir: data,
                web_dir: OnceLock::new(),
            });
            build_menu(&handle)?;
            // Always the start screen, except just after the app started itself again to
            // open a Workspace: then that Workspace, without a second click.
            let next = workspaces(&handle)
                .registry
                .lock()
                .unwrap()
                .take_open_next();
            match next {
                Some(entry) => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(notice) = open_workspace(&handle, entry).await {
                            let _ = open_setup(&handle, Some(notice));
                        }
                    });
                }
                None => open_setup(&handle, None)?,
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            SWITCH_WORKSPACE => leave_workspace(app),
            RUNNER_SETTINGS => {
                let _ = open_runner_settings(app);
            }
            UNDO => page_step(app, Step::Undo),
            REDO => page_step(app, Step::Redo),
            #[cfg(target_os = "linux")]
            QUIT => app.exit(0),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("the Infall desktop app could not start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Leave no `claude`, no Run and no embedded server behind: stop them all at
            // once, then wait (within the budget) for the processes and the server to go.
            let deadline = Instant::now() + EXIT_BUDGET;
            let state = app.state::<AppState>();
            state.begin_stop();
            let run = state.run.clone();
            run.cancel();
            let runner = app.try_state::<RunnerState>().map(|r| r.inner().clone());
            if let Some(runner) = &runner {
                runner.cancel_all();
            }
            let busy = || !run.is_idle() || runner.as_ref().is_some_and(|r| !r.is_idle());
            while busy() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            let stopping = state.embedded.lock().unwrap().stopping.take();
            if let Some(stopping) = stopping {
                // At least a moment, even when the Runs took the whole budget.
                let left = deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(500));
                // The timeout is made inside the runtime: its timer needs one, and this
                // callback runs on the main thread, outside it.
                tauri::async_runtime::block_on(async move {
                    let _ = tokio::time::timeout(left, stopping).await;
                });
            }
        }
    });
}

/// The menu on Linux, a bar in every window. GTK draws most of the predefined items of the
/// menu below greyed out (Quit among them), and its copy and paste items do nothing without
/// a library that fakes key presses: so only the app's own two items, and a Quit that works.
/// Copy and paste work from the keyboard and the page's own context menu. Since M15 also an
/// Edit menu with the app's own Undo and Redo (see `EditMenu`).
#[cfg(target_os = "linux")]
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let switch = MenuItemBuilder::with_id(SWITCH_WORKSPACE, "Switch Workspace…").build(app)?;
    let runner_settings =
        MenuItemBuilder::with_id(RUNNER_SETTINGS, "Runner settings…").build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "Quit")
        .accelerator("Ctrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Infall")
        .item(&switch)
        .item(&runner_settings)
        .separator()
        .item(&quit)
        .build()?;
    let edit = EditMenu::build(app, |edit| edit)?;
    app.set_menu(MenuBuilder::new(app).item(&app_menu).item(&edit).build()?)?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let switch = MenuItemBuilder::with_id(SWITCH_WORKSPACE, "Switch Workspace…").build(app)?;
    let runner_settings =
        MenuItemBuilder::with_id(RUNNER_SETTINGS, "Runner settings…").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Infall")
        .about(None)
        .separator()
        .item(&switch)
        .item(&runner_settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    // Without an Edit menu, copy and paste shortcuts do nothing on macOS. Undo and Redo: see
    // `EditMenu`.
    let edit = EditMenu::build(app, |edit| {
        edit.separator().cut().copy().paste().select_all()
    })?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// The start screen (desktop/ui/index.html): every Workspace, signing in to a Team
/// Workspace, making a Local one. `notice` is what it says first (`start_view`), when the
/// app came back to it because something failed.
fn open_setup(app: &AppHandle, notice: Option<String>) -> tauri::Result<()> {
    if notice.is_some() {
        *app.state::<AppState>().notice.lock().unwrap() = notice;
    }
    if let Some(window) = app.get_webview_window(SETUP_WINDOW) {
        return window.set_focus();
    }
    local_window(app, SETUP_WINDOW, "index.html")
        .title("Infall")
        .inner_size(920.0, 640.0)
        .min_inner_size(720.0, 560.0)
        .resizable(true)
        .build()?;
    Ok(())
}

fn is_local_asset(url: &Url) -> bool {
    // Windows and Android serve the app's own files from http(s)://tauri.localhost.
    url.host_str() == Some("tauri.localhost")
}

/// The main window: shows the Workspace at `origin`, and nothing else. It starts at
/// `start`, a page of that origin: the origin itself for a Team Workspace, the embedded
/// server's entry URL for a Local one. That URL carries the key that signs the Member in;
/// it is given to this window and to nothing else, and never written anywhere.
fn open_main(app: &AppHandle, entry: &Entry, origin: &str, start: &str) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let start = Url::parse(start)
        .ok()
        .filter(|url| address::same_origin(url, origin))
        .ok_or(tauri::Error::InvalidWebviewUrl("workspace address"))?;

    let mut granted = state.granted.lock().unwrap();
    match granted.as_deref() {
        Some(previous) if previous == origin => {}
        // `open_workspace` starts the app again rather than come here.
        Some(_) => return Err(tauri::Error::InvalidWebviewUrl("workspace address")),
        None => {
            // The only access remote content gets: the bridge commands, for pages of this
            // one origin, in this one window. (Tauri checks the calling page's URL against
            // it on every call; a call from any other origin, or for any other command, is
            // refused.) For the Runner that is: read its status, ask for the settings
            // window, ask for a Run, cancel it. The commands that choose an interpreter or
            // approve code are not in this list.
            app.add_capability(
                CapabilityBuilder::new("qoop-bridge")
                    .remote(format!("{origin}/*"))
                    .window(MAIN_WINDOW)
                    .permission("allow-claude-status")
                    .permission("allow-claude-send")
                    .permission("allow-claude-cancel")
                    .permission("allow-runner-status")
                    .permission("allow-runner-configure")
                    .permission("allow-runner-run")
                    .permission("allow-runner-cancel")
                    .permission("allow-switch-workspace")
                    // Saving an export where the Member chooses, in the system's dialog, and
                    // printing the page (macOS; see `bridge::OWN_PRINT`).
                    .permission("allow-save-file")
                    .permission("allow-print-page")
                    // What the page's Undo and Redo would do, for the Edit menu (M15).
                    .permission("allow-undo-state")
                    // The top bar's first row is the window's title bar (macOS has none of
                    // its own, see below): pressing on an empty part of it moves the window,
                    // a double click zooms it. Nothing else about the window is reachable.
                    .permission("core:window:allow-start-dragging")
                    .permission("core:window:allow-internal-toggle-maximize"),
            )?;
            *granted = Some(origin.to_owned());
        }
    }
    drop(granted);

    let script = bridge::script(
        origin,
        &app.package_info().version.to_string(),
        &state.bridge_key,
    );
    let nav_origin = origin.to_owned();
    let new_window_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(start))
        .title("Infall")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        // Runs in the main frame only, before the page's own scripts.
        .initialization_script(script)
        // A navigation can be started by a script in any frame — including a Visual in its
        // sandbox — and looks the same as one the Member started. So another site is simply
        // not shown, and nothing is opened: only a link the Member clicks (`target="_blank"`,
        // below; a sandboxed frame cannot open windows) reaches the system browser.
        .on_navigation(move |url| {
            matches!(address::navigation(url, &nav_origin), Navigation::Allow)
        })
        // Links that ask for a new window (`target="_blank"`) go to the system browser.
        .on_new_window(move |url, _| {
            open_externally(&new_window_app, &url, true);
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            // A page that is going away cannot receive the rest of its run, and a Run it
            // asked for must not go on (or wait for approval) behind its back.
            if payload.event() == PageLoadEvent::Started {
                window.state::<AppState>().run.cancel();
                window.state::<RunnerState>().cancel_all();
                // Its steps went with it.
                EditMenu::page_said(window.app_handle(), UndoSteps::default());
            }
        });
    // On macOS the page draws the title bar: its top row (30px) holds the traffic lights,
    // centred in that row with the first circle 13px in (inset: x = 13 - 1 for the button frame,
    // y = 30 - 14 for its height); the web UI leaves room for them.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 16.0));
    // The web inspector exists in debug builds only (the `devtools` feature is off).
    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);
    let window = builder.build()?;

    // Which main window this is: a window closed earlier must not end what a later one
    // shows when its last event comes in late.
    let generation = state.main_windows.fetch_add(1, Ordering::Relaxed) + 1;
    *state.open.lock().unwrap() = Some(OpenWorkspace {
        id: entry.id.clone(),
        generation,
        approvals: qoop_runner::Workspace {
            key: entry.approvals_key(),
            name: entry.approvals_name(),
        },
    });

    let run = state.run.clone();
    let runs = runner(app);
    let closed_app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            EditMenu::main_focused(&closed_app, *focused);
        }
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            run.cancel();
            runs.cancel_all();
        }
        if matches!(event, WindowEvent::Destroyed) {
            EditMenu::page_said(&closed_app, UndoSteps::default());
            // The Workspace is left: its server stops.
            let state = closed_app.state::<AppState>();
            let mut open = state.open.lock().unwrap();
            if open.as_ref().is_some_and(|o| o.generation == generation) {
                *open = None;
                drop(open);
                state.begin_stop();
            }
        }
    });
    Ok(())
}

/// A window of the app's own local UI (desktop/ui): bundled files, no remote content, and
/// nowhere else to go.
fn local_window<'a>(
    app: &'a AppHandle,
    label: &str,
    file: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(file.into()))
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "about") || is_local_asset(url))
        .on_new_window(|_, _| NewWindowResponse::Deny)
}

/// The Runner settings window: which Python, which folder.
fn open_runner_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        return window.set_focus();
    }
    let open = app.state::<AppState>().runner_settings.clone();
    open.set(true);
    let built = local_window(app, SETTINGS_WINDOW, "runner.html")
        .title("Runner settings")
        .inner_size(620.0, 700.0)
        .min_inner_size(480.0, 420.0)
        .build();
    match built {
        Ok(window) => {
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    open.set(false);
                }
            });
            Ok(())
        }
        Err(error) => {
            open.set(false);
            Err(error)
        }
    }
}

/// The app's two Runner windows, as the Runner asks for them (from its own thread).
struct RunnerWindows(AppHandle);

impl qoop_runner::Ui for RunnerWindows {
    fn configure(&self, cancel: &qoop_runner::Cancel) {
        if open_runner_settings(&self.0).is_ok() {
            self.0
                .state::<AppState>()
                .runner_settings
                .wait_closed(Some(cancel));
        }
    }

    /// The approval window for one question. Its label carries the ticket, and that is the
    /// only question it can answer. Closing it is "Don't run".
    fn show_approval(&self, ticket: u64) -> bool {
        let built = local_window(&self.0, &bridge::approval_window(ticket), "approval.html")
            .title("Run this code on your computer?")
            .inner_size(820.0, 760.0)
            .min_inner_size(560.0, 480.0)
            .always_on_top(true)
            .center()
            .build();
        let Ok(window) = built else {
            return false;
        };
        let runs = runner(&self.0);
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                runs.approval_closed(ticket);
            }
        });
        let _ = window.set_focus();
        true
    }

    fn close_approval(&self, ticket: u64) {
        if let Some(window) = self.0.get_webview_window(&bridge::approval_window(ticket)) {
            let _ = window.destroy();
        }
    }
}

/// Opens `url` in the system browser, at most once every two seconds.
fn open_externally(app: &AppHandle, url: &Url, throttle: bool) {
    if !address::may_open_externally(url) {
        return;
    }
    if throttle {
        let now = now_ms();
        let last = &app.state::<AppState>().last_external;
        let previous = last.load(Ordering::Relaxed);
        if now.saturating_sub(previous) < 2000
            || last
                .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return;
        }
    }
    // Handed to the operating system as one argument; no shell is involved.
    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
}

/// "Switch Workspace…" (and `qoopDesktop.switchWorkspace`): stops what is running, closes
/// the main window, shows the start screen.
fn leave_workspace(app: &AppHandle) {
    if open_setup(app, None).is_err() {
        return;
    }
    let state = app.state::<AppState>();
    state.run.cancel();
    runner(app).cancel_all();
    *state.open.lock().unwrap() = None;
    state.begin_stop();
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        let _ = main.close();
    }
}

// ---- opening a Workspace -----------------------------------------------------------------

/// Opens a Workspace in the main window and closes the start screen. The error is a
/// sentence for the start screen.
async fn open_workspace(app: &AppHandle, entry: Entry) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _opening = state
        .opening
        .try_lock()
        .map_err(|_| "Another workspace is being opened.".to_owned())?;
    // One Workspace at a time.
    if app.get_webview_window(MAIN_WINDOW).is_some() {
        return Err("Close the open workspace first.".to_owned());
    }
    state.stopped().await;

    let granted = state.granted.lock().unwrap().clone();
    match entry.kind {
        Kind::Team => {
            let origin = entry
                .address
                .clone()
                .ok_or("That workspace has no address.")?;
            let checked = origin.clone();
            let answered =
                tauri::async_runtime::spawn_blocking(move || address::check_health(&checked))
                    .await
                    .map(|r| r.is_ok())
                    .unwrap_or(false);
            if !answered {
                return Err(format!(
                    "“{}” did not answer; check that its server is running and try again.",
                    entry.name
                ));
            }
            if granted.is_some_and(|g| g != origin) {
                return restart_into(app, &entry);
            }
            open_main(app, &entry, &origin, &origin)
                .map_err(|_| "The window could not be opened.".to_owned())?;
        }
        Kind::Local => {
            // The embedded server's port is new at every start, so its origin is never the
            // one already granted.
            if granted.is_some() {
                return restart_into(app, &entry);
            }
            let server = start_embedded(app, &entry).await?;
            let opened = address::embedded_origin(server.origin()).and_then(|origin| {
                open_main(app, &entry, &origin, server.entry_url())
                    .map_err(|_| "The window could not be opened.".to_owned())
            });
            if let Err(message) = opened {
                server.stop().await;
                return Err(message);
            }
            state.embedded.lock().unwrap().server = Some(server);
            back_up(app, &entry.id);
        }
    }

    let _ = workspaces(app)
        .registry
        .lock()
        .unwrap()
        .opened(&entry.id, now_ms() as i64);
    if let Some(setup) = app.get_webview_window(SETUP_WINDOW) {
        let _ = setup.close();
    }
    Ok(())
}

/// The bridge was granted to another origin in this run of the app, and a grant cannot be
/// taken back: start again, so that only the new origin has it, and open `entry` then.
fn restart_into(app: &AppHandle, entry: &Entry) -> Result<(), String> {
    workspaces(app)
        .registry
        .lock()
        .unwrap()
        .set_open_next(&entry.id)?;
    app.request_restart();
    Ok(())
}

/// Starts the embedded server for a Local Workspace, on the app's own async runtime.
async fn start_embedded(app: &AppHandle, entry: &Entry) -> Result<LocalServer, String> {
    const NOT_STARTED: &str = "The workspace could not be opened on this computer.";
    let ws = workspaces(app);
    let web_dir = match ws.web_dir.get() {
        Some(dir) => dir.clone(),
        None => {
            let root = ws.data_dir.clone();
            let dir = tauri::async_runtime::spawn_blocking(move || webui::unpack(&root))
                .await
                .map_err(|_| NOT_STARTED.to_owned())?
                .map_err(|_| NOT_STARTED.to_owned())?;
            ws.web_dir.get_or_init(|| dir).clone()
        }
    };
    let preset = entry
        .preset
        .as_deref()
        .and_then(Preset::from_id)
        .unwrap_or(Preset::Blank);
    let (db, port) = {
        let registry = ws.registry.lock().unwrap();
        // Without a remembered port (the list could not be saved) the OS chooses one; the
        // Workspace opens all the same, only its address is new.
        (
            registry.db_path(&entry.id),
            registry.port_for(&entry.id).ok().flatten(),
        )
    };
    let options = LocalOptions {
        db,
        web_dir,
        preset,
        member_name: workspaces::member_name(),
        // When it is taken the server listens on another port for this once; the
        // remembered one is kept for the next start.
        port,
    };
    // The start screen gets a sentence; what the server said is not ours to word. Debug
    // builds print it for whoever is working on the app (it names files, never the key).
    start_local(options).await.map_err(|_error| {
        #[cfg(debug_assertions)]
        eprintln!("The Local Workspace did not start: {_error}");
        NOT_STARTED.to_owned()
    })
}

// ---- backups (docs/specs/portability.md, decision 2) --------------------------------------

/// Makes a backup of a Local Workspace that has just been opened, if one is due, on a
/// thread of its own: the Workspace is already open and never waits for it. A failure is
/// written to the log and tried again at the next opening.
fn back_up(app: &AppHandle, id: &str) {
    let (db, dir) = {
        let ws = workspaces(app);
        let registry = ws.registry.lock().unwrap();
        (registry.db_path(id), registry.backups_dir(id))
    };
    let state = app.state::<AppState>();
    let mut backups = state.backups.lock().unwrap();
    backups.retain(|_, task| !task.inner().is_finished());
    if backups.contains_key(id) {
        return;
    }
    let done = app.clone();
    let workspace = id.to_owned();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let made = portable::keep_backed_up(&db, &dir, now_ms() as i64, |db, dest| {
            export_workspace(db, dest).map_err(|e| e.to_string())
        });
        match made {
            Ok(newest) => {
                let _ = workspaces(&done)
                    .registry
                    .lock()
                    .unwrap()
                    .set_last_backup(&workspace, newest);
            }
            Err(e) => eprintln!("Infall: no backup of a workspace was made this time: {e}"),
        }
    });
    backups.insert(id.to_owned(), task);
}

/// Waits for the backup of `id` being made, if one is.
async fn backup_done(state: &AppState, id: &str) {
    let task = state.backups.lock().unwrap().remove(id);
    if let Some(task) = task {
        let _ = task.await;
    }
}

// ---- the system's file dialogs -----------------------------------------------------------

const NO_DIALOG: &str = "The file dialog could not be shown.";

/// Held while a dialog shows: one at a time, for every window.
struct DialogSlot<'a>(&'a AtomicBool);

impl<'a> DialogSlot<'a> {
    fn take(state: &'a AppState) -> Result<DialogSlot<'a>, String> {
        state
            .dialog
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| DialogSlot(&state.dialog))
            .map_err(|_| "A file dialog is already open.".to_owned())
    }
}

impl Drop for DialogSlot<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Shows a dialog `make` builds (on the main thread, as the systems want), attached to the
/// window it was asked from, and returns the path chosen: `None` when the person cancelled.
async fn ask_path<F, D>(app: &AppHandle, make: F) -> Result<Option<PathBuf>, String>
where
    F: FnOnce() -> D + Send + 'static,
    D: Future<Output = Option<rfd::FileHandle>> + Send + 'static,
{
    let (chosen, answer) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let dialog = make();
        // The answer is waited for away from the main thread, which keeps the dialog going.
        std::thread::spawn(move || {
            let _ = chosen.send(tauri::async_runtime::block_on(dialog));
        });
    })
    .map_err(|_| NO_DIALOG.to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        answer
            .recv()
            .ok()
            .flatten()
            .map(|file| file.path().to_path_buf())
    })
    .await
    .map_err(|_| NO_DIALOG.to_owned())
}

/// A save dialog suggesting `name`, offering `filter` (a label and an extension) if given.
async fn ask_save_path(
    app: &AppHandle,
    parent: tauri::Window,
    name: String,
    filter: Option<(&'static str, &'static str)>,
) -> Result<Option<PathBuf>, String> {
    ask_path(app, move || {
        let mut dialog = rfd::AsyncFileDialog::new()
            .set_parent(&parent)
            .set_file_name(name)
            .set_can_create_directories(true);
        if let Some((label, extension)) = filter {
            dialog = dialog.add_filter(label, &[extension]);
        }
        dialog.save_file()
    })
    .await
}

/// A sentence for the start screen from what the server crate said. Its sentences are fit
/// to show as they are (Contract A), except the system's own words about files.
fn port_sentence(error: PortError, io: &str) -> String {
    match error {
        PortError::Io(_) => io.to_owned(),
        other => other.to_string(),
    }
}

// ---- commands of the start screen (docs/specs/local.md, Contract C) ----------------------

fn check_setup_caller(webview: &Webview) -> Result<(), String> {
    bridge::check_setup_caller(webview.label(), webview.url().ok().as_ref())
}

#[derive(serde::Serialize)]
struct StartView {
    workspaces: Vec<workspaces::Listed>,
    notice: Option<String>,
}

/// Every Workspace, newest first, and why the app came back here, if it did (said once).
#[tauri::command]
fn start_view(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartView, String> {
    check_setup_caller(&webview)?;
    Ok(StartView {
        workspaces: workspaces(&app)
            .registry
            .lock()
            .unwrap()
            .list()
            .iter()
            .map(Entry::listed)
            .collect(),
        notice: state.notice.lock().unwrap().take(),
    })
}

/// Makes a Local Workspace from a Preset and opens it.
#[tauri::command]
async fn workspace_create(
    webview: Webview,
    app: AppHandle,
    preset: String,
    name: Option<String>,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    if Preset::from_id(&preset).is_none() {
        return Err("There is no such kind of workspace.".to_owned());
    }
    let entry = workspaces(&app)
        .registry
        .lock()
        .unwrap()
        .create_local(&preset, name.as_deref())?;
    let id = entry.id.clone();
    let opened = open_workspace(&app, entry).await;
    if opened.is_err() {
        // Nothing the Member made is lost: what failed to open was made just now.
        let _ = workspaces(&app).registry.lock().unwrap().remove(&id);
    }
    opened
}

/// Checks the address, asks the server for its health, remembers the Team Workspace and
/// opens it.
#[tauri::command]
async fn workspace_connect(
    webview: Webview,
    app: AppHandle,
    address: String,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    let origin = address::parse_server_address(&address)?;
    let checked = origin.clone();
    tauri::async_runtime::spawn_blocking(move || address::check_health(&checked))
        .await
        .map_err(|_| "The address could not be checked. Try again.".to_owned())??;
    let entry = workspaces(&app)
        .registry
        .lock()
        .unwrap()
        .remember_team(&origin)?;
    open_workspace(&app, entry).await
}

#[tauri::command]
async fn workspace_open(webview: Webview, app: AppHandle, id: String) -> Result<(), String> {
    check_setup_caller(&webview)?;
    let entry = workspaces(&app)
        .registry
        .lock()
        .unwrap()
        .get(&id)
        .ok_or("That workspace is no longer in the list.")?;
    open_workspace(&app, entry).await
}

#[tauri::command]
fn workspace_rename(
    webview: Webview,
    app: AppHandle,
    id: String,
    name: String,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    workspaces(&app).registry.lock().unwrap().rename(&id, &name)
}

/// A Local Workspace's files are deleted for good; a Team Workspace is only forgotten.
/// Never the open one.
#[tauri::command]
async fn workspace_remove(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    // Not while it is being opened, nor while its server is still stopping.
    let _opening = state
        .opening
        .try_lock()
        .map_err(|_| "A workspace is being opened; try again in a moment.".to_owned())?;
    if state.open_id().as_deref() == Some(id.as_str()) {
        return Err("This workspace is open; switch to another one before removing it.".to_owned());
    }
    state.stopped().await;
    // Its backup, if one is being made, is finished first: then everything goes.
    backup_done(&state, &id).await;
    let registry = workspaces(&app);
    let registry = registry.registry.lock().unwrap();
    let entry = registry
        .get(&id)
        .ok_or("That workspace is no longer in the list.")?;
    registry.remove(&id)?;
    drop(registry);
    // A Local Workspace is gone for good, and so are the Runs approved in it. A Team
    // Workspace's approvals stay: its server is still there, and may be signed in to again.
    if entry.kind == Kind::Local {
        let _ = runner(&app).forget_approvals_for(&entry.approvals_key());
    }
    Ok(())
}

/// The Local Workspace `id`, or the sentence for why it is not one.
fn local_entry(app: &AppHandle, id: &str) -> Result<Entry, String> {
    let entry = workspaces(app)
        .registry
        .lock()
        .unwrap()
        .get(id)
        .ok_or("That workspace is no longer in the list.")?;
    if entry.kind != Kind::Local {
        return Err("Only a workspace on this computer has a Workspace file.".to_owned());
    }
    Ok(entry)
}

/// Writes a Workspace file of a Local Workspace where the Member chooses (open or not: the
/// copy is consistent either way). The path written, or `None` when they cancelled.
#[tauri::command]
async fn workspace_export(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    check_setup_caller(&webview)?;
    let entry = local_entry(&app, &id)?;
    let db = workspaces(&app).registry.lock().unwrap().db_path(&id);
    if !db.is_file() {
        return Err("This workspace has nothing in it to export yet.".to_owned());
    }
    let chosen = {
        let _dialog = DialogSlot::take(&state)?;
        let name = format!(
            "{}.{WORKSPACE_EXTENSION}",
            portable::safe_stem(&entry.name, "Workspace")
        );
        let filter = Some(("Workspace file", WORKSPACE_EXTENSION));
        ask_save_path(&app, webview.window(), name, filter).await?
    };
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let dest = portable::with_extension(chosen, WORKSPACE_EXTENSION);
    const NOT_WRITTEN: &str = "The Workspace file could not be written there.";
    let written = dest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        portable::write_replacing(
            &written,
            |tmp| export_workspace(&db, tmp).map_err(|e| port_sentence(e, NOT_WRITTEN)),
            NOT_WRITTEN,
        )
    })
    .await
    .map_err(|_| NOT_WRITTEN.to_owned())??;
    Ok(Some(dest.display().to_string()))
}

/// Makes a new Local Workspace from a Workspace file the Member chooses — or from a Local
/// Workspace's own database (`.sqlite`) copied out of the app's data folder by hand — and
/// opens it. Nothing happens when they cancel.
#[tauri::command]
async fn workspace_import(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    let chosen = {
        let _dialog = DialogSlot::take(&state)?;
        let parent = webview.window();
        ask_path(&app, move || {
            rfd::AsyncFileDialog::new()
                .set_parent(&parent)
                .add_filter(
                    "Workspace file or database",
                    &[WORKSPACE_EXTENSION, portable::DATABASE_EXTENSION],
                )
                .pick_file()
        })
        .await?
    };
    let Some(file) = chosen else {
        return Ok(());
    };
    const NOT_READ: &str = "That file could not be read.";
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let importing = app.clone();
    let entry = tauri::async_runtime::spawn_blocking(move || {
        workspaces(&importing)
            .registry
            .lock()
            .unwrap()
            .import_local(&stem, |db: &Path| {
                import_workspace(&file, db)
                    .map(|imported| imported.preset.map(|p| p.id().to_owned()))
                    .map_err(|e| port_sentence(e, NOT_READ))
            })
    })
    .await
    .map_err(|_| NOT_READ.to_owned())??;
    // Should it not open now, it is kept all the same: it is in the list, to open later.
    open_workspace(&app, entry).await
}

/// Shows a Local Workspace's folder (its database, and its backups) in the file manager.
#[tauri::command]
fn workspace_reveal(webview: Webview, app: AppHandle, id: String) -> Result<(), String> {
    check_setup_caller(&webview)?;
    local_entry(&app, &id)?;
    let dir = workspaces(&app).registry.lock().unwrap().local_dir(&id);
    if !dir.is_dir() {
        return Err("This workspace's folder is no longer on this computer.".to_owned());
    }
    tauri_plugin_opener::open_path(&dir, None::<&str>)
        .map_err(|_| "The folder could not be shown.".to_owned())
}

// ---- commands behind `window.qoopDesktop` ----------------------------------------------

fn check_bridge_caller(webview: &Webview, state: &AppState, key: &str) -> Result<String, String> {
    let origin = state.granted.lock().unwrap().clone();
    let page = webview.url().ok();
    bridge::check_caller(
        webview.window().label(),
        page.as_ref(),
        origin.as_deref(),
        key,
        &state.bridge_key,
    )?;
    origin.ok_or_else(|| "Not allowed.".to_owned())
}

/// Back to the start screen, as the menu item "Switch Workspace…" does.
#[tauri::command]
async fn switch_workspace(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    leave_workspace(&app);
    Ok(())
}

/// Saves text where the Member chooses, in the system's save dialog (Contract D): `true`
/// once written whole, `false` when they cancelled.
#[tauri::command]
async fn save_file(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    suggested_name: String,
    text: String,
) -> Result<bool, String> {
    check_bridge_caller(&webview, &state, &key)?;
    if text.len() > MAX_SAVE_BYTES {
        return Err("The file is too large to save (at most 20 MB).".to_owned());
    }
    let chosen = {
        let _dialog = DialogSlot::take(&state)?;
        let name = portable::safe_file_name(&suggested_name, "Untitled");
        ask_save_path(&app, webview.window(), name, None).await?
    };
    let Some(dest) = chosen else {
        return Ok(false);
    };
    const NOT_WRITTEN: &str = "The file could not be written there.";
    tauri::async_runtime::spawn_blocking(move || {
        portable::write_replacing(
            &dest,
            |tmp| std::fs::write(tmp, text.as_bytes()).map_err(|_| NOT_WRITTEN.to_owned()),
            NOT_WRITTEN,
        )
    })
    .await
    .map_err(|_| NOT_WRITTEN.to_owned())??;
    Ok(true)
}

/// Opens the system's print dialog for the page (what `window.print()` does on macOS;
/// see `bridge::OWN_PRINT`).
#[tauri::command]
async fn print_page(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    webview
        .print()
        .map_err(|_| "The page could not be printed.".to_owned())
}

/// What the page's Undo and Redo would do now (`window.__infallUndo.state()`, sent by the
/// bridge script), for the Edit menu's two items. The page gets nothing back.
#[tauri::command]
fn undo_state(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    undo: Option<String>,
    redo: Option<String>,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    EditMenu::page_said(&app, UndoSteps::from_page(undo.as_deref(), redo.as_deref()));
    Ok(())
}

// ---- Undo and Redo in the Edit menu (docs/specs/undo.md, decision 11; desktop.md, M15) ---
//
// The keys are the page's: the menu takes none it did not take before M15. Each item is,
// by `bridge::edit_item`, the app's own item naming the page's step while the main window
// has focus and its page names one, and otherwise the system's own item (macOS, Windows)
// or a greyed-out one (Linux, where GTK has no working system item).

/// The app's own items' key equivalents: those of the system's items they stand in for, so
/// that swapping one for the other changes no key. None on Linux: GTK lets a menu's keys go
/// before the focused web view, so a Ctrl+Z there would take text undo from every field.
fn step_keys(step: Step) -> Option<&'static str> {
    match step {
        Step::Undo if cfg!(target_os = "macos") => Some("Cmd+Z"),
        Step::Redo if cfg!(target_os = "macos") => Some("Cmd+Shift+Z"),
        Step::Undo if cfg!(windows) => Some("Ctrl+Z"),
        Step::Redo if cfg!(windows) => Some("Ctrl+Y"),
        _ => None,
    }
}

struct EditSlot {
    step: Step,
    /// Its place at the top of the Edit menu.
    index: usize,
    own: MenuItem<Wry>,
    /// The system's own item; none on Linux.
    system: Option<PredefinedMenuItem<Wry>>,
}

impl EditSlot {
    fn new(app: &AppHandle, step: Step, id: &str, index: usize) -> tauri::Result<EditSlot> {
        let mut own = MenuItemBuilder::with_id(id, step.verb()).enabled(false);
        if let Some(keys) = step_keys(step) {
            own = own.accelerator(keys);
        }
        let system = match step {
            _ if cfg!(target_os = "linux") => None,
            Step::Undo => Some(PredefinedMenuItem::undo(app, None)?),
            Step::Redo => Some(PredefinedMenuItem::redo(app, None)?),
        };
        Ok(EditSlot {
            step,
            index,
            own: own.build(app)?,
            system,
        })
    }

    /// Makes the item `item`, which until now was `before` (`None`: as built).
    fn show(&self, edit: &Submenu<Wry>, item: &EditItem, before: Option<&EditItem>) {
        let own = match item {
            EditItem::Step(title) => {
                let _ = self.own.set_text(bridge::menu_text(title));
                let _ = self.own.set_enabled(true);
                true
            }
            EditItem::Off => {
                let _ = self.own.set_text(self.step.verb());
                let _ = self.own.set_enabled(false);
                true
            }
            EditItem::System => false,
        };
        let Some(system) = &self.system else {
            return;
        };
        // Never both at once: they have the same key.
        let own_shown = matches!(before, Some(EditItem::Step(_) | EditItem::Off));
        if own && !own_shown {
            let _ = edit.remove(system);
            let _ = edit.insert(&self.own, self.index);
        } else if !own && own_shown {
            let _ = edit.remove(&self.own);
            let _ = edit.insert(system, self.index);
        }
    }
}

/// The Edit menu's Undo and Redo, managed as app state once the menu is built.
struct EditMenu {
    edit: Submenu<Wry>,
    slots: [EditSlot; 2],
    /// What the page last said, and what each item is now (`None`: as built).
    shown: Mutex<(UndoSteps, [Option<EditItem>; 2])>,
}

impl EditMenu {
    /// The Edit menu: Undo and Redo, then what `below` adds.
    fn build(
        app: &AppHandle,
        below: impl FnOnce(SubmenuBuilder<'_, Wry, AppHandle>) -> SubmenuBuilder<'_, Wry, AppHandle>,
    ) -> tauri::Result<Submenu<Wry>> {
        let slots = [
            EditSlot::new(app, Step::Undo, UNDO, 0)?,
            EditSlot::new(app, Step::Redo, REDO, 1)?,
        ];
        let mut edit = SubmenuBuilder::new(app, "Edit");
        for slot in &slots {
            edit = match &slot.system {
                Some(system) => edit.item(system),
                None => edit.item(&slot.own),
            };
        }
        let edit = below(edit).build()?;
        app.manage(EditMenu {
            edit: edit.clone(),
            slots,
            shown: Mutex::default(),
        });
        Ok(edit)
    }

    /// What the main window's page said (nothing, when it went away).
    fn page_said(app: &AppHandle, steps: UndoSteps) {
        Self::refresh(app, Some(steps), None);
    }

    /// The main window gained or lost focus.
    fn main_focused(app: &AppHandle, focused: bool) {
        Self::refresh(app, None, Some(focused));
    }

    /// On the main thread, where the menu lives (and where every caller already is: commands
    /// without `async`, menu, window and page events run there, so this happens at once).
    fn refresh(app: &AppHandle, steps: Option<UndoSteps>, focused: Option<bool>) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let Some(menu) = app.try_state::<EditMenu>() else {
                return;
            };
            let mut shown = menu.shown.lock().unwrap();
            if let Some(steps) = steps {
                shown.0 = steps;
            }
            let named = shown.0 != UndoSteps::default();
            let focused = named
                && focused.unwrap_or_else(|| {
                    app.get_webview_window(MAIN_WINDOW)
                        .and_then(|main| main.is_focused().ok())
                        .unwrap_or(false)
                });
            for (i, slot) in menu.slots.iter().enumerate() {
                let item =
                    bridge::edit_item(shown.0.get(slot.step), focused, slot.system.is_some());
                if shown.1[i].as_ref() != Some(&item) {
                    slot.show(&menu.edit, &item, shown.1[i].as_ref());
                    shown.1[i] = Some(item);
                }
            }
        });
    }
}

/// The app's own Undo or Redo was chosen: the main window's page does it (see
/// `bridge::page_step_script`), if that window still shows the open Workspace.
fn page_step(app: &AppHandle, step: Step) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let origin = app.state::<AppState>().granted.lock().unwrap().clone();
    let on_origin = matches!(
        (main.url().ok(), origin),
        (Some(page), Some(origin)) if address::same_origin(&page, &origin)
    );
    if on_origin {
        let _ = main.eval(bridge::page_step_script(step));
    }
}

/// Is the `claude` command available on this machine (`claude --version`).
#[tauri::command]
async fn claude_status(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
) -> Result<Status, String> {
    check_bridge_caller(&webview, &state, &key)?;
    let missing = Status {
        installed: false,
        version: None,
    };
    let status = tauri::async_runtime::spawn_blocking(|| {
        qoop_claude_driver::locate().map(|bin| Driver::new(bin).status())
    })
    .await;
    Ok(status.ok().flatten().unwrap_or(missing))
}

/// One turn. Every outcome is reported as an event; the command itself only fails when the
/// caller is not allowed.
#[tauri::command]
async fn claude_send(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
    request: SendRequest,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    let origin = check_bridge_caller(&webview, &state, &key)?;
    let fail = |message: &str| {
        let _ = on_event.send(AiEvent::Error {
            message: message.to_owned(),
        });
        Ok(())
    };
    let (id, request) = match bridge::validate(request, &origin) {
        Ok(valid) => valid,
        Err(message) => return fail(&message),
    };
    let Some(bin) = qoop_claude_driver::locate() else {
        return fail("Claude Code is not installed on this computer.");
    };
    let cancel = Cancel::new();
    let slot = {
        let mut active = state.run.0.lock().unwrap();
        if active.is_some() {
            return fail("Another answer is still being written.");
        }
        *active = Some((id, cancel.clone()));
        RunSlot(state.run.clone())
    };
    let events = on_event.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        Driver::new(bin).run(&request, &cancel, &mut |event| {
            let _ = events.send(event);
        });
    })
    .await;
    if finished.is_err() {
        return fail("Claude Code could not be run.");
    }
    Ok(())
}

/// Stops the run with this id, if it is the one in progress.
#[tauri::command]
fn claude_cancel(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
    id: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    if let Some((active, cancel)) = state.run.0.lock().unwrap().as_ref()
        && *active == id
    {
        cancel.cancel();
    }
    Ok(())
}

// ---- the Runner, for the server's pages ------------------------------------------------
//
// A page can read the status, ask for the settings window, ask for a Run and cancel it.
// None of these commands takes an interpreter, a folder or an approval.

/// The interpreter and folder Runs would use.
#[tauri::command]
async fn runner_status(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<qoop_runner::Status, String> {
    check_bridge_caller(&webview, &state, &key)?;
    let runner = runner(&app);
    tauri::async_runtime::spawn_blocking(move || runner.status())
        .await
        .map_err(|_| "The Runner could not be asked.".to_owned())
}

/// Opens the app's own Runner settings window; returns when it has been closed.
#[tauri::command]
async fn runner_configure(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    open_runner_settings(&app).map_err(|_| "The window could not be opened.".to_owned())?;
    let open = state.runner_settings.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || open.wait_closed(None)).await;
    Ok(())
}

/// One Run. Every outcome is reported as an event; the command itself only fails when the
/// caller is not allowed. The code is executed only if the Member approves it in the app's
/// own window (or approved the same code in this Workspace before): see `qoop_runner`.
#[tauri::command]
async fn runner_run(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    request: qoop_runner::RunRequest,
    on_event: Channel<qoop_runner::RunEvent>,
) -> Result<(), String> {
    // The Workspace approvals are remembered for is the one the app opened, not anything
    // the page says about itself.
    check_bridge_caller(&webview, &state, &key)?;
    let workspace = state
        .open
        .lock()
        .unwrap()
        .as_ref()
        .map(|open| open.approvals.clone());
    let Some(workspace) = workspace else {
        let _ = on_event.send(qoop_runner::RunEvent::Error {
            reason: qoop_runner::Reason::Failed,
            message: "The Run could not be carried out.".to_owned(),
        });
        return Ok(());
    };
    let runner = runner(&app);
    let windows = RunnerWindows(app.clone());
    let events = on_event.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        runner.run(request, &workspace, &windows, &mut |event| {
            let _ = events.send(event);
        });
    })
    .await;
    if finished.is_err() {
        let _ = on_event.send(qoop_runner::RunEvent::Error {
            reason: qoop_runner::Reason::Failed,
            message: "The Run could not be carried out.".to_owned(),
        });
    }
    Ok(())
}

/// Stops the Run with this id, if it is the one in progress.
#[tauri::command]
fn runner_cancel(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    id: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    runner(&app).cancel(&id);
    Ok(())
}

// ---- commands of the approval window ---------------------------------------------------
//
// Callable only from the app's own approval window (its capability, and the check below).
// The question a window may see and answer is the one in its label.

fn check_approval_caller(webview: &Webview) -> Result<u64, String> {
    bridge::check_approval_caller(webview.label(), webview.url().ok().as_ref())
}

/// What the window shows: the code, where it came from, where it would run.
#[tauri::command]
fn approval_view(webview: Webview, app: AppHandle) -> Result<ApprovalView, String> {
    let ticket = check_approval_caller(&webview)?;
    runner(&app)
        .approval_view(ticket)
        .map(|view| (*view).clone())
        .ok_or_else(|| "This question is no longer open.".to_owned())
}

/// The Member's answer. The window closes, except when "Run" came too soon to be meant.
#[tauri::command]
fn approval_decide(webview: Webview, app: AppHandle, run: bool) -> Result<(), String> {
    let ticket = check_approval_caller(&webview)?;
    if let Err(DecideError::TooSoon) = runner(&app).approval_decide(ticket, run) {
        return Err("Read the code first, then choose.".to_owned());
    }
    // Answered, or no longer open: either way this window is done.
    if let Some(window) = app.get_webview_window(webview.label()) {
        let _ = window.destroy();
    }
    Ok(())
}

// ---- commands of the Runner settings window --------------------------------------------

fn check_settings_caller(webview: &Webview) -> Result<(), String> {
    bridge::check_settings_caller(webview.label(), webview.url().ok().as_ref())
}

fn close_runner_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.close();
    }
}

/// The current choice and the interpreters found on this computer (slow: it asks the
/// Member's shell and each interpreter).
#[tauri::command]
async fn runner_settings_view(webview: Webview, app: AppHandle) -> Result<SettingsView, String> {
    check_settings_caller(&webview)?;
    let runner = runner(&app);
    tauri::async_runtime::spawn_blocking(move || runner.settings_view())
        .await
        .map_err(|_| "Infall could not look for Python on this computer.".to_owned())
}

/// Checks and saves the Member's choice, then closes the window.
#[tauri::command]
async fn runner_settings_save(
    webview: Webview,
    app: AppHandle,
    python: Option<String>,
    folder: Option<String>,
) -> Result<(), String> {
    check_settings_caller(&webview)?;
    let runner = runner(&app);
    tauri::async_runtime::spawn_blocking(move || {
        runner.settings_save(python.as_deref(), folder.as_deref())
    })
    .await
    .map_err(|_| "The settings could not be checked. Try again.".to_owned())??;
    close_runner_settings(&app);
    Ok(())
}

/// Forgets every remembered approval.
#[tauri::command]
fn runner_settings_forget(webview: Webview, app: AppHandle) -> Result<(), String> {
    check_settings_caller(&webview)?;
    runner(&app).forget_approvals()
}

/// Closes the window without saving.
#[tauri::command]
fn runner_settings_close(webview: Webview, app: AppHandle) -> Result<(), String> {
    check_settings_caller(&webview)?;
    close_runner_settings(&app);
    Ok(())
}
