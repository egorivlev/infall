## What this changes

<!-- What a Member, an Admin or a contributor will notice; the issue it settles, if any. -->

## How it was checked

<!-- Tests added or changed; what you looked at by hand, on which system, in the browser or in the packaged app. Say what you did not check. -->

## Checklist

- [ ] Every word a person reads uses CONTEXT.md's terms (or this pull request changes CONTEXT.md first).
- [ ] A change in behaviour is in the spec under `docs/specs/` (and in an ADR if it reverses a decision).
- [ ] Root: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --workspace`
- [ ] `web/`: `npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`, `npm test`
- [ ] `desktop/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
- [ ] CHANGELOG.md has a line under "Unreleased" if a person would notice the change.
