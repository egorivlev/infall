use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    embed_web_ui();

    // Declaring the app's commands gives each one a permission (`allow-<command>`), so that
    // nothing can call them unless a capability grants it: the start screen gets the
    // Workspace commands (capabilities/setup.json), the origin of the open Workspace gets
    // the bridge commands (a capability added at run time, see src/shell.rs), and the
    // Runner's two local windows get theirs (capabilities/runner-*.json).
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            // The start screen (docs/specs/local.md, Contract C).
            "start_view",
            "workspace_create",
            "workspace_connect",
            "workspace_open",
            "workspace_rename",
            "workspace_remove",
            // Workspace files and backups (docs/specs/portability.md, Contract C).
            "workspace_export",
            "workspace_import",
            "workspace_reveal",
            // Moving a Local Workspace onto a Team server (docs/specs/team-move.md, Contract C).
            "workspace_move",
            // The bridge.
            "claude_status",
            "claude_send",
            "claude_cancel",
            "switch_workspace",
            // Saving a file and printing the page (docs/specs/portability.md, Contract D).
            "save_file",
            "print_page",
            // What the page's Undo and Redo would do, for the Edit menu (docs/specs/undo.md).
            "undo_state",
            // Handing a moved Workspace's file to its Team server's page, and saving a file
            // the page made (docs/specs/team-move.md, Contract C; desktop.md, M18).
            "move_handover",
            "move_file_chunk",
            "move_done",
            "save_binary_begin",
            "save_binary_chunk",
            "save_binary_finish",
            // The Runner, for the server's pages: status, open the settings, ask for a Run
            // (`runner_start`: one that names its language and environment, M19 and M19b),
            // cancel it. Nothing that chooses an interpreter or approves.
            "runner_status",
            "runner_configure",
            "runner_run",
            "runner_start",
            "runner_cancel",
            // The approval window (capabilities/runner-approval.json).
            "approval_view",
            "approval_decide",
            // The Runner settings window (capabilities/runner-settings.json).
            "runner_settings_view",
            "runner_settings_save",
            "runner_settings_change",
            "runner_settings_forget",
            "runner_settings_close",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// The built web UI (`web/dist`) goes inside the binary: a Local Workspace's server serves
/// it from a copy the app unpacks (src/webui.rs). Writes `web_dist.rs` into `OUT_DIR`: the
/// list of files, each one `include_bytes!`, and a digest of them all.
fn embed_web_ui() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("../../web/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    if !dist.join("index.html").is_file() {
        panic!(
            "\n\nThe desktop app carries the built web UI, and there is none at {}.\n\
             Build it first: `npm ci && npm run build` in the repository's web/ directory.\n\n",
            dist.display()
        );
    }
    let dist = dist.canonicalize().expect("web/dist can be resolved");

    let mut files = Vec::new();
    collect(&dist, &dist, &mut files);
    files.sort();

    // FNV-1a over every path and its contents: enough to tell one build of the UI from
    // another, which is all it is used for.
    let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            digest ^= u64::from(*b);
            digest = digest.wrapping_mul(0x0100_0000_01b3);
        }
    };
    let mut code = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (relative, path) in &files {
        let bytes = fs::read(path).expect("a file of web/dist can be read");
        feed(relative.as_bytes());
        feed(&(bytes.len() as u64).to_le_bytes());
        feed(&bytes);
        writeln!(
            code,
            "    ({relative:?}, include_bytes!({:?})),",
            path.to_str().expect("the path of web/dist is valid UTF-8")
        )
        .unwrap();
    }
    code.push_str("];\n");
    writeln!(code, "pub const DIGEST: &str = \"{digest:016x}\";").unwrap();

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("web_dist.rs");
    fs::write(out, code).expect("OUT_DIR is writable");
}

/// Every file under `dir`, with its path relative to `root` written with `/`.
fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(dir).expect("web/dist can be listed") {
        let path = entry.expect("web/dist can be listed").path();
        let kind = fs::symlink_metadata(&path).expect("web/dist can be read");
        if kind.is_dir() {
            collect(root, &path, files);
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_str().expect("file names are valid UTF-8"))
                .collect::<Vec<_>>()
                .join("/");
            if relative == ".DS_Store" || relative.ends_with("/.DS_Store") {
                continue;
            }
            println!("cargo:rerun-if-changed={}", path.display());
            files.push((relative, path));
        }
    }
}
