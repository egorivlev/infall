# The first day

What the Admin and a new Member do by hand, in order, on the day someone joins a team. The server is already running ([deploy/README.md](../deploy/README.md)). The same path is walked through the API by `scripts/rehearse-deploy.sh` every time it runs.

Trying Infall on your own, without a team? You need neither a server nor this page: install the desktop app ([desktop/README.md](../desktop/README.md)) and press **Tutorial** under **Create a workspace** on its start screen.

`https://qoop.example.org` stands for your server's address.

When this page is done, the next thing to read, for the Admin and the new Member alike, is [the tutorial](tutorial.md): fifteen minutes through each part of Infall, once.

## The Admin

1. Open `https://qoop.example.org` and sign in ("Sign in to Infall": Email, Password).
2. Open **Members** (left rail, or **Settings → Workspace**; Settings is in the menu under your name). Only an Admin has it.
3. Under **Invite someone**, enter the person's email, leave the role on **Member**, and press **Create invite**.
   For an outside reader choose **Guest** and a date under **Access until**: a Guest can read the Board and Pages of the main Branch until that date, and nothing else.
4. Copy the link under **Invite link for …** right away. It is shown once: after the next invite, or after you leave the screen, nobody can show it again.
5. Send the link to that person, and only to them, over a channel you trust. Whoever opens it first becomes that Member. It works once and expires after 7 days.
6. When they have joined, their name is in the Members table. Until then the invite is listed as pending and can be taken back with **Revoke**.

If the link is lost, used by the wrong person or expired: **Revoke** it if it is still pending (or **Remove** the wrong account), and create a new invite. An invite cannot be sent again.

If the Member will use the desktop app, also give them the package for their computer and its SHA-256, so they can tell the real file: `Infall-<version>.dmg` for a Mac (`scripts/package-macos.sh`), `infall_<version>_amd64.deb` for Ubuntu (`scripts/package-linux.sh`), `Infall-<version>-x64-setup.exe` for Windows (`scripts/package-windows.sh`; never yet started on Windows). Each script prints the SHA-256.

## The new Member

1. Open the link you were sent. The page says "You're invited as a Member" and shows your email.
2. Enter your **Name** (the others will see it next to your Changes) and a **Password** of at least 12 characters. Let a password manager make it and keep it.
3. Press **Join Infall**. You are signed in and see the Board.
4. Press **+ Card** at the top left of the Board and give the Card a title. Everyone else sees it at once, with your name on the Change.

⌘Z (Ctrl+Z on Windows and Linux) takes back your own last gesture and never another Member's work: what someone else changed since stays as they left it ([the tutorial](tutorial.md#undo), part 1).

From then on, sign in at `https://qoop.example.org` with your email and that password. The link does not work a second time: it says "This invite is no longer valid."

Forgot the password? Nobody can read it, and the Admin has no button for it: they set a new one on the server (deploy guide, "Forgot a password").

### The desktop app (optional)

The browser is enough to read and edit everything. The desktop app adds the Runner, which executes Runs on your own computer, and the AI sidebar on your own Claude Code.

1. Install the package the Admin gave you: [macOS](../desktop/README.md#installing-it-for-a-member), [Ubuntu](../desktop/README.md#installing-it-on-ubuntu-for-a-member), [Windows](../desktop/README.md#installing-it-on-windows-for-a-member).
2. On a Mac the first start is stopped by macOS once; the same page says what the warning means and how to allow Infall: ["The first start"](../desktop/README.md#the-first-start-allowing-infall-once). Windows shows a warning of its own the first time; its section says what to do.
3. The app opens with its start screen. Under **Sign in to a Team Workspace**, enter `https://qoop.example.org` as the **Server address** and press **Sign in**; then sign in as in the browser. Next time the team's Workspace is listed under **Your workspaces**: click its name.

## Bringing your papers in, taking work out

Most people arrive with papers already in a reference manager. Bring them in as BibTeX:

1. In Zotero, right-click the collection and choose **Export Collection…** (or **File → Export Library…**).
2. Choose **BibTeX**, press **OK**, and save the `.bib` file.
3. In Infall, choose **BibTeX ▾** → **Import BibTeX…** in the Board's second toolbar (**Sources on this Branch**). Each entry becomes a Card with its Source, inside a new Frame named after the file. **Import BibTeX…** in a Page's **Sources** row attaches the entries to that one Card instead.

For a single paper, type its DOI or arXiv address into **URL or DOI** in the Source form and press **Look up**: the title, authors and year are filled in. Only then does the team's server send that DOI or arXiv id, and nothing else, to Crossref or arXiv ([Privacy](privacy.md)).

To take work out: **Export as Markdown** and **Print…** under a Page's **Page tools** (⋯), **Export BibTeX** for Sources (a Page's Sources row, or **BibTeX ▾** on the Board). Details are in [the tutorial](tutorial.md#12-getting-work-in-and-out), part 12. The team's Workspace as a whole is the server's database; the Admin backs it up ([deploy guide](../deploy/README.md), step 9). Workspace files (`.infall`) and automatic backups are for Local Workspaces in the desktop app.
