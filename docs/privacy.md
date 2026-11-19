# Privacy: what Infall talks to

Infall has no account with us, no analytics and no crash reports. It talks to the Workspace's own server. Anything else is reached only when you ask for it, or, for the update check, only in a build made to update itself. All of it is listed below.

## The Workspace's own server

- **A Team Workspace**: the browser or the desktop app talks to the team's server, and only to it. Before opening one, the desktop app checks that the address answers (`/api/health`). Whoever runs that server can read everything in the Workspace, PDFs and Comments included ([deploy guide](../deploy/README.md), "What protects you").
- **A Local Workspace**: the server is inside the desktop app and listens on `127.0.0.1`, so nothing leaves your computer. A Local Workspace works with no network at all.
- **Moving a Local Workspace to a Team server** sends its Workspace file to the server you name, and only after you sign in there and press the button.

The fonts and the PDF reader (PDF.js) are part of Infall; nothing is fetched from a font service or a PDF service.

## Only when you ask

What the Workspace's server sends out goes from the team's server in a Team Workspace, and from your computer in a Local Workspace.

- **Look up**, in the Source form, only when you press the button: the server sends the DOI to Crossref (`api.crossref.org`) or the arXiv id to arXiv (`export.arxiv.org`). It sends nothing else: no name, no Workspace, no Card, and a generic client name.
- **Fetch the PDF from arXiv**, in the Source form after Look up found an arXiv paper, only when you press that button: the server asks arXiv (`export.arxiv.org`) for that paper's PDF, sending the arXiv id and nothing else, by the same rules as Look up. Infall never fetches a PDF by itself, and never from a publisher.
- **The AI sidebar**, only once it is set up and only when you send a question:
  - with an OpenRouter key: the server sends your question, and what the AI reads through Infall's tools, to OpenRouter.
  - in the desktop app with Claude Code: the app starts your own `claude`, which sends the same to Anthropic under your own login. Claude Code does its own start-up work as well (for example its update check); Infall does not manage that.
- **A link you open**: a Source's address or a link in a Page opens in your own browser, which then talks to that site. **Open in the system viewer** hands a PDF to your computer's own PDF program.

## The update check

Only a desktop app built with an update feed checks for updates; the builds handed out so far have none, so they never check and say nothing about updates. A build with a feed asks the feed's address for its list of versions at most once a day, and when you choose **Check for updates…**; if there is a newer version it downloads it from the address the list gives. These are plain downloads: they send what any download sends (the address asked for, and a client name), and nothing from any Workspace. The download is installed only when you press **Restart to update**, after every Local Workspace has been backed up ([release.md §11](specs/release.md#11-updates-m20-groundwork)).

## Not Infall, but worth knowing

- **A Run** is code you approved; it runs with your rights and may use the network itself ([tutorial](tutorial.md), parts 10 and 17).
- **A Run** is started with the usage reporting of the packages that document a switch for it turned off: `qdk` and `qsharp` (Microsoft), `huggingface_hub` (with `transformers`, `datasets` and the rest) and `mlflow` ([desktop spec](specs/desktop.md), "Usage reports off"). Other packages, and other languages' programs, do what they do.
- **A Visual** runs in a sandbox with no network.
- **A Workspace file** (`.infall`) holds the Workspace's Research Content, its history, To-dos, Comments and PDFs (unless left out), and Members' names. It holds no emails, sign-ins, access tokens or OpenRouter key. Whoever you give it to can read all the rest.
