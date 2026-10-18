# Tutorial

One pass through Infall, from an empty Board to having used each main part once. About fifteen minutes. You are signed in as a Member ([The first day](first-day.md) gets you there). Do the steps in order: later ones use what earlier ones made.

Keys are written for a Mac; elsewhere use Ctrl for ⌘. The app also has a short tour that points at the same controls: **Tour of Infall** in the menu under your name.

Two things to know before you start:

- **There is no save button.** Every edit is a Change, recorded with your name and sent to everyone at once. The bottom of the left rail says **Synced** when nothing is waiting.
- **There is no general undo.** ⌘Z does nothing on the Board. After a delete, a small notice offers **Undo** for a few seconds. For anything older, use History (part 8).

## 1. A Card

1. On an empty Board, press **+ Card** at the top left (or double-click empty space). A Card appears with its title ready to type.
2. Type `Surface code` and press Enter. Esc would have cancelled.
3. Click the Card once to select it. A panel headed **Card** opens on the right with **Title**, **Summary**, **Status** and **Connections**.
4. Type a line under **Summary** and click outside the field (or press ⌘Enter; a summary can have several lines, so Enter alone makes a new one).
5. Under **Status**, choose **Reading**. The five statuses are Idea, Reading, Understood, Open question and Dead end · kept. A dead end stays on the Board on purpose.
6. Make a second Card, `Threshold theorem`, and drag it beside the first.

Drag empty space or scroll to move around the Board; hold ⌘ and scroll to zoom. **Fit** at the bottom right shows everything. Zoomed far out, Cards show only a title or a status, and their text cannot be edited until you zoom back in.

**Search Cards** at the top (⌘K) finds a Card by its title or summary on the Branch that is open, and jumps to it. It does not search inside Pages.

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
8. In **URL or DOI**, enter `10.1103/PhysRevA.52.R2493`. Fill in **Title**, **Authors** and **Year** yourself: Infall does not look them up.
9. Press **Add Source**. If the same URL or DOI is already known, the form says "Already in Infall" and the button reads **Attach**: one Source can be on many Cards, and editing it changes it on all of them.

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

2. Press the Branch control at the top left (it reads **Branch main**) and choose **New Branch from now…**.
3. Under **New Branch**, enter the **Name** `colour-codes`, leave **Start from** on **Now**, and press **Create Branch and switch to it**. The top bar now shows `colour-codes` and changes colour, so you can tell you are not on `main`.
4. Add a Card, `Colour code`, and change the summary of `Surface code`.
5. Open the Branch control again and choose `main`. Neither change is there.

Then merge:

6. Open **Branches** in the left rail. In the row of `colour-codes`, press **Merge into main…**.
7. The review shows what **Merges automatically** and, if `main` changed the same things meanwhile, a list of **Conflicts**. Each Conflict needs a decision: one Branch's version, the other's, or **Edit by hand**. With nobody else editing there are none.
8. The field **Checkpoint on main before merging** is filled in for you. Press **Merge into main**.

`main` does not change until that last button, and a Checkpoint is made on it first, so the Merge can be undone from History.

What is not there: a Branch can be merged only with the Branch it was started from. Card positions are not merged: a Card moved on the Branch keeps the position it has on `main`. Branches cannot be deleted from the app.

## 8. History

1. On **Board**, with `main` open, press **History** in the top bar. A panel opens under the Board: one row per Member, a block for each stretch of their work (an Activity), and a **◆** for each Checkpoint.
2. Click a block, click a **◆**, or drag the slider. The Board above shows that moment, marked "Previewing main at … read-only". The right side of the panel says who made those Changes and what they were.
3. Press **Back to now** to leave the preview.

To go back for good, preview the moment and press **Restore main to here**. A Restore does not erase anything: it adds new Changes that bring the Board back, so it shows in History too and can itself be undone. Right after it, a notice offers **Undo** for ten seconds.

Pages cannot be opened while a moment is previewed. A Guest has no History.

## 9. The AI sidebar

Press **AI** at the top right. The sidebar is a Conversation between you and an AI about what you are looking at. It is private: other Members see only what you Pin. Conversations are kept on your device only.

Infall does not include a model. There are two ways to give the sidebar one.

**(a) In the desktop app: your own Claude Code.** In the desktop app, the **AI access** page says: "This app runs the sidebar on your own Claude subscription through Claude Code — nothing to set here", and below it either "Claude Code … found" or "Claude Code not found on this computer". If it is not found, the sidebar says "AI isn't set up on this computer" and asks you to install Claude Code, sign in to it once in a terminal, and press **Check again**. When Claude Code is found, the desktop app uses it for the sidebar even if you also added a key. This page says no more about path (a) than those screens do; path (b) is the one that was tested.

**(b) An OpenRouter key.** This is what the browser needs. It was tested and works.

1. Open the menu under your name and choose **AI access**. (The sidebar's own messages call this page "AI settings".)
2. In the section **AI sidebar**, under **OpenRouter (optional)**, paste your key into **OpenRouter key** and press **Add key**.
3. Under **Model**, choose a model.

The page says what happens to the key: it is stored encrypted on your server and is never shown again, and the server sends your question, and what the AI reads through Infall's tools, to OpenRouter. If the section says "This server is not set up to store keys", the Admin has to turn that on.

Then ask:

4. Select `Surface code` on the Board. The line above the question field reads **Card: Surface code** and follows your selection; with nothing selected it reads **Board: main**.
5. Type a question, or press one of the starters such as "What should connect to this Card?". Enter sends; ⇧Enter makes a new line; **Stop** ends an answer early.
6. Under a finished answer, press **Pin to Page · Surface code**. The answer is copied into that Card's Page as a block marked **AI-generated**, with the model, who pinned it and when, and "Not reviewed by a Member." until someone presses **Mark reviewed**.

The AI can read Cards, Pages, Sources and Connections, and it can propose a Source or a Connection. It cannot change, delete or accept anything. When an answer ends with "proposed a Suggestion", press **Open Suggestions** and go back to part 6.

The same page, **AI access**, also makes access tokens, which let an AI app outside Infall read the Board and propose Suggestions as you. That is not needed for the sidebar.

## 10. A Run

A Run is a block of Python together with the output from the last time someone ran it. Everyone can read the code and that output. Running it is possible only in the desktop app, on your own computer.

1. Open a Page, press **+ Add block** and choose **Run**. It starts as `experiment.py` with one line that prints a greeting. Change the **Name** or the **Code** if you like and press **Done**.

In the browser the **Run** button is disabled and the block says "Desktop app only". The rest needs the desktop app ([The first day](first-day.md#the-desktop-app-optional-macos) says how to install it):

2. The first time, the button reads **Set up the Runner…**. Press it. In the window **Runner settings**, choose a **Python** found on your computer, leave **Folder (optional)** empty, and press **Save**.
3. Press **Run**. The button changes to "Waiting for you…" and a separate window asks **Run this code on your computer?** It shows the code exactly as it will run.
4. Read the code and scroll to its end; only then can **Run on this computer** be pressed. **Don't run** declines.
5. The output appears as it is printed. **Stop** ends the Run. When it finishes, the block records "Last run by you", the time, and "current code".

What to know:

- **Approved code is not fenced in.** It runs with your own rights: it can read, change and delete your files and use the network. The approval window is the only barrier.
- Infall remembers an approval for that exact code on that server and does not ask again until the code changes. **Runner settings…** (under **⋯** on a Run) can forget all approvals.
- **One Run at a time** on a computer. While one is going, the others say "Another Run is in progress". There is no time limit.
- After the code is edited, the old output stays, marked "code changed since", until someone runs it again.
- Figures drawn with matplotlib are captured and shown above the output: the ones still open when the code ends, at most three. `plt.show()` does nothing in a Run.
- **Clear output** under **⋯** removes the captured output for everyone; the code stays.

## 11. A Guest

A Guest is an outside reader with an end date. Only an Admin can invite one: **Members**, then **Invite someone**, role **Guest**, and a date under **Access until**. The steps are in [The first day](first-day.md#the-admin).

What a Guest gets: the Board and the Pages of `main`, read-only, with Visuals that work and the captured output of Runs. The top bar reads "main · read-only" and "Guest — access until …". What a Guest does not get: editing, other Branches, History, To-dos, Suggestions, the AI sidebar, or the names of who else is here. Access ends by itself on the date.

## Where things are

| To do this | Go here |
|---|---|
| Add a Card or a Frame | **+ Card**, **+ Frame**, top left of the Board |
| Find a Card | **Search Cards**, ⌘K |
| Write on a Card | select it, **Open Page** (or O) |
| Take back a delete | **Undo** on the notice, within a few seconds |
| Go back further | **History**, then **Restore … to here** |
| Name a moment | **Checkpoint**, top bar |
| Work apart, then bring it in | Branch control, then **Branches** and **Merge into …** |
| See who owes what | **To-dos**, left rail |
| Review what an AI proposed | **Suggestions**, left rail |
| Set up the AI | menu under your name, **AI access** |
| Invite or remove people (Admin) | **Members**, left rail |
