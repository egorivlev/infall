# Desktop app (Tauri) is the primary client; the browser is a fallback

Two headline features need the Member's own machine: executing Runs on local hardware (real Python QRL stacks, GPU) and an AI sidebar that uses the Member's Claude subscription. A browser tab cannot start local programs, so we ship a Tauri desktop app whose Rust side is the Runner, and serve the same TypeScript UI from the server for browser access with only the local-machine features disabled.

## Considered Options

- **Browser only + separate local Runner daemon** — rejected: everyone installs something anyway, plus a localhost bridge with its own browser security obstacles.
- **Server-side code execution** — rejected: arbitrary code execution on a public self-hosted box, and effectively rebuilding JupyterHub.
- **Fully native Rust GUI** — rejected: canvas, rich text with math, and embedded Visuals have mature libraries only in the web ecosystem.

## Consequences

- The app executes code authored by other Members; it must show the code and ask before first executing a Run someone else wrote or changed.
- A Run stores its captured output as Research Content, so browser users and Guests see results without executing anything.
- One always-on server (storage, sync, accounts) is still required; the app is not standalone.
