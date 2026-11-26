# Contributing to Infall

Thank you for looking. Infall is small and built by very few people, so a pull request is read closely, and an issue that describes a real research task is often worth as much as code. Before a large change, open an issue first so that nobody builds the same thing twice or something that was decided against.

## The parts

| Part | Where | Language |
|---|---|---|
| Versioning core: Changes, Branches, Merge, Restore | `crates/core` | Rust |
| Server: the HTTP API, persistence, live updates, the AI tool endpoint | `crates/server` | Rust |
| Web UI: the Board, Pages, History, everything a Member sees | `web/` | TypeScript, React |
| Desktop app: the server inside for Local Workspaces, the Runner, the AI sidebar on Claude Code | `desktop/src-tauri` (Rust, its own Cargo workspace), `desktop/ui` (the app's own windows, plain HTML and JS) | Rust, Tauri 2 |
| Team server deployment | `deploy/`, `Dockerfile` | shell, Compose |
| Packaging and development scripts | `scripts/` | shell |

## Building

What to install: [README.md, "Build from source"](README.md#build-from-source). In short, Rust 1.96, Node.js 22.12 or newer with npm, a C compiler, and on Linux the WebKitGTK 4.1 and GTK 3 development packages.

```sh
npm --prefix web ci                 # once, and after web/package-lock.json changes
sh scripts/dev-server.sh            # the server on http://localhost:8787, data in .dev/
npm --prefix web run dev            # the web UI on http://localhost:5173, against that server
```

The desktop app embeds the built web UI (`desktop/src-tauri/build.rs` stops if `web/dist/index.html` is missing), so build that before compiling, testing or linting the app:

```sh
npm --prefix web run build
cd desktop/src-tauri && cargo run
```

More on the app, its packages and what each script checks: [desktop/README.md](desktop/README.md). The server's container: [deploy/README.md](deploy/README.md).

## Checks

These are the commands the continuous build runs ([.github/workflows/ci.yml](.github/workflows/ci.yml)). Run the ones for the parts you changed before you open a pull request; all of them must pass before it is merged.

At the root (`crates/core`, `crates/server`):

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

In `web/`:

```sh
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm test
```

In `desktop/src-tauri` (after `npm --prefix web run build`):

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Tests that need a program your computer lacks print a `SKIPPED` line and pass: a real Python 3 for most Runner tests, matplotlib for figures, Julia, R, Node.js, bash, and Python's `qdk` for Q#. The Runner and driver tests are mostly Unix-only and are not compiled on Windows. The continuous build runs on Ubuntu, macOS and Windows with what those runners have installed, so a test that skips on your computer may run there.

## The words

[CONTEXT.md](CONTEXT.md) is binding. Every word a person reads (in the interface, in messages, in the docs, in a commit message about behaviour) uses its terms in its sense: a **Card**, not a node; a **Change**, not a commit; a **Member**, not a user; a **Restore**, not a revert. Each entry lists the words to avoid. If a change needs a word the glossary does not have, or a word to mean something new, change CONTEXT.md in the same pull request and say why.

## Specs before code

Anything that changes what Infall does (what a Member sees, what the server accepts or returns, what the desktop app runs, what is stored) is written in the spec under [docs/specs/](docs/specs) first, or in the same pull request: [api.md](docs/specs/api.md) for the server's contract, [desktop.md](docs/specs/desktop.md) for the app, [core.md](docs/specs/core.md) for versioning, and the others by topic. A reviewer reads the spec change before the code. A fix that makes the code do what the spec already says needs no spec change.

A decision that is hard to reverse, or that reverses an earlier one, gets an ADR in [docs/adr/](docs/adr): a short file, numbered after the last one, saying what was decided, why, and what follows from it. Read the existing ones before proposing something they rule out (for example [ADR 0003](docs/adr/0003-ai-through-subscriptions-and-a-shared-tool-layer.md) on how AI reaches Infall).

## Commits

The history shows the style:

- A subject line in the form `type(scope): what changed`, in plain words: `feat(desktop): Runner settings say when a language's program is not working`, `fix(web): search focus ring clear of the Branch stripe on a non-main Branch`, `docs(plan): …`. Types used: `feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`. Scopes are the part: `core`, `server`, `web`, `desktop`, `runner`, `deploy`, `spec`, `plan`.
- A body, when the subject is not enough, saying what changed and why, and what was checked.
- A branch of several commits is merged with a merge commit whose subject starts `Merge:` and says what the branch did.
- One change per commit where it can be: a spec change, the code for it and its tests can be one commit or several, but unrelated fixes are not mixed in.

Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased" for anything a Member, an Admin or someone building Infall would notice.

## Contributions written with AI

Welcome, and reviewed like any other: the person who opens the pull request is responsible for it, has read every line, and can explain it. Most of Infall itself was written with AI assistants under one person's direction, and the history says so: those commits carry a `Co-Authored-By:` line naming the model. Do the same when an assistant wrote a meaningful part of a commit. Say in the pull request what you checked yourself, beyond the tests passing.

## Licence of contributions

Infall is under the [Apache License 2.0](LICENSE). By opening a pull request you agree that your contribution is licensed under the same terms, as section 5 of the licence says (inbound = outbound). There is no contributor licence agreement to sign. Do not add code you do not have the right to contribute, and name the licence of anything you bring in from elsewhere; dependencies must be under a licence compatible with Apache-2.0.

## Security

Do not report a vulnerability in an issue or a pull request: [SECURITY.md](SECURITY.md) says how to report it privately.
