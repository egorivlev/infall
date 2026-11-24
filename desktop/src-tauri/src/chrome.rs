//! The traffic lights and the page's interface scale (macOS; docs/specs/desktop.md, "Bridge —
//! chrome scale"). The page draws the title bar, and its interface scale (CSS zoom) makes the
//! top bar's first row taller or shorter; the lights follow it (`bridge::traffic_light_y`).
//!
//! - What each Workspace's page last said is kept in `window.json` in the app's config
//!   directory, so its next main window is built with the lights already in place: the page's
//!   own setting lives in its storage, which the app cannot read before the page has loaded.
//! - A change while the window is open goes through tao's own inset (`set_traffic_light_inset`),
//!   which tao re-applies on every draw of its view, after a title change and on leaving
//!   fullscreen. Tauri 2.12 builds a window with it but has no setter for it on the window;
//!   the runtime has the message (`WindowMessage::SetTrafficLightPosition`), and a runtime
//!   plugin (`Inset`) sends it from inside the event loop, where the main window's runtime id is
//!   known.
// Off macOS nothing moves and nothing is remembered.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::Path;

use serde_json::{Map, Value};

use crate::bridge;

/// The main window's title (hidden on macOS; the page draws the title bar).
pub const MAIN_TITLE: &str = "Infall";

const FILE: &str = "window.json";
const KEY: &str = "chromeScale";

/// The interface scale the page of Workspace `id` last said, or 100 %.
pub fn remembered(config: &Path, id: &str) -> f64 {
    read(config).get(id).copied().unwrap_or(1.0)
}

/// Keeps `scale` (already checked, `bridge::chrome_scale`) for Workspace `id`. Writes only
/// when it changed. Returns whether it did.
pub fn remember(config: &Path, id: &str, scale: f64) -> io::Result<bool> {
    let mut scales = read(config);
    if scales.get(id) == Some(&scale) {
        return Ok(false);
    }
    scales.insert(id.to_owned(), scale);
    write(config, &scales)?;
    Ok(true)
}

/// What the file says, entry by entry; anything that is not a usable scale is dropped.
fn read(config: &Path) -> BTreeMap<String, f64> {
    let text = fs::read_to_string(config.join(FILE)).unwrap_or_default();
    parse(&text)
}

fn parse(text: &str) -> BTreeMap<String, f64> {
    let value = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let Some(scales) = value.get(KEY).and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    scales
        .iter()
        .filter(|(id, _)| !id.is_empty() && id.len() <= 128)
        .filter_map(|(id, v)| {
            let scale = bridge::chrome_scale(v.as_f64()?).ok()?;
            Some((id.clone(), scale))
        })
        .collect()
}

fn write(config: &Path, scales: &BTreeMap<String, f64>) -> io::Result<()> {
    fs::create_dir_all(config)?;
    let mut object = Map::new();
    object.insert(
        KEY.to_owned(),
        Value::Object(
            scales
                .iter()
                .map(|(id, s)| (id.clone(), Value::from(*s)))
                .collect(),
        ),
    );
    let text = serde_json::to_string_pretty(&Value::Object(object))?;
    let tmp = config.join(format!("{FILE}.tmp"));
    let mut file = fs::File::create(&tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(tmp, config.join(FILE))
}

#[cfg(target_os = "macos")]
pub use inset::{Inset, Pending};

#[cfg(target_os = "macos")]
mod inset {
    use std::sync::{Arc, Mutex};

    use tauri::{EventLoopMessage, LogicalPosition};
    use tauri_runtime_wry::tao::event::Event;
    use tauri_runtime_wry::tao::event_loop::{ControlFlow, EventLoopProxy, EventLoopWindowTarget};
    use tauri_runtime_wry::{
        Context, EventLoopIterationContext, Message, Plugin, PluginBuilder, WebContextStore,
        WindowMessage,
    };

    use crate::bridge::{MAIN_WINDOW, TRAFFIC_LIGHT_X};

    /// The y the main window's lights should move to, until the event loop has sent it.
    #[derive(Clone, Default)]
    pub struct Pending(Arc<Mutex<Option<f64>>>);

    impl Pending {
        /// Asks for the lights at `y`; the event loop takes it at its next message (the
        /// caller wakes it, e.g. with `run_on_main_thread` from another thread).
        pub fn set(&self, y: f64) {
            *self.0.lock().unwrap() = Some(y);
        }

        fn take(&self) -> Option<f64> {
            self.0.lock().unwrap().take()
        }
    }

    /// The runtime plugin that moves the main window's lights (see the module's comment).
    pub struct Inset(pub Pending);

    impl PluginBuilder<EventLoopMessage> for Inset {
        type Plugin = Inset;
        fn build(self, _context: Context<EventLoopMessage>) -> Inset {
            self
        }
    }

    impl Plugin<EventLoopMessage> for Inset {
        fn on_event(
            &mut self,
            event: &Event<Message<EventLoopMessage>>,
            _event_loop: &EventLoopWindowTarget<Message<EventLoopMessage>>,
            proxy: &EventLoopProxy<Message<EventLoopMessage>>,
            _control_flow: &mut ControlFlow,
            context: EventLoopIterationContext<'_, EventLoopMessage>,
            _web_context: &WebContextStore,
        ) -> bool {
            // Only on a message to the event loop: what wakes it for this.
            if !matches!(event, Event::UserEvent(_)) {
                return false;
            }
            let Some(y) = self.0.take() else {
                return false;
            };
            let Ok(windows) = context.windows.0.try_borrow() else {
                // Busy: asked again at the next message.
                self.0.set(y);
                return false;
            };
            let main = windows
                .iter()
                .find(|(_, window)| window.label() == MAIN_WINDOW)
                .map(|(id, _)| *id);
            drop(windows);
            // No main window: the next one is built with the remembered scale.
            if let Some(id) = main {
                let position = LogicalPosition::new(TRAFFIC_LIGHT_X, y).into();
                // tao only stores the inset; setting the title (the same one) applies it at
                // once (tao re-applies the inset after a title change). Both go in order.
                let _ = proxy.send_event(Message::Window(
                    id,
                    WindowMessage::SetTrafficLightPosition(position),
                ));
                let _ = proxy.send_event(Message::Window(
                    id,
                    WindowMessage::SetTitle(super::MAIN_TITLE.to_owned()),
                ));
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scale_is_remembered_per_workspace_and_written_only_when_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        assert_eq!(remembered(&config, "a"), 1.0);
        assert!(remember(&config, "a", 1.5).unwrap());
        assert!(!remember(&config, "a", 1.5).unwrap());
        assert!(remember(&config, "b", 0.8).unwrap());
        assert_eq!(remembered(&config, "a"), 1.5);
        assert_eq!(remembered(&config, "b"), 0.8);
        assert_eq!(remembered(&config, "c"), 1.0);
        assert!(remember(&config, "a", 1.25).unwrap());
        assert_eq!(remembered(&config, "a"), 1.25);
        assert!(!config.join("window.json.tmp").exists());
    }

    #[test]
    fn what_the_file_says_is_taken_only_as_usable_scales() {
        let parsed = parse(
            r#"{"chromeScale": {"a": 1.25, "b": 9, "c": 0.1, "d": "1.5", "e": null, "": 1.1}}"#,
        );
        assert_eq!(parsed.get("a"), Some(&1.25));
        // Out of range: clamped, as the page's own word would be.
        assert_eq!(parsed.get("b"), Some(&bridge::MAX_CHROME_SCALE));
        assert_eq!(parsed.get("c"), Some(&bridge::MIN_CHROME_SCALE));
        assert_eq!(parsed.len(), 3);
        for damaged in ["", "{not json", "[]", r#"{"chromeScale": 1.5}"#, "null"] {
            assert!(parse(damaged).is_empty(), "{damaged:?}");
        }
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), "{oops").unwrap();
        assert_eq!(remembered(dir.path(), "a"), 1.0);
        // A damaged file is written over with what is known now.
        assert!(remember(dir.path(), "a", 1.1).unwrap());
        assert_eq!(remembered(dir.path(), "a"), 1.1);
    }
}
