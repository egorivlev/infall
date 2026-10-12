# Qoop desktop app

A thin [Tauri v2](https://v2.tauri.app/) shell around the web UI that the Qoop server serves. It adds two things: the AI sidebar can run on the Member's own Claude Code (M7), and the **Runner** executes Runs on the Member's own computer (M8; see [The Runner](#the-runner) and [its security model](#the-runners-security-model-in-plain-words)). The contract is [`docs/specs/desktop.md`](../docs/specs/desktop.md); the reasons are in ADR [0002](../docs/adr/0002-desktop-app-primary-browser-fallback.md) and [0003](../docs/adr/0003-ai-through-subscriptions-and-a-shared-tool-layer.md).

```
desktop/
  ui/                      the app's own local windows (plain HTML/CSS/JS, no build step)
    index.html, setup.*    the first-run screen
    approval.html, .js     the Runner's approval window
    runner.html, .js       the Runner settings window
  src-tauri/               the app (Rust); a Cargo workspace of its own, excluded from the root one
    src/shell.rs           the Tauri layer: windows, menu, the commands
    src/bridge.js          defines window.qoopDesktop on the server's pages
    src/bridge.rs          who may call the bridge and the local windows' commands
    src/address.rs         server address rules, health check, navigation rule
    src/config.rs          the saved server address
    capabilities/          what each local window may call
    driver/                qoop-claude-driver: runs `claude`; no Tauri types
      tests/stub-claude.sh a stand-in `claude` for tests
    runner/                qoop-runner: the Runner; no Tauri types
      src/approvals.rs     the approval gate and the remembered approvals
      src/inspect.rs       what the approval window shows of the code
      src/exec.rs          the process, its output, figures, temporary directory
      src/runner.py        the program that runs the code (standard library only)
      src/python.rs        finding and checking interpreters, the shell's environment
      src/settings.rs      the chosen interpreter and folder
      tests/real_python.rs the Runner against a real Python
    proc/                  qoop-proc: process groups and private folders, shared by both
```

## Prerequisites

- Rust 1.90 or newer (Tauri 2.12 needs it). Built and tested here with 1.96.
- macOS: the Xcode Command Line Tools are enough (`xcode-select --install`); full Xcode is not needed for a development build. Linux and Windows need the usual [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/); those platforms have not been built or run (see "Unverified").
- The Tauri CLI (`cargo tauri`) is **not** needed to build or run. It would only be needed to produce an installer bundle (`.app`/`.dmg`), which is not part of M7.
- For the AI sidebar: Claude Code installed and signed in (`claude`), version 2.1.x. The flags below were read from 2.1.265.
- For the Runner: a Python 3 (3.8 or newer) of the Member's own. matplotlib only if Runs draw figures. The Runner tests use whatever Python 3 they find (see "Tests").

## Build and run in development

Start the server and its UI as usual (`cargo run -p qoop-server` from the repository root; it listens on `http://localhost:8787`). Then:

```sh
cd desktop/src-tauri
cargo run
```

On first start the app asks for the server address: enter `http://localhost:8787`. It checks `GET /api/health`, saves the address (macOS: `~/Library/Application Support/app.qoop.desktop/config.json`) and shows the server's UI. Later starts go straight there. **Qoop → Change Server…** brings the first-run screen back.

Checks:

```sh
cd desktop/src-tauri
cargo test                                   # driver (stub claude) + Runner (real Python) + app rules
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

A release build with plain cargo needs one feature, so that the app's own files are served from inside the binary (`cargo tauri build` would turn it on by itself):

```sh
cargo build --release --features custom-protocol
```

Release builds have no web inspector: the `devtools` feature of the `tauri` crate is off, and Tauri only enables the inspector by itself in debug builds.

To use a different `claude` (tests do this with the stub): `QOOP_CLAUDE_BIN=/path/to/claude cargo run`. Without it the app looks for `claude` on `PATH`, then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin` (an app started from the Finder gets a short `PATH`).

## What is where: Tauri mechanisms used

Tauri **2.12.7** (`tauri-build` 2.7.6, `wry` 0.57.3). Version 3 exists only as an alpha and is not used.

| Need | Mechanism |
|---|---|
| Show the server's UI | The main window is created at run time with `WebviewUrl::External(<origin>)`. There are no windows in `tauri.conf.json`. |
| First-run screen | A second, local window (`setup`) showing `desktop/ui/index.html`, with its own static capability (`capabilities/setup.json`): it may call `setup_current` and `setup_save`, nothing else. |
| Approval window, Runner settings window | Local windows too (`runner-approval-<ticket>` showing `approval.html`, `runner-settings` showing `runner.html`), each with its own static capability (`capabilities/runner-approval.json`, `runner-settings.json`) that names only its own commands and only its own window labels. |
| Give the bridge to one origin, known only at run time | `build.rs` declares the app's commands in an app manifest, so each has a permission (`allow-claude-send`, …) and nothing may call a command without a capability. When the main window is created, the app adds a capability **at run time**: `app.add_capability(CapabilityBuilder::new("qoop-bridge").remote("<origin>/*").window("main").permission("allow-claude-status")…)`. Tauri checks the calling page's URL against it on every call. |
| Stream from Rust to the page | A Tauri `Channel<AiEvent>` passed to `claude_send`. No event-plugin permission is granted to the page. |
| Put `window.qoopDesktop` on the page | `WebviewWindowBuilder::initialization_script`, which runs in the **main frame only** (the all-frames variant is a separate method and is not used). |
| Keep the window on one origin | `on_navigation`: the configured origin (and `about:blank`, `about:srcdoc`, same-origin `blob:`) is allowed; everything else is refused and **nothing is opened** (a script in any frame can start a navigation). `on_new_window` (links with `target="_blank"`, which a sandboxed frame cannot use): always refused in the app and opened in the system browser, at most once every two seconds. |
| Open the system browser | `tauri_plugin_opener::open_url` called from Rust. The plugin is **not** registered with the app, so it adds no commands that a page could call. |

Every mechanism in this table was confirmed by reading the source of exactly these versions in the local cargo registry (`tauri-2.12.7/src/webview/mod.rs` for the access check of remote pages and the main-frame-only scripts, `src/ipc/protocol.rs` and `src/ipc/channel.rs` for the IPC and channel wire format, `src/ipc/capability_builder.rs`, `wry-0.57.3/src/wkwebview/` for what macOS reports about frames and navigations), and then by running it (see the smoke run below). The matching documentation pages: [Capabilities, including remote API access](https://v2.tauri.app/security/capabilities/), [Calling Rust: channels](https://v2.tauri.app/develop/calling-rust/#channels), [`Manager::add_capability`](https://docs.rs/tauri/2.12.7/tauri/trait.Manager.html#method.add_capability), [`CapabilityBuilder`](https://docs.rs/tauri/2.12.7/tauri/ipc/struct.CapabilityBuilder.html), [`WebviewWindowBuilder`](https://docs.rs/tauri/2.12.7/tauri/webview/struct.WebviewWindowBuilder.html), [`tauri_build::AppManifest`](https://docs.rs/tauri-build/2.7.6/tauri_build/struct.AppManifest.html).

## How the bridge is scoped

The server's pages are remote content and get no general access to the app. Layers, outermost first:

1. **Only seven commands, only one origin, only the main window.** The run-time capability above grants `claude_status`, `claude_send`, `claude_cancel` and, for the Runner, `runner_status`, `runner_configure`, `runner_run`, `runner_cancel` to `<origin>/*` in window `main`. For remote pages Tauri refuses every command that no capability grants, so the setup commands, the approval and settings commands and every plugin command (events, windows, …) are refused.
2. **Top frame only.** Tauri's own IPC bootstrap (`window.__TAURI_INTERNALS__` and the per-run "invoke key" that every call must carry) and the bridge script are injected in the main frame only. A frame gets neither. The Visual sandbox frame (`/visual-frame`, `sandbox allow-scripts`) has an opaque origin, so it cannot reach into its parent to borrow them.
3. **A second key of the app's own.** The bridge script holds a random key (new on every start) in a closure and sends it with each call; the commands refuse calls without it (`bridge::check_caller`). This does not depend on Tauri's invoke key.
4. **A check inside every command**: the call must come from window `main` while that window's page is on the configured origin.
5. **The request is checked** before anything starts (`bridge::validate`): `tools.url` must be exactly `<configured origin>/mcp`, so Claude Code can only be pointed at the tool endpoint of the server the window shows; `resume` must look like a session id; sizes are bounded.
6. The bridge script itself returns early unless `window.top === window` and `location.origin` is the configured origin. `window.qoopDesktop` is frozen and cannot be replaced.

Known limits, stated plainly:

- **Tauri does not tell a command which frame called it.** On macOS the low-level message channel (`window.webkit.messageHandlers.ipc`) exists in every frame, and Tauri then sees the frame's URL, which for `/visual-frame` is on the configured origin. What stops a frame is that it has neither Tauri's invoke key nor the bridge key (layers 2 and 3). This was observed in a smoke run: a message posted from the sandboxed frame was dropped by Tauri for a wrong invoke key. (Tauri then prints the expected key on the app's standard error; that is Tauri's behaviour, and the page cannot read it.)
- **A run-time capability cannot be removed.** After "Change Server…" to a different address the app restarts itself, so that only the new origin holds the grant.
- **A script in any frame can start a navigation**, and Tauri's navigation callback only gets the URL, not the frame. So navigations to other sites are refused without opening anything; only `target="_blank"` links (which the Visual sandbox cannot produce) reach the system browser.
- The server address must be `https://…`, or `http://` only for `localhost` and `127.0.0.1`, with no user name, password or path; the health check does not follow redirects.

## How a run is executed

`qoop-claude-driver` starts `claude` directly with an argument vector (never through a shell), in its own process group, with this command line:

```
claude
  --print
  --output-format stream-json
  --include-partial-messages
  --verbose
  --input-format text
  --strict-mcp-config
  --mcp-config <work folder>/mcp-<pid>-<n>-<n>.json
  --tools ""
  --allowedTools mcp__qoop__list_branches,mcp__qoop__list_cards,mcp__qoop__get_card,mcp__qoop__list_connections,mcp__qoop__list_sources,mcp__qoop__list_suggestions,mcp__qoop__suggest_source,mcp__qoop__suggest_connection
  --permission-mode dontAsk
  --permission-prompts none
  --setting-sources ""
  --disable-slash-commands
  --no-chrome
  --append-system-prompt=<system>
  [--resume=<session id>]
```

with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` added to the environment, the prompt written to standard input, and the working directory set to an empty folder.

| Flag | What it is for |
|---|---|
| `--print` | Answer and exit; no interactive session. With nothing after the options, the prompt is read from standard input. |
| `--output-format stream-json` | One JSON event per line. |
| `--include-partial-messages` | Text arrives as it is written (→ `delta`). |
| `--verbose` | Older versions required it with `stream-json` in print mode. 2.1.265 does not mention it; it is kept for those. |
| `--input-format text` | The prompt on standard input is plain text (the default, made explicit). |
| `--mcp-config <file>` | The Qoop tool endpoint: `{"mcpServers":{"qoop":{"type":"http","url":"<origin>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`. The **token is only in this file**, never on the command line. The file is created with mode `0600` in a `0700` folder and deleted when the run ends, however it ends. |
| `--strict-mcp-config` | Only the servers in that file; the Member's own MCP servers are not loaded. |
| `--tools ""` | **Disables every built-in tool** (shell, file read/write/edit, web fetch, sub-agents, …). |
| `--allowedTools mcp__qoop__…` | The eight Qoop tools may run without a permission prompt. |
| `--permission-prompts none` | Anything that would ask for permission is refused: nobody is there to answer. |
| `--permission-mode dontAsk` | The permission mode that does not ask. Together with the line above: what is not on the allow list does not run. |
| `--setting-sources ""` | Loads none of the user, project and local settings files, and so none of the hooks, plugins, permissions and environment they configure. |
| `--disable-slash-commands` | No skills or custom commands. |
| `--no-chrome` | No browser integration. |
| `--append-system-prompt=<system>` | The web UI's system text, appended to the default system prompt. Attached with `=` so the text can never be read as an option. |
| `--resume=<id>` | Continue the session of an earlier `done`. Only when given. |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | Do not load `CLAUDE.md` memory files (user and project instructions). |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Do not use Claude Code's automatic memory. |

Deliberately **not** used:

- `--bare`: it would switch off everything, but also the Member's login (it only accepts an API key), which is the whole point.
- `--safe-mode`: it also drops the servers given with `--mcp-config` (seen in the code of 2.1.265: in safe mode only SDK-type servers are kept), so the Qoop tools would be gone.
- `--no-session-persistence`: `resume` needs the session on disk.
- `--dangerously-skip-permissions` or any bypass mode: never.

**The working directory.** It is `<temp dir>/qoop-desktop-claude-<uid>/cwd`: emptied before and after every run, owner-only, so every run starts in a fresh empty temporary directory, but **at the same path**. The path is kept stable on purpose: Claude Code stores sessions per working directory, and `--resume` would not find a session started in a differently named folder. The folder above it must be a real directory owned by the user (a symlink or someone else's folder is refused).

**What could not be switched off.** Administrator-managed (policy) settings of Claude Code always apply, including hooks set there. Claude Code's own start-up work (update check, telemetry, its session files under `~/.claude`) is left alone: the app does not manage the Member's Claude Code.

**Ending a run.** One run at a time. `cancel` asks the process group to stop (`SIGTERM`), waits up to 1.5 s, then kills the group (`SIGKILL`); the same happens after 120 s without any output (then with an `error` event), when the page is reloaded, when the window closes and when the app quits. After a normal result the process gets 3 s to exit by itself. A cancelled run delivers no further event; `send` then resolves.

**Events.** `delta`: text deltas. `tool`: the tool name without the `mcp__qoop__` prefix. `done`: the result line, with the session id and the model. `error`: a failed result (Claude Code's own sentence, bounded, with the token removed should it ever appear), an exit without a result, the silence timeout, or a start failure. Lines that are not JSON or have an unknown type are ignored.

The app never reads or stores Claude credentials and makes no network request of its own except the health check of the server address.

## The Runner

A Run is a block of Python in a Page together with the output captured the last time someone executed it. The Runner is what executes it: on the Member's own computer, with the Member's own Python. The server never executes anything; the page receives the result from the app and records it through the server like any other edit.

What the server's page can do (`window.qoopDesktop.runner`): read which interpreter and folder are set (`status`), ask for the app's settings window (`configure`), ask for a Run of some code (`run`), and cancel that Run (`cancel`). It cannot choose the interpreter or the folder, and it cannot approve anything.

What happens on `run({ id, code, title }, onEvent)`:

1. **Is there a Python?** The interpreter is the one chosen in **Qoop → Runner settings…**. Nothing is chosen until the Member chooses: the first Run opens that window, and gets `error`/`no_python` if it is closed without a choice.
2. **Approval.** If exactly this code (by SHA-256) was approved before for this server, it goes straight on. Otherwise the page gets `approval` and the app opens its own window: the Run's title, the server, the interpreter, the folder, and the complete code with line numbers. "Don't run" is the default button; closing the window, Escape, and the page going away all mean "Don't run" (`error`/`declined`). "Run on this computer" becomes available once the code has been scrolled to its end and has been on screen for a second.
3. **Execution.** The approved text is written to `main.py` in a new temporary directory (mode `0700`, files `0600`) and started as `<python> -u -X utf8 runner.py main.py` in a process group of its own. The working directory is the folder from the settings, or the temporary directory. The environment is the Member's shell environment plus `MPLBACKEND=Agg`, `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8` and `QOOP_RUN_DIR`. The page gets `started`, then `output` events (at most about ten a second, each at most 16 000 characters), then `done`.
4. **Afterwards** the temporary directory is removed and whatever the code left running in its process group is killed.

`runner.py` (bundled in the app, standard library only) runs the code as `__main__`: tracebacks say `File "main.py", line N` with the right numbers and lines, `sys.exit(n)` gives exit code `n`, the working directory is first on `sys.path`. The code is always read as UTF-8 and compiled from text, so an encoding declaration inside it cannot make Python read something else than what was shown. When the code ends, normally or not, `runner.py` saves the matplotlib figures that are still open (only if the code itself imported `matplotlib.pyplot`): the first three, as PNG, with fewer dots per inch if a file would be over 120 000 bytes (160 000 base64 characters), and one `[qoop] …` line in the output for each figure it had to leave out. It also notes the Python version and the versions of up to eight packages the code imports. `plt.show()` does nothing in a Run (there is no screen); leave figures open and they are captured.

The result (`done`): exit code (`null` if stopped or killed by a signal), `stopped`, duration, the SHA-256 of the executed code, the output, the figures, and `env` (Python version, packages, `os`, `arch`). Standard output and standard error share one pipe, so their order is kept. The kept output is at most 64 000 characters (counted in UTF-16 units, so the limit holds however a reader counts): beyond that, the first and the last 32 000 are kept with one line in between saying how much is not shown, and `output_truncated` is set. Bytes that are not UTF-8 become U+FFFD.

There is **no time limit**. `cancel(id)` asks the process group to stop (`SIGTERM`), waits half a second, then kills the group (`SIGKILL`): `done` with `stopped: true`, `exit: null`, the output so far, no figures. Closing the main window, reloading or leaving the page, "Change Server…" and quitting the app do the same. One Run at a time per app, counted from the moment it is asked for (`error`/`busy` otherwise; a Run asked for right after a cancel waits up to four seconds for the old one to be gone).

**Runner settings** (app menu, or `runner.configure()` from the page; kept in `runner.json` in the app's config directory, per device):

- *Python*: the interpreters found as `python3` or `python` on the `PATH` of the Member's shell, and in `~/.pyenv/shims`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`. Each is asked what it really is (so a pyenv shim is listed as the interpreter behind it) and listed once. Or the full path of another one, accepted when `<path> --version` answers `Python 3.…` within five seconds.
- *Folder* (optional): typed as a path; must be an existing directory.
- *Approvals*: how many are remembered, and a button to forget them all.

The shell's environment is read once per start of the app by running `$SHELL -l -i -c` (then `-l -c`, then the app's own environment). The contract says "the way a login shell would"; the interactive flag is added because many set-ups, the machine this was built on included, put pyenv or conda into the file that only interactive shells read.

`QOOP_PYTHON_BIN=/path/to/python` overrides the chosen interpreter (for tests and smoke runs). It does not touch approval. **Nothing switches approval off**: no environment variable, no flag, no debug build. Tests approve through the same Rust calls the approval window makes.

## The Runner's security model, in plain words

**What you are protected from.** Code in a Run may have been written or changed by someone else, and the page that asks for it to be run is remote content. Neither can make anything run on your computer by itself:

- **Code runs only after you said yes to exactly that code**, in a window that belongs to the app. The page cannot draw that window, read it, click in it, or answer for you: the commands behind it are granted only to that window (Tauri capability), are checked again inside each command (window label and the app's own bundled page address), and the question a window can answer is fixed by its label. This was tried from a page in the smoke run: every such call was refused.
- **What you see is what runs.** The app hashes and writes out the very text it displayed. Characters you could not see (zero-width, direction controls, control characters, unusual spaces, and so on) are drawn as marked codes such as `U+202E`, and a notice says so. Text is drawn strictly left to right in file order, so right-to-left text cannot rearrange code. Long lines are wrapped, never cut. Lines are numbered the way Python counts them. Titles and code are shown as text, never interpreted as HTML.
- **A changed Run asks again.** Approval is remembered per server and per SHA-256 of the code (`runner-approvals.json` in the app's config directory, newest 1 000). One changed character, by anyone, including you, is new code.
- **The page cannot choose where code runs.** Interpreter and folder come only from the settings window. The request has no field for them.
- **An accidental yes is hard.** "Don't run" has the focus; Enter, Escape and closing the window all decline; "Run" is refused by the app until the window has had the code for a second, and stays disabled until you have scrolled to the end.
- **Size is bounded.** Code over 100 000 characters is refused without a question.

**What you are not protected from. Read this part.**

- **There is no sandbox.** Approved code runs with your own rights: it can read, change and delete your files, use the network, and start other programs. Approval is the only barrier. Read the code.
- **A remembered approval is permanent until the code changes or you forget it.** After you approved some code once, the server's page can run that same code again, at any time and any number of times, without asking. If the server or the page is compromised, it can replay everything you ever approved, though only that. The approval does not record the interpreter or the folder: code approved while Runs used a temporary folder runs without a question in a folder you set later. Use "Forget them" in Runner settings when in doubt.
- **Look-alikes.** Letters from other alphabets that look like Latin ones, and Unicode letters that Python treats as the same as ASCII ones, are visible but not flagged. Code can also simply be misleading. The window shows the truth; it cannot read for you.
- **Nagging.** A page can ask again after you declined, as often as it likes, and can open the settings window. Every question still needs your yes.
- **The page learns** the path of your interpreter and folder (`status`), and everything the code prints or draws: the result goes to the server, to be shown to the team.
- **Your environment is passed on.** The code gets the environment of your shell, including any secrets you keep in environment variables.
- **A program can escape the stop.** Cancel kills the process group. A program that deliberately moves itself to another session (`os.setsid`, a daemon) is no longer in it. And if the app itself is killed hard (`kill -9`, a crash), a Run in progress keeps running.
- **Other programs running as you** can edit the app's files in its config directory (for instance add approvals). They already have your rights.

## Tests

`cargo test` in `desktop/src-tauri` runs:

- `driver` unit tests: the event mapping, the exact argument vector, the config file contents, redaction.
- `driver/tests/stub.rs`: the driver against `driver/tests/stub-claude.sh`, a shell script that records its arguments, standard input, working directory, environment and the MCP config file it was given, and prints canned streams (an answer with a tool call, an error, garbage lines, a crash, a hang, a process that ignores `SIGTERM`, one that lingers after its result). They assert: the token is in the file and not in the arguments; the file is `0600`, outside the working directory, and deleted afterwards; built-in tools are off and only the eight tools are allowed; the working directory is empty and emptied again; cancel stops the process and its child; the silence timeout (injected, short) ends the run; events map as specified.
- app unit tests: server address rules, health check against a local socket, navigation rule, who may call the bridge and the commands of the app's own windows, request validation, the saved address.
- `runner` unit tests: the approval gate (nothing without a yes, remembered per server and hash, the newest 1 000, changed code asks again, decline, window closed, an answer only counts for the question it was given to, a yes that comes at once does not count), what the approval window is given (lines as Python counts them, invisible and direction characters, long lines, titles), settings, interpreter checks and lookup (with small stand-in programs), the shell environment, output handling (split multi-byte characters, non-UTF-8 bytes, head and tail, event spacing), and the checks on what a program leaves behind (links, sizes, PNG signature).
- `runner/tests/real_python.rs`: the Runner **against a real Python interpreter**, nothing stubbed; the "Member" answers through the same calls the approval window makes. Output and its order, exit codes, tracebacks, `SystemExit`, Unicode, truncation, event rate, a matplotlib figure captured as a real PNG, more than three figures, a figure too large, packages, cancel killing a child and grandchild of the code, a program that ignores `SIGTERM`, busy, the settings flow, the folder, an encoding declaration that tries to smuggle code in, programs that sabotage their own process.

  Which interpreter: `QOOP_TEST_PYTHON=/path/to/python3` if set; otherwise the first one the Runner's own lookup finds that has matplotlib, otherwise the first it finds. With none, each of these tests prints `SKIPPED: no Python 3 interpreter was found` and passes; without matplotlib the five figure tests print `SKIPPED: … has no matplotlib`. See the lines with `cargo test -- --nocapture`. Run here against 3.12.13 (with matplotlib 3.10.9: all 30 run) and against the system's 3.9.6 (no matplotlib: 25 run, 5 skipped).

No test starts the real `claude`.

## Unverified against a real run

Nothing here has been run against the real `claude`: doing so would have spent the owner's subscription. The flags were read from `claude --help` (2.1.265); a few facts were read from the program's bundled code. The following are assumptions and must be checked with one real turn before relying on M7:

1. **The shape of the `stream-json` output.** `--help` does not specify it. The parser assumes, from the Claude Code SDK's documented message types:
   - `{"type":"system","subtype":"init","session_id":…,"model":…}` at the start;
   - with `--include-partial-messages`, `{"type":"stream_event","event":{…}}` lines wrapping API stream events: `content_block_delta` with `delta.type == "text_delta"` (→ `delta`), `content_block_start` with `content_block.type == "tool_use"` and a `name` (→ `tool`), `message_start` with `message.model`;
   - complete `{"type":"assistant","message":{"content":[…]}}` lines, used for text and tool calls only if no `stream_event` was seen;
   - a final `{"type":"result","subtype":"success"|"error_…","is_error":bool,"result":"…","session_id":"…"}` (→ `done` or `error`).
   If a real stream differs, text or tool events may be missing; unknown lines never break a run.
2. **`--tools ""` together with `--allowedTools mcp__qoop__…`** leaves the MCP tools usable while all built-in tools are gone. The help text says `--tools` is about "the built-in set", which is why MCP tools are expected to remain.
3. **`--permission-mode dontAsk` with `--permission-prompts none`** runs allow-listed tools and refuses the rest, without stalling.
4. **MCP tool names** are `mcp__qoop__<tool>` for a server named `qoop`, and the `http` server entry with a `headers` object is accepted by `--mcp-config`.
5. **`--setting-sources ""`** is accepted as "none" (read in the code of 2.1.265), and the two environment variables do what their names say (they occur in the code; their effect was not observed).
6. **Plugins and hooks** that reach Claude Code some other way than the three settings files (for example from administrator policy) are not switched off.
7. **`--resume`** finds the session from the stable working directory, and a resumed run keeps the same restrictions.
8. **The prompt on standard input** is taken as the whole prompt in print mode.
9. **`--verbose`** is harmless on versions that no longer need it.
10. **Not signed in**: what Claude Code prints then is unknown; the app shows its error sentence if it sends an error result, otherwise "Claude Code stopped before finishing the answer".

Other things not verified:

- **Clicking through the first-run screen.** The window was started and stayed up without errors; its form was not operated. The address rules and the health check behind it are unit-tested.
- **Opening the system browser**, the **Change Server…** menu item and the restart after it, and **stopping a run when the app quits** were not exercised (the code paths are simple; the kill itself is tested in the driver).
- **Linux and Windows.** Only macOS (Apple Silicon) was built and run. The process-group kill is Unix code; on Windows only the `claude` process itself would be killed, and file modes do not apply. Installers, signing and auto-update are not in M7.
- If the app itself is killed hard (`kill -9`, a crash), a running `claude` is not stopped by it; it ends by itself.
- If the saved server is unreachable at start, the window shows the webview's own error page; use **Change Server…**.

What was verified in a short smoke run of the debug build on macOS, against a local fake server sending the real server's Content-Security-Policy headers, with the stub `claude`: the window opens the configured origin; `window.qoopDesktop` exists in the top frame, is frozen, and reports the app version; `status()` returns the stub's version; `send()` delivers `delta`/`tool`/`done` in order and resolves after the last event; a second `send` during a run gets an `error`; `cancel()` stops a hanging run and its child process and `send` resolves; a request naming another tool endpoint is refused; calls with a wrong key, the setup commands and plugin commands are refused from the page; the sandboxed `/visual-frame` has neither `window.qoopDesktop` nor `window.__TAURI_INTERNALS__`, cannot read its parent, and its direct message to the IPC channel is dropped; a frame that loads while a run is streaming does not interrupt the run. The release build (`--features custom-protocol`) was started the same way and behaved the same.

## Unverified: the Runner (M8)

Verified by a smoke run of the debug build on macOS (Apple Silicon), against a local fake server sending the real server's Content-Security-Policy, with an isolated home folder, `QOOP_PYTHON_BIN` pointing at a real Python 3.12 with matplotlib, and two approvals placed in the app's approvals file beforehand (as an earlier yes would have): `window.qoopDesktop.runner` exists, is frozen, has `status`, `configure`, `run`, `cancel`; `status()` reports the interpreter; an approved Run delivers `started`, `output`, `done` in order with Unicode output, one PNG figure, packages and `env`; a second Run during the first gets `busy`; `cancel()` stops a Run (`stopped: true`); code over the limit gets `failed`; code not approved before gets `approval`, the app's approval window opens, loads its bundled page and reads the code through its own command; while it is open, the page's direct calls to the approval and settings commands (with and without a key) are all refused by Tauri, and bridge calls with a wrong key are refused by the app; after the page cancels, the Run ends `declined` and the code never ran; a reload during a Run kills its process, and the reloaded page can run again at once; `configure()` opens the settings window, which loads and lists the interpreters found.

Not verified:

1. **Nobody clicked in the two windows inside the real app.** No tool here could press buttons in the app (the operating system did not grant control of it). So "Run on this computer", "Don't run", closing the approval window, and choosing and saving in the settings window have not been operated in the app's own webview. What stands behind them was tested separately: the pages' behaviour in a browser (Chromium) with a stand-in for the app (text is never interpreted as HTML, the Run button stays off until the end of the code and the wait, Escape declines, errors show), and the Rust behind each button in the tests above. **Before relying on M8, approve one Run and decline one by hand.**
2. **The look of the windows in the app's own webview** (WebKit): layout, dark mode, how marked characters and wrapped lines are drawn, whether the approval window comes to the front and stays on top.
3. **Quitting the app during a Run**, closing the main window during a Run, and the menu item were not exercised in the running app (the kill itself is tested; the page-reload path, which uses the same call, was exercised).
4. **Python 3.8.** The contract says 3.8 or newer; `runner.py` was run on 3.9.6 and 3.12.13 only.
5. **Linux and Windows.** Not built. On Windows the process group, the file modes, the shell lookup and the no-follow file reads are Unix code paths that do not apply; the Runner must not be shipped there as it is.
6. **Other shells than zsh** for reading the environment (fish, csh), and shell start-up files that wait for input: after eight seconds the app gives up on the interactive shell and tries the plain login shell, then its own environment.
7. **conda and virtual environments** in the interpreter list: the lookup logic is tested with stand-ins; only pyenv and the system Python were found for real.
8. **Very large or unusual figures** beyond the tests (animations, 3D, non-Agg backends set by the code).

## Open question: Anthropic's terms

ADR 0003: driving each Member's own Claude Code, under that Member's own login, from this app is **assumed acceptable for a private team**. That assumption has not been confirmed with Anthropic. It **must be re-checked against Anthropic's terms before any public release**, which will likely need a paid-API path instead of the Members' subscriptions.
