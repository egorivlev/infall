//! The Infall desktop app: the server's web UI for a Team Workspace, and the server itself
//! for a Local Workspace (docs/specs/desktop.md, docs/specs/local.md).
// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod address;
mod bridge;
mod datadir;
mod files;
mod portable;
mod shell;
mod transfer;
mod update;
mod webui;
mod workspaces;

fn main() {
    shell::run();
}
