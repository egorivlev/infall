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
use crate::datadir;
use crate::files;
use crate::portable::{self, MAX_SAVE_BYTES, WORKSPACE_EXTENSION};
use crate::transfer::{self, Upload};
use crate::update;
use crate::webui;
use crate::workspaces::{self, Entry, FilesSummary, Kind, Registry};

const SWITCH_WORKSPACE: &str = "switch-workspace";
const RUNNER_SETTINGS: &str = "runner-settings";
#[cfg(target_os = "linux")]
const QUIT: &str = "quit";
#[cfg(infall_updater)]
const CHECK_UPDATES: &str = "check-updates";
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
    /// The file the main window's page is sending for `saveBinaryFile` or `openExternally`,
    /// until it is saved or opened. One at a time; forgotten when the page goes away.
    upload: Mutex<Option<Upload>>,
    /// The folders the main window's page picked (`pickFolder`); forgotten when it goes away.
    folders: Mutex<files::Folders>,
    /// When a PDF was last handed to the system's viewer (ms since the epoch).
    last_viewer: AtomicU64,
    /// The version of Infall downloaded and ready to install, if any (only a build with the
    /// updater ever has one).
    update_ready: Mutex<Option<String>>,
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
    /// The app's cache folder: the PDFs handed to the system's viewer (`files`).
    cache_dir: PathBuf,
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

/// The app's configuration (tauri.conf.json), with the updater's key and feed filled in when
/// this build has an updater.
fn context() -> tauri::Context<Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(infall_updater)]
    updating::configure(&mut context);
    context
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(infall_updater)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
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
            upload: Mutex::new(None),
            folders: Mutex::default(),
            last_viewer: AtomicU64::new(0),
            update_ready: Mutex::new(None),
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
            workspace_move,
            update_view,
            update_install,
            claude_status,
            claude_send,
            claude_cancel,
            switch_workspace,
            save_file,
            print_page,
            undo_state,
            move_handover,
            move_file_chunk,
            move_done,
            save_binary_begin,
            save_binary_chunk,
            save_binary_finish,
            pick_folder,
            folder_file_chunk,
            open_external_finish,
            runner_status,
            runner_configure,
            runner_run,
            runner_start,
            runner_cancel,
            approval_view,
            approval_decide,
            runner_settings_view,
            runner_settings_save,
            runner_settings_change,
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
            let roaming = handle
                .path()
                .app_data_dir()
                .map_err(|_| "the app has no data directory")?;
            // Windows: Local Workspaces live in the local (non-roaming) data folder since
            // 0.9.0; those an earlier version kept in the roaming one are moved across now,
            // and any that cannot be are used from where they are (see `datadir`).
            let local = if cfg!(windows) {
                handle
                    .path()
                    .app_local_data_dir()
                    .map_err(|_| "the app has no local data directory")?
            } else {
                roaming.clone()
            };
            let (data, legacy) = datadir::choose(roaming, local);
            if let Some(old) = &legacy {
                let moved = datadir::move_workspaces(old, &data);
                if let Some(notice) = moved.notice(old, &data) {
                    *handle.state::<AppState>().notice.lock().unwrap() = Some(notice);
                }
            }
            // PDFs handed to the system's viewer are temporary: none outlives a run of the app.
            let cache = handle
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| data.join("cache"));
            files::clear_viewer_files(&cache);
            app.manage::<RunnerState>(Arc::new(Runner::new(
                qoop_runner::Options::from_process_env(config.clone()),
            )));
            #[cfg(infall_updater)]
            updating::at_start(&handle, config.clone());
            let registry = Registry::with_legacy(config, data.clone(), legacy);
            // What a move cut short left behind, and moves no page took within a week.
            registry.sweep_moves();
            registry.prune_moves(now_ms() as i64);
            app.manage(Workspaces {
                registry: Mutex::new(registry),
                data_dir: data,
                cache_dir: cache,
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
            #[cfg(infall_updater)]
            CHECK_UPDATES => updating::check_from_menu(app),
            UNDO => page_step(app, Step::Undo),
            REDO => page_step(app, Step::Redo),
            #[cfg(target_os = "linux")]
            QUIT => app.exit(0),
            _ => {}
        })
        .build(context())
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
            if let Some(ws) = app.try_state::<Workspaces>() {
                files::clear_viewer_files(&ws.cache_dir);
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
        .item(&runner_settings);
    #[cfg(infall_updater)]
    let app_menu =
        app_menu.item(&MenuItemBuilder::with_id(CHECK_UPDATES, "Check for updates…").build(app)?);
    let app_menu = app_menu.separator().item(&quit).build()?;
    let edit = EditMenu::build(app, |edit| edit)?;
    app.set_menu(MenuBuilder::new(app).item(&app_menu).item(&edit).build()?)?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let switch = MenuItemBuilder::with_id(SWITCH_WORKSPACE, "Switch Workspace…").build(app)?;
    let runner_settings =
        MenuItemBuilder::with_id(RUNNER_SETTINGS, "Runner settings…").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Infall").about(None);
    #[cfg(infall_updater)]
    let app_menu =
        app_menu.item(&MenuItemBuilder::with_id(CHECK_UPDATES, "Check for updates…").build(app)?);
    let app_menu = app_menu
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
                    // A Run that names its language and environment (M19, M19b). A new
                    // command, so that an app from before it has none: a page that needs it
                    // finds `runner.start` missing there and refuses, instead of an old app
                    // running Julia code as Python.
                    .permission("allow-runner-start")
                    .permission("allow-runner-cancel")
                    .permission("allow-switch-workspace")
                    // Saving an export where the Member chooses, in the system's dialog, and
                    // printing the page (macOS; see `bridge::OWN_PRINT`).
                    .permission("allow-save-file")
                    .permission("allow-print-page")
                    // What the page's Undo and Redo would do, for the Edit menu (M15).
                    .permission("allow-undo-state")
                    // Moving a Local Workspace onto this server: what is being moved, its
                    // file, and that the server has it (M18). Each answers only the page of
                    // a server a move is pending to.
                    .permission("allow-move-handover")
                    .permission("allow-move-file-chunk")
                    .permission("allow-move-done")
                    // Saving a file the page made (an image, a Workspace file) where the
                    // Member chooses (M18).
                    .permission("allow-save-binary-begin")
                    .permission("allow-save-binary-chunk")
                    .permission("allow-save-binary-finish")
                    // PDFs (M19): a folder the Member picks in the system's dialog and the PDFs
                    // inside it, read through a token (never a path); a PDF the page hands over,
                    // opened in the system's viewer. `openExternally` sends its bytes with the
                    // two `save_binary_*` commands above.
                    .permission("allow-pick-folder")
                    .permission("allow-folder-file-chunk")
                    .permission("allow-open-external-finish")
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
                // And a file it was sending will never be finished; the folders it picked are
                // not the next page's.
                *window.state::<AppState>().upload.lock().unwrap() = None;
                window.state::<AppState>().folders.lock().unwrap().clear();
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
            *closed_app.state::<AppState>().upload.lock().unwrap() = None;
            closed_app
                .state::<AppState>()
                .folders
                .lock()
                .unwrap()
                .clear();
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

/// The Runner settings window: which Python, which folder, environments and languages.
fn open_runner_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        return window.set_focus();
    }
    let open = app.state::<AppState>().runner_settings.clone();
    open.set(true);
    let built = local_window(app, SETTINGS_WINDOW, "runner.html")
        .title("Runner settings")
        .inner_size(680.0, 760.0)
        .min_inner_size(520.0, 460.0)
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
    let (db, port) = {
        let registry = ws.registry.lock().unwrap();
        // Without a remembered port (the list could not be saved) the OS chooses one; the
        // Workspace opens all the same, only its address is new.
        (
            registry.db_path(&entry.id),
            registry.port_for(&entry.id).ok().flatten(),
        )
    };
    let options = local_options(entry, db, web_dir, port);
    // The start screen gets a sentence; what the server said is not ours to word. Debug
    // builds print it for whoever is working on the app (it names files, never the key).
    start_local(options).await.map_err(|_error| {
        #[cfg(debug_assertions)]
        eprintln!("The Local Workspace did not start: {_error}");
        NOT_STARTED.to_owned()
    })
}

/// How a Local Workspace's server is started. The one place that says whether it is
/// read-only (a Workspace moved to a Team server, docs/specs/team-move.md, Contract A).
fn local_options(entry: &Entry, db: PathBuf, web_dir: PathBuf, port: Option<u16>) -> LocalOptions {
    let preset = entry
        .preset
        .as_deref()
        .and_then(Preset::from_id)
        .unwrap_or(Preset::Blank);
    let read_only = entry.read_only();
    let moved_to = if read_only {
        entry.moved_to.clone()
    } else {
        None
    };
    LocalOptions {
        db,
        web_dir,
        preset,
        member_name: workspaces::member_name(),
        // When it is taken the server listens on another port for this once; the
        // remembered one is kept for the next start.
        port,
        read_only,
        moved_to,
    }
}

/// Contract A's `export_for_move` (docs/specs/team-move.md): a Workspace file to hand to a
/// Team server. The same as `export_workspace` by the contract, under its own name so that a
/// later difference has a place.
fn export_for_move(db: &Path, dest: &Path) -> Result<(), PortError> {
    qoop_server::local::export_for_move(db, dest)
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
    let registry = workspaces(&app);
    let registry = registry.registry.lock().unwrap();
    registry.prune_moves(now_ms() as i64);
    let listed = registry
        .list()
        .iter()
        .map(|entry| {
            let mut listed = entry.listed();
            if entry.kind == Kind::Local {
                listed.files = stored_files(&registry.db_path(&entry.id));
            }
            listed
        })
        .collect();
    Ok(StartView {
        workspaces: listed,
        notice: state.notice.lock().unwrap().take(),
    })
}

/// How many PDFs a Local Workspace keeps with its database, and their size (`WorkspaceEntry
/// .files`): when it has some, Export… asks whether to include them.
fn stored_files(db: &Path) -> Option<FilesSummary> {
    // TODO(M19 zone 1): once the server crate can count a Workspace's stored PDFs, answer
    // `Some(FilesSummary { count, bytes })` from it here (`None` when it cannot be read).
    let _ = db;
    None
}

/// Writes a Workspace file of the database at `db` to `dest`, with the Workspace's PDFs or
/// without them (docs/specs/pdf-sources.md, decision 6; Export… asks, backups always include
/// them).
fn export_with_files(db: &Path, dest: &Path, include_files: bool) -> Result<(), PortError> {
    // TODO(M19 zone 1): replace the next two lines with
    // `export_workspace_with(db, dest, ExportOptions { include_files })` (and import both).
    let _ = include_files;
    export_workspace(db, dest)
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
/// `include_files` (`includeFiles` on the page): whether its PDFs go in; absent, they do.
#[tauri::command]
async fn workspace_export(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    include_files: Option<bool>,
) -> Result<Option<String>, String> {
    let include_files = include_files.unwrap_or(true);
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
            |tmp| {
                export_with_files(&db, tmp, include_files)
                    .map_err(|e| port_sentence(e, NOT_WRITTEN))
            },
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

/// Moves a Local Workspace onto a Team server (docs/specs/team-move.md, decision 4 and
/// Contract C): checks the address as `workspace_connect` does, writes a Workspace file of
/// it into the app's own private folder, remembers the pending move, remembers the Team
/// Workspace and opens it. The server's page then takes the file through the bridge
/// (`moveHandover`, `moveFile`, `moveDone`); until it says it has it, nothing about the Local
/// Workspace changes.
#[tauri::command]
async fn workspace_move(
    webview: Webview,
    app: AppHandle,
    id: String,
    address: String,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    let entry = local_entry(&app, &id).map_err(|_| {
        "Only a workspace on this computer can be moved to a Team server.".to_owned()
    })?;
    if let Some(to) = &entry.moved_to {
        return Err(format!(
            "This workspace was already moved to {}; open it there.",
            to.split_once("://").map_or(to.as_str(), |(_, host)| host)
        ));
    }
    let db = workspaces(&app).registry.lock().unwrap().db_path(&id);
    if !db.is_file() {
        return Err("This workspace has nothing in it to move yet.".to_owned());
    }
    let origin = address::parse_server_address(&address)?;
    let checked = origin.clone();
    tauri::async_runtime::spawn_blocking(move || address::check_health(&checked))
        .await
        .map_err(|_| "The address could not be checked. Try again.".to_owned())??;

    // The Team Workspace is remembered first: a move is kept only towards one that is.
    let team = workspaces(&app)
        .registry
        .lock()
        .unwrap()
        .remember_team(&origin)?;
    let (file, dest) = workspaces(&app).registry.lock().unwrap().new_move_file()?;
    const NOT_COPIED: &str = "The workspace could not be copied for the move.";
    let written = dest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        portable::write_replacing(
            &written,
            |tmp| export_for_move(&db, tmp).map_err(|e| port_sentence(e, NOT_COPIED)),
            NOT_COPIED,
        )
    })
    .await
    .map_err(|_| NOT_COPIED.to_owned())??;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    if size > transfer::MAX_MOVE_BYTES {
        let _ = std::fs::remove_file(&dest);
        return Err(format!(
            "This workspace is too large to move in one file (at most {} MB).",
            transfer::MAX_MOVE_BYTES / (1024 * 1024)
        ));
    }
    let kept = workspaces(&app).registry.lock().unwrap().add_pending_move(
        &id,
        &origin,
        &file,
        now_ms() as i64,
    );
    if let Err(message) = kept {
        let _ = std::fs::remove_file(&dest);
        return Err(message);
    }
    // Should it not open now, the move stays pending (a week): signing in to that server
    // later picks it up.
    open_workspace(&app, team).await
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

// ---- moving a Local Workspace onto this server (docs/specs/team-move.md, Contract C) ----
//
// Each of these answers only the main window's page, on the open Workspace's origin, with
// the key (`check_bridge_caller`), and only about a move pending to that origin: a page of
// any other server learns nothing and gets nothing.

/// The pending move's Workspace name and file size, or `None` when nothing is being moved
/// to this server.
#[tauri::command]
fn move_handover(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<workspaces::Handover>, String> {
    let origin = check_bridge_caller(&webview, &state, &key)?;
    Ok(workspaces(&app)
        .registry
        .lock()
        .unwrap()
        .handover(&origin, now_ms() as i64))
}

const NOTHING_TO_HAND_OVER: &str = "There is no workspace from this computer to bring in.";

/// A piece of the pending move's Workspace file (see `transfer`): the bridge script calls
/// it until it has the whole file.
#[tauri::command]
async fn move_file_chunk(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    offset: u64,
) -> Result<transfer::Chunk, String> {
    let origin = check_bridge_caller(&webview, &state, &key)?;
    let path = {
        let ws = workspaces(&app);
        let registry = ws.registry.lock().unwrap();
        let pending = registry
            .pending_move(&origin, now_ms() as i64)
            .ok_or(NOTHING_TO_HAND_OVER)?;
        registry.move_file_path(&pending)
    };
    tauri::async_runtime::spawn_blocking(move || transfer::read_chunk(&path, offset))
        .await
        .map_err(|_| "The Workspace file could not be read. Try again.".to_owned())?
}

/// The page says whether this server took the Workspace. `ok`: the Local Workspace is marked
/// as moved here (it opens read-only from now on) and its file is deleted. Not `ok`: the move
/// stays, so the Admin can try again.
#[tauri::command]
fn move_done(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    ok: bool,
) -> Result<(), String> {
    let origin = check_bridge_caller(&webview, &state, &key)?;
    let ws = workspaces(&app);
    let registry = ws.registry.lock().unwrap();
    if registry.pending_move(&origin, now_ms() as i64).is_none() {
        return Err(NOTHING_TO_HAND_OVER.to_owned());
    }
    if ok {
        registry.finish_move(&origin)?;
    }
    Ok(())
}

// ---- saving a file the page made (docs/specs/desktop.md, M18) ---------------------------
//
// `saveBinaryFile`: the bytes come first, in pieces (see `transfer`), then the save dialog,
// as for `saveFile`. One file at a time; a new one, or the page going away, drops the last.

/// Starts receiving a file of `size` bytes; the ticket names it in the next calls.
#[tauri::command]
fn save_binary_begin(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
    size: u64,
) -> Result<String, String> {
    check_bridge_caller(&webview, &state, &key)?;
    let upload = Upload::begin(size)?;
    let ticket = upload.ticket().to_owned();
    *state.upload.lock().unwrap() = Some(upload);
    Ok(ticket)
}

/// The next piece of the file, as base64, starting at `offset`.
#[tauri::command]
fn save_binary_chunk(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
    ticket: String,
    offset: u64,
    data: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    let mut slot = state.upload.lock().unwrap();
    let pushed = match slot.as_mut() {
        Some(upload) => upload.push(&ticket, offset, &data),
        None => Err("The file could not be saved. Try again.".to_owned()),
    };
    if pushed.is_err() {
        // Half a file is never saved: the page starts again.
        *slot = None;
    }
    pushed
}

/// All of it has come: the system's save dialog, suggesting `suggested_name` (made safe as
/// for `saveFile`), then the file is written whole. `false` when the Member cancelled.
#[tauri::command]
async fn save_binary_finish(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    ticket: String,
    suggested_name: String,
) -> Result<bool, String> {
    check_bridge_caller(&webview, &state, &key)?;
    let upload = state.upload.lock().unwrap().take();
    let bytes = upload
        .ok_or_else(|| "The file could not be saved. Try again.".to_owned())?
        .finish(&ticket)?;
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
            |tmp| std::fs::write(tmp, &bytes).map_err(|_| NOT_WRITTEN.to_owned()),
            NOT_WRITTEN,
        )
    })
    .await
    .map_err(|_| NOT_WRITTEN.to_owned())??;
    Ok(true)
}

// ---- PDFs (docs/specs/pdf-sources.md, decision 10 and "Desktop"; desktop.md, M19) --------
//
// `pickFolder`: the system's folder dialog; the page gets a token and the folder's name, never
// its path. `readFileIn`: a PDF inside that folder, in pieces (see `files`, `transfer`).
// `openExternally`: a PDF the page hands over (its bytes sent as for `saveBinaryFile`), written
// to a private temporary file and opened in the system's viewer.

/// The system's folder dialog. `None` when the Member cancelled.
#[tauri::command]
async fn pick_folder(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<files::Picked>, String> {
    check_bridge_caller(&webview, &state, &key)?;
    let chosen = {
        let _dialog = DialogSlot::take(&state)?;
        let parent = webview.window();
        ask_path(&app, move || {
            rfd::AsyncFileDialog::new()
                .set_parent(&parent)
                .set_title("Choose the folder with the PDFs")
                .pick_folder()
        })
        .await?
    };
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    // Still the page that asked: one that came after it must not get its folder.
    check_bridge_caller(&webview, &state, &key)?;
    state.folders.lock().unwrap().pick(&chosen).map(Some)
}

/// A piece of the PDF `path` names inside the folder of `token` (see `files::resolve_in`).
#[tauri::command]
async fn folder_file_chunk(
    webview: Webview,
    state: State<'_, AppState>,
    key: String,
    token: String,
    path: String,
    offset: u64,
) -> Result<transfer::Chunk, String> {
    check_bridge_caller(&webview, &state, &key)?;
    let folder = state
        .folders
        .lock()
        .unwrap()
        .get(&token)
        .map(Path::to_path_buf)
        .ok_or("Choose the folder again.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = files::resolve_in(&folder, &path)?;
        files::read_pdf_chunk(&file, offset)
    })
    .await
    .map_err(|_| "The file could not be read. Try again.".to_owned())?
}

/// The PDF the page sent (`save_binary_begin` and `save_binary_chunk` first) is written to a
/// private temporary file and opened in the system's viewer. At most one every second.
#[tauri::command]
async fn open_external_finish(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    ticket: String,
    suggested_name: String,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    let upload = state.upload.lock().unwrap().take();
    let bytes = upload
        .ok_or_else(|| "The PDF could not be opened. Try again.".to_owned())?
        .finish(&ticket)?;
    files::check_for_viewer(&bytes)?;
    let now = now_ms();
    let last = state.last_viewer.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 1000
        || state
            .last_viewer
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return Err("A PDF is being opened already. Try again in a moment.".to_owned());
    }
    let cache = workspaces(&app).cache_dir.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        files::write_for_viewer(&cache, &suggested_name, &bytes)
    })
    .await
    .map_err(|_| "The PDF could not be opened on this computer.".to_owned())??;
    // Handed to the operating system as one argument; no shell is involved. The file ends in
    // `.pdf` and starts as a PDF does, so it opens in whatever views PDFs here.
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|_| "No program on this computer opened the PDF.".to_owned())
}

// ---- updates (docs/specs/release.md, section 11) -----------------------------------------

/// What the start screen says about an update: the version downloaded and ready, if any.
#[derive(serde::Serialize)]
struct UpdateView {
    version: String,
    notice: String,
}

/// The update that is ready to install, if any. Always `None` in a build without the updater.
#[tauri::command]
fn update_view(webview: Webview, state: State<'_, AppState>) -> Result<Option<UpdateView>, String> {
    check_setup_caller(&webview)?;
    Ok(state
        .update_ready
        .lock()
        .unwrap()
        .clone()
        .map(|version| UpdateView {
            notice: update::ready_notice(&version),
            version,
        }))
}

/// "Restart to update": every Local Workspace is backed up, then the update is installed and
/// the app starts again as the new version. Only from the start screen, never while a
/// Workspace is open.
#[tauri::command]
async fn update_install(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    #[cfg(infall_updater)]
    {
        updating::install(&app, &state).await
    }
    #[cfg(not(infall_updater))]
    {
        let _ = (app, state);
        Err("This version of Infall does not update itself.".to_owned())
    }
}

/// Makes a backup of every Local Workspace now, as the automatic backups are made (the same
/// format, the same folder, the newest seven kept): what is done before an update is
/// installed. The first that fails stops it, with a sentence that names that Workspace.
#[cfg_attr(not(infall_updater), allow(dead_code))]
async fn back_up_every_workspace(app: &AppHandle) -> Result<(), String> {
    let locals: Vec<(Entry, PathBuf, PathBuf)> = {
        let ws = workspaces(app);
        let registry = ws.registry.lock().unwrap();
        registry
            .list()
            .into_iter()
            .filter(|e| e.kind == Kind::Local)
            .map(|e| {
                let (db, dir) = (registry.db_path(&e.id), registry.backups_dir(&e.id));
                (e, db, dir)
            })
            .collect()
    };
    let state = app.state::<AppState>();
    for (entry, db, dir) in locals {
        // Never opened: nothing in it to lose.
        if !db.is_file() {
            continue;
        }
        backup_done(&state, &entry.id).await;
        let made = tauri::async_runtime::spawn_blocking(move || {
            portable::back_up_now(&db, &dir, now_ms() as i64, |db, dest| {
                export_workspace(db, dest).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|made| made);
        match made {
            Ok(newest) => {
                let _ = workspaces(app)
                    .registry
                    .lock()
                    .unwrap()
                    .set_last_backup(&entry.id, newest);
            }
            Err(error) => {
                eprintln!("Infall: no backup of a workspace was made before the update: {error}");
                return Err(format!(
                    "“{}” could not be backed up, so the update was not installed. Nothing has \
                     changed; try again, or export that workspace first.",
                    entry.name
                ));
            }
        }
    }
    Ok(())
}

/// The updater itself: only in a build with it (see build.rs and `update`).
#[cfg(infall_updater)]
mod updating {
    use super::*;
    use tauri_plugin_updater::{Update, UpdaterExt};

    /// The update downloaded and checked, with its bytes, until it is installed.
    #[derive(Default)]
    pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

    /// One check at a time.
    static CHECKING: AtomicBool = AtomicBool::new(false);

    /// The key and the feed this build was given, into the plugin's configuration.
    pub fn configure(context: &mut tauri::Context<Wry>) {
        let plugins = &mut context.config_mut().plugins.0;
        let base = plugins.get("updater").cloned();
        let config = update::plugin_config(
            base.as_ref(),
            update::PUBKEY.unwrap_or_default().trim(),
            update::URL.unwrap_or_default().trim(),
        );
        plugins.insert("updater".to_owned(), config);
    }

    /// When the app starts: a check, if the last one is a day old, in the background. Nothing
    /// is said unless it finds a new version.
    pub fn at_start(app: &AppHandle, config: PathBuf) {
        app.manage(Pending::default());
        if !update::check_due(&config, now_ms() as i64) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // A failed check (no network) is tried again at the next start.
            if check(&app).await != update::Checked::Failed {
                update::record_check(&config, now_ms() as i64);
            }
        });
    }

    /// Asks the feed; a newer version is downloaded and its signature checked, then the start
    /// screen offers it.
    pub async fn check(app: &AppHandle) -> update::Checked {
        use update::Checked;
        if CHECKING.swap(true, Ordering::AcqRel) {
            return Checked::Failed;
        }
        struct Done;
        impl Drop for Done {
            fn drop(&mut self) {
                CHECKING.store(false, Ordering::Release);
            }
        }
        let _done = Done;
        let Ok(updater) = app.updater() else {
            return Checked::Failed;
        };
        let found = match updater.check().await {
            Ok(Some(found)) => found,
            Ok(None) => return Checked::UpToDate,
            Err(error) => {
                eprintln!("Infall: the update check failed: {error}");
                return Checked::Failed;
            }
        };
        let Some(version) = update::shown_version(&found.version) else {
            return Checked::Failed;
        };
        let state = app.state::<AppState>();
        if state.update_ready.lock().unwrap().as_deref() == Some(version.as_str()) {
            return Checked::Ready(version);
        }
        // `download` checks the signature against the key built into the app.
        match found.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                eprintln!("Infall: version {version} is downloaded, checked and ready to install");
                *app.state::<Pending>().0.lock().unwrap() = Some((found, bytes));
                *state.update_ready.lock().unwrap() = Some(version.clone());
                Checked::Ready(version)
            }
            Err(error) => {
                eprintln!("Infall: the update was not downloaded: {error}");
                Checked::Failed
            }
        }
    }

    /// "Check for updates…": checks now, whenever the last check was, and says what it found
    /// in a message of the system's (the Member asked).
    pub fn check_from_menu(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let checked = check(&app).await;
            let current = app.package_info().version.to_string();
            let (title, text) = checked.message(&current);
            let parent = app
                .get_webview_window(MAIN_WINDOW)
                .or_else(|| app.get_webview_window(SETUP_WINDOW))
                .map(|w| w.as_ref().window());
            let _ = app.run_on_main_thread(move || {
                let mut dialog = rfd::AsyncMessageDialog::new()
                    .set_level(rfd::MessageLevel::Info)
                    .set_title(title)
                    .set_description(text)
                    .set_buttons(rfd::MessageButtons::Ok);
                if let Some(window) = &parent {
                    dialog = dialog.set_parent(window);
                }
                let shown = dialog.show();
                std::thread::spawn(move || {
                    let _ = tauri::async_runtime::block_on(shown);
                });
            });
        });
    }

    /// Backs every Local Workspace up, then installs the update and starts again.
    pub async fn install(app: &AppHandle, state: &AppState) -> Result<(), String> {
        if app.get_webview_window(MAIN_WINDOW).is_some() {
            return Err("Close the open workspace first.".to_owned());
        }
        let _opening = state
            .opening
            .try_lock()
            .map_err(|_| "A workspace is being opened; try again in a moment.".to_owned())?;
        let pending = app.state::<Pending>().0.lock().unwrap().take();
        let Some((found, bytes)) = pending else {
            return Err("There is no update to install.".to_owned());
        };
        state.stopped().await;
        if let Err(message) = back_up_every_workspace(app).await {
            *app.state::<Pending>().0.lock().unwrap() = Some((found, bytes));
            return Err(message);
        }
        let installed =
            tauri::async_runtime::spawn_blocking(move || found.install(&bytes).map(|()| bytes))
                .await
                .map_err(|_| ());
        match installed {
            // On Windows the installer has taken over and the app has ended before this.
            Ok(Ok(_)) => app.restart(),
            Ok(Err(error)) => {
                eprintln!("Infall: the update was not installed: {error}");
                *state.update_ready.lock().unwrap() = None;
                Err(
                    "The update could not be installed. Infall is unchanged; download the new \
                     version from the download page instead."
                        .to_owned(),
                )
            }
            Err(()) => Err("The update could not be installed. Try again.".to_owned()),
        }
    }
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

/// Opens the app's own Runner settings window; returns when it has been closed. `lang`: a
/// language a Run is in, to be shown set up (or ready to be set up) there. A name, nothing
/// more: the window shows it as text.
#[tauri::command]
async fn runner_configure(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    lang: Option<String>,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    let runner = runner(&app);
    // Only when nothing else (a Run) is asking already.
    let asks = lang
        .filter(|l| qoop_runner::toolchains::valid_id(l))
        .filter(|_| runner.asking().is_none());
    if let Some(lang) = &asks {
        runner.set_asking(Some(qoop_runner::Ask::Lang(lang.clone())));
    }
    let opened = open_runner_settings(&app);
    if opened.is_ok() {
        let open = state.runner_settings.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || open.wait_closed(None)).await;
    }
    if asks.is_some() && matches!(runner.asking(), Some(qoop_runner::Ask::Lang(_))) {
        runner.set_asking(None);
    }
    opened.map_err(|_| "The window could not be opened.".to_owned())
}

/// One Run, as the Workspace the main window shows asked for it. Every outcome is reported
/// as an event.
async fn start_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: qoop_runner::RunRequest,
    on_event: Channel<qoop_runner::RunEvent>,
) -> Result<(), String> {
    // The Workspace approvals are remembered for is the one the app opened, not anything
    // the page says about itself.
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

/// A Run of Python code in the default environment: `runner.run`, exactly as in M8. The
/// code is executed only if the Member approves it in the app's own window (or approved the
/// same code in this Workspace before): see `qoop_runner`. A request naming another language
/// is refused here, never run as Python: such a Run is asked for with `runner_start`.
#[tauri::command]
async fn runner_run(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    mut request: qoop_runner::RunRequest,
    on_event: Channel<qoop_runner::RunEvent>,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    if request
        .lang
        .as_deref()
        .is_some_and(|lang| lang != qoop_runner::toolchains::PYTHON)
    {
        let _ = on_event.send(qoop_runner::RunEvent::Error {
            reason: qoop_runner::Reason::Failed,
            message: "This Run is not in Python, and was not asked for as such.".to_owned(),
        });
        return Ok(());
    }
    request.lang = None;
    request.env = None;
    start_run(app, state, request, on_event).await
}

/// A Run that names its language and, for Python and Q#, its environment (`runner.start`,
/// M19 and M19b). Names only: what they start is decided by this device's settings, and the
/// code is executed only after the Member's approval, as for `runner_run`.
#[tauri::command]
async fn runner_start(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    request: qoop_runner::RunRequest,
    on_event: Channel<qoop_runner::RunEvent>,
) -> Result<(), String> {
    check_bridge_caller(&webview, &state, &key)?;
    start_run(app, state, request, on_event).await
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

/// The current choices, and the interpreters, environments and programs found on this
/// computer. `refresh` ("Check again"): look for them again (slow: it asks the Member's shell
/// and each candidate); otherwise what was found when the window last looked.
#[tauri::command]
async fn runner_settings_view(
    webview: Webview,
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<SettingsView, String> {
    check_settings_caller(&webview)?;
    let runner = runner(&app);
    tauri::async_runtime::spawn_blocking(move || runner.settings_view(refresh.unwrap_or(false)))
        .await
        .map_err(|_| "Infall could not look for Python on this computer.".to_owned())
}

/// One change made in the window (an environment, a name, Q#, a language); the window stays
/// open and reads the view again.
#[tauri::command]
async fn runner_settings_change(
    webview: Webview,
    app: AppHandle,
    change: qoop_runner::Change,
) -> Result<(), String> {
    check_settings_caller(&webview)?;
    let runner = runner(&app);
    tauri::async_runtime::spawn_blocking(move || runner.settings_change(change))
        .await
        .map_err(|_| "The settings could not be checked. Try again.".to_owned())?
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
