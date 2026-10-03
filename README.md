# Qoop

A self-hosted shared workspace where a small research team maps, extends, and tracks the state of a research project. Vocabulary: [CONTEXT.md](CONTEXT.md). Decisions: [docs/adr](docs/adr). Rules: [docs/specs](docs/specs).

## What exists

| Part | Where | State |
|---|---|---|
| Versioning core — Changes, Branches, Checkpoints, Restore, Merge | `crates/core` | done, tested |
| Server — accounts by invite, persistence, live updates | `crates/server` | M1 done |
| Web app — sign-in, Members, the Board | `web/` | M1 done |
| Deployment kit — systemd, Caddy, backups, hardening | `deploy/` | written; not yet run on a real VPS |
| Design source | `design/` | reference |

M1 covers one Branch (`main`) and the Board: Cards, Frames, Connections, with live updates. Branch switching, History, Merge review, Pages, To-dos and AI are later milestones; the core already supports the versioning underneath them.

## Run it locally

Needs Rust (1.96+) and Node (22+).

```bash
sh scripts/dev-server.sh
```

That creates `.dev/qoop.db` with an Admin `admin@qoop.test` on first run (the generated password is in `.dev/admin-password`, git-ignored) and serves the API on http://localhost:8787.

```bash
npm --prefix web install
```

```bash
npm --prefix web run dev
```

Open http://localhost:5173. To serve the built UI from the server itself instead, run `npm --prefix web run build` and open http://localhost:8787.

## Check everything

```bash
cargo test --workspace
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
npm --prefix web test
```

## Put it on a server

Follow [deploy/README.md](deploy/README.md), then [deploy/harden.md](deploy/harden.md).
