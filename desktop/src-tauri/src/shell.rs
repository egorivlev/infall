//! The Tauri layer: windows, the menu, and the five commands. Everything with a rule in it
//! lives in `address`, `bridge`, `config` and the `qoop-claude-driver` crate; this file only
//! connects them to Tauri.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use qoop_claude_driver::{AiEvent, Cancel, Driver, Status};
use tauri::ipc::{CapabilityBuilder, Channel};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, State, Url, Webview, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::address::{self, Navigation};
use crate::bridge::{self, MAIN_WINDOW, SendRequest};
use crate::config;

const SETUP_WINDOW: &str = "setup";
const CHANGE_SERVER: &str = "change-server";

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
        })
        .invoke_handler(tauri::generate_handler![
            setup_current,
            setup_save,
            claude_status,
            claude_send,
            claude_cancel
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_menu(&handle)?;
            match config_dir(&handle).and_then(|dir| config::load(&dir)) {
                Some(origin) => open_main(&handle, &origin)?,
                None => open_setup(&handle)?,
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CHANGE_SERVER {
                change_server(app);
            }
        })
        .build(tauri::generate_context!())
        .expect("the Qoop desktop app could not start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Leave no `claude` behind: stop the run and wait for its process group to go.
            let run = app.state::<AppState>().run.clone();
            run.cancel();
            let deadline = Instant::now() + Duration::from_secs(4);
            while !run.is_idle() && Instant::now() < deadline {
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
    let app_menu = SubmenuBuilder::new(app, "Qoop")
        .about(None)
        .separator()
        .item(&change)
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
    WebviewWindowBuilder::new(app, SETUP_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Qoop")
        .inner_size(520.0, 420.0)
        .resizable(false)
        // The local screen has nowhere else to go.
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "about") || is_local_asset(url))
        .on_new_window(|_, _| NewWindowResponse::Deny)
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

    // The only access remote content gets: the three bridge commands, for pages of this one
    // origin, in this one window. (Tauri checks the calling page's URL against it on every
    // call; a call from any other origin, or for any other command, is refused.)
    app.add_capability(
        CapabilityBuilder::new("qoop-bridge")
            .remote(format!("{origin}/*"))
            .window(MAIN_WINDOW)
            .permission("allow-claude-status")
            .permission("allow-claude-send")
            .permission("allow-claude-cancel"),
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
            // A page that is going away cannot receive the rest of its run.
            if payload.event() == PageLoadEvent::Started {
                window.state::<AppState>().run.cancel();
            }
        });
    // The web inspector exists in debug builds only (the `devtools` feature is off).
    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);
    let window = builder.build()?;

    let run = state.run.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            run.cancel();
        }
    });
    Ok(())
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
