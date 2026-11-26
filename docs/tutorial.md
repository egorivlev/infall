# Tutorial

One pass through Infall, from an empty Board to having used each main part once. About fifteen minutes. Do the steps in order: later ones use what earlier ones made.

Where to do it:

- **On your own, with no server**: install the desktop app ([desktop/README.md](../desktop/README.md)), and on its start screen press **Tutorial** under **Create a workspace**. That makes a Tutorial Workspace on your computer: a sample Board about random walks, and a hands-on Tutorial in the app that goes through the same parts as this page, waits for you to do each one, and moves on by itself. It can be left at any step (**Leave the tutorial**), and **Skip this step** is always there; **Tutorial** in the menu under your name brings it back. This page can be read next to it. For this page's own steps, a **Blank** workspace (same screen) gives the empty Board it starts from.
- **In your team's Workspace**: you are signed in as a Member ([The first day](first-day.md) gets you there).

In a Local Workspace (the kinds you make on the start screen) you are the only Member: there are no other Members to give To-dos to, no invites and no Guests (part 11), and nobody else sees what you do. When you want others in, move it onto a Team server (part 14).

Keys are written for a Mac; elsewhere use Ctrl for ⌘. The app also has a short tour that points at the same controls: **Tour of Infall** in the menu under your name. How to get your work out of Infall, and Sources in, is part 12; Settings is part 13. Parts 14 to 18 are for later: moving to a team, Comments, PDFs, Runs in other languages, and the Board as a picture.

Two things to know before you start:

- **There is no save button.** Every edit is a Change, recorded with your name and sent to everyone at once. The bottom of the left rail says **Synced** when nothing is waiting.
- **⌘Z takes back your own last gesture**, on the Board and in a Page (see "Undo" at the end of part 1). For anything older, or anything Undo does not take back, use History (part 8).

## 1. A Card

1. On an empty Board, press **+ Card** at the top left (or double-click empty space). A Card appears with its title ready to type.
2. Type `Surface code` and press Enter. Esc would have cancelled.
3. Click the Card once to select it. A panel headed **Card** opens on the right with **Title**, **Summary**, **Status** and **Connections**.
4. Type a line under **Summary** and click outside the field (or press ⌘Enter; a summary can have several lines, so Enter alone makes a new one).
5. Under **Status**, choose **Reading**. The five statuses are Idea, Reading, Understood, Open question and Dead end · kept. A dead end stays on the Board on purpose.
6. Make a second Card, `Threshold theorem`, and drag it beside the first.

Drag empty space or scroll to move around the Board; hold ⌘ and scroll to zoom. **Fit** at the bottom right shows everything. Zoomed far out, Cards show only a title or a status, and their text cannot be edited until you zoom back in.

**Search Cards** at the top (⌘K) finds a Card by its title or summary on the Branch that is open, and jumps to it. It also finds words inside the PDFs of Sources (part 16). It does not search the text of Pages.

### Undo

7. Drag `Threshold theorem` somewhere else, then press ⌘Z. It goes back where it was. ⇧⌘Z (Redo) moves it again. On Windows and Linux the keys are Ctrl+Z, and Ctrl+Y or Shift+Ctrl+Z.

- **What it takes back**: your own latest gestures on the Branch that is open, newest first, one per press. A Card, Frame or Connection added, moved, resized or deleted (a deleted Card comes back whole, with its Page, its Sources and its Connections); a title, summary, status, label or kind changed; anything done on a Page (blocks, Sources, a Pin); an accepted Suggestion; a whole **Import BibTeX…**. A drag of five Cards is one step.
- **Where**: the two arrows beside **+ Card** and **+ Frame** at the top left of the Board, and the same two in a Page's header. Pointing at one names the step and its key ("Undo Move 3 Cards ⌘Z"). In the desktop app, **Edit → Undo** and **Edit → Redo** name it too. After each one a small notice at the bottom says what was done ("Undid Move 3 Cards.").
- **While you type in a field**, ⌘Z undoes your typing, as in any editor. Once you leave the field, what you wrote there is one step.
- **What it never does**: take back someone else's Changes. If another Member changed the same thing since, it is left as they made it, and the notice says so ("1 left as it is — Ana changed it since."). It does not touch To-dos, and does not take back a Merge, a Restore, a Checkpoint or a new Branch. When a Merge or a Restore lands on the Branch, by anyone, there is nothing left to undo on it. It does not work while History shows an earlier moment, and a Guest has none.
- **How far**: what you did in this window since it was opened, up to 100 steps per Branch. Reloading or closing the app starts from nothing. The way further back is a Restore (part 8).

An Undo is recorded like any edit, as new Changes by you that History shows. Nothing is erased.

## 2. The Page

Every Card opens into a Page: the write-up, made of blocks.

1. Select `Surface code` and press **Open Page** (or press O, or double-click the Card away from its text). The Page opens over the right of the Board; the Board stays usable.
2. The Page says "This Page is empty." Press **+ Add block** and choose **Text**.
3. Type:

   ```
   ## Idea
   Logical error rate falls as $p_L \sim (p/p_{th})^{d/2}$.

   $$
   H = -\sum_v A_v - \sum_p B_p
   $$
   ```

4. Press ⌘Enter, or click outside the block. The text is shown as a heading, a sentence with inline math, and a display formula. Click the block to edit it again; Esc leaves it as it was.

Text blocks take Markdown and nothing else: `#`, `##`, `###` headings, **bold**, *italic*, `code`, fenced code, `-` and `1.` lists, `>` quotes, `[text](https://…)` links, `$…$` and `$$…$$` math. There are no tables.

**Images.** There is no image block and no upload, and Markdown image syntax is not read. A picture reaches a Page in one of two ways: as a matplotlib figure captured from a Run (part 10), or drawn by a Visual.

**A Visual** is a block that is interactive for everyone who opens the Page, in the browser too.

5. Hover between or below blocks, press **+ Add block**, choose **Visual**, then **Bloch sphere** under "Start the Visual from".
6. The editor has **Title**, **Source** (HTML, CSS and JavaScript) and a **Preview**. **Run** reloads the preview from what you typed. Press **Done**. Unlike a text block, clicking outside does not finish a Visual.

A Visual runs in a sandbox: no network, no access to Infall.

To the left of each block, **↑** and **↓** move it and **✕** deletes it (with **Undo** for a few seconds).

**A Source** is a paper or web page, identified by its URL or DOI.

7. Under **Sources**, press **+ Add Source**.
8. In **URL or DOI**, enter `10.1103/PhysRevA.52.R2493` and press **Look up**, to its right. Infall asks Crossref about that DOI and fills in **Title**, **Authors** and **Year**. An arXiv address or id (`https://arxiv.org/abs/2103.05577`, or `2103.05577`) is asked of arXiv the same way. Look up fills only empty fields. If you already typed something different, it shows what the registry has and asks: **Use these** or **Keep mine**. While it asks, the button reads **Looking up…** and the form stays usable. When the DOI is already a Source in Infall, there is nothing to look up: the form offers that Source instead. If nothing is found, or the registry does not answer, the form says so and keeps what was there: fill the fields in yourself.
9. Press **Add Source**. Nothing is saved before this. If the same URL or DOI is already known, the form says "Already in Infall" and the button reads **Attach**: one Source can be on many Cards, and editing it changes it on all of them.

Look up sends the DOI or the arXiv id and nothing else: not your name, not the Workspace, not the Card. It goes from the Workspace's server (in a Local Workspace, the one inside the app on your computer) to Crossref for a DOI or to arXiv for an arXiv id, and only when you press the button. Infall never looks anything up by itself. [Privacy](privacy.md) lists everything Infall talks to.

A Source can also carry the paper itself as a PDF: part 16.

While you have an editor open on a Page, the others see "… is editing this Page" and can read it but not change it until you finish.

Close the Page with **✕** at its top right, or Esc. **⤢** beside it opens the Page at full width.

## 3. A Connection

1. Move the pointer over `Threshold theorem`. Four small dots appear on its edges.
2. Drag from a dot to `Surface code` and let go. A line joins the two Cards and a small box opens under it.
3. In the box choose the kind: **Related**, **Directed** (an arrow from the first Card to the second) or **Contradicts**. Choose **Directed**.
4. In **Label**, type `applies to` and press Enter.

Click a Connection to change it later; **Delete Connection** is in the same box. The Connections of a Card are also listed in its panel and at the bottom of its Page.

## 4. A Frame

1. Press **+ Frame**. Type `Error correction` and press Enter.
2. Click the Frame's title to select it, then drag its corners until both Cards are inside. The count beside the title becomes "2 Cards".

A Card belongs to a Frame when its centre is inside it. Dragging a Frame by its title moves only the Frame: the Cards stay where they are. Connections may cross Frames. The left rail lists every Frame under **Frames**; click one to jump to it.

## 5. A To-do

1. Open the Page of `Threshold theorem`. Under **To-dos on this Card**, type `Read the proof sketch` in the field "Add a To-do for…".
2. Leave the owner on yourself, or pick another Member, and press **Add To-do**.
3. Open **To-dos** in the left rail. There is one column per Member, and **Open**, **Done** and **All** at the top. Tick yours.

Anyone can give anyone a To-do. Only its owner can tick it; the owner and whoever made it can **Edit** or **Delete** it. To-dos are not part of the Board's history: they are the same on every Branch, and a To-do outlives the Card it points at.

## 6. Suggestions

Open **Suggestions** in the left rail. On a new Board it says "No Suggestions": a Suggestion is a Source or a Connection proposed by an AI, and none has been asked yet. Nothing a Suggestion proposes is on the Board until a Member presses **Accept**.

Come back here after part 9. When there is one:

1. Read the line after **Why:** and the line saying whose AI proposed it. Pointing at a proposed Connection draws it on the Board as a preview.
2. Press **Accept** or **Reject**. After accepting a Source you are offered a To-do, "Read this", for a Member you choose: press **Create To-do**, or untick it and press **Done**.

A rejection you made can be taken back with **Undo** on the same entry.

## 7. A Branch, a Checkpoint, a Merge

A Branch is a full copy of the Board where work stays apart until you Merge. `main` is the Branch everyone shares.

First name the present moment, so it can be found again:

1. Go back to **Board**. In the top bar press **Checkpoint**, type `Before trying colour codes`, and press **Create Checkpoint**.

Then branch:

2. Press the Branch control at the top left (it reads **Branch main**) and choose **New Branch…**. The **Branches** screen opens on the Branch Graph, with the newest dot of `main` selected and the cursor in the field **New Branch**.
3. Type `colour-codes`. The line under the field says **Starts from now on main**. Press Enter (or **Create Branch and switch to it**). The top bar now shows `colour-codes` and changes colour, so you can tell you are not on `main`.
4. Add a Card, `Colour code`, and change the summary of `Surface code`.
5. Open the Branch control again and choose `main`. Neither change is there.

The Branch Graph draws every Branch from the first Change: one row per stretch of someone's work (an Activity), newest at the top, each Branch a line of its own colour with its name on a label at the top end of the line, a **◆** where a Checkpoint is. To start a Branch from an earlier moment, click a dot or a **◆**, on any Branch, before pressing Enter: the line under the field says where it will start ("from Checkpoint Before trying colour codes on main"). Keyboard: ↑ ↓ move between rows, ← → to the neighbouring line, Enter shows what can be done there, N goes to the field, Esc goes back.

Then merge:

6. Open **Branches** in the left rail. On the label of `colour-codes`, at the top end of its line, press **Merge into main…**.
7. The review shows what **Merges automatically** and, if `main` changed the same things meanwhile, a list of **Conflicts**. Each Conflict needs a decision: one Branch's version, the other's, or **Edit by hand**. With nobody else editing there are none.
8. The field **Checkpoint on main before merging** is filled in for you. Press **Merge into main**.

`main` does not change until that last button, and a Checkpoint is made on it first, so the Merge can be undone from History.

What is not there: a Branch can be merged only with the Branch it was started from. Card positions are not merged: a Card moved on the Branch keeps the position it has on `main`. Branches cannot be deleted from the app.

## 8. History

1. On **Board**, with `main` open, press **History** in the top bar. A panel opens under the Board: one row per Member, a block for each stretch of their work (an Activity), and a **◆** for each Checkpoint.
2. Click a block, click a **◆**, or drag the slider. The Board above shows that moment, marked "Previewing main at … read-only". The right side of the panel says who made those Changes and what they were.
3. Press **Back to now** to leave the preview.

The same preview is on **Branches**: select a dot and press **Preview the Board**. That Branch opens with History at that moment; leaving the preview brings you back to the graph.

To go back for good, preview the moment and press **Restore main to here**. A Restore does not erase anything: it adds new Changes that bring the Board back, so it shows in History too and can itself be undone. Right after it, a notice offers **Undo** for ten seconds.

Pages cannot be opened while a moment is previewed. A Guest has no History.

## 9. The AI sidebar

Press **AI** at the top right. The sidebar is a Conversation between you and an AI about what you are looking at. It is private: other Members see only what you Pin. Conversations are kept on your device only.

Infall does not include a model. There are two ways to give the sidebar one.

**(a) In the desktop app: your own Claude Code.** In the desktop app, the **AI access** page says: "This app runs the sidebar on your own Claude subscription through Claude Code — nothing to set here", and below it either "Claude Code … found" or "Claude Code not found on this computer". If it is not found, the sidebar says "AI isn't set up on this computer" and asks you to install Claude Code, sign in to it once in a terminal, and press **Check again**. When Claude Code is found, the desktop app uses it for the sidebar even if you also added a key. This page says no more about path (a) than those screens do; path (b) is the one that was tested.

**(b) An OpenRouter key.** This is what the browser needs. It was tested and works.

1. Open **Settings** (in the menu under your name, or ⌘,) and choose **AI access**. (The sidebar's own messages call this page "AI settings".)
2. In the section **AI sidebar**, under **OpenRouter (optional)**, paste your key into **OpenRouter key** and press **Add key**.
3. Under **Model**, choose a model.

The page says what happens to the key: it is stored encrypted on your server and is never shown again, and the server sends your question, and what the AI reads through Infall's tools, to OpenRouter. If the section says "This server is not set up to store keys", the Admin has to turn that on. In a Local Workspace the server is the one inside the desktop app: the key is stored encrypted in that Workspace's files on your computer, and the questions go from your computer to OpenRouter.

Then ask:

4. Select `Surface code` on the Board. The line above the question field reads **Card: Surface code** and follows your selection; with nothing selected it reads **Board: main**.
5. Type a question, or press one of the starters such as "What should connect to this Card?". Enter sends; ⇧Enter makes a new line; **Stop** ends an answer early.
6. Under a finished answer, press **Pin to Page · Surface code**. The answer is copied into that Card's Page as a block marked **AI-generated**, with the model, who pinned it and when, and "Not reviewed by a Member." until someone presses **Mark reviewed**.

The AI can read Cards, Pages, Sources and Connections, and it can propose a Source or a Connection. It cannot change, delete or accept anything. When an answer ends with "proposed a Suggestion", press **Open Suggestions** and go back to part 6.

The same page, **AI access**, also makes access tokens, which let an AI app outside Infall read the Board and propose Suggestions as you. That is not needed for the sidebar.

## 10. A Run

A Run is a block of code together with the output from the last time someone ran it. Everyone can read the code and that output. Running it is possible only in the desktop app, on your own computer. This part uses Python; other languages, and naming the Python environment a Run needs, are part 17.

1. Open a Page, press **+ Add block** and choose **Run**. It starts as `experiment.py` with one line that prints a greeting. Change the **Name** or the **Code** if you like and press **Done**.

In the browser the **Run** button is disabled and the block says "Desktop app only". The rest needs the desktop app ([The first day](first-day.md#the-desktop-app-optional) says how to install it):

2. The first time, the button reads **Set up the Runner…**. Press it. In the window **Runner settings**, choose a **Python** found on your computer, leave **Folder (optional)** empty, and press **Save**.
3. Press **Run**. The button changes to "Waiting for you…" and a separate window asks **Run this code on your computer?** It shows the code exactly as it will run.
4. Read the code and scroll to its end; only then can **Run on this computer** be pressed. **Don't run** declines.
5. The output appears as it is printed. **Stop** ends the Run. When it finishes, the block records "Last run by you", the time, and "current code", and under the output a line saying what ran: the Python version and the packages the code imported, for example "Python 3.12.3 · numpy 2.1.0, scipy 1.14.1 +5".

What to know:

- **Approved code is not fenced in.** It runs with your own rights: it can read, change and delete your files and use the network. The approval window is the only barrier.
- Infall remembers an approval for that exact code, in that Workspace, run by that Python in that folder, and does not ask again until one of them changes. **Runner settings…** (under **⋯** on a Run) can forget all approvals (**Forget them**).
- Infall installs nothing. When the code needs a package your Python does not have, the output shows Python's own error and one more line: "[infall] This environment has no package <name>."
- **One Run at a time** on a computer. While one is going, the others say "Another Run is in progress". There is no time limit.
- After the code is edited, the old output stays, marked "code changed since", until someone runs it again.
- Figures drawn with matplotlib are captured and shown above the output: the ones still open when the code ends, at most three. `plt.show()` does nothing in a Run.
- **Clear output** under **⋯** removes the captured output for everyone; the code stays.

## 11. A Guest

A Guest is an outside reader with an end date. Guests exist only in a Team Workspace; a Local Workspace has no invites. Only an Admin can invite one: **Members**, then **Invite someone**, role **Guest**, and a date under **Access until**. The steps are in [The first day](first-day.md#the-admin).

What a Guest gets: the Board and the Pages of `main`, read-only, with Visuals that work and the captured output of Runs. The top bar reads "main · read-only" and "Guest — access until …". What a Guest does not get: editing, other Branches, History, To-dos, Suggestions, the AI sidebar, or the names of who else is here. Access ends by itself on the date.

## 12. Getting work in and out

Everything in this part works in the browser and in the desktop app, unless it says otherwise. A Guest can take out what they can read, and cannot import anything.

### A Page as Markdown, or printed

1. Open the Page of `Surface code`. Open **Page tools** (the **⋯** in the Page's header) and choose **Export as Markdown**. The desktop app asks where to save the file; a browser downloads it.

   The file has the title as a heading, the summary, then the blocks in order: text as you wrote it, formulas kept as TeX (`$…$` and `$$…$$`), a Run as its code followed by its captured output, with its figures embedded as images inside the file, a line saying where a Visual is (a Visual only works inside Infall), pinned AI text marked as AI-generated, and the Card's Sources as a numbered list at the end.

2. **Print…**, in the same menu, opens the system's print dialog with the Page alone: no rail, no bars, no Board, black on white in either theme, with formulas and Run output as they are on screen. To make a PDF, use the dialog: on a Mac, **PDF** at the bottom left, then **Save as PDF**; on Windows, the printer **Microsoft Print to PDF**; on Ubuntu, **Print to File**.

### Sources as BibTeX

**Export BibTeX** gives a `.bib` file that a reference manager or LaTeX can read:

- in a Page's **Sources** row, next to **+ Add Source**: the Sources of that Card;
- on the Board, in the second toolbar at the top left (**Sources on this Branch**): open **BibTeX ▾** and choose **Export BibTeX** for every Source on the Branch that is open.

A Source with a DOI becomes an `@article`, any other an `@misc`. Keys are the first author's surname, the year and a word of the title (`fowler2012surface`), made unique. Titles are written as they are, without extra braces to keep their capitals, so a LaTeX style that lowers the case of titles will lower yours too: add braces in the `.bib` file where it matters (`{Bloch}`).

**Import BibTeX…** brings a `.bib` file in (or text you paste):

- in a Page's **Sources** row: every entry becomes a Source on that Card;
- on the Board, **BibTeX ▾** → **Import BibTeX…**: every entry becomes a Card (its title is the entry's title, its status **Idea**, the Source attached), laid out in a grid inside a new Frame named after the file.

In the window that opens, choose the file under **BibTeX file**, or paste the entries under **Or paste the entries**; it says how many entries it found. Press **Import** (it reads, for example, **Import 40 entries**), then **Done**. An entry whose DOI or URL is already a Source reuses that Source instead of making a second one. Infall reads `title`, `author`, `year` (or the year in `date`), `doi`, `url` and `note`; it skips the rest. Entries it could not read are counted, and the message after the import says how many. A whole import is one step of Undo (⌘Z right after it takes all of it back) and one Activity in History: later, Restore to the moment before it (part 8).

**From Zotero**, in three steps:

1. In Zotero, right-click the collection and choose **Export Collection…** (for the whole library: **File → Export Library…**).
2. Choose the format **BibTeX** and press **OK**. Save the `.bib` file.
3. In Infall, choose **BibTeX ▾** → **Import BibTeX…** on the Board (or press **Import BibTeX…** in a Page's **Sources** row) and choose that file.

Mendeley and JabRef export BibTeX too; their files are read the same way.

### A Local Workspace: where it is, Workspace files, backups

A Team Workspace lives on the team's server; the Admin keeps its backups ([deploy guide](../deploy/README.md)) and can take it out as a Workspace file (part 14). The rest of this part is about Local Workspaces, which live on your computer. It needs the desktop app's start screen: **Switch Workspace…** in the app menu, or **Switch workspace…** in the menu under your name, takes you there.

Each Local Workspace's row on the start screen has a **⋯** menu with **Rename**, **Export…**, **Show in folder**, **Move to a Team server…** (part 14) and **Remove…**.

**Where it is.** Each Local Workspace is a folder on your computer. In its row's **⋯** menu, choose **Show in folder** to open that folder in the Finder (Explorer on Windows, the file manager on Ubuntu). It holds the Workspace's database, a key file beside it, and the folder `backups/`. The folders are under:

- macOS: `~/Library/Application Support/app.infall.desktop/workspaces/`
- Ubuntu: `~/.local/share/app.infall.desktop/workspaces/`
- Windows: `%LOCALAPPDATA%\app.infall.desktop\workspaces\` (before 0.9.0 they were under `%APPDATA%`; the first start of 0.9.0 moves them)

Do not copy the database file to keep a copy: use **Export…**.

**Export.** In the Workspace's **⋯** menu, choose **Export…** and choose where to save. When the Workspace has PDFs (part 16), a small panel asks first: **Include PDFs (N files, X MB)**, ticked; untick it for a smaller file whose Sources come without their PDFs, then press **Export…**. The result is one **Workspace file**, named `<Workspace name>.infall`. The row then says "Workspace file saved to …" with the path. It holds the Workspace's Research Content with all its history, Branches and Checkpoints, its To-dos and Comments, its PDFs unless you left them out, and your name. It does not hold:

- sign-ins;
- access tokens (made under **AI access**);
- the AI settings, the OpenRouter key among them;
- your Conversations with the AI, which are kept by the app on this computer, not in the Workspace;
- this device's Settings (Appearance, Board) and the Runner's approvals.

So a Workspace file can be given to someone without giving them your key.

**Import.** Below **Your workspaces** (under **Create a workspace** while you have none), press **Import a workspace…** and choose a `.infall` file. Infall makes a **new** Local Workspace from it, named after the file (with a number added if that name is taken), and opens it. It never replaces a Workspace you have. A file exported from a Team server opens the same way (part 14). A Workspace file made by **Export…**, or an automatic backup, is the way to do this. If all you have is a copy of a Workspace's database made by hand (`workspace.sqlite` from its folder), choose that instead: it is imported too, as **Recovered workspace**. Copy `workspace.sqlite-wal` along with it if it was there, and keep the two side by side, or the newest Changes may be missing. Your copy is only read, never changed, and the sign-ins and AI settings in it are left out, as in an export. Add an OpenRouter key again under **AI access** if you used one. A Workspace file made by a newer version of Infall is refused: update the app first.

**Backups.** The app keeps copies of each Local Workspace by itself. When you open a Workspace and its newest copy is older than 24 hours, the app makes a new one. It keeps the newest 7, in that Workspace's `backups/` folder. A copy is a Workspace file, like an export. There is nothing to set. Once there is a copy, the Workspace's row says when, for example "backed up yesterday at 09:12". If a copy cannot be made, the Workspace still opens.

A backup always includes the PDFs.

To get a backup back: choose **Show in folder** and look in `backups/`. Each copy is named after when it was made, in UTC: `backup-2026-11-24-150405.infall` is 24 November 2026 at 15:04:05. Then press **Import a workspace…** and choose that file. It opens as a new Workspace beside the old one; remove the old one when you are sure.

The backups are on the same computer, inside the Workspace's folder. **Remove…** on the start screen deletes that folder, backups included (it asks first, and offers **Export first…**), and a lost or broken disk takes them with it. For a copy that survives that, put a Workspace file from **Export…** somewhere else: another disk, or a folder that is backed up.

## 13. Settings

Open **Settings** from the menu under your name, or press ⌘, anywhere. The sections are listed on the left; every change applies at once, and a changed setting offers **Reset to default**.

- **Appearance**, kept on this device only: **Theme** (Light, Dark, Match system); **Interface scale** (bars, panels, menus and Page text; not the Board); **Text size** (text only, on top of the interface scale; Visuals keep their own sizes); **Reduce motion** (Match system, On, Off).
- **Board**, kept on this device only: **Board scale**, how large Cards, Frames and Connections are drawn at the Board's 100%. On the Board, when you are not typing in a field, ⇧+ makes it larger, ⇧− smaller, and ⇧0 puts it back to 100%.
- **AI access**: the AI sidebar and access tokens (part 9).
- **Runs**: which Python the Runner uses, the languages and environments set up on this computer, and **Open Runner settings** (desktop app only; parts 10 and 17).
- **Workspace**: which kind of Workspace this is, and your name and role. In a Local Workspace, **Change name** and **Switch workspace…**; in a Team Workspace, **Members** (Admin only) and **Sign out**, and for an Admin **Export Workspace file…** (part 14).
- **About**: browser or desktop app and its version, **Tour of Infall**, **Tutorial** (in a Tutorial Workspace), and the licences of the fonts and of PDF.js, which shows PDFs.

A Guest has no **AI access** and no **Runs**.

## 14. From alone to a team

A Local Workspace can be moved onto a Team server, and a Team Workspace can be taken off one. Both go through a Workspace file. Someone has to run the server first ([deploy guide](../deploy/README.md)), and you need to be its Admin.

A Team server takes a Workspace only while it is **empty**: `main` is its only Branch and has no Changes and no Checkpoints, and there are no To-dos and no Comments. Members and invites may already be there. A server that is not empty refuses the file and changes nothing.

### Moving a Local Workspace to a Team server

1. On the desktop app's start screen, open the **⋯** of the Local Workspace and choose **Move to a Team server…**.
2. Under **Team server address**, enter the server's address (`https://…`) and press **Move to server**. The app checks the address, writes a Workspace file of this Workspace into a private folder of its own, and opens the server.
3. Sign in as the server's Admin. The server greets you with "This Team server is empty". Press **Bring in <name> from this computer (<size>)**. A bar shows the file going up; **Stop** cancels.
4. The screen then says "The Workspace is in" and "Your earlier work as <name> is now yours.": every Change, Checkpoint, To-do, Pin and Comment you made alone now carries your name on the server. Press **Open the Board**.

What happens to the copy on your computer: it stays, and nothing of it is deleted. Its row on the start screen says **Moved to <host>**, and clicking it opens the Workspace on the server (**Open on the server**). Its **⋯** has **Open this copy (read-only)**, **Rename**, **Export…**, **Show in folder** and **Remove…**; it cannot be moved a second time. Opened, the copy shows a bar "Moved to <host>. This copy is read-only." with **Open on the server**, which goes back to the start screen. You can read everything there, History included, and export it, but nothing can be changed and Undo has nothing to do. Remove it yourself once you are sure.

If the server refuses, or you close the window before step 3, the copy stays as it was and the file waits: open the server again and the button is there. The app forgets a waiting file after 7 days.

A Workspace file over 512 MB is refused by a server set up as the guide says; a Workspace with many PDFs can pass that, and the Admin raises the limit ([deploy guide](../deploy/README.md)).

### Bringing a Workspace file into an empty server

The same first screen, in a browser, offers **Bring in a Workspace file…** and **Start empty**. **Start empty** leaves the Board empty. **Bring in a Workspace file…** asks for a `.infall` file: an export from the desktop app, a backup, or a file another Team server exported. Members who are not Admins see an ordinary empty Board instead of this screen.

The file brings every Branch, its history, Checkpoints, To-dos, Comments and PDFs. Whoever made the file (a Local Workspace's one Member, or the Admin who exported it from a server) becomes you. Everyone else in the file arrives as a name only, listed under **Names that came with the file**, each "— not signed in yet", with **Invite**. Emails never travel in a file, so you type each person's email in the invite; whoever accepts it takes over that name with everything under it (The first day, ["Taking over a name"](first-day.md#taking-over-a-name)).

The Admin of a server can also do this on the server's command line, with `infall-server import-workspace <file> --admin-email <email>` ([deploy guide](../deploy/README.md)).

### Leaving a server

1. As an Admin of the Team Workspace, open **Settings** (⌘,) → **Workspace**.
2. Under **Workspace file**, press **Export Workspace file…**. The desktop app asks where to save it; a browser downloads it.

The file holds every Branch, the history, Checkpoints, To-dos, Comments, Suggestions and PDFs, and the Members and Admins as **names only**. It does not hold emails, passwords, sign-ins, invites, access tokens, AI keys or settings, or Guests. Conversations with the AI were never on the server.

What to do with it:

- **Take it home**: on the desktop app's start screen, **Import a workspace…**. It opens as a new Local Workspace. You, who exported it, are its one Member, under your computer's user name. The others stay names: their Changes keep their names in History, and their open To-dos keep their owner and can be given to someone else.
- **Put it on another server**: bring it into that server while it is empty, as above. The others then take over their names by invite.

## 15. Comments and For you

A Comment is a remark about a Card, for the other Members to read. Comments are outside the Board's history, like To-dos: the same on every Branch, never in History, never merged, and ⌘Z does not touch them. A Guest sees none of them.

1. Open the Page of `Surface code`. Below its Sources and To-dos is **Comments**.
2. In **Start the thread**, type `@` and the first letters of a Member's name; choose the name from the list (↑ ↓ and Enter, or click). Write the rest of the remark. Comments take the same inline Markdown and `$math$` as a text block.
3. Press **Add Comment** (or ⌘Enter). It shows once the server has it, with your name and the time.

- **Edit** and **Delete** are under your own Comments; an Admin can also delete anyone's. A deleted Comment cannot be brought back. An edited one is marked "· edited".
- **Resolve** closes the thread: it folds away, reading "This thread is resolved.", with **Show all N Comments**. Anyone can **Reopen** it; a Comment can only be added to an open thread.
- On the Board a Card with a thread shows a speech mark and the number of Comments, and a ✓ when the thread is resolved.
- A Comment is at most 10 000 characters.
- A thread outlives its Card: when the Card is removed, the thread is still reached from For you, marked "On a Card that was removed. The thread is kept."
- In a Local Workspace you are the only Member: Comments are notes to yourself, and they go with the Workspace when it moves to a Team server.

**For you** in the left rail (beside To-dos, and as a tab at the top of To-dos) lists the Comments that mention you, newest first, with a count of the ones you have not seen. Each reads "<Name> mentioned you on <Card>"; click it to open that Card's Page at the Comment, which also marks it and everything older as seen. **Mark all as seen** does that for the whole list. While you are in the Workspace, a new mention also shows a short notice with **Open**. Editing a Comment notifies only Members it did not mention before. There is no email. The list keeps the newest 200.

## 16. PDFs on Sources

A Source can carry one PDF of the paper. Which PDF a Source has is part of the Board's history like its title; the file itself is stored once in the Workspace, however many Branches or Sources use it. In a Team Workspace it is on the team's server; in a Local Workspace, in its folder on your computer.

**Attach.** In a Page's **Sources**, each Source row has **Attach PDF…**: choose a `.pdf` file, or drop one on the Source's row (or anywhere on the Sources when the Card has only one). A bar shows it going up. The row then shows the file's name, its size and number of pages, and **Open PDF**, **Replace…** and **Remove PDF**. **Replace…** asks first ("Replace … with …? Undo brings the old one back."). Attaching, replacing and removing are each one step of Undo. Only PDFs are taken (Infall reads the file's first bytes, not its name), at most 100 MB each.

**Read.** **Open PDF** opens the reader where the Page was. At the top: **‹ Page** goes back (Esc does too), **⤢** opens it at full width, and **Open in the system viewer** in the desktop app (**Save a copy** in a browser). Below: the page number (type one and press Enter), ← → and PageUp / PageDown between pages, − and + to zoom, **Fit width**, and **Find** (⌘F; Enter and ⇧Enter between matches). Text can be selected and copied. Infall remembers on this device which page you were on in each PDF. The PDF is drawn inside Infall with PDF.js, which comes with it; nothing is fetched from the internet to show it.

**Search.** ⌘K (**Search Cards**) also finds words in the PDFs of the open Branch's Sources. Such a result reads "in the PDF of <Source title>, page N"; choosing it opens the Card's Page and the reader at that page. A scanned PDF without text cannot be searched or selected; the reader says "This PDF has no text to search or select."

**Fetch from arXiv.** When **Look up** (part 2) found an arXiv paper, the Source form offers **Fetch the PDF from arXiv**. Only when you press it, the Workspace's server downloads the paper's PDF from arXiv, sending nothing but the arXiv id. The PDF is attached when you press **Add Source** (or **Update Source**). A DOI gets no PDF this way: download it from the publisher and attach it.

**BibTeX with files** (desktop app). Zotero can export a collection with its files: in its export dialog, tick **Export Files**. The `.bib` file then names each PDF in a `file` field. In Infall's **Import BibTeX…**, once the file is chosen, the window says how many entries name a PDF and offers **Attach the PDFs…**: pick the folder the paths start from (the one Zotero exported to, or Zotero's storage folder). **Import** then attaches each PDF to its entry's Source, in the same one step of Undo, and says how many were attached and which were not found. Infall reads only PDFs inside the folder you picked. JabRef's and Mendeley's `file` fields are read too. In a browser the entries come in without their PDFs, and the window says how many had one.

**Workspace files.** Every Workspace file carries the PDFs: **Export…** on the start screen unless you untick **Include PDFs** (part 12), every automatic backup, a move to a Team server, and a Team Workspace's **Export Workspace file…**. A Source whose PDF was left out of a file still names it; its reader says "The server does not have this PDF’s file." until the same file is attached again.

A Guest can open the PDFs of Sources on `main`, and nothing else.

## 17. Runs in other languages, and environments

A Run names its **language**, and a Python or Q# Run may name the **environment** it wants. Each of them is only a name: what it starts is set by each person on their own computer, in **Runner settings**. Infall installs nothing.

**On the Run.** Press **Edit** on a Run. **Language** offers Python, Q#, Julia, R, JavaScript, Shell and **Other…** (then type a **Language id**, such as `haskell`). For Python and Q#, **Environment this Run asks for** takes a name, such as `analysis`; left empty, the Run uses the default Python. The block's head then reads "Run · Julia" and shows the environment's name. Changing either is one step of Undo and shows in History like a change of the code.

**Setting up a language** (once per computer). Open **Runner settings…** (app menu, or **⋯** on a Run). Under **Languages**:

- **Q#**: turn its switch on. It runs through the `qdk` package of the default Python, which needs Python 3.10 or newer; if `qdk` is missing, the window says to run `pip install qdk` in that Python.
- **Julia**, **R**, **JavaScript** (node) and **Shell** (bash): each lists the programs found on this computer; choose one, or enter its full path, and press **Set up <Name>**. On Windows, Shell is Git for Windows' bash.
- Anything else: **Add a language** with its **Id** (what Runs name), **Name**, **Program** (full path), **Arguments** (one per line; `{file}` stands for the Run's file, once) and **File extension**. A program is always started with the Run's file, never through a shell.

A Run in a language this computer has not set up shows "<Name> is not set up in Runner settings on this computer." with **Open Runner settings**. In a desktop app older than 0.9.0 it shows "Update Infall on this computer to run <Name> code." and is never run as Python.

**Naming an environment.** Runner settings lists, under **Python**, every Python found: conda environments, pyenv versions, a `venv` or `.venv` in the Runner's folder, and those on your `PATH`. The one chosen there is the default. **Add an environment** adds another by **Name** and the full path of its **Python**. A Run naming `analysis` runs in the environment called `analysis` on this computer. When there is none, the Runner settings window opens at a question ("A Run asks for the Python environment “analysis”, and nothing on this computer goes by that name."): choose one and press **Use it for “analysis”**. The answer is kept under **Names Runs ask for**, where it can be changed or removed, and the Run goes on. Closing the window instead stops the Run. Other Members' computers ask them the same, once, for themselves.

**What the result records.** The line under the output says what actually ran: "Python 3.12.3 · numpy 2.1.0, scipy 1.14.1 +5" (the Python version and the packages the code imported, with what they directly need, at most 32; the rest are behind **+N**), "Q# · qdk 1.34.0", or "Julia 1.11.2". When a Run's language or environment is changed after it ran, the record says so: "ran as Python", "ran in “analysis”".

**What the approval window asks.** Besides the code, it shows the language next to the Run's name, the **Environment** the Run asked for, and what will run it: the Python's path; for Q#, "Q#, through Python at <path>"; for another language, the **Command** with each argument. An approval holds only for that code in that language, run by that Python or program, in that folder. It asks again when any of these changes: the same code sent as another language, an environment name that now means another Python, another program for the language. Changing only a language's arguments does not ask again.

## 18. The Board as a picture

1. On the Board, open **Export ▾** at the top left and choose **Board as SVG…** or **Board as PNG…**.
2. The window says what will be in the picture. Tick **Visible area only** for just what is on screen, and **Light background** for a white background (for printing and papers). For a PNG, choose **Size**: 1×, 2× or 4×. A very large Board is made smaller, to the largest PNG Infall makes, and the window says so; SVG keeps every detail.
3. Press **Export SVG** (or **Export PNG**). The desktop app asks where to save; a browser downloads it. The file is named after the Branch, for example `Board of main.svg`.

While History shows an earlier moment, the picture is of that moment, and its name says when.

## Where things are

| To do this | Go here |
|---|---|
| Add a Card or a Frame | **+ Card**, **+ Frame**, top left of the Board |
| Find a Card, or words in a PDF | **Search Cards**, ⌘K |
| Write on a Card | select it, **Open Page** (or O) |
| Take back your own last gesture | ⌘Z (Ctrl+Z), or the Undo arrow beside **+ Frame** or in a Page's header; in the desktop app also **Edit → Undo**; after a delete also **Undo** on the notice |
| Do it again | ⇧⌘Z (Ctrl+Y), or the Redo arrow beside it |
| Go back further, or past someone else's work | **History**, then **Restore … to here** |
| Name a moment | **Checkpoint**, top bar |
| Work apart, then bring it in | Branch control, **New Branch…**; then **Branches** and **Merge into …** on the Branch's label |
| Start a Branch from an earlier moment | **Branches**: click a dot or a **◆**, type a name in **New Branch**, Enter |
| See who owes what | **To-dos**, left rail |
| Review what an AI proposed | **Suggestions**, left rail |
| Fill in a Source from its DOI or arXiv id | **Look up**, beside **URL or DOI** |
| Give a Source its PDF | **Attach PDF…** on its row in a Page's Sources, or drop the file there; **Fetch the PDF from arXiv** after **Look up** |
| Read a PDF | **Open PDF** on the Source's row |
| Remark on a Card, or ask someone | **Comments** in its Page, below Sources and To-dos; `@` and a name |
| See who mentioned you | **For you**, left rail |
| Take a Page out | **Page tools** (⋯ in the Page's header), **Export as Markdown** or **Print…** |
| Take the Board out as a picture | **Export ▾**, top left of the Board, **Board as SVG…** or **Board as PNG…** |
| Take Sources out, or bring them in | **Export BibTeX**, **Import BibTeX…**: in a Page's Sources row, or **BibTeX ▾** on the Board |
| Keep or move a Local Workspace | start screen, **⋯** in its row, **Export…**; **Import a workspace…** |
| Move a Local Workspace onto a Team server | start screen, **⋯** in its row, **Move to a Team server…** |
| Bring a Workspace file into an empty Team server (Admin) | the server's first screen, **Bring in a Workspace file…** |
| Take a Team Workspace off its server (Admin) | **Settings** (⌘,), **Workspace**, **Export Workspace file…** |
| See where a Local Workspace is | start screen, **⋯** in its row, **Show in folder** |
| Run code in another language, or name an environment | **Edit** on a Run, **Language** and **Environment this Run asks for**; then **Runner settings…** |
| Change how Infall looks | **Settings** (⌘,), **Appearance** and **Board** |
| Set up the AI | **Settings** (⌘,), **AI access** |
| Invite or remove people (Admin) | **Members**, left rail |
| Let someone take over a name from a Workspace file (Admin) | **Members**, **Invite** beside the name |
