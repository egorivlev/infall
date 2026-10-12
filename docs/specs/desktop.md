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
