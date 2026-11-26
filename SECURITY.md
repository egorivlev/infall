# Security

## How to report a problem

Report it privately through GitHub: on this repository's **Security** tab, **Report a vulnerability** (or go straight to <https://github.com/egorivlev/infall/security/advisories/new>). Only the maintainer sees it. Please do not open an issue, a pull request or a discussion about it until it is fixed.

Say what an attacker can do, what they need first (an account on the server, a Guest link, a Run someone approved, a program already on the Member's computer), the version and system, and the steps or a proof of concept. Leave out real research content and real credentials.

## What to expect

Infall is maintained by one person, with no security team and no paid support, so these are intentions, not guarantees:

- An answer saying the report was received within **7 days**.
- An assessment (whether it is a vulnerability here, and how serious) within **30 days**, and a fix or a plan for one after that.
- The fix is released as a new version, with a GitHub security advisory that credits you unless you would rather not be named. Please keep the problem private until then, or for 90 days after your report if no fix has come by then; tell us if you plan to publish sooner.

## Supported versions

Until 1.0, only the **latest release** gets fixes. A fix is not back-ported to an older 0.x version: update to the newest one. A Team server is updated as [deploy/README.md](deploy/README.md) says (the container's `update.sh`).

## What counts

Anything that lets someone read, change or run what they should not, in:

- **The Team server** (`crates/server`, the container and the deploy kit): signing in and sessions, invites, what a Member, an Admin and a Guest may each read and change (a Guest reads only the main Branch, for a limited time), access tokens and the AI tool endpoint (`/mcp`), the import of a Workspace file, the storage of OpenRouter keys (encrypted with the server's secret key), backups, the HTTP headers and limits the guide sets.
- **The server inside the desktop app** for Local Workspaces: it listens on `127.0.0.1` only, and signing in needs a random key the app makes at each start. Another account or a web page on the same computer getting in counts.
- **The desktop bridge**: the server's pages are remote content, and the app grants them a fixed set of commands only, in the main window only, on the open Workspace's origin only ([desktop/README.md, "How the bridge is scoped"](desktop/README.md#how-the-bridge-is-scoped)). A page, a frame inside it (such as a Visual's sandbox), or another site reaching a command it should not, or reaching the file system beyond the dialogs a Member answered, counts.
- **The Runner.** A Run is code that executes on the Member's own computer, with the Member's own rights, after the Member approved exactly that code in a window of the app's own. Anything that gets code run without that approval, runs different code from what the window showed, or runs it with another program or in another folder than the one approved, counts.
- **The AI paths**: an AI reaching anything beyond Infall's own tools, or changing Research Content other than through a Suggestion a Member accepts.
- The release files: a package that differs from what the published source and workflows build.

### What the Runner's approval protects, and what it does not

From [docs/specs/desktop.md](docs/specs/desktop.md#approval--the-apps-own-window) and [desktop/README.md, "The Runner's security model, in plain words"](desktop/README.md#the-runners-security-model-in-plain-words):

**It protects against** a Run whose code was written or changed by someone else, and against the server's page itself, running anything without the Member's yes. The page cannot draw, read or answer the approval window. The code shown is the code run (the app hashes and writes out the very text it displayed, with invisible and direction-changing characters drawn as visible codes). An approval holds only for that exact code, in that language, with that interpreter or program, in that folder, from that Workspace: one changed character asks again. The page cannot choose which program runs the code; that is set only in the app's own settings window.

**It does not protect against**, and reports of these as such are not vulnerabilities:

- **What approved code does.** There is no sandbox. Approved code can read, change and delete the Member's files, use the network and start other programs. Approval is the only barrier, and the Member is asked to read the code.
- **Replay of approved code.** Once some code is approved, the server's page can run that same code again at any time without asking. A compromised server can replay everything a Member ever approved there, but only that, and only with the program and folder approved. ("Forget them" in Runner settings clears approvals.)
- **Misleading code** that looks harmless, and letters from other alphabets that look like Latin ones.
- **The environment**: the code gets the Member's shell environment, including any secrets kept in environment variables.
- **Escaping the stop**: a program that deliberately leaves the Run's process group, or a Run in progress when the app itself is killed hard, keeps running.
- **Other programs already running as the Member**, which can change the app's files (approvals included) as they can any of the Member's files.

### Also not in scope

- The macOS, Windows and Ubuntu builds being unsigned, and the warnings that follow: that is stated, and the SHA-256 in each release is the check.
- Weaknesses that need an Admin of the server, or root on the host, to act against their own server.
- Denial of service by a signed-in Member who floods their own team's server.
- Problems in Claude Code, OpenRouter, Crossref, arXiv or other services Infall talks to: report those to them. How Infall uses them is in scope.
