fn main() {
    // Declaring the app's commands gives each one a permission (`allow-<command>`), so that
    // nothing can call them unless a capability grants it: the local first-run screen gets the
    // setup commands (capabilities/setup.json), the configured server origin gets the
    // bridge commands (a capability added at run time, see src/shell.rs), and the Runner's two
    // local windows get theirs (capabilities/runner-*.json).
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "setup_current",
            "setup_save",
            "claude_status",
            "claude_send",
            "claude_cancel",
            // The Runner, for the server's pages: status, open the settings, ask for a Run,
            // cancel it. Nothing that chooses an interpreter or approves.
            "runner_status",
            "runner_configure",
            "runner_run",
            "runner_cancel",
            // The approval window (capabilities/runner-approval.json).
            "approval_view",
            "approval_decide",
            // The Runner settings window (capabilities/runner-settings.json).
            "runner_settings_view",
            "runner_settings_save",
            "runner_settings_forget",
            "runner_settings_close",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
