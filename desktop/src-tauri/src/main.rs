//! The Qoop desktop app: a thin shell around the server's web UI (docs/specs/desktop.md).
// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod address;
mod bridge;
mod config;
mod shell;

fn main() {
    shell::run();
}
