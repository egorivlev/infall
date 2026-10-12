# Qoop desktop app — contract (M7)

The desktop app ([ADR 0002](../adr/0002-desktop-app-primary-browser-fallback.md), [ADR 0003](../adr/0003-ai-through-members-claude-subscriptions.md)) is a thin Tauri shell around the same web UI the server serves. What it adds in M7 is one thing: the AI sidebar can run on the Member's own Claude Code. (The Runner is M8.)

## Shell
- First start (or "Change server…" from the app menu): a small local screen asks for the server address (`https://…`; `http://` only for `localhost`/`127.0.0.1`), checks `GET <address>/api/health` answers `{ "ok": true }`, stores the address in the app's config directory, and loads the server's UI in the main window. Later starts go straight there.
- The window shows only that origin. A navigation to any other origin is refused and opens nothing — a script in any frame, a Visual's sandbox included, can start one, and it looks the same as one the Member started. Only a link that asks for a new window (`target="_blank"`, which every external link in the UI uses and which a sandboxed frame cannot do) is handed to the system browser, at most once every two seconds. No address bar, no devtools in release builds.
- The server's pages are remote content: they get **no** general access to the app. The only thing exposed to that one origin is the bridge below; nothing is exposed to any other origin or to frames (the Visual sandbox frame included).

## Bridge — `window.qoopDesktop`
Present only inside the desktop app, only on the configured server origin, only in the top frame. The web UI detects the app by its presence.

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
The app starts the Member's own `claude` in print mode, in a fresh empty temporary directory, with **only** the Qoop tools:

- output as a stream of JSON events with partial messages, mapped to `AiEvent` (assistant text → `delta`; a tool call → `tool` with the bare tool name; the final result → `done` with the session id and model; anything that fails → `error` with a plain sentence);
- the Qoop `/mcp` server given through a config **file** written with owner-only permissions and deleted when the run ends (the token must never be on the command line, where other local processes could read it), with strict MCP config so the Member's other MCP servers are not loaded;
- **every built-in tool disabled** (no shell, no file read/write/edit, no web fetch, no sub-agents) and only the eight `mcp__qoop__*` tools allowed — text on a Board is written by other people and other AIs, and must not be able to make an AI act on the Member's machine;
- the Member's own Claude Code settings, hooks, plugins, memory files and project instructions not loaded, as far as the CLI allows (document exactly which flags achieve what, and what could not be switched off);
- the `system` text appended to the system prompt; `resume` passed when given; the prompt sent on standard input, not as an argument.

One run at a time per window; `cancel` terminates the process (and its children). A run with no output for 120 s is terminated with an `error`. The app never reads or stores the Member's Claude credentials, and sends nothing anywhere itself: only the `claude` process talks to Anthropic, under the Member's own login.

The path of the `claude` binary can be overridden with the environment variable `QOOP_CLAUDE_BIN` (used by tests with a stub that prints a canned event stream).

## Not in M7
Auto-update, code signing/notarisation, installers for other platforms, the Runner (M8), offline use.


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
