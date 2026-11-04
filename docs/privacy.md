# Privacy: what Infall talks to

Infall has no account with us, no analytics, no crash reports and no update check. It talks to the Workspace's own server. Anything else is reached only when you ask for it, as listed below.

## The Workspace's own server

- **A Team Workspace**: the browser or the desktop app talks to the team's server, and only to it. Before opening one, the desktop app checks that the address answers (`/api/health`). Whoever runs that server can read everything in the Workspace ([deploy guide](../deploy/README.md), "What protects you").
- **A Local Workspace**: the server is inside the desktop app and listens on `127.0.0.1`, so nothing leaves your computer. A Local Workspace works with no network at all.

The fonts are part of Infall; nothing is fetched from a font service.

## Only when you ask

- **The AI sidebar**, only once it is set up and only when you send a question:
  - with an OpenRouter key: the Workspace's server sends your question, and what the AI reads through Infall's tools, to OpenRouter. In a Local Workspace that server is your computer.
  - in the desktop app with Claude Code: the app starts your own `claude`, which sends the same to Anthropic under your own login. Claude Code does its own start-up work as well (for example its update check); Infall does not manage that.
- **Look up**, in the Source form, only when you press the button: the Workspace's server sends the DOI to Crossref (`api.crossref.org`) or the arXiv id to arXiv (`export.arxiv.org`). It sends nothing else: no name, no Workspace, no Card, and a generic client name. In a Team Workspace the request comes from the team's server; in a Local Workspace, from your computer.
- **A link you open**: a Source's address or a link in a Page opens in your own browser, which then talks to that site.

## Not Infall, but worth knowing

- **A Run** is code you approved; it runs with your rights and may use the network itself ([tutorial](tutorial.md), part 10).
- **A Run** is started with the usage reporting of the packages that document a switch for it turned off: `qdk` and `qsharp` (Microsoft), `huggingface_hub` (with `transformers`, `datasets` and the rest) and `mlflow` ([desktop spec](specs/desktop.md), "Usage reports off").
- **A Visual** runs in a sandbox with no network.
- **A Workspace file** (`.infall`) holds the Workspace's Research Content and your name, but no sign-ins, no access tokens and no OpenRouter key. Whoever you give it to can read all of that Research Content.
