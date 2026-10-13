# The first day

What the Admin and a new Member do by hand, in order, on the day someone joins. The server is already running ([deploy/README.md](../deploy/README.md)). The same path is walked through the API by `scripts/rehearse-deploy.sh` every time it runs.

`https://qoop.example.org` stands for your server's address.

## The Admin

1. Open `https://qoop.example.org` and sign in ("Sign in to Qoop": Email, Password).
2. Open **Members** (left rail, or the menu under your name). Only an Admin has it.
3. Under **Invite someone**, enter the person's email, leave the role on **Member**, and press **Create invite**.
   For an outside reader choose **Guest** and a date under **Access until**: a Guest can read the Board and Pages of the main Branch until that date, and nothing else.
4. Copy the link under **Invite link for …** right away. It is shown once: after the next invite, or after you leave the screen, nobody can show it again.
5. Send the link to that person, and only to them, over a channel you trust. Whoever opens it first becomes that Member. It works once and expires after 7 days.
6. When they have joined, their name is in the Members table. Until then the invite is listed as pending and can be taken back with **Revoke**.

If the link is lost, used by the wrong person or expired: **Revoke** it if it is still pending (or **Remove** the wrong account), and create a new invite. An invite cannot be sent again.

If the Member will use the desktop app, also give them the `Qoop-<version>.dmg` and its SHA-256 (printed by `scripts/package-macos.sh`), so they can tell the real file.

## The new Member

1. Open the link you were sent. The page says "You're invited as a Member" and shows your email.
2. Enter your **Name** (the others will see it next to your Changes) and a **Password** of at least 12 characters. Let a password manager make it and keep it.
3. Press **Join Qoop**. You are signed in and see the Board.
4. Press **+ Card** at the top left of the Board and give the Card a title. Everyone else sees it at once, with your name on the Change.

From then on, sign in at `https://qoop.example.org` with your email and that password. The link does not work a second time: it says "This invite is no longer valid."

Forgot the password? Nobody can read it, and the Admin has no button for it: they set a new one on the server (deploy guide, "Forgot a password").

### The desktop app (optional, macOS)

The browser is enough to read and edit everything. The desktop app adds the Runner, which executes Runs on your own computer, and the AI sidebar on your own Claude Code.

1. Install the `.dmg` the Admin gave you: [desktop/README.md, "Installing it"](../desktop/README.md#installing-it-for-a-member).
2. The first start is stopped by macOS once; the same page says what the warning means and how to allow Qoop: ["The first start"](../desktop/README.md#the-first-start-allowing-qoop-once).
3. The app asks for the server address: enter `https://qoop.example.org`, then sign in as in the browser.
