# M12 — Local Workspaces, the start screen, and the hands-on Tutorial

Words are CONTEXT.md's: Workspace, Team Workspace, Local Workspace, Preset, Tutorial Workspace, Tutorial, Tour.

## Why

The desktop app shipped without a server: its first screen asked for a server address, and a person without a team had nothing to enter. From M12 the app carries the real Infall server inside itself, so a Workspace can live on one computer, and a first-time person can try every part of Infall with nothing installed and nothing typed.

## Decisions (settled with the owner)

1. The real server (`crates/server`) is linked into the desktop app and runs in-process on `127.0.0.1`, one SQLite file per Local Workspace. No sidecar program, no fake server.
2. The start screen is shown on **every** start. It has: **Sign in** (a Team Workspace, by server address), **Create a workspace** (four Presets), and **Your workspaces** (every Local Workspace and every remembered Team Workspace).
3. Presets: `tutorial`, `blank`, `literature-review`, `research-project`.
4. A Local Workspace asks nothing: its one Member is named after the computer's user name and is signed in silently. No email or password is ever shown. The name can be changed in the account menu.
5. The hands-on Tutorial runs only in a Tutorial Workspace. Every other Workspace keeps the read-only Tour.
6. A Tutorial step whose tool is missing (Python for a Run, Claude Code or an OpenRouter key for the AI sidebar) shows what the step would have shown, says what to install, offers **Check again**, and can be passed; it is listed as "not tried" at the end.
7. Moving a Local Workspace onto a server is not in M12.
8. One Workspace is open at a time.

## Zones

Each zone owns its files and touches no others.

| Zone | Owns |
|---|---|
| 1 Server | `crates/**`, `docs/specs/api.md` |
| 2 Desktop shell | `desktop/src-tauri/**` |
| 3 Start screen | `desktop/ui/index.html`, `desktop/ui/setup.css`, `desktop/ui/setup.js` |
| 4 Web UI | `web/**` |
| 5 Docs and packaging | `docs/**` except `docs/specs/api.md` and this file, `README.md`, `desktop/README.md`, `deploy/**`, `scripts/**` |

## Contract A — the server crate, for the desktop shell

In `infall_server::local`:

```rust
pub enum Preset { Blank, Tutorial, LiteratureReview, ResearchProject }
// ids, also used on the wire: "blank", "tutorial", "literature-review", "research-project"
impl Preset { pub fn id(&self) -> &'static str; pub fn from_id(&str) -> Option<Preset>; }

pub struct LocalOptions {
    pub db: PathBuf,            // created if absent
    pub web_dir: PathBuf,       // a built web/dist
    pub preset: Preset,         // used only when `db` is new; ignored afterwards
    pub member_name: String,    // used only when `db` is new
    pub port: Option<u16>,      // the port to listen on if it is free; otherwise, and for None, the OS chooses
}

pub struct LocalServer { /* … */ }
impl LocalServer {
    pub fn origin(&self) -> &str;     // "http://127.0.0.1:<port>", port chosen by the OS
    pub fn entry_url(&self) -> &str;  // "<origin>/api/local/enter?key=<secret>"
    pub async fn stop(self);          // closes live connections, finishes in-flight requests, a few seconds at most
}

pub async fn start_local(options: LocalOptions) -> Result<LocalServer, StartError>;
```

- Listens on `127.0.0.1` only. The public origin is `origin()`; the existing Origin checks apply unchanged.
- A new `db` gets: the Workspace seeded from the Preset, and one Member (role Admin, the given name, an email nobody can use). The Preset id is kept in the database.
- `entry_url`: `GET` with the right key sets the session cookie for the one Member and answers `303` to `/`. The key is 256 random bits made at each start, compared in constant time, valid until `stop`. A wrong or missing key is `404`. Without the key nothing on the machine can sign in.
- The session cookie has a name of its own per Local Workspace, `infall_session_<id>`, the id made once and kept in the database (api.md §16): every Local Workspace is on `127.0.0.1`, cookies are not kept apart by port, and under one shared name opening one Workspace replaced the sign-in of another and sent one database's session to another's server. A Team Workspace's cookie stays `infall_session`.
- Runs on the caller's tokio runtime. No environment variables are read. No signal handlers.
- OpenRouter keys at rest need a secret key: the local server makes one on first start and keeps it beside the database in a file only the owner can read.

## Contract B — the HTTP API in a Local Workspace, for the web UI

Added (documented in `docs/specs/api.md`):

| Request | Who | Answer |
|---|---|---|
| `GET /api/workspace` | any signed-in Member or Guest, any Workspace | `{"kind":"team","preset":null}` or `{"kind":"local","preset":"tutorial"}` |
| `GET /api/local/enter?key=…` | local only | `303` to `/` with the session cookie; else `404` |
| `PATCH /api/local/member` body `{"name":"…"}` | local only | `200 {"name":"…"}`; the usual name rules |
| `GET /api/local/tutorial` | local only | `200 {"state": <JSON or null>}` |
| `PUT /api/local/tutorial` body `{"state": <JSON>}` | local only | `204`; body at most 16 KiB; the server stores it as is and does not read it |

On a Team Workspace every `/api/local/*` path is `404`.

In a Local Workspace these are refused (`403`, the usual error body): creating and revoking invites, removing a Member, changing a role, signing in with a password, changing the password. Signing out is refused too: there would be no way back in.

Everything else is the same server, unchanged.

### What each Preset seeds

All text is in CONTEXT.md's words, short, and deletable. Every Preset leaves `main` as the only Branch unless said.

- **blank** — nothing.
- **literature-review** — Frames `To read`, `Reading`, `Key findings`, `Open questions`; three or four example Cards that say what belongs there, one with a Source.
- **research-project** — Frames `Questions`, `Hypotheses`, `Experiments`, `Results`; a few example Cards, one with a Run that uses only Python's standard library and carries captured output.
- **tutorial** — the sample Board below. The web UI's Tutorial finds things by these exact titles; they are constants on both sides.

The Tutorial sample Board (subject: random walks, small enough to read in a minute):

| Thing | Exact name | Notes |
|---|---|---|
| Frame | `Start here` | holds the welcome Card |
| Frame | `Papers` | two or three Cards, at least one with a Source |
| Frame | `Experiments` | holds the Run Card and the Visual Card |
| Card | `Welcome to Infall` | Page: a few sentences of text and one formula |
| Card | `Random walk experiment` | Page has a Run: standard library only, finishes in under two seconds, prints the mean squared displacement for a few step counts; captured output present |
| Card | `Watch a walk` | Page has a Visual of a random walk |
| Connections | — | at least one of each kind (related, directed, contradicts), one with a label |
| Suggestion | — | exactly one pending Suggestion: a Connection between two of the Papers Cards |
| To-do | `Read the welcome Card` | owned by the Member, pointing at `Welcome to Infall` |
| Checkpoint | `Before the tutorial` | on `main`, after everything above |
| Branch | `longer-walks` | made from `main` at the Checkpoint. On it: the summary of `Random walk experiment` is changed, and one Card `Walks of 10 000 steps` is added. After the Branch was made, `main` also changed the summary of `Random walk experiment` to something else. Merging `longer-walks` into `main` therefore has **exactly one Conflict** and one clean addition. |

Changes made by seeding are recorded under the Member, like any others.

## Contract C — the desktop shell's commands, for the start screen

The start screen is the window labelled `setup` showing `desktop/ui/index.html`. It calls these through `window.__TAURI_INTERNALS__.invoke(name, args)`; each is allowed for that window only. A failure rejects with one plain sentence that can be shown as is.

```ts
type WorkspaceEntry = {
  id: string;
  kind: 'local' | 'team';
  name: string;
  preset: string | null;      // local: the Preset id it was made from
  address: string | null;     // team: the server origin
  lastOpened: number | null;  // unix ms
};

start_view(): { workspaces: WorkspaceEntry[]; notice: string | null }
  // newest first. `notice`: one sentence when the app came back here because something
  // failed (for example a Team Workspace that did not answer); otherwise null.

workspace_create({ preset: string, name?: string }): void
  // makes a Local Workspace and opens it. Without a name: the Preset's name,
  // made unique ("Tutorial", "Tutorial 2").
workspace_connect({ address: string }): void
  // checks the address as today, remembers the Team Workspace (name: its host), opens it.
workspace_open({ id: string }): void
workspace_rename({ id: string, name: string }): void
workspace_remove({ id: string }): void
  // local: deletes its files for good. team: forgets the address. The screen asks first.
```

When a Workspace opens, the main window appears and the start screen closes.

The shell also:

- keeps the list in the app's config directory and each Local Workspace's files in the app's data directory; an address saved by an earlier version becomes a Team Workspace entry;
- unpacks the web UI it was built with (`web/dist`, embedded at compile time) to a directory it owns and gives that to `start_local`;
- names the Member after the operating system's user name (fallback `Me`);
- gives each Local Workspace its own port, remembered in the list and asked for at every start, so its address — and with it what the web UI keeps in the browser's storage (theme, the Tour's "offered once") — stays the same between starts; when that port is taken the Workspace still opens, on another one;
- remembers Run approvals by Workspace, not by address, and the approval window names the Workspace;
- replaces the menu item "Change Server" with **Switch Workspace…**, which stops what is running, closes the main window and shows the start screen;
- stops the embedded server when the Workspace is left and when the app quits.

Added to the bridge (`window.infallDesktop`), for the web UI: `switchWorkspace(): Promise<void>` — the same as the menu item. The web UI must check that it exists before offering it.

The start screen window: 920 × 640, resizable, minimum 720 × 560.

## The Tutorial (web UI)

Runs when `GET /api/workspace` says `local` and `tutorial`. It starts by itself when the Workspace is first opened, can be left at any step (**Leave the tutorial**) and resumed or restarted from the account menu (**Tutorial**). Progress is kept with `PUT /api/local/tutorial`, never in `localStorage` (the origin's port changes between starts).

Each step: a title, one to three sentences, what to do, and it moves on by itself once that has been done (observed from the app's own state, not from clicks on particular pixels). **Skip this step** is always there. Steps, in order:

1. Move around the Board; open `Welcome to Infall`.
2. Make a Card; give it a title and a status.
3. Undo (since M15, [undo.md](undo.md)): make a slip on purpose — drag a Card somewhere else — and take it back with Cmd/Ctrl+Z or the Undo button in the Board's toolbar, which the step points at. It passes once an Undo on the open Branch has taken something back, as the web UI's own list of steps shows it (`undo.subscribe`: the newest step moved to Redo), whichever way it was asked for: the keys, a button, the desktop app's Edit menu, a delete's notice. A Card moved back by hand does not pass it. The step says that Undo takes back only one's own latest gestures, and that History and Restore go further back.
4. Write on its Page: text, a formula.
5. Attach a Source to a Card.
6. Draw a Connection and label it.
7. Make a Frame and put a Card in it.
8. Search for a Card.
9. Tick the To-do; make another.
10. Accept or dismiss the Suggestion.
11. Open `Watch a walk` and use the Visual.
12. Execute the Run on `Random walk experiment` (desktop app, Python needed — decision 6).
13. Name a Checkpoint.
14. Switch to `longer-walks`, look, switch back.
15. Merge `longer-walks` into `main` and decide the Conflict (since M15b: **Merge into main…** on the label of `longer-walks` on the Branch Graph, which the step points at when it is on screen).
16. Open History; Restore to `Before the tutorial`'s moment or just look (either passes).
17. Open the AI sidebar and ask something; Pin an answer to a Page (decision 6).
18. The end: what was tried and what was not; what a Team Workspace adds (Members, Guests, invites — said in words, they do not exist here); **Back to workspaces** (`switchWorkspace`, when there is a bridge).

Why Undo is step 3: it is the first moment the person has a gesture of their own to take back (step 1 only opens a Page), and it comes before the steps where slips happen. The slip it asks for is a move, not the Card of step 2, which step 4 writes on.

Progress names steps by id (`look`, `card`, `undo`, `page`, …), never by number, so adding a step needs no new version of what is stored. Progress saved before step 3 existed loads as it was and carries on at the very step it named; Undo has no result in it, so the list of steps shows it as to do and the end lists it as not reached.

The Tour (docs/specs/tutorial.md §1) stays as it is in every other Workspace. In the desktop app its last step also says that a Tutorial Workspace can be made from the start screen, with a button that calls `switchWorkspace`.

In a Local Workspace the web UI hides what cannot be used there: Members, invites, Guests, password, sign out. The account menu gains **Change name**.
