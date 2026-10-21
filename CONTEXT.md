# Infall

A self-hosted shared workspace where a small research team maps, extends, and tracks the state of a research project.

## Language

### Workspaces

**Workspace**:
One team's whole Infall: its Research Content, its Members, and its To-dos. A person may have several Workspaces; each is entirely separate from the others.
_Avoid_: Project, instance, server

**Team Workspace**:
A Workspace kept on a server the team runs, which Members sign in to.
_Avoid_: Remote workspace, cloud workspace

**Local Workspace**:
A Workspace kept only on one person's computer by the desktop app. It has exactly one Member and needs no server and no sign-in.
_Avoid_: Offline mode, personal workspace, solo mode

**Preset**:
The starting Research Content a new Local Workspace is created with: Blank, Tutorial, Literature review, or Research project. After creation it is ordinary Research Content with no tie to the Preset.
_Avoid_: Template, sample, starter

**Tutorial Workspace**:
A Local Workspace created from the Tutorial Preset, the only place the Tutorial runs.
_Avoid_: Demo, sandbox, mock server

**Tutorial**:
A hands-on sequence of steps in a Tutorial Workspace, each asking the person to use one part of Infall and moving on once they have. It makes real Changes.
_Avoid_: Onboarding, walkthrough, wizard

**Tour**:
A read-only sequence of pointers at the controls of any Workspace. It never makes a Change.
_Avoid_: Tutorial, walkthrough

### Content

**Board**:
The spatial canvas on which a Branch's Cards and Connections are laid out.
_Avoid_: Canvas, map, whiteboard

**Frame**:
A named region of the Board that groups Cards belonging to one theme. Connections may cross Frames.
_Avoid_: Group, section, area, sub-board

**Card**:
One unit of research on the Board — a topic, question, finding, or idea — with a title, summary, and status. There is only one kind of Card.
_Avoid_: Node, note, sticky, item

**Page**:
The team's own write-up inside a Card: an ordered sequence of blocks (text, Simulation, image, Sources). A Card with an empty Page is still a Card.
_Avoid_: Article, document, note

**Simulation**:
A block in a Page that shows research behaviour rather than describing it. Either a Visual or a Run.
_Avoid_: Demo, notebook, widget

**Visual**:
A Simulation that is interactive and works for anyone who opens the Page, with nothing to install.
_Avoid_: Animation, widget

**Run**:
A Simulation consisting of experiment code together with the output captured the last time someone executed it, and a record of who executed it, when, and against which version of the code. Readers see the captured output without executing anything.
_Avoid_: Notebook, job, cell

**Runner**:
The part of the desktop app that executes Runs on the member's own hardware. A member using Infall from a browser has no Runner, and can still read every Run's captured output.
_Avoid_: Kernel, agent, worker

**Source**:
An external reference — a paper, preprint, or web page — identified by its URL or DOI. One Source may be attached to many cards.
_Avoid_: Link, article, reference, citation

**Connection**:
A relation between two Cards, drawn as a line on the Board. It is one of three kinds — related, directed, or contradicts — and may carry a free-text label saying what the relation is.
_Avoid_: Link, edge, arrow

**Suggestion**:
A Source or Connection proposed by an AI that is not part of Research Content until a team member accepts it.
_Avoid_: Recommendation, proposal

### Versioning

**Research Content**:
The body of knowledge the team has assembled: the board, its cards, and everything a card expands into (articles, simulations, links). The only thing that is versioned.
_Avoid_: Project state

**Branch**:
An alternative line of Research Content that can diverge from and be merged back into another Branch. Represents a research direction being explored.
_Avoid_: Snapshot, version, checkpoint

**Merge**:
Bringing the changes made on one Branch into another.

**Conflict**:
A place where two Branches being merged disagree in a way that cannot be combined: the same field of the same card changed on both, or a card edited on one and deleted on the other. A team member decides each one before the Merge lands. Disagreements about where a card sits are not Conflicts.
_Avoid_: Clash, collision

**Change**:
A single recorded edit to Research Content on a Branch — who altered what, and when. Recorded automatically; there is no commit step.
_Avoid_: Commit, edit, revision

**Checkpoint**:
A name a team member gives to a moment in a Branch's history so it can be found again.
_Avoid_: Commit, tag, snapshot, save

**Activity**:
One Member's consecutive Changes on a Branch made close together in time, shown as a single entry when reading history. A way of reading the history, not something recorded.
_Avoid_: Session, edit, burst

**Restore**:
Returning a Branch to how it was at an earlier moment by adding new Changes that undo the later ones. History is never erased, so a Restore can itself be undone.
_Avoid_: Revert, rollback, reset

### Outside versioning

**To-do**:
A task owned by one Member, visible to all Members, and assignable by any Member; only its owner marks it done. A fact about real-world work, so it is the same on every Branch. May point at one Card, and outlives that Card if it is removed.
_Avoid_: Task, ticket

**Conversation**:
A Member's private exchange with an AI about what they are looking at. Not Research Content, and not visible to anyone else.
_Avoid_: Chat, thread, session

**Pin**:
To copy part of a Conversation into a Page, where it becomes Research Content marked as AI-generated with who pinned it, which model, and when. Pinned text is shown as not reviewed until a Member marks it reviewed.
_Avoid_: Share, save, export

### People

**Member**:
A person on the research team. Every Member has equal, full rights over Research Content.
_Avoid_: User, account, student, teammate

**Admin**:
A Member who additionally invites and removes people and manages the server. Has no extra authority over Research Content.
_Avoid_: Owner, superuser

**Guest**:
An outsider invited for a limited time who can read the Research Content of the main Branch and nothing else — no history, no other Branches.
_Avoid_: Viewer, visitor, reader
