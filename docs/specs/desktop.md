# Infall desktop app — contract (M7)

The desktop app ([ADR 0002](../adr/0002-desktop-app-primary-browser-fallback.md), [ADR 0003](../adr/0003-ai-through-subscriptions-and-a-shared-tool-layer.md)) is a Tauri shell around the same web UI the server serves. What it adds in M7 is one thing: the AI sidebar can run on the Member's own Claude Code. (The Runner is M8.) Since M12 it is no longer only a shell: it carries the server itself, for Local Workspaces, and opens with a start screen instead of a question for a server address ([ADR 0004](../adr/0004-server-embedded-in-the-desktop-app-for-local-workspaces.md); [M12](#m12--workspaces-on-this-computer) below).

## Shell
- (M7 to M11; replaced in M12 by the start screen, [below](#m12--workspaces-on-this-computer).) First start (or "Change server…" from the app menu): a small local screen asks for the server address (`https://…`; `http://` only for `localhost`/`127.0.0.1`), checks `GET <address>/api/health` answers `{ "ok": true }`, stores the address in the app's config directory, and loads the server's UI in the main window. Later starts go straight there if the server answers its health check; if it does not, the same local screen opens saying that the server could not be reached, with the saved address, and "Connect" tries again.
- The window shows only that origin (since M12: the open Workspace's origin). A navigation to any other origin is refused and opens nothing — a script in any frame, a Visual's sandbox included, can start one, and it looks the same as one the Member started. Only a link that asks for a new window (`target="_blank"`, which every external link in the UI uses and which a sandboxed frame cannot do) is handed to the system browser, at most once every two seconds. No address bar, no devtools in release builds.
- The server's pages are remote content: they get **no** general access to the app. The only thing exposed to that one origin is the bridge below; nothing is exposed to any other origin or to frames (the Visual sandbox frame included).

## Bridge — `window.qoopDesktop`
Present only inside the desktop app, only on the configured server origin (since M12: the open Workspace's origin, a Local Workspace's `http://127.0.0.1:<port>` included), only in the top frame. The web UI detects the app by its presence.

```ts
type AiEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; model?: string; session?: string }   // session: Claude Code's session id, to resume with
  | { type: "error"; message: string };

type QoopDesktop = {
  version: string;                                   // app version
  claude: {
    status(): Promise<{ installed: boolean; version?: string }>;   // is the `claude` command available on this machine
    send(
      request: {
        id: string;                                  // chosen by the caller; identifies the run for cancel
        prompt: string;                              // the Member's message
        system: string;                              // appended system prompt (scope, rules) written by the web UI
        resume?: string;                             // session id from an earlier `done`
        tools: { url: string; token: string };       // the server's /mcp endpoint and an access token (api.md §12)
      },
      onEvent: (event: AiEvent) => void,
    ): Promise<void>;                                // resolves when the run has ended (after `done` or `error`)
    cancel(id: string): Promise<void>;
  };
};
```

## How a run is executed
The app starts the Member's own `claude` in print mode, in a fresh empty temporary directory, with **only** the Infall tools:

- output as a stream of JSON events with partial messages, mapped to `AiEvent` (assistant text → `delta`; a tool call → `tool` with the bare tool name; the final result → `done` with the session id and model; anything that fails → `error` with a plain sentence);
- the Infall `/mcp` server given through a config **file** written with owner-only permissions and deleted when the run ends (the token must never be on the command line, where other local processes could read it), with strict MCP config so the Member's other MCP servers are not loaded;
- **every built-in tool disabled** (no shell, no file read/write/edit, no web fetch, no sub-agents) and only the eight `mcp__qoop__*` tools allowed — text on a Board is written by other people and other AIs, and must not be able to make an AI act on the Member's machine;
- the Member's own Claude Code settings, hooks, plugins, memory files and project instructions not loaded, as far as the CLI allows (document exactly which flags achieve what, and what could not be switched off);
- the `system` text appended to the system prompt; `resume` passed when given; the prompt sent on standard input, not as an argument.

One run at a time per window; `cancel` terminates the process (and its children). A run with no output for 120 s is terminated with an `error`. The app never reads or stores the Member's Claude credentials, and sends nothing anywhere itself: only the `claude` process talks to Anthropic, under the Member's own login.

The path of the `claude` binary can be overridden with the environment variable `QOOP_CLAUDE_BIN` (used by tests with a stub that prints a canned event stream).

## Not in M7
Auto-update, code signing/notarisation, installers for other platforms, the Runner (M8), offline use (since M12, a Local Workspace needs no network).


# M8 — the Runner

The Runner is the part of the desktop app that executes Runs on the Member's own hardware (CONTEXT.md; api.md §15 for what a result is). **Executing a Run means running code that someone else may have written, with the Member's own rights on their own computer.** There is no sandbox in M8. Everything below exists so that this never happens without the Member having seen the code, in a window the web page cannot draw or click.

## Bridge — `window.qoopDesktop.runner`
Added to the M7 bridge under the same rules (configured origin, top frame, bridge key). The web UI treats a bridge without `runner` as an app that is too old.

```ts
type RunEvent =
  | { type: "approval" }                           // the app is showing the code to the Member and waits
  | { type: "started" }                            // the process is running
  | { type: "output"; text: string }               // more standard output / standard error
  | { type: "done";
      exit: number | null;                         // null: stopped or killed
      stopped: boolean;
      duration_ms: number;
      code_sha256: string;                         // of the code the app executed
      output: string;                              // everything kept (≤ 64 000 characters)
      output_truncated: boolean;
      figures: { png: string }[];                  // base64, ≤ 3, each ≤ 160 000 characters
      env: { python?: string; packages?: Record<string, string>; os?: string; arch?: string } }
  | { type: "error"; reason: "declined" | "no_python" | "busy" | "failed"; message: string };

type QoopRunner = {
  status(): Promise<{ python?: { path: string; version: string }; folder?: string }>;
  configure(): Promise<void>;                      // opens the app's own "Runner settings" window; resolves when it closes
  run(request: { id: string; code: string; title: string }, onEvent: (e: RunEvent) => void): Promise<void>;   // resolves after `done` or `error`
  cancel(id: string): Promise<void>;
};
```

The page can ask for a Run and can ask for the settings window to open. It cannot choose the interpreter, the folder, or approve anything.

## Approval — the app's own window
Before code is executed the app opens a window of its **own local UI** (like the first-run screen: bundled files, its own capability, no remote content) showing: the Run's title, the server it came from, the interpreter and the folder it will run in, and the **complete code** in a scrollable monospace view with line numbers, with "Run on this computer" and "Don't run" (the default; closing the window is "Don't run"). The text says plainly that the code will run with the Member's own rights and can read and change their files.

- Approval is remembered per server origin, per `code_sha256` and per configured folder (a file in the app's config directory, newest 1 000): the same code runs again in the same place without asking; code approved for a temporary folder asks again once a folder of the Member's own is set; any change to the code — including the Member's own edit, which the app cannot tell from anyone else's — asks again.
- While the window is open the page gets `approval`; "Don't run" gives `error` / `declined`.
- The code shown is the code executed: the app hashes and writes out exactly the bytes it displayed.

## Runner settings — the app's own window
Also local UI; reached from the app menu ("Runner settings…") and through `runner.configure()`. It sets, per device:
- **Python**: the interpreters the app found (looking up `python3` and `python` the way a login shell would, so pyenv/conda/Homebrew ones are found although a GUI app has a bare `PATH`), each with its version, plus a field for the full path of another one (accepted when `<path> --version` answers like Python 3). Nothing is chosen until the Member chooses: the first Run with no choice made opens this window (`no_python` if it is closed without one).
- **Folder** (optional): the directory Runs execute in, so code can import the Member's own modules and read their data. Unset: a fresh empty temporary directory per Run.

## How a Run is executed
- The code is written to `main.py` in a fresh owner-only temporary directory and started as `<python> -u -X utf8 <the app's bundled runner.py> <that main.py>`, working directory the configured folder or else that temporary directory, as a new process group. The environment is the login shell's, plus `MPLBACKEND=Agg`, `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, `QOOP_RUN_DIR=<temporary directory>`.
- `runner.py` (bundled, standard library only, works on Python ≥ 3.8) runs the code as `__main__` (tracebacks name `main.py` with the right line numbers; `SystemExit` and its code are honoured; the working directory is on `sys.path`). When it ends — normally or with an exception — it saves every matplotlib figure still open (only if the code imported `matplotlib.pyplot`) as PNG into `QOOP_RUN_DIR`, first three, smaller dpi if a file would exceed the limit, a one-line note in the output for any it had to leave out; and writes `env.json`: the Python version and the versions of the top-level packages the code imports (at most 8).
- Standard output and standard error go through one pipe, so their order is kept. `output` events are sent at most about ten times a second. Kept output is at most 64 000 characters: beyond that the beginning and the end are kept and one marker line says how much was dropped (`output_truncated`).
- **No time limit** — experiments run for hours. `cancel` kills the whole process group (`done` with `stopped: true`, `exit: null`, whatever was captured so far, no figures). Quitting the app, closing the window or reloading the page kills it too. One Run at a time per app (`busy`).
- The temporary directory is deleted afterwards. The app sends nothing anywhere: the page receives the events and records the result through the server.
- The interpreter path can be overridden for tests with `QOOP_PYTHON_BIN`; approval can **not** be switched off by any environment variable or build flag — tests drive the approval through the Rust code behind the window.

## Not in M8
Sandboxing or containers; other languages; per-Run environments or dependency installation; streaming figures while it runs; GPU/hardware reporting; running on the server or on another Member's machine; native file pickers.

# M9 — the Runner monitor

While a Run executes, the Member sees what it is doing to their computer: processor, memory, graphics processor, how long it has run and — when the code says how far it is — how long it has left. Only the Member whose computer runs it sees this; nothing of it is recorded in the result or sent to the server.

## Bridge — one more event
```ts
type RunEvent = /* M8 */ | ({ type: "stats" } & RunUsage);

type RunUsage = {
  cpu_percent: number;          // of the Run's own processes (its whole process group); 100 = one core fully busy
  cores: number;                // logical cores of this computer
  memory_bytes: number;         // resident memory of the Run's own processes
  memory_total_bytes: number;   // of this computer
  processes: number;            // processes in the Run's group
  gpu?: { percent: number; name?: string };   // the WHOLE computer's graphics processor, not only the Run; absent when it cannot be read
  step?: string;                // what the code says it is doing: one line, control characters removed, ≤ 120 characters
  progress?: { done: number; total: number }; // total > 0, 0 ≤ done ≤ total, both finite
};
```
- Sent after `started`, the first within about a second, then about once a second until the process ends; never after `done` / `error`. A page from M8 ignores the unknown event; an M8 app never sends it and the page then shows the running time only.
- Measuring must not need more rights than the app has, must not start anything that asks for a password, and must never delay or break the Run: a sample that cannot be taken is skipped, a field that cannot be read is left out (`gpu`) — `cpu_percent`, `cores`, `memory_bytes`, `memory_total_bytes`, `processes` are always present.
- How (Unix): processes of the Run's process group from `ps`; totals from the system (`sysctl` on macOS, `/proc` on Linux); graphics processor from `ioreg` (macOS, "Device Utilization %") or `nvidia-smi` when it is on the path (Linux), each with a short timeout. No new dependency.

## What the code can say — `qoop`
`runner.py` makes a module `qoop` importable by the Run's code (it exists only inside the Runner):
```python
import qoop
qoop.step("thermalising")            # what is being done now
qoop.progress(done, total)           # how far; total > 0
qoop.progress(done, total, "sweep")  # both at once
```
- Calls are cheap and never raise or print, whatever they are given (bad values are ignored); they write one small file in `QOOP_RUN_DIR` (atomically, at most about five times a second, the last call always lands), which the app reads when it samples.
- Code that does not call `qoop` but shows a `tqdm` bar still gets progress: when nothing was reported through `qoop`, the app reads the last progress bar in the output (`45%|… | 45/100 [`), and its description as `step`.
- Code meant to run outside Infall too can guard the import: `try: import qoop` / `except ImportError: qoop = None`.

## Not in M9
Per-process graphics-processor use; energy; network and disk; history of usage after the Run ended; usage recorded in the result; Windows.

## Notes from the M9 implementation
- Where: `runner/src/monitor.rs` (the sampler and every parser), `runner.py` (`qoop`), `exec.rs` (starts the sampler after `started`, stops it when the process has ended). The bridge needed no new command: `stats` travels through the same channel as the other events, as `{ type: "stats", …RunUsage }`.
- Timing: the first sample is taken 0.8 s after the process started, then one a second. A Run shorter than that sends no `stats`. Samples are taken on a thread of their own; the loop that reads the output and watches for cancel only picks up finished samples and drops any that arrive once the process has ended.
- `cpu_percent` is the processor time the group's processes used between two samples divided by the time between them (the first: since the start), not `ps`'s own `%cpu`, which is a slow average. Processor time comes from `ps -o time=` (hundredths of a second on macOS) and, where `/proc/<pid>/stat` exists, from there (Linux, where `ps` counts whole seconds). Processes that have ended and wait to be collected are not counted.
- Tools are started by full path (`/bin/ps` or `/usr/bin/ps`, `/usr/sbin/sysctl`, `/usr/sbin/ioreg`; `nvidia-smi` from the absolute directories of the login shell's `PATH`, only when there is no `ioreg`), with an empty environment (`LC_ALL=C`), no input, 0.8 s to answer, then killed. `cores` is the standard library's count; total memory is read once (`/proc/meminfo`, else `sysctl -n hw.memsize`); a sample is skipped until it is known. A graphics processor that cannot be read three times in a row is not asked again in that Run. With several graphics processors the busiest is reported.
- `qoop` writes `qoop-progress.json` (`{"step": …, "done": …, "total": …}`) in `QOOP_RUN_DIR`: at once if the last write is 0.2 s ago, else a timer thread writes the last state when the 0.2 s are over; once more when the code ends. Calls with the wrong arguments are ignored like wrong values. `qoop.step("")` takes the step away. The app reads the file without following links, at most 4 096 bytes, and checks it again (it is the Run's own program that wrote it).
- Progress bars: `progress` and `step` are taken from the bar only when the file says neither. Scaled counts (`1.20k/5.00k`) are read; a bar without a total says nothing; a line longer than 600 bytes is not looked at. The kept output is untouched.
- Not verified: anything on Linux (the `/proc` and `nvidia-smi` paths are tested only against text written by hand, not run), and Intel Macs with two graphics processors.

# M12 — Workspaces on this computer

The contract is [local.md](local.md) (Contract A for the server inside the app, Contract C for the start screen's commands); the reasons are in [ADR 0004](../adr/0004-server-embedded-in-the-desktop-app-for-local-workspaces.md). This section says what the shell does with them.

## The start screen
- Shown at **every** start, in the window `setup` (the app's own local page `desktop/ui/index.html`; 920 × 640, at least 720 × 560). The one exception: right after the app started itself again to open a Workspace (see "One Workspace at a time"), it opens that Workspace directly, once.
- **Your workspaces**: every Local Workspace and every remembered Team Workspace, the one opened most recently first, each with **Rename** and **Remove**. Removing asks first; for a Local Workspace it deletes its files for good, for a Team Workspace it forgets the address. The open Workspace cannot be removed.
- **Create a workspace**: one tile per Preset (Tutorial, Blank, Literature review, Research project). A new Local Workspace is named after its Preset, made unique ("Tutorial 2"), and opens at once.
- **Sign in to a Team Workspace**: a server address, with the M7 rules (`https://…`; `http://` only for `localhost` and `127.0.0.1`) and the same health check. The Team Workspace is remembered, named after the address's host, and opened. Signing in is then the server's own page, as before.
- When the app comes back to the start screen because something failed (a Team Workspace that did not answer, a Local Workspace that could not be opened), the screen says so in one sentence.
- The start screen may call only the six commands of Contract C (capability `setup`, that window only). It gets none of the bridge.

## Where things are kept
- The list of Workspaces: `workspaces.json` in the app's config directory. The address an earlier version kept (`config.json`, one server) becomes a Team Workspace entry the first time the list is read; `config.json` itself is left as it was.
- Each Local Workspace: a directory `workspaces/<id>/` in the app's data directory, holding `workspace.sqlite` and, beside it, `workspace.sqlite.secret-key`, the key that seals OpenRouter keys at rest (owner-only on macOS and Linux; on Windows only what the folder inherits).
- The web UI the app was built with (`web/dist`, inside the program since the build) is unpacked to `web/` in the data directory the first time a Local Workspace opens, and replaced whole when the program holds a different build.
- Config and data directories: macOS `~/Library/Application Support/app.qoop.desktop/` (both); Linux `~/.config/app.qoop.desktop/` and `~/.local/share/app.qoop.desktop/`; Windows `%APPDATA%\app.qoop.desktop\` (both).
- Nothing copies a Local Workspace anywhere else. There is no backup of it but the files themselves. (Until M13; since then the app keeps backups in the Workspace's folder and exports Workspace files: [M13](#m13--workspace-files-backups-saving-and-printing) below.)

## Opening a Workspace
- **Local**: the app unpacks the web UI if needed and starts the server in its own process (`start_local`: the database, the web UI's directory, the Preset, and the Member's name, which is the operating system's user name or else `Me`). The main window opens the server's `entry_url`, which signs the one Member in and goes on to the Board. No email or password is asked or shown.
- **Team**: the health check, then the main window opens the server's address, as in M7.
- The main window gets the bridge for exactly that origin (the run-time capability of M7, plus `switch_workspace`).

## One Workspace at a time
- **Switch Workspace…** (the app menu; on Linux the menu bar of each window) and `window.qoopDesktop.switchWorkspace()` both cancel a running `claude` and any Run, show the start screen, close the main window and stop the embedded server.
- A capability given at run time cannot be taken back, and each Local Workspace has its own port, so its own origin. So when a second Workspace is opened in the same run of the app, the app notes which one, starts itself again and opens it then. To the Member this is the app closing and reopening once.
- Quitting stops `claude`, any Run and the embedded server, within a few seconds.

## The embedded server: what guards it
- It listens on `127.0.0.1` only, on a port the operating system chooses, and only while a Local Workspace is open. The shell accepts nothing but `http://127.0.0.1:<port>` as its origin.
- Every program on the computer, of any account, can connect to that port. Signing in needs the key in `entry_url`: 256 random bits made at each start, compared in constant time, gone when the server stops; a wrong or missing key is `404`. The key is only in the address the app gives its own window; it is not written to disk or printed. Signing in with a password, invites and signing out are refused in a Local Workspace ([local.md](local.md#contract-b--the-http-api-in-a-local-workspace-for-the-web-ui)), so there is no other way in.
- The server's Origin checks apply unchanged, with `http://127.0.0.1:<port>` as the public origin.
- What it does not guard against: programs running as the same user can read and change the Workspace's files directly, as they can any of that user's files.

## Not in M12
Moving a Local Workspace onto a server; more than one Workspace open at once; a Local Workspace with more than one Member; backups, export or sync of a Local Workspace.

# M13 — Workspace files, backups, saving and printing

The contract is [portability.md](portability.md) (Contract A for the server crate's `export_workspace` and `import_workspace`, Contract C for the start screen's commands, Contract D for the bridge). This section says what the shell does with them.

## The start screen's new commands
Added to the `setup` window's commands, under the M12 rules (allowed for that window only; a failure rejects with one plain sentence that can be shown as is):

```ts
workspace_export({ id: string }): string | null
  // local only. The system's save dialog, suggested name "<Workspace name>.infall".
  // Writes a Workspace file with export_workspace; resolves to the path written, or null when cancelled.
workspace_import(): void
  // The system's open dialog for a .infall file. Makes a new Local Workspace from it with
  // import_workspace (name: the file's name without extension, made unique) and opens it.
  // Resolves without doing anything when cancelled.
workspace_reveal({ id: string }): void
  // local only. Shows the Workspace's folder in the file manager.
```

`WorkspaceEntry` (local.md, Contract C) gains `lastBackup: number | null`: the time of the newest backup in unix ms, for a Local Workspace; `null` for a Team Workspace and while none is known.

The start screen shows, per Local Workspace, **Export…** and **Show in folder**, and "Backed up <when>" when `lastBackup` is known; below the list, also when it is empty, **Import a workspace…**. After an export it says in one line where the file went.

## The Workspace file
- One file, extension `.infall`: a consistent copy of the Workspace's database, taken safely while it is open, without what is secret or tied to this computer: sessions, access tokens, AI settings with the OpenRouter key, the entry key. The key file beside the database (`workspace.sqlite.secret-key`) is not in it either.
- Importing always makes a **new** Local Workspace (its own folder, its own new key file); it never writes over one. Its one Member is kept, name included. A file made by a newer schema than this build knows is refused, never half opened; a file that is not a Workspace file is refused with a sentence that says so.

## Backups
- When a Local Workspace is opened and its newest backup is older than 24 hours (or there is none), the shell writes a Workspace file into `workspaces/<id>/backups/` and then keeps the newest 7 there, deleting older ones. Same format as an export, so a backup is brought back with **Import a workspace…**.
- No setting. A failed backup never stops the Workspace from opening.
- The backups are inside the Workspace's folder, so **Remove** deletes them with the Workspace.

## Bridge — saving a file
Added to `window.qoopDesktop`, under the same rules as the rest of the bridge (configured origin, top frame, bridge key):

```ts
saveFile(file: { suggestedName: string; text: string }): Promise<boolean>
  // The system's save dialog; writes the text as UTF-8. false when cancelled. At most 20 MB.
```

The page chooses the suggested name and the text, never the folder or the path: only the person, in the system's dialog, chooses where the file goes. The web UI checks that `saveFile` exists; without it (a browser, an older app) it downloads the file the browser's way. Used for a Page as Markdown and for BibTeX.

## Printing
The web UI calls `window.print()` for **Print…** on a Page, and the system's print dialog opens; the person makes a PDF from there. On macOS the web view ignores `window.print()`, so there the bridge script replaces it with a call to the bridge command `print_page`, which asks the web view to print (`bridge::OWN_PRINT`). On Linux and Windows the web view's own `window.print()` is used. The main window's bridge therefore grants ten commands: M12's eight, `save_file` and `print_page`.

## Not in M13
Moving a Local Workspace onto a server; backups of a Team Workspace by the app (the server's backups are the Admin's: deploy guide); a setting for how often or how many backups; backups anywhere but the Workspace's own folder; a bridge command for opening files (a `.bib` file reaches the page through the web view's own file chooser, as in a browser).
