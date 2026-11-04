# M19 — Sources a researcher expects: PDFs, and a Python environment per Run

Words are CONTEXT.md's. The owner asked for this to be built without further questions (2026-11-25); the decisions below are the recommendations from the plan, taken as defaults. Each is marked so it can be revisited.

The Board as an image (the third part of M19) is specified in the plan and built separately.

## Part 1 — A PDF on a Source

### Decisions (defaults)

1. **One PDF per Source.** A Source may carry one PDF file. Attaching another replaces it (after a confirmation).
2. **Not versioned.** The file is stored once, by its content (SHA-256). The Source's fields gain `pdf` (the hash) and `pdf_name`, `pdf_size`, `pdf_pages`; those fields are Research Content like any other field — so *which* PDF a Source has is in History, per Branch, merged and undone like a title. The bytes themselves live outside the Change log and are never duplicated: two Branches, or two Sources, pointing at the same hash share one stored file.
3. **Kept while referenced anywhere in history.** A stored file is removed only when no Change on any Branch — current or past — refers to its hash (so Restore and Undo always find it). In practice: files are kept until the Workspace is removed. A later milestone may add cleaning.
4. **Limits:** 100 MB per file (server setting `QOOP_MAX_PDF_MB`), PDF only (checked by the file's first bytes, not its name). A Workspace's total is not limited.
5. **Who:** Members attach, replace and remove. Guests may open the PDF of a Source they can see on main.
6. **In Workspace files:** included, so an export, a backup and a move carry the PDFs. Export… gains a checkbox "Include PDFs (N files, X MB)" on by default; automatic backups always include them.
7. **Reading:** opens inside Infall in the Page panel's place (a reader with page navigation, zoom, fit width, text selection and copy, find in document, open-in-system-viewer / save a copy). Rendering is done in the web UI with a bundled PDF renderer (pdf.js, shipped locally — no network). No annotation in M19.
8. **Search:** the text of each PDF is extracted once in the browser when it is first attached or opened, and sent to the server (`pdf_text`, stored beside the file, by hash; not Research Content, not versioned). Search Cards (⌘K) then also finds Sources by words in their PDF, shown as "in the PDF of <Source title>, page N". Scanned PDFs without text are simply not searchable; the reader says so.
9. **From Look up:** when Look up answers with an arXiv id, the Source form offers "Fetch the PDF from arXiv" — the *server* downloads `https://arxiv.org/pdf/<id>` on that button only (same privacy rule as Look up: only on the button, only the id is sent). DOIs get no automatic PDF (publishers' terms).
10. **Import BibTeX:** a `file = {…}` field (Zotero's export with files) is noticed; the dialog offers "Attach the PDFs" with a folder picker — desktop app only, matching files by the paths in the field. In a browser the entries are imported without files and the report says how many had one.

### Contracts

**Server** (documented in `docs/specs/api.md`; Members unless said; Local and Team):

- `PUT /api/files/pdf` — body: the PDF, `application/pdf`. Answers `200 {"hash","size","pages": null}` (pages are filled by the client later). Idempotent by content. `413` over the limit, `415` not a PDF.
- `GET /api/files/pdf/{hash}` — the bytes, `Content-Type: application/pdf`, long cache, `Content-Disposition: inline`. Members; a Guest only when a Source on main's present Board refers to that hash. Supports `Range`.
- `PUT /api/files/pdf/{hash}/text` — `{"pages": ["text of page 1", …]}` at most 20 MB; stored once (first write wins). `GET` the same for the reader's find.
- `POST /api/sources/fetch-pdf` — `{"arxiv": "<id>"}` → the server downloads it (limit, 30 s, the same client rules as Look up, base address injectable for tests), stores it, answers as `PUT /api/files/pdf`. `502` with a sentence when arXiv does not answer.
- Search endpoint/behaviour: whatever the web UI's search uses today gains PDF text. If search is purely client-side today, add `GET /api/search/pdf?q=` → `[{"hash","page","snippet"}]` (simple case-insensitive word match is enough; say what you built).
- Schema: `Source` gains the four fields in `crates/core/src/schema.rs` (text/number as fits the existing `Value` types). Stored files in a table or a directory beside the database — choose (a table keeps export a single consistent snapshot; a directory keeps the database small) and justify; Workspace files must carry them either way, and `export_workspace` gains `include_files: bool` through a new function `export_workspace_with(db, dest, ExportOptions { include_files })` — the old function keeps including them.
- Never executed, never served as HTML: strict content type, `X-Content-Type-Options: nosniff`, and the app's CSP must allow pdf.js's worker from `'self'` only.

**Web UI:**

- Source form and Source rows: **Attach PDF…** (file picker; drag a file onto the Sources section), **Open PDF**, **Replace…**, **Remove PDF**; size and page count shown; attaching, replacing and removing are Undo steps ("Attach a PDF to <title>").
- The reader, as decision 7; keyboard: arrows/PageUp/PageDown, ⌘F find, Esc closes; remembers the page per PDF per device.
- pdf.js bundled locally (worker included), loaded only when a PDF is opened (kept out of the first load).
- Search results from PDF text, decision 8.
- "Fetch the PDF from arXiv", decision 9. Import BibTeX files, decision 10 (needs a bridge call — see desktop).
- Guests: Open PDF only.

**Desktop:** bridge `pickFolder(): Promise<string | null>` and `readFileAt(path: string, under: string): Promise<Uint8Array>` restricted to files *inside the folder the person just picked* (path-escape checked), PDF only, 100 MB — for decision 10. Open-in-system-viewer: `openFileExternally` for a PDF the page hands over (written to a private temp file first).

### Zones

| Zone | Files |
|---|---|
| 1 Server | `crates/**`, `docs/specs/api.md` |
| 2 Web: files and reader | `web/src/lib/files*.ts`, `web/src/ui/pdf/**`, `web/src/ui/page/Sources.tsx` and its helpers, search UI, vendored pdf.js |
| 3 Desktop | `desktop/src-tauri/**` (bridge additions, export checkbox on the start screen: `desktop/ui/**`) |
| 4 Docs | `docs/tutorial.md`, `docs/privacy.md` (arXiv fetch), `README.md`, `web/src/ui/DESIGN.md` |

## Part 2 — A Python environment per Run

### Decisions (defaults)

1. The Runner settings already choose one Python. M19 adds: a list of **named environments** on this device (name → interpreter path; found automatically: the system Python, `conda` environments, `venv`/`.venv` folders in the working folder, `pyenv` versions; and added by hand), one of them the default.
2. A Run may **name** the environment it wants (`env`, a free name, Research Content like the code). The name is only a wish: each Member maps names to their own environments on their own device. A Run naming an environment this device lacks asks which to use (and remembers the answer for that name); it never fails silently and never installs anything.
3. A Run's captured result records what actually ran: Python version and the versions of the packages the code imported (top-level imports resolved through `importlib.metadata`, plus their direct dependencies — not the whole environment), as `env.packages`. Readers see it under the output ("Python 3.12.3 · numpy 2.1.0, scipy 1.14.1 …").
4. The approval window names the environment and its interpreter path. An approval is remembered per code *and* interpreter path.
5. Nothing is installed by Infall. A missing package shows Python's own error; the Run block adds one line: "This environment has no package <name>."

This shares its shape with M19b's Toolchains (a Run names what it wants; the device decides what that starts). Build it so M19b extends it: the per-device map and the "ask once, remember" flow are the same mechanism.

### Zones

| Zone | Files |
|---|---|
| 5 Runner | `desktop/src-tauri/runner/**`, the Runner settings and approval windows in `desktop/ui/**`, `desktop/src-tauri/src/**` as needed |
| 6 Run block | `web/src/ui/page/runs/**`, `web/src/lib` Run types; server: the `env` field and `env.packages` in the result (`crates/**` — coordinate with zone 1; one agent owns `crates/**` at a time) |

## Done when

- Every suite green.
- Hand check: attach a PDF to a Source, read it, find a word, search for a word from page 3 with ⌘K, Undo the attach and Redo it; export the Workspace with PDFs, import it, the PDF opens; a Guest opens it on main and is refused on a Source that is only on a Branch; fetch a PDF from arXiv through a fake registry in tests and once for real by hand; thirty PDFs in a literature review export whole.
- A Run naming `analysis` on a device with a conda environment of that name runs there and records its packages; on a device without it, asks once.

## Not in M19

Annotation and highlights. OCR. PDFs on Cards without a Source. Other file types. Cleaning unreferenced files. Installing packages.
