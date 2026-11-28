# Infall desktop app — contract (M7)

The desktop app ([ADR 0002](../adr/0002-desktop-app-primary-browser-fallback.md), [ADR 0003](../adr/0003-ai-through-subscriptions-and-a-shared-tool-layer.md)) is a Tauri shell around the same web UI the server serves. What it adds in M7 is one thing: the AI sidebar can run on the Member's own Claude Code. (The Runner is M8.) Since M12 it is no longer only a shell: it carries the server itself, for Local Workspaces, and opens with a start screen instead of a question for a server address ([ADR 0004](../adr/0004-server-embedded-in-the-desktop-app-for-local-workspaces.md); [M12](#m12--workspaces-on-this-computer) below).

## Shell
- (M7 to M11; replaced in M12 by the start screen, [below](#m12--workspaces-on-this-computer).) First start (or "Change server…" from the app menu): a small local screen asks for the server address (`https://…`; `http://` only for `localhost`/`127.0.0.1`), checks `GET <address>/api/health` answers `{ "ok": true }`, stores the address in the app's config directory, and loads the server's UI in the main window. Later starts go straight there if the server answers its health check; if it does not, the same local screen opens saying that the server could not be reached, with the saved address, and "Connect" tries again.
- The window shows only that origin (since M12: the open Workspace's origin). A navigation to any other origin is refused and opens nothing — a script in any frame, a Visual's sandbox included, can start one, and it looks the same as one the Member started. Only a link that asks for a new window (`target="_blank"`, which every external link in the UI uses and which a sandboxed frame cannot do) is handed to the system browser, at most once every two seconds. No address bar, no devtools in release builds.
- The server's pages are remote content: they get **no** general access to the app. The only thing exposed to that one origin is the bridge below; nothing is exposed to any other origin or to frames (the Visual sandbox frame included).

## Bridge — `window.infallDesktop`
Present only inside the desktop app, only on the configured server origin (since M12: the open Workspace's origin, a Local Workspace's `http://127.0.0.1:<port>` included), only in the top frame. The web UI detects the app by its presence.

```ts
type AiEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; model?: string; session?: string }   // session: Claude Code's session id, to resume with
  | { type: "error"; message: string };

type InfallDesktop = {
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
- **every built-in tool disabled** (no shell, no file read/write/edit, no web fetch, no sub-agents) and only the eight `mcp__infall__*` tools allowed — text on a Board is written by other people and other AIs, and must not be able to make an AI act on the Member's machine;
- the Member's own Claude Code settings, hooks, plugins, memory files and project instructions not loaded, as far as the CLI allows (document exactly which flags achieve what, and what could not be switched off);
- the `system` text appended to the system prompt; `resume` passed when given; the prompt sent on standard input, not as an argument.

One run at a time per window; `cancel` terminates the process (and its children). A run with no output for 120 s is terminated with an `error`. The app never reads or stores the Member's Claude credentials, and sends nothing anywhere itself: only the `claude` process talks to Anthropic, under the Member's own login.

The path of the `claude` binary can be overridden with the environment variable `INFALL_CLAUDE_BIN` (used by tests with a stub that prints a canned event stream).

## Not in M7
Auto-update, code signing/notarisation, installers for other platforms, the Runner (M8), offline use (since M12, a Local Workspace needs no network).


# M8 — the Runner

The Runner is the part of the desktop app that executes Runs on the Member's own hardware (CONTEXT.md; api.md §15 for what a result is). **Executing a Run means running code that someone else may have written, with the Member's own rights on their own computer.** There is no sandbox in M8. Everything below exists so that this never happens without the Member having seen the code, in a window the web page cannot draw or click.

## Bridge — `window.infallDesktop.runner`
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

type InfallRunner = {
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
- The code is written to `main.py` in a fresh owner-only temporary directory and started as `<python> -u -X utf8 <the app's bundled runner.py> <that main.py>`, working directory the configured folder or else that temporary directory, as a new process group. The environment is the login shell's, plus `MPLBACKEND=Agg`, `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, `INFALL_RUN_DIR=<temporary directory>`.
- **Usage reports off.** Every Run is also started with the documented switch that turns off the usage report of a package researchers often import, over whatever the login shell sets: `QDK_PYTHON_TELEMETRY=none` (`qdk`, and `qsharp` from 1.28: both READMEs on PyPI; see [qsharp-check.md](qsharp-check.md) §8 for what is sent otherwise), `QSHARP_PYTHON_TELEMETRY=none` (older `qsharp` releases: their README on PyPI, e.g. 1.20.0), `HF_HUB_DISABLE_TELEMETRY=1` (`huggingface_hub`, which reports for `transformers`, `datasets`, `diffusers` and the rest: its documentation, "Environment variables"), `MLFLOW_DISABLE_TELEMETRY=true` (`mlflow` 3.2 and later: its documentation, "Usage Tracking"). Only switches a package documents are set (`exec.rs`, `NO_USAGE_REPORTS`); what a Run's code itself sends is up to the code.
- `runner.py` (bundled, standard library only, works on Python ≥ 3.8) runs the code as `__main__` (tracebacks name `main.py` with the right line numbers; `SystemExit` and its code are honoured; the working directory is on `sys.path`). When it ends — normally or with an exception — it saves every matplotlib figure still open (only if the code imported `matplotlib.pyplot`) as PNG into `INFALL_RUN_DIR`, first three, smaller dpi if a file would exceed the limit, a one-line note in the output for any it had to leave out; and writes `infall-env.json`: the Python version and the versions of the packages the code imports (since M19: the distributions its top-level imports come from, then what those require directly, at most 32; see "Environments" below).
- Standard output and standard error go through one pipe, so their order is kept. `output` events are sent at most about ten times a second. Kept output is at most 64 000 characters: beyond that the beginning and the end are kept and one marker line says how much was dropped (`output_truncated`).
- **No time limit** — experiments run for hours. `cancel` kills the whole process group (`done` with `stopped: true`, `exit: null`, whatever was captured so far, no figures). Quitting the app, closing the window or reloading the page kills it too. One Run at a time per app (`busy`).
- The temporary directory is deleted afterwards. The app sends nothing anywhere: the page receives the events and records the result through the server.
- The interpreter path can be overridden for tests with `INFALL_PYTHON_BIN`; approval can **not** be switched off by any environment variable or build flag — tests drive the approval through the Rust code behind the window.

## Not in M8
Sandboxing or containers; other languages (M19b: "Languages — Runs in more than Python", below); per-Run environments or dependency installation; streaming figures while it runs; GPU/hardware reporting; running on the server or on another Member's machine; native file pickers.

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

## What the code can say — `infall`
`runner.py` makes a module `infall` importable by the Run's code (it exists only inside the Runner):
```python
import infall
infall.step("thermalising")            # what is being done now
infall.progress(done, total)           # how far; total > 0
infall.progress(done, total, "sweep")  # both at once
```
- Calls are cheap and never raise or print, whatever they are given (bad values are ignored); they write one small file in `INFALL_RUN_DIR` (atomically, at most about five times a second, the last call always lands), which the app reads when it samples.
- Code that does not call `infall` but shows a `tqdm` bar still gets progress: when nothing was reported through `infall`, the app reads the last progress bar in the output (`45%|… | 45/100 [`), and its description as `step`.
- Code meant to run outside Infall too can guard the import: `try: import infall` / `except ImportError: infall = None`.
- The same module is also importable as `qoop`, its name before the rename, for code saved in a Workspace before it ([Names before the rename](#names-before-the-rename)).

## Not in M9
Per-process graphics-processor use; energy; network and disk; history of usage after the Run ended; usage recorded in the result; Windows.

## Notes from the M9 implementation
- Where: `runner/src/monitor.rs` (the sampler and every parser), `runner.py` (`infall`), `exec.rs` (starts the sampler after `started`, stops it when the process has ended). The bridge needed no new command: `stats` travels through the same channel as the other events, as `{ type: "stats", …RunUsage }`.
- Timing: the first sample is taken 0.8 s after the process started, then one a second. A Run shorter than that sends no `stats`. Samples are taken on a thread of their own; the loop that reads the output and watches for cancel only picks up finished samples and drops any that arrive once the process has ended.
- `cpu_percent` is the processor time the group's processes used between two samples divided by the time between them (the first: since the start), not `ps`'s own `%cpu`, which is a slow average. Processor time comes from `ps -o time=` (hundredths of a second on macOS) and, where `/proc/<pid>/stat` exists, from there (Linux, where `ps` counts whole seconds). Processes that have ended and wait to be collected are not counted.
- Tools are started by full path (`/bin/ps` or `/usr/bin/ps`, `/usr/sbin/sysctl`, `/usr/sbin/ioreg`; `nvidia-smi` from the absolute directories of the login shell's `PATH`, only when there is no `ioreg`), with an empty environment (`LC_ALL=C`), no input, 0.8 s to answer, then killed. `cores` is the standard library's count; total memory is read once (`/proc/meminfo`, else `sysctl -n hw.memsize`); a sample is skipped until it is known. A graphics processor that cannot be read three times in a row is not asked again in that Run. With several graphics processors the busiest is reported.
- `infall` writes `infall-progress.json` (`{"step": …, "done": …, "total": …}`) in `INFALL_RUN_DIR`: at once if the last write is 0.2 s ago, else a timer thread writes the last state when the 0.2 s are over; once more when the code ends. Calls with the wrong arguments are ignored like wrong values. `infall.step("")` takes the step away. The app reads the file without following links, at most 4 096 bytes, and checks it again (it is the Run's own program that wrote it).
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
- Config and data directories: macOS `~/Library/Application Support/app.infall.desktop/` (both); Linux `~/.config/app.infall.desktop/` and `~/.local/share/app.infall.desktop/`; Windows `%APPDATA%\app.infall.desktop\` (both). Builds from before the rename used `app.qoop.desktop` in each of these places; the first start of a later build moves what is there ([Names before the rename](#names-before-the-rename)).
- **Since 0.9.0, on Windows, Local Workspaces' files live in the local (non-roaming) data folder**, `%LOCALAPPDATA%\app.infall.desktop\` (`workspaces\`, `moves\`, `web\`), beside WebView2's own `EBWebView\`; the config folder (`workspaces.json`, `runner.json`, `runner-approvals.json`, `updates.json`) stays in `%APPDATA%\app.infall.desktop\`. A roaming profile copies `%APPDATA%` to a server at every sign-in and sign-out, which a database of hundreds of megabytes must not go through (the open decision of release.md §9.2, taken by the owner's default). macOS and Linux: unchanged.
- **Moving them** (`src/datadir.rs`, at every start before anything opens): each `workspaces\<id>\` in the roaming folder that is not in the local one is copied beside its place (`.<id>.moving`), the copy compared with the original — the same files, the same sizes, the same bytes — then renamed into place, then the original removed. A link anywhere in it, or any failure, removes the copy and leaves the original; the list (`workspaces.json`, which names Workspaces by id, never by path) needs no change, because `Registry::local_dir` uses the roaming folder for an id whose folder is only there. The start screen then says, once: "One workspace could not be moved to <local> and is still kept in <roaming>, where Infall goes on using it. Nothing was lost. Infall tries again at its next start." A pending move's file in `moves\` goes the same way (if it cannot, that move has no file and the page is told there is nothing to hand over). The roaming `web\` is deleted when it holds the app's marker (it is unpacked again). Removing a Workspace removes both copies, should an old one have been left beside a moved one. The tests run on every platform with two temporary folders; **on Windows itself it has never run.**
- Nothing copies a Local Workspace anywhere else. There is no backup of it but the files themselves. (Until M13; since then the app keeps backups in the Workspace's folder and exports Workspace files: [M13](#m13--workspace-files-backups-saving-and-printing) below.)

## Opening a Workspace
- **Local**: the app unpacks the web UI if needed and starts the server in its own process (`start_local`: the database, the web UI's directory, the Preset, and the Member's name, which is the operating system's user name or else `Me`). The main window opens the server's `entry_url`, which signs the one Member in and goes on to the Board. No email or password is asked or shown.
- **Team**: the health check, then the main window opens the server's address, as in M7.
- The main window gets the bridge for exactly that origin (the run-time capability of M7, plus `switch_workspace`).

## One Workspace at a time
- **Switch Workspace…** (the app menu; on Linux the menu bar of each window) and `window.infallDesktop.switchWorkspace()` both cancel a running `claude` and any Run, show the start screen, close the main window and stop the embedded server.
- A capability given at run time cannot be taken back, and each Local Workspace has its own port, so its own origin. So when a second Workspace is opened in the same run of the app, the app notes which one, starts itself again and opens it then. To the Member this is the app closing and reopening once.
- Quitting stops `claude`, any Run and the embedded server, within a few seconds.

## The embedded server: what guards it
- It listens on `127.0.0.1` only, on a port the operating system chooses, and only while a Local Workspace is open. The shell accepts nothing but `http://127.0.0.1:<port>` as its origin.
- Every program on the computer, of any account, can connect to that port. Signing in needs the key in `entry_url`: 256 random bits made at each start, compared in constant time, gone when the server stops; a wrong or missing key is `404`. The key is only in the address the app gives its own window; it is not written to disk or printed. Signing in with a password, invites and signing out are refused in a Local Workspace ([local.md](local.md#contract-b--the-http-api-in-a-local-workspace-for-the-web-ui)), so there is no other way in.
- The server's Origin checks apply unchanged, with `http://127.0.0.1:<port>` as the public origin.
- The web view keeps one cookie jar for `127.0.0.1`, whatever the port, so each Local Workspace's session cookie has a name of its own (`infall_session_<id>`, api.md §16): entering one Workspace leaves the sign-in of every other as it was, and no Workspace's session is ever accepted by another's server. A Team Workspace's cookie is `infall_session`, as before.
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
  // The system's open dialog, filter "Workspace file or database": a .infall file, or a
  // Local Workspace's own .sqlite database copied by hand. Makes a new Local Workspace from
  // it with import_workspace (name: the file's name without extension, made unique; a file
  // called "workspace" gives "Recovered workspace", made unique) and opens it.
  // Resolves without doing anything when cancelled.
workspace_reveal({ id: string }): void
  // local only. Shows the Workspace's folder in the file manager.
```

`WorkspaceEntry` (local.md, Contract C) gains `lastBackup: number | null`: the time of the newest backup in unix ms, for a Local Workspace; `null` for a Team Workspace and while none is known.

The start screen shows, per Local Workspace, **Export…** and **Show in folder**, and "Backed up <when>" when `lastBackup` is known; below the list, also when it is empty, **Import a workspace…**. After an export it says in one line where the file went.

## The Workspace file
- One file, extension `.infall`: a consistent copy of the Workspace's database, taken safely while it is open, without what is secret or tied to this computer: sessions, access tokens, AI settings with the OpenRouter key, the entry key. The key file beside the database (`workspace.sqlite.secret-key`) is not in it either.
- Importing always makes a **new** Local Workspace (its own folder, its own new key file); it never writes over one. Its one Member is kept, name included. A file made by a newer schema than this build knows is refused, never half opened; a file that is not a Workspace file is refused with a sentence that says so.
- A Local Workspace's own `workspace.sqlite`, copied out of its folder by hand, imports too: the `workspace.sqlite-wal` beside it, if there is one (a copy made while the app ran), is taken in, the result is cleaned exactly as an export is, and the files chosen are only read. **Export…** stays the way to make a copy: one consistent file, safe at any moment.

## Backups
- When a Local Workspace is opened and its newest backup is older than 24 hours (or there is none), the shell writes a Workspace file into `workspaces/<id>/backups/` and then keeps the newest 7 there, deleting older ones. Same format as an export, so a backup is brought back with **Import a workspace…**.
- No setting. A failed backup never stops the Workspace from opening.
- The backups are inside the Workspace's folder, so **Remove** deletes them with the Workspace.

## Bridge — saving a file
Added to `window.infallDesktop`, under the same rules as the rest of the bridge (configured origin, top frame, bridge key):

```ts
saveFile(file: { suggestedName: string; text: string }): Promise<boolean>
  // The system's save dialog; writes the text as UTF-8. false when cancelled. At most 20 MB.
```

The page chooses the suggested name and the text, never the folder or the path: only the person, in the system's dialog, chooses where the file goes. The web UI checks that `saveFile` exists; without it (a browser, an older app) it downloads the file the browser's way. Used for a Page as Markdown and for BibTeX.

## Printing
The web UI calls `window.print()` for **Print…** on a Page, and the system's print dialog opens; the person makes a PDF from there. On macOS the web view ignores `window.print()`, so there the bridge script replaces it with a call to the bridge command `print_page`, which asks the web view to print (`bridge::OWN_PRINT`). On Linux and Windows the web view's own `window.print()` is used. The main window's bridge therefore grants ten commands: M12's eight, `save_file` and `print_page`.

## Not in M13
Moving a Local Workspace onto a server; backups of a Team Workspace by the app (the server's backups are the Admin's: deploy guide); a setting for how often or how many backups; backups anywhere but the Workspace's own folder; a bridge command for opening files (a `.bib` file reaches the page through the web view's own file chooser, as in a browser).


# Languages — Runs in more than Python

**Built on 2026-11-25** together with M19 Part 2 (environments; see "Environments and Toolchains — as built" at the end of this section, which is binding where it differs from the text before it). Everything in M8 and M9 stays as written for Python; this says what is added. The Run's side of it (the `lang` field, the result) is api.md §15, "Languages".

A Run names its language; the Member's own computer decides what that name starts. **The page chooses a name and nothing else.** Which program runs, with which arguments, is set by the Member in the Runner settings window on this device, never by the request — the M8 rule for the interpreter, kept for every language.

## Toolchains
A **Toolchain** (CONTEXT.md) is what the Runner starts for one language. Three kinds:

- **`python`** — built in. The M8 interpreter, `runner.py`, figures, packages, `infall`. Unchanged.
- **`qsharp`** — built in, hosted by Python. Q# has no program of its own to start: it runs through the `qdk` package of the chosen Python (see "Q#"). Since 1.29 the `qsharp` package is a deprecated shim that only pulls in `qdk`; a `qsharp` of 1.28 or earlier, from before `qdk`, is the package itself and is used when there is no `qdk`.
- **A command** — any other language: a program on this computer, its arguments, and a file extension. Set up by the Member, from a preset or by hand.

A language id is 1–24 characters, `^[a-z][a-z0-9_-]{0,23}$`. Ids are compared exactly. `python` and `qsharp` cannot be redefined.

## Bridge — what changes
```ts
type RunEvent = /* M8, M9 */
  // `done` gains:  lang: string            — the language it was executed as
  //                env.runtime?: string    — what a command Toolchain said its version is (≤ 40 characters)
  // `error` gains the reason "no_toolchain": the Run's language is not set up on this computer

type InfallRunner = {
  status(): Promise<{
    python?: { path: string; version: string };
    folder?: string;
    languages?: Record<string, { name: string; version?: string }>;   // every language a Run could be executed in now, `python` included
  }>;
  configure(lang?: string): Promise<void>;          // opens Runner settings, at that language
  run(request: { id: string; code: string; title: string; lang?: string }, onEvent: (e: RunEvent) => void): Promise<void>;
  cancel(id: string): Promise<void>;
};
```
- `lang` absent or `"python"`: exactly M8, `no_python` included. An app from before this section ignores `lang` and has no `languages` in `status()`; the page must then refuse to start a Run whose language is not Python ("Update Infall on this computer to run Julia code.") rather than let it be executed as Python.
- `lang` that is not a valid id: `error` / `failed`, nothing is shown or executed.
- `lang` with no Toolchain here: the settings window opens at that language (a known preset, or an empty form carrying the id); `no_toolchain` if it is closed without one.
- `status().languages` is read from the saved settings: it starts nothing.

## Runner settings — one more part
Below **Python** and **Folder**, **Languages**:
- **Q#** — a switch, usable once a Python is chosen. Turning it on asks that Python (`-I`, `importlib.metadata`, five seconds) for the version of its `qdk` distribution, and when there is none, of its `qsharp` distribution; when there is neither the window says what to install (`pip install qdk` into that Python; it needs Python 3.10 or newer) and the switch stays off. What is saved is which of the two was found and its version. The `qsharp` shim's own version says nothing about the compiler (1.31.0 is the last shim and requires only `qdk>=1.31.0`), so with a `qdk` present it is not looked at.
- **Presets** — Julia (`julia`, `.jl`), R (`Rscript`, `.R`), JavaScript (`node`, `.mjs`), Shell (`bash`, `.sh`; not on Windows): each offered with the programs found the way Python is found (the login shell's `PATH`), arguments `{file}`. Nothing is set up until the Member chooses it.
- **Add a language** — id, name (≤ 40 characters), the program's full path, arguments, file extension.

What is accepted when saving a command Toolchain:
- the program is an absolute path to an executable file. On Windows it must not be a `.bat` or `.cmd` file: those are run by the command interpreter, which reads arguments its own way;
- at most 16 arguments, each at most 200 characters, and `{file}` appears in exactly one of them;
- the extension is `^[A-Za-z0-9]{1,8}$`;
- at most 24 languages.

`<program> --version` is asked once when saving (five seconds, first line, control characters removed, at most 40 characters). A program that does not answer is still accepted, with no version: unlike Python, the app cannot know what a right answer looks like.

Saved in `runner.json` beside `python` and `folder`:
```jsonc
{
  "qsharp": { "package": "qdk", "version": "1.34.0" },   // "package": "qdk", or "qsharp" for a 1.28 or earlier
  "languages": {
    "julia": { "name": "Julia", "program": "/opt/homebrew/bin/julia", "args": ["{file}"], "ext": "jl", "version": "julia version 1.11.2" }
  }
}
```
Anything unreadable or implausible in it counts as not set up, entry by entry.

A language that needs two steps (compile, then run) is set up by pointing the Toolchain at a script of the Member's own that does both. The settings take one command, and never a shell line.

## Approval — what changes
- The window names the **language** next to the title, and shows the **command** that will run in place of the interpreter: the program's full path and its arguments as they will be passed, `{file}` standing for the Run's file. For Q#: "Q#, through Python at `<path>`".
- An approval is remembered per Workspace, per `code_sha256`, per folder **and per language**. The same text approved as Python asks again when a page sends it as Shell: the same characters are a different program. What was remembered before this section counts as Python.
- Changing a Toolchain's program or arguments does not ask again for code already approved, as changing the Python does not: both are the Member's own choice on their own device, and the window shows what is set at the time it asks.
- A language id and a Toolchain's name reach the window as text and are drawn as text, like the title and the code.

## How a Run in another language is executed
For a command Toolchain:
- The code is written to `main.<ext>` in the Run's owner-only temporary directory and started as `<program> <arguments>`, `{file}` replaced by that file's full path. The arguments are passed as they are, one by one: **no shell reads them**. The code is never on the command line.
- Working directory, process group, the one pipe for output, the output limits, `cancel`, no time limit, one Run at a time, deleting the directory afterwards: as M8.
- The environment is the login shell's plus `INFALL_RUN_DIR` and the usage-report switches of M8 (a script may start a Python that imports those packages). The Python-only variables (`MPLBACKEND`, `PYTHONUNBUFFERED`, `PYTHONIOENCODING`) are not set.
- `env` in `done`: `runtime` (the version saved with the Toolchain), `os`, `arch`. No `python`, no `packages`.

What a Run in any language gets without doing anything: its output, its exit code, stopping, the Runner monitor's usage figures, and progress read from a `tqdm`-style bar in its output (M9).

What its code can opt into, by writing files into `INFALL_RUN_DIR` — the same files `runner.py` writes for Python, read with the same checks (no links followed, sizes capped, content checked as hostile):
- **Figures**: `infall-figure-1.png`, `infall-figure-2.png`, `infall-figure-3.png`, present when the process ends. Real PNG, at most 120 000 bytes each; anything else is left out.
- **Progress**: `infall-progress.json`, `{"step": "…", "done": 45, "total": 100}`, every part optional, rewritten whenever the code likes (written to another name and moved into place). Read when the monitor samples.

There is no `infall` module outside Python. Code written before the rename finds the same directory in `QOOP_RUN_DIR`, and its `qoop-figure-N.png` and `qoop-progress.json` are read too ([Names before the rename](#names-before-the-rename)).

## Q#
- Started as `<python> -u -X utf8 <the app's bundled qsharp_runner.py> <main.qs>`, with the environment of a Python Run.
- **Telemetry off.** `qdk` (and `qsharp` 1.28) sends a usage report to Microsoft by default: at exit it posts the OS kernel version, the locale and counts of what was called, and waits up to 3 s for an answer. The Runner starts every Run with `QDK_PYTHON_TELEMETRY=none` (M8, "Usage reports off"), and `qsharp_runner.py` sets it again in its own environment before the import, which both honour; with it, nothing opens a socket.
- `qsharp_runner.py` (bundled; standard library and `qdk` or `qsharp` only) imports `from qdk import qsharp`, and only when there is no `qdk`, `import qsharp`. Never `import qsharp` beside a `qdk`: the shim then writes a `DeprecationWarning` to standard error at every Run.
- It evaluates the whole text with one `qsharp.eval`. `Message` output and `DumpMachine` go to standard output as they happen (each is printed and flushed), so a long Run shows them while it runs. `eval` prints nothing for the value of a final expression, it returns it as a Python value: `qsharp_runner.py` prints it, as Q# itself writes a value in an interpolated string — `true`, `One`, `[Zero, One]`, `(1, true, One, s, 2.5)`, `PauliX`, `1..3` (not Python's `True`, `Pauli.X`, `<Range> 1..3`, `'s'`). A `Unit` value prints nothing.
- **The entry point** is the compiler's own: the callable marked `@EntryPoint()`, else the callable named exactly `Main`, in any namespace. One with parameters, and two of them, are compile errors (`Qdk.Qsc.EntryPoint.Args`, `…Duplicate`); with an `@EntryPoint()`, a `Main` is an ordinary callable. Neither `eval` nor anything else in the package calls it, and nothing tells Python which one it is. So after the text is evaluated, `qsharp_runner.py` finds it among the callables `eval` registered (`qdk.code`, with their namespaces, so `Demo.Main` is found), the `@EntryPoint()` one by its name in the text, and evaluates `<full name>()` unless the text has a call to it of its own besides the declaration (comments and string contents left out). Its value is printed like a final expression's. A text that declares callables and has neither runs nothing: no output, exit code 0.
- A Run is executed once. `qsharp.run` (many shots) takes an entry expression from Python, which a Run does not have; code that wants repetitions loops in Q#.
- Compile errors and failures while running both raise `QSharpError`. `qsharp_runner.py` prints its text — the error code (`Qdk.Qsc.Parse.Rule`, `Qdk.Qsc.Eval.UserFail`; `Qsc.…` in 1.28), the message and the lines it points at, positions given as `line_0:<line>:<column>`; a failure while running is preceded by `Error: program failed: …` and its call stack — and nothing of Python's, and the exit code is 1. Output written before a failure stays.
- When neither `qdk` nor `qsharp` can be imported (removed since the settings were saved), the output is one sentence saying what to install, and the exit code is 1.
- `qsharp_runner.py` writes `infall-env.json` as `runner.py` does, at exit: the Python version and one package, `qdk` (or `qsharp`) with its version read then by `importlib.metadata`, so an upgrade since the settings were saved is recorded as it ran. `pyqir`, which `qdk` requires, is not loaded by `eval` and is not recorded.
- `env`: `python`, `packages: { "qdk": "<version>" }` (or `"qsharp"`), `os`, `arch`. No figures, no `infall`; the monitor shows usage only.
- Stopping is as for Python: SIGTERM to the group ends it at once, also in the middle of a long computation, and nothing is left in its group.
- Nothing is written outside the Run's directory, and in it nothing but `infall-env.json`.

## The page
- Every Run shows its language beside its title: `Python`, `Q#`, `Julia`, `R`, `JavaScript`, `Shell`, and for any other id the id itself. Someone who may edit the Page can change it: the known ones, and **Other…** for an id typed by hand.
- **Run** is offered when `status().languages` has the Run's language. Otherwise the button is **Set up `<name>`** and calls `configure(lang)`. In a browser nothing changes: no Runner, the captured output is read as before.
- A result is shown as being from other code when its `code_sha256` differs from the present code **or its `lang` differs from the Run's**.
- The line under a result names what executed it: `Python 3.12.3`, `Q# · qdk 1.34.0` (the package and version in `env.packages`), or `runtime` as recorded.
- Export as Markdown (portability.md) tags the fenced code block with the Run's language id.

## Not here
Sandboxing or containers; compiling as a step of its own; installing a language or its packages; state kept between Runs (kernels, notebooks); syntax colouring per language; package versions for languages other than Python; a `infall` library for other languages; Toolchains shared across a Workspace — each Member sets up their own device.

## Environments and Toolchains — as built (M19 Part 2 and M19b, 2026-11-25)

One mechanism for both: a Run **names** what it wants — its language (`lang`) and, for Python and Q#, an environment (`env`) — and this device decides what the names start. A name this device does not know is asked once, in the Runner settings window opened at that question, and the answer is remembered. Nothing is ever installed.

### Bridge — exact shapes
```ts
type InfallRunner = {
  status(): Promise<{
    python?: { path: string; version: string };            // the default environment (M8)
    folder?: string;
    languages: Record<string, { name: string; version?: string }>;  // runnable now, python included
    environments: string[];                                 // env names that run here without a question
  }>;
  configure(lang?: string): Promise<void>;                  // opens Runner settings, at that language
  run(request: { id: string; code: string; title: string }, onEvent): Promise<void>;
      // M8, Python in the default environment. A request with `lang` other than "python" gets
      // one `error`/`failed` event and nothing runs (never as Python).
  start(request: { id: string; code: string; title: string; lang?: string; env?: string },
        onEvent): Promise<void>;                            // NEW: names a language and environment
  cancel(id: string): Promise<void>;
};
// RunEvent `done` gains `lang: string` (always present) and `env.runtime?: string`.
// RunEvent `error.reason` gains "no_toolchain" and "no_environment".
```
- `languages` versions: `python` → the Python version; `qsharp` → `"qdk 1.34.0"` (package and version); a command Toolchain → what `--version` said when it was saved, or absent. Only ids, names and versions reach the page; `status()` starts nothing (it reads the settings and the file system).
- `environments`: the names the Member mapped, the environments added by hand, and the found environments whose name is unambiguous. No paths.
- `env` is ignored for languages other than Python and Q#. An empty `env` is the default environment. An `env` that is not 1–60 characters of one line, without control or invisible characters, is `error`/`failed` before anything is shown.

**The old-app fail-safe.** An app from before this milestone has no `runner.start` (and no bridge command `runner_start`); its `run` silently drops `lang`. So the page must ask for every Run whose language is not Python **only** through `runner.start`, and when `typeof infallDesktop.runner.start !== "function"` refuse with "Update Infall on this computer to run Julia code." A Python Run naming an environment should also use `start` (on an old app, fall back to `run`: the name is only a wish). `status().languages` missing means the same thing. In the new app, `run` refuses another language in the bridge script and again in the command.

### Environments (Python, and Q#'s host)
- Found from the file system only, nothing started: conda (`CONDA_EXE`, `MAMBA_ROOT_PREFIX`, `~/miniconda3`, `~/anaconda3`, `~/miniforge3`, `~/mambaforge`, `~/micromamba`, Homebrew's Caskroom, `/opt/…`, and every prefix in `~/.conda/environments.txt`; a root is `base`, others by folder name), pyenv (`PYENV_ROOT` or `~/.pyenv`, each version and pyenv-virtualenv env by folder name; `~\.pyenv\pyenv-win` on Windows), a `.venv` or `venv` with `pyvenv.cfg` in the working folder; plus the interpreters on `PATH` (M8) and environments added by hand (name + path, checked with `--version`). Interpreter inside a prefix: `bin/python3`/`bin/python`; Windows `python.exe` or `Scripts\python.exe`.
- A Run's `env` is resolved: the Member's answer for that name (`runner.json` `names`), an environment added by hand under it, then the one found environment of exactly that name (two of the same name are ambiguous and ask). Otherwise the settings window opens asking "which environment does this name mean here"; the answer is saved; closed without one: `no_environment`, "No environment on this computer is chosen for “<name>”.". The interpreter is checked (`--version`) at every Run. With `INFALL_PYTHON_BIN` set, every Python Run uses it.
- An environment is started as its Python directly, not activated.
- `env.packages` (Python Runs): the distributions the code's top-level imports come from (`importlib.metadata.packages_distributions`, Python 3.10+; before that the module's own name), in the order the code names them, then what each of them requires directly (requirements that belong to an extra are left out; only installed ones), at most **32**, names as the distributions' metadata writes them. A local module no distribution provides counts by its name when it has `__version__`. Read in the Run's process when it ends; any failure leaves the list shorter, never breaks the Run.
- A Run that ends with an uncaught `ModuleNotFoundError` for a package that is really not there gets one more line: `[infall] This environment has no package <name>.` (The page need not add its own.)

`runner.json` gains, beside `python` (the default environment), `folder`, `qsharp`, `languages`:
```jsonc
"environments": [ { "name": "lab", "path": "/opt/lab/bin/python", "version": "3.13.1" } ],
"names": { "analysis": "/Users/me/miniconda3/envs/analysis/bin/python" },
"languages": { "haskell": { …, "off": true } }      // the switch; "qsharp": { …, "off": true } likewise
```
Saving another default Python forgets what Q# found (it is asked again).

### Toolchains
- Presets: `julia` (Julia, `julia`, `.jl`), `r` (R, `Rscript`, `.R`), `javascript` (JavaScript, `node`, `.mjs`), `shell` (Shell, `bash`, `.sh`), arguments `{file}`. Programs looked for on the login shell's `PATH`, then `~/.juliaup/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, R.framework, `/Applications/Julia-*.app`; on Windows `julia.exe`, `Rscript.exe`, `node.exe`, `bash.exe` there and in `Program Files\nodejs`, `Program Files\R\R-*\bin`, `Program Files\Git\bin`, `%LOCALAPPDATA%\Programs\Julia*\bin`. At most four per preset, each asked `--version`.
- **Shell on Windows** is bash too, where Git for Windows provides it — never `System32\bash.exe` or a WindowsApps one (WSL: a Linux that cannot open the Run's Windows path). cmd.exe and PowerShell are other languages: PowerShell can be added by hand (`pwsh.exe`, `-NoProfile -File {file}`, `ps1`); `.bat`/`.cmd` programs are refused. (The spec above said "not on Windows".)
- **A program that is there but not working** (2026-11-26). `--version` counts only when it ends with exit code 0; then its first line, from either stream, is the version (some programs print it on standard error). Crashed (a signal), failed (another exit code), no answer in five seconds, or not startable: no version, whatever it printed (a Homebrew `node` missing a library printed `dyld[…]: Library not loaded: …` and aborted, and that line had been taken for its version), and a short reason instead: `problem` on the found program in `presets[].found` and on a set-up language in `languages[]` of `runner_settings_view` (and in `runner.json`), e.g. "It crashed (signal 6) when asked its version. It said: dyld[27529]: Library not loaded: …" (at most 160 characters). Absent when it works, so older readers see a program without a version. Found programs that work are listed before those that do not, so the one offered first is never a broken one while a working one was found. A program with a `problem` may still be set up by hand (some programs fail on `--version` alone); `status()` is unchanged.
- **Locale.** A Run in a command language gets `LC_CTYPE=en_US.UTF-8` (`C.UTF-8` on Linux) when the login shell's environment sets none of `LC_ALL`, `LC_CTYPE`, `LANG` (an app started from the Finder usually has none: Terminal sets `LANG`, not the shell's files). Without it R prints `"αβγ"` as `"\316\261\316\262\316\263"` and counts its characters as bytes.
- **Stopping.** Besides the Run's process group, `cancel` ends what the Run started that left the group (Julia's `Distributed` workers and `run(detach(…))`, a shell's background jobs under `set -m`): found with `ps` (`pid`, `ppid`, `pgid`) just before the group is asked to stop, killed afterwards if each is still the same process in the same group. Something that left the group in a Run that ends by itself is not looked for. Unix only (on Windows the job object holds them).
- `{file}` may sit inside an argument (`--file={file}`); it appears exactly once in all arguments.
- Not set up, switched off, or its program gone: the settings window opens at that language; `no_toolchain`, "<Name> is not set up in Runner settings on this computer." (`Q# is not set up …` for Q#).
- Q# switch on: asks the default Python (`-I`, five seconds) for `qdk`, else `qsharp`; when neither: "Q# is not installed for the chosen Python. Install it into that Python with: pip install qdk (it needs Python 3.10 or newer)." — or, for a Python older than 3.10, "Q# needs Python 3.10 or newer, …". A Q# Run naming an environment runs in that environment's Python; `qsharp_runner.py` prints the install sentence when `qdk` is missing there. The recorded package is `qdk` whenever `import qdk` works (an early `qdk` 1.28 wraps `qsharp.code`), else `qsharp`.

### Approval
- The window shows the language next to the title; **Environment** (the name the Run asked for) when there is one; for Python the interpreter; for Q# "Q#, through Python at <path>"; for another language **Command**: the program and each argument as passed (quoted when it holds a space), `{file}` standing for the Run's file.
- Remembered per Workspace, `code_sha256`, language, **interpreter or program path**, and folder (pdf-sources.md Part 2, decision 4, which overrides "changing the Toolchain does not ask again" above): the same code sent as another language, or resolving to another environment's interpreter, or to another program, asks again. Changing only a Toolchain's arguments does not. Approvals remembered before this name no interpreter and ask once more after the update.

### Runner settings window
Python (the default, chosen among everything found and added; **Check again**), **Add an environment**, **Names Runs ask for** (each name → an interpreter, Remove), Folder, then **Save Python and folder** (the only part saved by a button; everything else is saved as it is changed), **Languages** (Q# switch with what was found; each preset either set up — switch, command, version, Remove — or a choice of found programs or a path and **Set up <Name>**; languages added by hand; **Add a language**: id, name, program, arguments one per line, extension), Approvals. When opened to ask, a notice at the top says what a Run asked for; answering it (choosing the environment, setting up the language) closes the window and the Run goes on; Escape or Close leaves the Run.
Settings window commands: `runner_settings_view({ refresh?: boolean })`, `runner_settings_save({ python, folder })`, `runner_settings_change({ change })` with `change` one of `{do:"add_environment",name,path}`, `{do:"remove_environment",name}`, `{do:"map",name,path|null}`, `{do:"qsharp",on}`, `{do:"set_language",id,name,program,args,ext}`, `{do:"remove_language",id}`, `{do:"enable_language",id,on}`, `runner_settings_forget`, `runner_settings_close`.

### Not done here
Activation of conda environments (`PATH`, `CONDA_PREFIX`); versions of a found environment are asked only when the settings window looks; package versions for languages other than Python; Windows and Linux not run (only macOS).

## Checked on 2026-11-24 with qsharp 1.31.0 (qdk 1.34.0) on macOS arm64
The section was first written from the package's documentation as remembered; the Q# part above is now what running it showed. Scripts, samples and their captured output, to repeat the check: [qsharp-check.md](qsharp-check.md).

Verified on macOS 26.5 arm64, Python 3.12.13, in a throwaway virtual environment, programs started as the Runner starts them (`-u -X utf8`, standard input from `/dev/null`, one pipe for both streams, own process group):
- `pip install qsharp` installs `qsharp` 1.31.0 (a pure-Python shim, the last release, 31 July 2026), `qdk` 1.34.0 and `pyqir` 0.12.8. `qdk` alone, and `qsharp` 1.28.0 alone, run every sample the same way.
- `Message` and `DumpMachine` output on standard output as it happens; values returned, not printed; the formatting of each kind of value; `Unit` as `None`.
- The entry-point rule, with namespaces, `@EntryPoint()`, a `Main` with parameters, two `Main`s, a `Main` the text calls itself, no entry point, a syntax error, a failure while running.
- Errors as `QSharpError` (an `Exception` at run time, though the package's type stubs say `BaseException`) and their text; `qsharp.run` raises at the first failing shot instead of returning the failure in its list as its docstring says.
- `importlib.metadata.version` under `-I`: `"qdk"` → `1.34.0`, `"qsharp"` → `1.31.0` (shim) or `1.28.0`; neither has a `__version__`.
- Telemetry: what is sent and when (to a local listener, never to Microsoft's address), up to 3 s added at exit when the answer is slow, nothing sent and no socket opened with `QDK_PYTHON_TELEMETRY=none` (a Python audit hook and `lsof` on the running process).
- Nothing written in a fresh `HOME`, `TMPDIR`, the working directory or the environment's `site-packages`, except `infall-env.json` in the Run's directory.
- SIGTERM to the group ends a never-ending Q# loop in milliseconds, nothing left; SIGINT does not (only SIGKILL then).
- Time, warm: Python start 0.02 s, `import qdk.qsharp` 0.11–0.15 s, the whole of a small Run 0.23 s. The first import after installing took 1.0 s.

Read from PyPI, not run: `qdk` 1.34.0 has wheels for macOS arm64 (11.0+) and x64 (10.12+), Linux x64 and arm64 (`manylinux_2_28`, glibc 2.28+), Windows x64 and arm64, all `cp310-abi3` (any CPython 3.10 or newer; the package requires `>=3.10`). `pyqir` 0.12.8 has the same platforms.

Not verified, to confirm in M16/M19b on each system: Windows x64 and Linux (x64, arm64) — the import, the output through the pipe, `-X utf8` with non-Latin text, stopping (a job object on Windows), and that nothing is written outside the Run's directory; a Python older than 3.10 when the switch is turned on.

# M15 — Undo in the Edit menu

The Edit menu's **Undo** and **Redo** name the open Branch's next step and take it ([undo.md](undo.md), decisions 6, 7 and 11). The web UI does all the undoing; the app shows what the page says and passes a click on to it.

## The keys are the page's
**On every platform the page handles Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl+Y itself, as in a browser. The menu never acts on these keys in its place.** For the web UI this means:
- When focus is not in a field being edited, act on the key **and call `preventDefault()` on the event**. Do that also when all it does is say "Nothing to undo".
- When focus is in a field being edited, leave the event alone (no `preventDefault()`). The field's own text undo then happens, on macOS through the system's Edit menu item.
- Do not look for the desktop app. There is no flag to check: the handler is the same as in a browser.

Why one press is one undo:
- **macOS.** WKWebView gives a key pressed with ⌘ to the page first. It passes the key on to the menu only when the page did not prevent its default (it sends the unhandled event to the application again). The items keep the key equivalents the system's items had (⌘Z, ⇧⌘Z). So a key the page took never reaches the menu, and a key it left reaches the system's text undo.
- **Windows.** The items keep the keys the system's items had (Ctrl+Z, Ctrl+Y). The web view has the keyboard, so the page gets the key.
- **Linux.** The items have no key. GTK gives a menu's keys to the menu before the focused web view, so a Ctrl+Z there would take text undo away from every field.

## What each item is
Undo and Redo each follow one rule (`bridge::edit_item`):
- **The main window has focus and its page names a step**: the app's own item, titled with the step ("Undo Move 3 Cards"). Choosing it calls the page's `undo()` or `redo()`.
- **Otherwise, on macOS and Windows**: the system's own item, exactly as before M15. Text fields in the page, on the start screen and in the Runner settings keep their undo. The two items are swapped in place and are never in the menu together, since they have the same key. The system's item is never greyed out, on macOS either: the menu library turns off the system's automatic enabling of items, so nothing asks the focused field whether it has anything to undo. Choosing the system's item with nothing to undo does nothing.
- **Otherwise, on Linux**: the app's own item, plain "Undo" or "Redo", greyed out. GTK has no working system item. On Linux the menu bar has a second menu, **Edit**, with just these two items.

The page's state is `{ undo: null, redo: null }` both when there is nothing to do and while a field is being edited. The app cannot tell these apart, so in both cases it falls back to the system's item.

The title is the page's label, made one line of plain text: control characters become spaces, runs of space become one, and characters that change the direction of text are removed. A label that does not start with the item's verb gets it put in front: whatever a page says, the item starts with what it does. At most 80 characters, cut with "…".

## How the menu learns the page's state
Only through the bridge, under its rules (the open Workspace's origin, the top frame, the main window, the bridge key). The page gets nothing new: `window.infallDesktop` is unchanged.
- The bridge script watches the page's `window.__infallUndo`. It sees the object as soon as the page sets it, through an accessor the script puts on `window` before the page's scripts run. When it finds the object, it calls `subscribe`. When `state()` gives two labels other than the last ones sent, it posts them to the app with the bridge command `undo_state` (`{ key, undo: string | null, redo: string | null }`, each label at most 200 characters). Posts are sent one at a time, in order, and only when something changed.
- It also reads `state()` again after every `focusin`, `focusout`, `pointerup` and `keyup`. Entering or leaving a field changes what the menu should be, even if the page does not notify. This also covers a page that sets its object without assigning to `window.__infallUndo`. **The web UI's `subscribe` should still notify on every change of `state()`, focus included.** Then the title is right also for Changes that arrive without a gesture (a Merge clears the list).
- `undo_state` is refused unless the call passes `bridge::check_caller`, like every bridge command. It is never accepted from the start screen, the Runner settings or an approval window, or from another origin.
- The app pulls nothing. muda, the menu library, has no "menu will open" event, so the page has to push.
- When the main window's page starts loading or the window is destroyed, the steps are forgotten. When the window gains or loses focus, both items are decided again.
- Without the object (an older web UI, a Team server's page that is not Infall's) nothing is posted. The menu is then exactly what it was before M15.

The main window's bridge grants eleven commands: those of M13 and `undo_state`.

## Choosing the app's own item
The app runs a short script in the main window's page, and only while that window still shows the open Workspace's origin (`bridge::page_step_script`). The script checks `state()` once more. If the state still names a step, it calls the page's own `undo()` or `redo()`. If not (a field was entered after the menu was last told), it runs `document.execCommand('undo')` (or `'redo'`), which is what the system's item would have done. Errors stay in the page.

## Not in M15
A menu item that tells "nothing to undo" apart from "a field is being edited" (the page's state does not say which). An Undo item for the start screen or the Runner windows beyond the system's own. Key equivalents on Linux.

**Seen on macOS 26.5 (arm64)**, in a scratch build against a fake page object, with the app driven from the background:
- the page's state reached the menu: Undo became the app's own item, "Undo Rename R&D" (the `&` shown once);
- choosing it called the page's `undo()` once. Through `subscribe` the titles then moved to "Undo Move 3 Cards" and "Redo Rename R&D";
- choosing Redo called `redo()` once and put the system's Redo back.

That build treated the main window as focused, because a window of an app in the background is never the focused one. In the real build, run the same way, the items stayed the system's own, as the rule says.

**Not seen:** the focus rule switching to the app's own items in a frontmost window; a real ⌘Z (WebKit giving the key to the page first, and `preventDefault()` keeping it from the menu); the fallback to text undo in a field; Windows; Linux.

# M18 — Moving a Local Workspace onto a Team server

The contract is [team-move.md](team-move.md) (decision 3, Contract A for the server crate, Contract C for the start screen and the bridge). This section says what the shell does with it.

## The start screen's new command
Added to the `setup` window's commands, under the M12 rules (that window only; a failure rejects with one plain sentence):

```ts
workspace_move({ id: string, address: string }): void
```

- Local only, and not one already moved. The address is checked exactly as for `workspace_connect` (the M7 rules and the health check), before anything is written.
- A Workspace file is written with Contract A's `export_for_move` (until the server crate has it, a local wrapper around `export_workspace`: `shell::export_for_move`) into `moves/` in the app's data directory, a folder only the owner can open, under a random name. A file larger than 512 MB is refused (what a Team server takes by default).
- The Team Workspace is remembered as `workspace_connect` remembers it, the pending move `{ id, origin, file, at }` is kept in `workspaces.json` (`pendingMoves`; `file` is a name in `moves/`, never a path), and the Team Workspace is opened. One pending move per Team server and per Local Workspace: a new one replaces the one before, and its file.
- A pending move is dropped with its file when it is 7 days old, when its Team Workspace is forgotten, when its Local Workspace is removed, once the server has the Workspace, or when the server's page cancels it (`moveDone({ ok: false, cancel: true })`). Files in `moves/` that no pending move names (a move cut short) are deleted when the app starts.

`WorkspaceEntry` gains `movedTo: string | null`: the Team origin a Local Workspace was moved to. Such a Workspace's server is started with `read_only: true` (in one place, `shell::local_options`).

The start screen: a Local row's ⋯ menu has **Move to a Team server…**, which asks for the address in the row. A moved row says **Moved to <host>**, its main action is **Open on the server** (`workspace_connect` with that origin), and its menu keeps Rename, Export…, Show in folder and Remove…, with **Open this copy (read-only)** for the copy on this computer.

## Bridge — handing the file over
Added to `window.infallDesktop` under the same rules as the rest of the bridge (the open Workspace's origin, the top frame, the main window, the bridge key). Each answers only about a move pending to the origin the main window shows: on any other server `moveHandover()` is `null` and the other two reject.

```ts
moveHandover(): Promise<{ name: string; size: number } | null>
  // The Local Workspace's name and its file's size in bytes.
moveFile(): Promise<Uint8Array>
  // The file's bytes. Rejects with a sentence when there is nothing to hand over.
moveDone(result: { ok: boolean; cancel?: boolean }): Promise<void>
  // ok: the Local Workspace is marked movedTo = this origin, its file deleted, the move
  // forgotten (cancel is ignored). Not ok: nothing changes; the page can ask again.
  // Not ok with cancel: true (the server can never take it: not empty, or the person is not
  // an Admin): the move is forgotten and its file deleted; the Local Workspace stays as it
  // was, not moved, and can be moved again from the start screen.
```

## Bridge — saving a file the page made

```ts
saveBinaryFile(file: { suggestedName: string; bytes: Uint8Array }): Promise<boolean>
  // As saveFile, for bytes: the system's save dialog, the name made safe as saveFile makes it,
  // written whole or not at all. false when cancelled. At most 512 MB. An ArrayBuffer or any
  // typed array is taken too.
```

For a PNG of the Board and a Team Workspace's Workspace file. The web UI checks that it exists; without it (a browser, an older app) it downloads the file the browser's way.

## How the bytes travel
The server's pages may connect only to their own origin (`connect-src 'self'`), so the web view cannot reach Tauri's `ipc:` protocol from them and every call goes through the web view's message channel. There a binary answer arrives as a JSON array of numbers (about four characters a byte), and a `Uint8Array` argument goes the same way. So both directions are **chunked base64**, in calls the bridge script makes by itself:

- `moveFile`: `move_file_chunk({ offset })` answers `{ size, data }`, at most 4 MB of the file a call; the script fills one `Uint8Array` of `size` and rejects if the size changes between calls. Limit 512 MB.
- `saveBinaryFile`: `save_binary_begin({ size })` gives a ticket, `save_binary_chunk({ ticket, offset, data })` sends 3 MB of bytes a call (in order; at most 8 MB of text a call), `save_binary_finish({ ticket, suggestedName })` shows the dialog and writes. The bytes are held in the app's memory until then; one file at a time, dropped when the page starts loading another page or the window closes. Limit 512 MB.

The main window's bridge grants seventeen commands: those of M15, the three of the move and the three of the binary save. (Since M19/M19b eighteen: `runner_start`, below.)

## Not in M18
Moving a Workspace that was already moved; moving onto a server that is not empty (the server refuses); a progress figure for the copy before the server opens; the bridge opening the Team server from a read-only copy's page.


# M19 — PDFs across the bridge

[pdf-sources.md](pdf-sources.md), Part 1, decisions 6 and 10. Built 2026-11-25 (desktop zone). The shapes below are binding where they differ from that spec's "Desktop" line (`pickFolder` returns a token, not a path; `readFileIn` replaces `readFileAt`; `openExternally` is the name).

## Bridge

Added to `window.infallDesktop` under the same rules as the rest of the bridge (the open Workspace's origin, the top frame, the main window, the bridge key):

```ts
pickFolder(): Promise<{ token: string; name: string } | null>
  // The system's folder dialog ("Choose the folder with the PDFs"). The page gets an opaque
  // token (32 hex characters) and the folder's display name, never its path. null when cancelled.
  // At most 8 tokens are held; the oldest is forgotten first. Every token dies when the page
  // starts loading another page or the main window closes.
readFileIn(token: string, relativePath: string): Promise<Uint8Array>
  // A PDF inside that folder. `relativePath` is relative to it, or an absolute path, or the
  // whole `file` field of a BibTeX entry as Zotero, JabRef or Mendeley write it
  // ("description:path:type", several separated by ";", "\:" and "\\" escaped): its paths are
  // tried in order after the string itself. A candidate counts only when, after every link is
  // followed (canonicalised), it is an existing file inside the folder (canonicalised when it
  // was picked). "..", absolute paths elsewhere and links leading out are "There is no such file
  // in the folder you chose." Only a PDF (the first bytes are "%PDF-"; the name says nothing),
  // at most 100 MB (files::MAX_PDF_BYTES, the server's INFALL_MAX_PDF_MB default). Rejects with a
  // sentence; an unknown or dead token is "Choose the folder again."
openExternally(file: { suggestedName: string; bytes: Uint8Array }): Promise<void>
  // A PDF the page has, opened in the system's default viewer. Checked in the page and again
  // in the app: "%PDF-" first, at most 100 MB. Written owner-only to
  // <app cache folder>/opened/<random>/<suggestedName made safe, ending in .pdf>; everything
  // under opened/ is deleted when the app quits and again when it starts (a file a viewer still
  // holds open on Windows stays until then). At most one a second. An ArrayBuffer or any typed
  // array is taken too.
```

How the bytes travel is M18's way (chunked base64, `transfer.rs`): `readFileIn` calls `folder_file_chunk({ token, path, offset })`, which answers `{ size, data }` with at most 4 MB of the file a call, resolving and checking the path again and checking the PDF header at every piece; the script fills one `Uint8Array` and rejects if the size changes between calls. `openExternally` sends its bytes with `save_binary_begin` and `save_binary_chunk` (the binary save's one slot: a save and an open at the same time drop the first) and ends with `open_external_finish({ ticket, suggestedName })`.

The main window's bridge grants twenty-one commands: M18's seventeen, `runner_start`, and `pick_folder`, `folder_file_chunk`, `open_external_finish`.

What it does not guard against: a file inside the folder replaced by a link between the check and the read (the read opens the canonical path found a moment before); a PDF that exploits the system's viewer — the same file opened from the Finder or Explorer would.

## Bridge — fullscreen (built 2026-11-25)

On macOS the main window has no title bar of its own (`TitleBarStyle::Overlay`): the top bar's first row, 36px tall, is the title bar, and its left 75px are left free for the traffic lights. In fullscreen macOS hides them, so the page is told:

```ts
fullscreen: {
  current(): boolean,                                  // synchronous; last known state, false until known
  subscribe(fn: (on: boolean) => void): () => void,    // called on every change, including the first
                                                       // answer after load if it differs from false;
                                                       // returns unsubscribe
}
```

- The bridge script asks as it runs, before the page's own scripts: `window_fullscreen({ key, onChange })`, one more bridge command, checked with `bridge::check_caller` like the rest. `onChange` is a channel; the app sends the state at once (`Window::is_fullscreen`) and again whenever it changes, every value through the channel so that they arrive in order. The command returns nothing. A later call (the next page) replaces the channel; it is dropped when the main window closes.
- Changes: on every `WindowEvent::Resized` of the main window the app reads `is_fullscreen()` again and sends it only when it differs from what the page was last told. Entering and leaving fullscreen resize the window however they were asked for, the green button and the View menu included. On macOS tao marks the window fullscreen when the system says it will enter (`windowWillEnterFullScreen:`, also for the green button) and clears it when it has left (`windowDidExitFullScreen:`), and sends a resize after both transitions end, so the state read then is the final one. While the exit animation runs the page still hears `true`.
- First frame: the answer is a round trip through the IPC started from the initialization script, so it normally arrives before the web UI first renders, but nothing waits for it. A page that renders first sees `false` for a moment and then hears `true` through `subscribe`. A new main window opens normally out of fullscreen, so this matters mostly after a reload in fullscreen.
- Linux and Windows: the member is there and tells the truth; nothing uses it.
- The page can only read. It cannot enter or leave fullscreen or reach anything else about the window.

The main window's bridge grants twenty-two commands: M19's twenty-one and `window_fullscreen`.

The traffic lights are placed with `traffic_light_position(12, 20)`. tao makes the buttons' container 14 + y tall (the button's height plus y) and moves the buttons sideways only; AppKit keeps each button 9pt up from the container's bottom (macOS 26: 14pt buttons, 32pt default bar). The centre is then 14 + y − 9 − 7 = y − 2 = 18px from the top. tao applies it again on every draw of its view, after a title change and after leaving fullscreen. Since "Bridge — chrome scale" y follows the page's interface scale (20 at 100 %).

## Bridge — chrome scale (built 2026-11-26)

The page's interface scale (Settings → Appearance, 80–150 %) is CSS `zoom`: the top bar's first row is 36px × scale points tall, while the traffic lights do not zoom. So the page tells the app its scale, and the lights' centre is put 18 × scale points from the top:

```ts
chromeScale(scale: number): Promise<void>   // a factor: 1 = 100 %
```

- The bridge script refuses anything but a finite number; otherwise it sends `chrome_scale({ key, scale })`, one more bridge command, checked with `bridge::check_caller` like the rest. The app refuses a non-finite number and clamps the rest to 0.8–1.5 (`bridge::chrome_scale`): all a page can do with it is move the lights up or down within what the setting allows. Nothing comes back. Linux and Windows: checked, then nothing.
- y = 18 × scale + 2 (`bridge::traffic_light_y`; see "Bridge — fullscreen" for why the centre is y − 2). x stays 12. The brand cell's room for the lights is 75px at 100 % and above, and 75 real points below 100 % (DESIGN.md "Top bar, two rows"): at 80 % 75px would be 60 points, short of the lights' right edge at 65.
- Moving them while the window is open: Tauri 2.12.7 builds a window with `traffic_light_position` but has no setter on its `Window`. Its runtime has one (`WindowDispatch::set_traffic_light_position`, `tauri-runtime` 2.12.4 `src/lib.rs:1025`, sent as `WindowMessage::SetTrafficLightPosition`, handled by `tauri-runtime-wry` 2.12.5 `src/lib.rs:3567–3570` with tao's `set_traffic_light_inset`), but the dispatcher is `pub(crate)` (`tauri` `src/window/mod.rs:998`). The app therefore adds a `tauri-runtime-wry` runtime plugin (`App::wry_plugin`, `chrome::Inset`): `chrome_scale` (async, so off the main thread) stores the y and wakes the event loop with an empty `run_on_main_thread`; the plugin, at that message, finds the main window's runtime id by its label and sends it `SetTrafficLightPosition` and then `SetTitle` with the same title. tao's setter only stores the inset (tao 0.37.3 `platform_impl/macos/window_delegate.rs:1553–1563`); a title change applies it at once (`set_title`, `:594–597`). From then on tao applies the new value on every draw of its view (`view.rs:197–199`) and on leaving fullscreen (`window_delegate.rs:1884–1886`), so a scale changed in fullscreen, where the lights are hidden, holds once the window leaves it.
- First frame: the scale lives in the page's storage, per origin, which the app cannot read before the page has loaded. The app keeps what each Workspace's page last said in `window.json` in its config directory (`chrome::remember`, written only on a change) and builds the next main window for that Workspace with it (`chrome::remembered`; 100 % when unknown). `public/boot.js` tells the app the saved scale as the page's head loads, and `useAppliedPrefs` again at start and on every change. So the lights jump only the first time a Workspace's window opens with a scale other than 100 % (nothing remembered yet), or when the setting was changed in a browser tab of the same origin since.

The main window's bridge grants twenty-three commands: twenty-two and `chrome_scale`.

## Export… with or without the PDFs

`workspace_export({ id, includeFiles?: boolean })`: `includeFiles` absent means true. `WorkspaceEntry` (local.md, Contract C) gains `files: { count: number, bytes: number } | null`. When a Local Workspace's `files.count` is above 0, **Export…** opens a panel in its row with a checkbox "Include PDFs (N files, X MB)", ticked, and **Export…**; otherwise it exports at once as before. **Export first…** in the remove confirmation and every automatic backup include them.

Until the server crate has them, both ends are stubs in `src/shell.rs`, each one marked `TODO(M19 zone 1)`:
- `stored_files(db)` answers `None`, so the checkbox is never shown. Replace its two body lines (`let _ = db;` and `None`) with the server crate's count, as `Some(FilesSummary { count, bytes })`.
- `export_with_files(db, dest, include_files)` ignores the flag. Replace its two body lines (`let _ = include_files;` and `export_workspace(db, dest)`) with `export_workspace_with(db, dest, ExportOptions { include_files })`, and import both from `infall_server::local`.

# Updates

[release.md, section 11](release.md#11-updates-m20-groundwork). The start screen gets two commands (capability `setup`): `update_view(): { version: string, notice: string } | null` and `update_install(): void` (refused while a Workspace is open; backs up every Local Workspace first; on success the app starts again as the new version). A build without the updater answers `null` and refuses `update_install` with "This version of Infall does not update itself."; the start screen then shows nothing. Since 28 November 2026 the app also asks by itself, in a message of the system's over the open Workspace, when a version becomes ready: **Restart to update** leaves the Workspace as **Switch Workspace…** does and then installs as `update_install` does; **Later** does nothing. The app menu has **Get beta builds** (a tick) in a build given a feed of them. No command of the bridge is added: a Workspace's page cannot ask about, start or redirect an update.

# Names before the rename

Until 0.9.0 was renamed in its code (CHANGELOG, 0.9.0), its builds used the working name `qoop`. Data those builds left on a computer keeps working; these old names are still read, and nothing new is ever written under them:

- **The app's folders** (`src/rename.rs`, at the start, before the list of Workspaces is read and before any web view opens). Old identifier `app.qoop.desktop`, new `app.infall.desktop`. The folders moved, each old one into the new one beside it: the config folder and the data folder (one folder on macOS, `~/Library/Application Support/<identifier>/`; Linux `~/.config/<identifier>/` and `~/.local/share/<identifier>/`; Windows `%APPDATA%\<identifier>\` and `%LOCALAPPDATA%\<identifier>\`), and on macOS the web view's own `~/Library/WebKit/<identifier>/`. That carries `workspaces.json`, every Local Workspace's folder with its database, key and backups, `moves/`, `runner.json` and `runner-approvals.json` (no key in either holds the old name: they need no mapping), `window.json`, `updates.json`, and the web view's storage where the app can reach it (below). Only when the new folders hold no Workspace (no listed one, no Local Workspace's folder; an empty list is kept aside as `workspaces.json.empty-before-move`) and an old folder exists. Each Workspace's folder, then each other file or folder, is copied beside its new place, compared byte for byte, renamed into place, and only then removed from the old folder (`datadir::move_one`, the Windows move's own steps); nothing in a new folder is ever written over. A Workspace that cannot be moved stays where it is and is used from there (`Registry`'s legacy folders), and the start screen says so as for the Windows move. `.moving-from-app.qoop.desktop` in the new config folder marks a move that failed to move a Workspace or a file; the next start goes on with it, and it is removed once nothing failed. Something the new folder already had is not tried again: its old copy stays in the old folder. The cache folder (`~/Library/Caches/app.qoop.desktop/`, `~/.cache/app.qoop.desktop/`: only PDFs handed to the system's viewer, cleared at every start) is not moved.
- **The web view's storage.** The page's settings on this device (theme, scales, whether the tour was offered, the AI sidebar's Conversations) are in the web view's storage, per origin; a Local Workspace keeps its port, so its origin, so they are found again if the storage itself moved. Windows (WebView2's `EBWebView\` in the local data folder) and Linux (WebKitGTK's storage in the data folder): moved with the folder. macOS: WKWebView keeps it in `~/Library/WebKit/<bundle identifier>/`, which the app moves as above; that folder is WebKit's, not the app's, so this is the one part that rests on WebKit reading a moved folder as its own (it is not documented). Cookies (`~/Library/HTTPStorages/`) are not moved: sessions are made again (each Local Workspace signs its Member in by itself). A development build run without a bundle (`cargo run`) keeps WebKit's storage under the program's name, which was `qoop-desktop`: not moved.
- **Storage keys in the page** (`web/src/ui/settings/renamedKeys.ts`, before anything reads them): each `qoop.ai.<member>` and `qoop-tour:<member>` value is copied to `infall.ai.<member>` / `infall-tour:<member>` when that key is absent; the old keys are left. `qoop-theme` (the theme before Settings, M12) is read where it always was (`prefs.ts`, `public/boot.js`).
- **The Run contract** (`runner/src/exec.rs`, `monitor.rs`, `runner.py`): every Run gets both `INFALL_RUN_DIR` and `QOOP_RUN_DIR`; figures are read as `infall-figure-N.png`, else `qoop-figure-N.png`; progress from `infall-progress.json`, else `qoop-progress.json`; the description from `infall-env.json`, else `qoop-env.json`; in Python the module `infall` is also importable as `qoop` (the same module object). `runner.py` and `qsharp_runner.py` write only the new names.
- **Environment variables** of the app (`infall_proc::env_var_os`): `INFALL_PYTHON_BIN`, `INFALL_CLAUDE_BIN`; when unset, `QOOP_PYTHON_BIN` / `QOOP_CLAUDE_BIN` are used, with one warning line on standard error.
- Not kept: the bridge (`window.qoopDesktop`, now `window.infallDesktop`; the page and the app ship together), the MCP server's name in the Claude Code config (`mcp__infall__*`, made anew for every turn), the session cookies and the request header (people sign in again).
