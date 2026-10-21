# M13 — Getting work in and out: Workspace files, backups, export, and Sources that fill themselves in

Words are CONTEXT.md's. This file is binding for every zone; where it is silent, the zone decides and says so in its report.

## Why

A researcher will not put real work into something they cannot get it back out of, or that lives in one hidden file with no copy. And nobody types the title, authors and year of forty papers by hand. M13 covers: a Local Workspace as a file that can be exported, imported and is backed up by itself; Pages and Sources that can be taken out as Markdown and BibTeX; Sources that are filled in from a DOI or an arXiv address, or brought in from a BibTeX file (which is what Zotero, Mendeley and JabRef export).

## Decisions

1. **Workspace file.** A Local Workspace exports to one file, extension `.infall`: a consistent copy of its database with everything secret or tied to this computer removed (sessions, access tokens, AI settings including the OpenRouter key, the entry key). Importing one makes a **new** Local Workspace; it never overwrites one.
2. **Backups.** The desktop app keeps copies of each Local Workspace by itself: one when the Workspace is opened if the newest copy is older than 24 hours, kept in that Workspace's folder under `backups/`, the newest 7 kept. Same format as an export. No setting; it just happens. A failed backup never stops the Workspace from opening.
3. **Where the data is.** The start screen can show a Local Workspace's folder in the file manager.
4. **Export of content** (any Workspace, browser or desktop): a Page as Markdown (formulas kept as TeX, Sources listed at the end); a Page printed (print stylesheet — the system's print dialog makes the PDF); a Card's Sources, or all Sources on the Branch, as BibTeX.
5. **Sources fill themselves in.** In the Source form, **Look up** asks the server for the title, authors and year of a DOI or an arXiv address. The server asks Crossref (DOIs) or arXiv (arXiv ids) — only when a person presses the button, never by itself. The answer fills the fields; nothing is saved until the person saves.
6. **BibTeX import.** In a Page's Sources: **Import BibTeX…** attaches every entry of a `.bib` file (or pasted text) to this Card as Sources. On the Board: **Import BibTeX…** makes one Card per entry (title = the entry's title, status `idea`, the Source attached), laid out in a grid inside a new Frame named after the file. An entry whose DOI or URL already exists as a Source on the Branch reuses that Source.
7. **Not in M13:** attaching, reading or annotating PDFs; Board as an image; moving a Local Workspace onto a server; talking to Zotero directly; code signing.

## Zones

| Zone | Owns |
|---|---|
| 1 Server | `crates/**`, `docs/specs/api.md` |
| 2 Desktop shell | `desktop/src-tauri/**` |
| 3 Start screen | `desktop/ui/index.html`, `desktop/ui/setup.css`, `desktop/ui/setup.js` |
| 4 Web UI | `web/**` |
| 5 Docs | `docs/**` except `docs/specs/api.md` and this file, `README.md`, `desktop/README.md`, `deploy/**`, `scripts/**` |

A zone touches no file outside what it owns. The repository has a large uncommitted change set from M12; build on it, do not revert or reformat it, and commit nothing.

## Contract A — the server crate, for the desktop shell

In `qoop_server::local`:

```rust
/// Writes a Workspace file for the database at `db` to `dest` (which must not exist).
/// Safe while the Workspace is open (a consistent snapshot). Secrets and
/// this-computer-only rows are not in the result.
pub fn export_workspace(db: &Path, dest: &Path) -> Result<(), PortError>;

/// Checks that `file` is a Workspace file this version can open, and copies it to `db`
/// (which must not exist). The copy is brought up to the current schema when it is opened
/// by `start_local`. Returns what the start screen needs.
pub fn import_workspace(file: &Path, db: &Path) -> Result<Imported, PortError>;

pub struct Imported { pub preset: Option<Preset> }

/// One plain sentence each, fit to show as is.
pub enum PortError { NotAWorkspaceFile, NewerVersion, DestinationExists, Io(String) }
impl std::fmt::Display for PortError { /* … */ }
```

- A file made by a newer schema than this build knows is refused (`NewerVersion`), never half-opened.
- After import, `start_local` on the new `db` works exactly as on any existing database: the one Member is kept (their name too), `member_name` and `preset` in `LocalOptions` are ignored.
- A Workspace file from a **Team** server's database is out of scope: refuse it as `NotAWorkspaceFile` unless it happens to be importable with no extra work; say which in the report.

## Contract B — HTTP, for the web UI

Documented in `docs/specs/api.md`:

`POST /api/sources/lookup` — any Member (not Guests: `403`). Body `{"doi":"10.…"}` or `{"arxiv":"2103.05577"}`.

| Answer | When |
|---|---|
| `200 {"title":"…","authors":"…","year":"…","doi":"…"|null,"url":"…"|null}` | found. `authors` in the form the Source field already uses; fields that the registry lacks are `""` |
| `404` usual error body | the registry does not know it |
| `502` usual error body, a sentence a person can act on | the registry did not answer, or answered nonsense |
| `400` | neither or both keys, or not a DOI / arXiv id |

The server talks to `https://api.crossref.org` and `https://export.arxiv.org` only, with a 10 s limit, a generic client name, and no detail about the Workspace or the person. The base addresses come from configuration that tests can point elsewhere; **no test may reach the network**. Per Member, at most 30 lookups a minute (`429` beyond).

## Contract C — the desktop shell's commands, for the start screen

Added to the `setup` window's commands (same rules as M12: allowed for that window only; a failure rejects with one plain sentence):

```ts
workspace_export({ id: string }): string | null
  // local only. Opens the system's save dialog (suggested name "<Workspace name>.infall").
  // Returns the path written, or null when the person cancelled.
workspace_import(): void
  // Opens the system's open dialog for a .infall file, makes a new Local Workspace from it
  // (name: the file's name without extension, made unique), and opens it.
  // Resolves without doing anything when the person cancelled.
workspace_reveal({ id: string }): void
  // local only. Shows the Workspace's folder in the file manager.
```

`WorkspaceEntry` gains `lastBackup: number | null` (unix ms; local only).

The shell also makes the backups of decision 2.

## Contract D — the bridge, for the web UI

Added to `window.qoopDesktop`:

```ts
saveFile(file: { suggestedName: string; text: string }): Promise<boolean>
  // Opens the system's save dialog and writes the text as UTF-8. false when cancelled.
  // At most 20 MB. The web UI must check that it exists; without it (a browser, an older
  // app) it downloads the file the browser's way.
```

Printing: the web UI calls `window.print()`. The shell makes sure that works in the main window (and says in its report if the platform's webview cannot).

## The web UI

- **Page → Markdown**: in the Page's tools, **Export as Markdown**. Title as `#`, summary, then the blocks in order: text as is, formulas as `$…$` / `$$…$$`, a Run as a fenced code block followed by its captured output, a Visual as a line saying a Visual is here, pinned AI text marked as such, Sources as a numbered list at the end.
- **Print**: **Print…** in the same place; a print stylesheet that prints the Page alone (no rail, bars, Board), black on white in either theme, formulas and Run output intact.
- **BibTeX out**: **Export BibTeX** in a Page's Sources (that Card's Sources) and in the Board's toolbar or menu (every Source on the Branch). Entry type from what is known (`@article` when there is a DOI, else `@misc`); keys `firstauthorYEARword`, made unique; text escaped for BibTeX.
- **BibTeX in**: decision 6. The parser is the web UI's own, pure and tested: `@article{…}` and friends, `{…}` and `"…"` values, nested braces, `#` concatenation and `@string`, `and`-separated authors, common LaTeX accents turned into the real letters, `@comment`/`@preamble` skipped. Fields used: `title`, `author`, `year` (or the year in `date`), `doi`, `url`, `note`. What could not be read is counted and said, not silently dropped. Everything goes through the ordinary ops, in batches, so it is one Activity in History and can be undone with Restore.
- **Look up**: next to "URL or DOI" in the Source form. Recognises a DOI and an arXiv address or id. While asking: the button shows it and the form stays usable. Fills only empty fields unless the person confirms replacing what they typed. Failure: the server's sentence, and the form is left as it was.
- Guests see none of the import controls; export of what they can read is fine.

## The start screen

Each Local Workspace row gains **Export…** and **Show in folder**; when the backup time is known, the row says "Backed up <when>". Below the list (and present when the list is empty): **Import a workspace…**. After an export: one line saying where the file went. Vocabulary: "Workspace file".

## Docs

`docs/tutorial.md` / `docs/first-day.md`: where the data is, export, import, backups, BibTeX from Zotero in three lines, Look up and what it sends to whom. `README.md`: one paragraph. A short privacy note: the only time the app talks to anything outside the Workspace's own server (AI aside) is Look up.
