fn main() {
    // Declaring the app's commands gives each one a permission (`allow-<command>`), so that
    // nothing can call them unless a capability grants it: the local first-run screen gets the
    // setup commands (capabilities/setup.json), the configured server origin gets the three
    // bridge commands (a capability added at run time, see src/shell.rs).
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "setup_current",
            "setup_save",
            "claude_status",
            "claude_send",
            "claude_cancel",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
