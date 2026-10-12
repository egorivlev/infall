//! The Tauri layer: windows, the menu, and the commands. Everything with a rule in it lives
//! in `address`, `bridge`, `config` and the `qoop-claude-driver` and `qoop-runner` crates;
//! this file only connects them to Tauri.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use qoop_claude_driver::{AiEvent, Cancel, Driver, Status};
use qoop_runner::{ApprovalView, DecideError, Runner, SettingsView};
use tauri::ipc::{CapabilityBuilder, Channel};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, State, Url, Webview, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::address::{self, Navigation};
use crate::bridge::{self, MAIN_WINDOW, SETTINGS_WINDOW, SendRequest};
use crate::config;

const SETUP_WINDOW: &str = "setup";
const CHANGE_SERVER: &str = "change-server";
const RUNNER_SETTINGS: &str = "runner-settings";

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

struct AppState {
    /// The server origin the main window shows and the bridge is granted to.
    origin: Mutex<Option<String>>,
    /// Held only by the bridge script; see `bridge::check_caller`.
    bridge_key: String,
    run: ActiveRun,
    /// When a blocked navigation last opened the system browser (ms since the epoch).
    last_external: AtomicU64,
    runner_settings: Arc<SettingsWindow>,
}

/// The Runner. Managed on its own because it needs the app's config directory, which is
/// only known once the app is being set up.
type RunnerState = Arc<Runner>;

fn runner(app: &AppHandle) -> RunnerState {
    app.state::<RunnerState>().inner().clone()
}

fn random_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system provides random bytes");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState {
            origin: Mutex::new(None),
            bridge_key: random_key(),
            run: ActiveRun::default(),
            last_external: AtomicU64::new(0),
            runner_settings: Arc::default(),
        })
        .invoke_handler(tauri::generate_handler![
            setup_current,
            setup_save,
            claude_status,
            claude_send,
            claude_cancel,
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
            // config directory. Without one there is nowhere safe to keep them: no fallback.
            let dir = config_dir(&handle).ok_or("the app has no config directory")?;
            app.manage::<RunnerState>(Arc::new(Runner::new(
                qoop_runner::Options::from_process_env(dir),
            )));
            build_menu(&handle)?;
            match config_dir(&handle).and_then(|dir| config::load(&dir)) {
                Some(origin) => open_main(&handle, &origin)?,
                None => open_setup(&handle)?,
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            CHANGE_SERVER => change_server(app),
            RUNNER_SETTINGS => {
                let _ = open_runner_settings(app);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("the Qoop desktop app could not start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Leave no `claude` and no Run behind: stop them and wait for their process
            // groups to go.
            let run = app.state::<AppState>().run.clone();
            run.cancel();
            let runner = app.try_state::<RunnerState>().map(|r| r.inner().clone());
            if let Some(runner) = &runner {
                runner.cancel_all();
            }
            let busy = || !run.is_idle() || runner.as_ref().is_some_and(|r| !r.is_idle());
            let deadline = Instant::now() + Duration::from_secs(4);
            while busy() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    });
}

fn config_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok()
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let change = MenuItemBuilder::with_id(CHANGE_SERVER, "Change Server…").build(app)?;
    let runner_settings =
        MenuItemBuilder::with_id(RUNNER_SETTINGS, "Runner settings…").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Qoop")
        .about(None)
        .separator()
        .item(&change)
        .item(&runner_settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    // Without an Edit menu, copy and paste shortcuts do nothing on macOS.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
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

/// The local first-run screen (desktop/ui): asks for the server address.
fn open_setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETUP_WINDOW) {
        return window.set_focus();
    }
    local_window(app, SETUP_WINDOW, "index.html")
        .title("Qoop")
        .inner_size(520.0, 420.0)
        .resizable(false)
        .build()?;
    Ok(())
}

fn is_local_asset(url: &Url) -> bool {
    // Windows and Android serve the app's own files from http(s)://tauri.localhost.
    url.host_str() == Some("tauri.localhost")
}

/// The main window: shows the server's UI at `origin`, and nothing else.
fn open_main(app: &AppHandle, origin: &str) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let start =
        Url::parse(origin).map_err(|_| tauri::Error::InvalidWebviewUrl("server address"))?;

    // The only access remote content gets: the bridge commands, for pages of this one
    // origin, in this one window. (Tauri checks the calling page's URL against it on every
    // call; a call from any other origin, or for any other command, is refused.) For the
    // Runner that is: read its status, ask for the settings window, ask for a Run, cancel
    // it. The commands that choose an interpreter or approve code are not in this list.
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
            .permission("allow-runner-cancel"),
    )?;
    *state.origin.lock().unwrap() = Some(origin.to_owned());

    let script = bridge::script(
        origin,
        &app.package_info().version.to_string(),
        &state.bridge_key,
    );
    let nav_origin = origin.to_owned();
    let new_window_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(start))
        .title("Qoop")
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
            }
        });
    // The web inspector exists in debug builds only (the `devtools` feature is off).
    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);
    let window = builder.build()?;

    let run = state.run.clone();
    let runs = runner(app);
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            run.cancel();
            runs.cancel_all();
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
        .inner_size(620.0, 640.0)
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
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
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

/// "Change Server…": back to the first-run screen.
fn change_server(app: &AppHandle) {
    if open_setup(app).is_ok()
        && let Some(main) = app.get_webview_window(MAIN_WINDOW)
    {
        app.state::<AppState>().run.cancel();
        runner(app).cancel_all();
        let _ = main.close();
    }
}

// ---- commands of the local first-run screen ---------------------------------------------

fn check_setup_caller(webview: &Webview) -> Result<(), String> {
    if webview.label() == SETUP_WINDOW {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
}

/// The address saved earlier, to fill the field with.
#[tauri::command]
fn setup_current(webview: Webview, app: AppHandle) -> Result<Option<String>, String> {
    check_setup_caller(&webview)?;
    Ok(config_dir(&app).and_then(|dir| config::load(&dir)))
}

/// Checks the address, asks the server for its health, saves, and shows the server's UI.
#[tauri::command]
async fn setup_save(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
) -> Result<(), String> {
    check_setup_caller(&webview)?;
    let origin = address::parse_server_address(&address)?;
    let checked = origin.clone();
    tauri::async_runtime::spawn_blocking(move || address::check_health(&checked))
        .await
        .map_err(|_| "The address could not be checked. Try again.".to_owned())??;

    const NOT_SAVED: &str = "The address could not be saved on this computer.";
    let dir = config_dir(&app).ok_or(NOT_SAVED)?;
    config::save(&dir, &origin).map_err(|_| NOT_SAVED.to_owned())?;

    let granted = state.origin.lock().unwrap().clone();
    match granted {
        // The bridge was already granted to another origin in this run of the app, and a
        // grant cannot be taken back: start again, so that only the new origin has it.
        Some(previous) if previous != origin => app.restart(),
        _ => {}
    }
    if app.get_webview_window(MAIN_WINDOW).is_none() {
        open_main(&app, &origin).map_err(|_| "The window could not be opened.".to_owned())?;
    }
    if let Some(setup) = app.get_webview_window(SETUP_WINDOW) {
        let _ = setup.close();
    }
    Ok(())
}

// ---- commands behind `window.qoopDesktop` ----------------------------------------------

fn check_bridge_caller(webview: &Webview, state: &AppState, key: &str) -> Result<String, String> {
    let origin = state.origin.lock().unwrap().clone();
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
/// own window (or approved the same code from this server before): see `qoop_runner`.
#[tauri::command]
async fn runner_run(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    request: qoop_runner::RunRequest,
    on_event: Channel<qoop_runner::RunEvent>,
) -> Result<(), String> {
    // The origin approvals are remembered for is the one the app was set up with, not
    // anything the page says about itself.
    let origin = check_bridge_caller(&webview, &state, &key)?;
    let runner = runner(&app);
    let windows = RunnerWindows(app.clone());
    let events = on_event.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        runner.run(request, &origin, &windows, &mut |event| {
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
        .map_err(|_| "Qoop could not look for Python on this computer.".to_owned())
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
