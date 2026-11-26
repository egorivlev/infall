# M18 — From alone to a team

Words are CONTEXT.md's. Decisions settled with the owner in a grilling on 2026-11-25. This file is binding for every zone; where it is silent, the zone decides and says so in its report.

## Why

A project started alone in a Local Workspace has no way onto a team's server, and a team has no way off one. Teams also have nowhere to talk about a Card. And nobody outside this project has ever installed a Team server. M18 fixes all four.

Append-only storage of Changes (found in M15's measurement) lands just before M18 and is its foundation; every schema change below builds on that layout.

## Decisions

1. **Where a Local Workspace can go:** only onto an **empty** Team server. Empty means: `main` is the only Branch and has no Changes, no Checkpoints, no To-dos, no Comments. Members and invites may already exist.
2. **Who owns the work after a move:** the local Member's Changes, Checkpoints, To-dos, Pins and Comments become the importing Admin's. History reads continuously under the Admin's server name.
3. **The laptop copy after a move made from the desktop app:** it stays, marked **Moved to <server address>**, and opens read-only. Its start-screen row offers **Open on the server**. Nothing is deleted; Remove stays manual.
4. **How the file gets there:** (a) in the server's own web page — an empty server greets its Admin with **Start empty** or **Bring in a Workspace file…**; from the desktop app, **Move to a Team server…** opens the server, and after the Admin signs in, hands the file over by itself; from a browser, the Admin picks the file. (b) On the server's command line: `infall-server import-workspace <file> --admin-email <e>`, documented beside `create-admin`.
5. **Leaving a server:** an Admin can export the Team Workspace as a Workspace file (Settings → Workspace → **Export Workspace file…**). It holds every Branch, the history, Checkpoints, To-dos and Comments, and the Members as **names only** — no emails, passwords, sessions, invites, access tokens or AI keys. It can go onto another empty Team server (decision 4), or be opened by the desktop app as a Local Workspace.
6. **Team file → Local Workspace:** the Member who exported the file becomes the Local Workspace's one Member (named after the computer's user, as usual). Every other Member stays as a name: their Changes keep their names in History; their open To-dos keep their owner and can be reassigned.
7. **Team file → another Team server:** the Member who exported the file becomes the importing Admin. Every other Member arrives as a name that cannot sign in (**not signed in yet**). The Members screen offers **Invite** for each; the person who accepts that invite takes over that name and everything under it. Emails never travel in a file, so the Admin types them.
8. **Installing a Team server:** an official container. One `compose.yaml`: the server, automatic HTTPS from one domain setting, daily backups to a volume on by default; the first Admin made with one `docker compose run` line; upgrading = changing the version and `up -d`, the database copied before any migration. The systemd route in `deploy/README.md` stays as the alternative.
9. **Comments:** one thread per Card (it covers the Card's Page). Outside versioning, like To-dos: the same on every Branch, not in History, never merged, kept when the Card is removed (shown "on a Card that was removed"). Members only — Guests never see them. Any Member writes; the author edits or deletes their own (an Admin may delete any). `@Name` mentions a Member: the mention appears in their **For you** list and, if they are online, as a short notice. A thread can be marked resolved and reopened by any Member. No email. In a Local Workspace Comments work as notes to oneself and travel with a move.

Defaults chosen here (change on request): a Comment is at most 10 000 characters, plain text with the same inline Markdown and math as a Page's text block; mentions inside an edited Comment notify only newly mentioned Members; a resolved thread is collapsed but readable; the For you list keeps the last 200 mentions.

## Zones

| Zone | Owns |
|---|---|
| 1 Server | `crates/**`, `docs/specs/api.md` |
| 2 Desktop shell | `desktop/src-tauri/**` |
| 3 Start screen | `desktop/ui/index.html`, `setup.css`, `setup.js` |
| 4 Web UI | `web/**` |
| 5 Deploy | `deploy/**`, a `Dockerfile` and `.dockerignore` at the repo root, `.github/workflows/**` (image build) |
| 6 Docs | `docs/**` except `docs/specs/api.md` and this file, `README.md`, `desktop/README.md`, `CONTEXT.md` |

Zone 1 starts after the append-only storage work is on main. Zones 2–6 code against the contracts below and test with fakes; they must not change a contract — if one is impossible as written, do the closest and say so loudly.

## Contract A — server crate, for the desktop shell

`infall_server::local`:

- `LocalOptions` gains `pub read_only: bool`. When true, every request that would change anything answers `403` with code `moved` and the sentence "This Workspace was moved to a Team server; open it there to make changes." Reading, search, History, export to Markdown/BibTeX/image keep working. `start_local` callers pass `false` except for a moved Workspace.
- `import_workspace(file, db)` also accepts a Team export (decision 6): the exporting Member becomes the one Member who can sign in; the others are kept as names only. `Imported` gains `pub from_team: bool`.
- New: `pub fn export_for_move(db: &Path, dest: &Path) -> Result<(), PortError>` — same as `export_workspace` (a Local Workspace's file already strips everything decision 5 lists); kept as its own name so a future difference has a place.

## Contract B — HTTP

Documented in `docs/specs/api.md` (new section). All refusals use the usual error body.

**Workspace**
- `GET /api/workspace` adds `"empty": bool` (Team; always `false` in Local) and `"read_only": bool`.
- `POST /api/workspace/import` — Admin, Team, only while empty. Body: the Workspace file, `application/octet-stream`, at most 512 MiB (configurable `INFALL_MAX_IMPORT_MB`). Answers `200 {"members":[{"id","name","claimed":bool}], "you_were": "<name>"}`. `409 not_empty`, `400 not_a_workspace_file`, `413`, `422 newer_version`. Local file → decision 2; Team file → decision 7. One transaction: nothing changes on failure. The live connection then tells everyone the Board changed.
- `GET /api/workspace/export` — Admin, Team. Answers the Workspace file (`Content-Disposition: attachment; filename="<name>.infall"`), made as decision 5 says, recording which Member exported it.
- Command line: `infall-server import-workspace <file> --admin-email <e>` — same rules; the named existing Admin plays the importing Admin; refuses if the Workspace is not empty or the Admin does not exist.

**Members**
- Members list items gain `"claimed": bool`. An unclaimed Member has no email and cannot sign in.
- `POST /api/invites` gains optional `"claims": "<member id>"` (an unclaimed Member). Accepting that invite sets email and password on that Member instead of creating a new one; their role is the invite's role. An unclaimed Member can be removed like any other.

**Comments** (Members and Admins; Guests `403`; Local and Team)
- `GET /api/cards/{card}/comments` → `{"resolved": bool, "comments": [{"id","author","text","mentions":[member ids],"created_at","edited_at"|null}]}`.
- `POST /api/cards/{card}/comments` `{"text", "mentions":[member ids]}` → `201` the comment. The Card id need not exist on any Branch (a thread outlives its Card). Each mentioned id must be a Member; others are `400`.
- `PATCH /api/comments/{id}` `{"text","mentions"}` — author only. `DELETE /api/comments/{id}` — author or Admin.
- `PUT /api/cards/{card}/comments/resolved` `{"resolved": bool}` — any Member.
- `GET /api/comments/counts` → `{"<card id>": {"open": n, "resolved": bool}}` for every Card with a thread (for badges).
- `GET /api/for-you` → `{"items":[{"comment","card","author","at","seen":bool}]}` newest first, at most 200. `POST /api/for-you/seen` `{"up_to": "<comment id>"}`.
- Live frames to every signed-in Member (not Guests): `{type:"comments", card}` when a thread changes; `{type:"for_you", count}` to a Member when their unseen count changes.
- Comments are in Workspace files and exports, and survive import both ways.

## Contract C — the desktop shell and the start screen

Start-screen commands (setup window only; failures reject with one sentence):

```ts
workspace_move({ id: string, address: string }): void
  // Local only. Checks the address as workspace_connect does, writes a Workspace file of that
  // Workspace to a private temporary place, remembers a pending move { id, origin, file },
  // remembers the Team Workspace (as workspace_connect does) and opens it.
```

`WorkspaceEntry` gains `movedTo: string | null` (the Team origin; local only). A moved entry opens read-only (`read_only: true`), and its row shows **Moved to <host>** with **Open on the server** (calls `workspace_connect` with that origin) in place of Open; Export…, Show in folder and Remove… stay.

Bridge (`window.infallDesktop`, main window, only on the origin of a pending move):

```ts
moveHandover(): Promise<{ name: string; size: number } | null>
  // The pending move's Workspace name and file size, or null when there is none for this origin.
moveFile(): Promise<Uint8Array>
  // The file's bytes (the page then POSTs them to /api/workspace/import itself, with its session).
moveDone(result: { ok: boolean }): Promise<void>
  // ok: the shell marks the Local Workspace movedTo = this origin, deletes the temporary file,
  // and forgets the pending move. Not ok: keeps it, so the Admin can try again.
```

A pending move older than 7 days, or whose origin is forgotten, is dropped with its file.

## The web UI

- **Empty Team server, Admin:** a first screen with **Start empty** and **Bring in a Workspace file…** (file picker; progress; the answer's members listed with "Invite" links when a Team file brought names; "Your earlier work as <name> is now yours."). With a pending desktop move (`moveHandover()` not null) it says "Bring in <name> from this computer (<size>)" and does it with one press, then `moveDone`. Non-Admins on an empty server see the ordinary empty Board.
- **Settings → Workspace** (Team, Admin): **Export Workspace file…** (download / `saveFile`-like for binary — if the bridge has no binary save, the browser download path).
- **Members:** unclaimed Members listed as "<name> — not signed in yet" with **Invite** (prefills the claim).
- **Moved Local Workspace** (`read_only`): a quiet bar "Moved to <host>. This copy is read-only." with **Open on the server** when the bridge allows; editing controls disabled; Undo has nothing to do.
- **Comments:** a Comments section in the Page panel (thread, write box with `@` completion of Members, edit/delete own, resolve/reopen); a count badge on the Card at the Board's full and compact levels; a removed Card's thread reachable from For you.
- **For you:** a tab beside To-dos with a rail badge for unseen mentions; a short notice when a mention arrives while online; opening an item opens that Card's Page at the comment.
- Guests see none of it. Vocabulary from CONTEXT.md; font sizes `calc(Npx * var(--q-text, 1))`; works at interface scale 150 % and 900×600.

## Deploy

`compose.yaml` (server, Caddy with automatic HTTPS from `INFALL_DOMAIN`, a backup job writing daily Workspace files — via `export_workspace`-equivalent, not a raw file copy — with a retention setting, named volumes), a multi-arch image (amd64, arm64) built from a root `Dockerfile` (small, non-root, healthcheck on `/api/health`), `.env.example`, upgrade notes. CI builds and pushes the image only on tags (registry chosen by the owner later; the workflow takes it as a setting). Tested by bringing it up on this Mac with Docker against `localhost` (Caddy's internal certificate), creating an Admin, importing a Workspace file through the web flow and the command line, taking a backup, and upgrading from an image built at the previous commit.

## Done when

- Every suite green; the migration test passes from every schema version.
- Hand check: a Tutorial Workspace moved from the desktop app onto a freshly composed server (Admin signs in, one press, laptop copy marked Moved and read-only, Open on the server works); the same by `import-workspace`; an Admin exports the Team Workspace, imports it into a second fresh server, invites Ana to claim her name, Ana signs in and her Changes are hers; the export opened in the desktop app as a Local Workspace; Comments with a mention between two Members in two windows, resolve, reopen, survive an export/import; Guest sees none of it.
- An outsider brings up the container from `deploy/README.md` alone, with us watching (owner arranges).

## Not in M18

Merging into a non-empty server. Several Workspaces on one server. Emails in files. Email notifications. Comments on Branches or versioned Comments. Single sign-on.

## As built (2026-11-25)

The decisions above stand. Where the code on `main` differs from this file, or says more than it, it is listed here; the exact shapes are in [api.md §19](api.md#19-m18--from-alone-to-a-team-workspace-files-onto-and-off-a-team-server-members-as-names-comments-for-you) and [desktop.md, M18](desktop.md#m18--moving-a-local-workspace-onto-a-team-server).

- **`moved_to`.** `LocalOptions` has `moved_to: Option<String>` beside `read_only`, and `build_local_app_with` takes both. In a moved Local Workspace `GET /api/workspace` gives `moved_to` (the Team origin), which Contract B did not have; the UI names the host from it, and says "a Team server" without it.
- **Read-only** refuses every `/api` request that is not `GET` or `HEAD`, before any handler, except `POST /api/sources/lookup` (it only reads). An `editing` claim over the WebSocket gets an error frame with code `moved`; the tool layer refuses `suggest_*` with the same sentence.
- **Team files leave Guests out** (with their For you entries), and every setting; decision 5 did not name Guests. Each Member and Admin keeps id, name, role, colour and `created_at`.
- **Who exported**: a file records `file_kind` (`local` or `team`) and `exported_by`. Over HTTP that is the Admin who pressed the button. **Command-line exports record the oldest Admin** (by `created_at`, then id): `infall-server export-workspace <dest>`, which this file did not have, and `export_workspace` of a Team database.
- **Team file into a Local Workspace** (decision 6): the exporter becomes the one Member who can sign in, as an Admin with the email `me@local.invalid`; the others stay names with role `member`. The Workspace is then treated as a Blank one, and its Member is renamed after the computer's user at the first start.
- **Import onto a Team server**: the file's `main` takes the server's `main` id, so open windows stay on it; a Member of the file whose id is already on the server keeps their account; the owner's id is replaced everywhere, inside Change ops too (a Pin's `ai_pinned_by` and `ai_reviewed_by`, a Run result's `by`). The body may have any `Content-Type`; over the limit is `413 too_large`.
- **`content_epoch`**: after `import-workspace`, a server that was running on the same database refuses to write until it is restarted, so it cannot write its empty Workspace over the one brought in.
- **The exported file's name** is the host of the server's public origin (`:` as `-`) with `.infall`, not the Workspace's name.
- **Comments**: the server does not read `@Name` in the text; the client sends the mentioned ids. Nobody gets a For you entry for mentioning themself. `GET /api/comments/counts` gives as `open` the number of Comments in the thread, resolved or not. Resolving a Card that has no Comments is `404`.
- **The desktop side**: the move's file is kept in `moves/` in the app's data folder and refused over 512 MB; there is one pending move per Team server and per Local Workspace; it is dropped also when the Local Workspace is removed. The moved row's menu has **Open this copy (read-only)** besides Rename, Export…, Show in folder and Remove…. The copy's bar **Open on the server** goes back to the start screen (the bridge cannot open another origin from the copy).
- **PDFs** (M19) travel in every Workspace file of both kinds; a Team Workspace's export always includes them.
- **Other Members' To-dos in a Local Workspace** (decision 6, "can be reassigned"): there is no reassigning — `PATCH /api/todos/{id}` has no `owner`, and giving a To-do a new owner would lose whose it was unless a new column recorded it (a schema change this did not need). Instead, in a Local Workspace, a To-do owned by a name only (a Member who cannot sign in) is the Local Member's to tick, untick, change and delete, as their own are; it stays in that Member's column with that name and with who added it (api.md §11). Nothing is moved to another list, nothing is lost. On a Team server a name's To-dos stay as they are until someone claims the name (decision 7).
- **Backups of the container** are SQLite copies, not Workspace files, until the backup job uses `export-workspace` (release.md §10.2).
