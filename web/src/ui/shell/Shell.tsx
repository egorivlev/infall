import { useEffect, useRef, useState } from 'react'
import { board, branches, members, useWorkspace, workspace } from '../../lib'
import type { Member } from '../../lib'
import { AiSidebar } from '../ai'
import { BoardView } from '../board'
import { sidePanelsFit } from '../board/geometry'
import { suggestionsPanel, useAiPanel, usePagePanel, useSuggestionsPanel } from '../bridge'
import { MergeReview } from '../merge'
import { Settings } from '../settings'
import { Todos } from '../todos'
import { Tour, Tutorial, TUTORIAL_PRESET } from '../tutorial'
import { Branches } from './Branches'
import { errorStatus } from './errorMessages'
import { Link } from './Link'
import { Members } from './Members'
import { Rail } from './Rail'
import { branchPath, currentPath, MAIN, navigate, parseRoute, rememberBranch, SETTINGS_PATH } from './router'
import type { Route } from './router'
import { TopBar } from './TopBar'

// The data layer may reject (network, 403); the shell shows state via the Board status, so ignore here.
const ignore = () => {}

export type ShellView = 'board' | 'branches' | 'members' | 'merge' | 'todos' | 'settings'

/** What this person may see for a route; anything else falls back to the Board. */
function viewFor(route: Route, member: Member, local: boolean): ShellView {
  // A Local Workspace has one Member and nobody to invite: no Members screen.
  if (route.name === 'members') return member.role === 'admin' && !local ? 'members' : 'board'
  if (route.name === 'branches') return member.role === 'guest' ? 'board' : 'branches'
  if (route.name === 'merge') return member.role === 'guest' ? 'board' : 'merge'
  if (route.name === 'todos') return member.role === 'guest' ? 'board' : 'todos' // To-dos are for the team, not for Guests
  if (route.name === 'settings') {
    // A Guest has no access tokens and runs nothing: those two sections are not theirs.
    if (member.role === 'guest' && (route.section === 'ai' || route.section === 'runs')) return 'board'
    return 'settings'
  }
  return 'board' // the invite link means nothing once signed in
}

export function Shell({ member, route }: { member: Member; route: Route }) {
  const isGuest = member.role === 'guest'
  const ws = useWorkspace()
  const local = ws.kind === 'local'
  const tutorialWorkspace = local && ws.preset === TUTORIAL_PRESET
  const view = viewFor(route, member, local)

  // What kind of Workspace this is: asked once per session; until it answers, it reads as a Team Workspace.
  useEffect(() => {
    void workspace.load()
  }, [member.id])

  // The Branch in the URL is the truth. Screens without one (/branches, /members, /todos, /settings) keep the last Branch open.
  // Guests can read main only.
  const routeBranch = route.name === 'board' ? (isGuest ? MAIN : route.branch) : null
  const [lastBranch, setLastBranch] = useState(routeBranch ?? MAIN)
  if (routeBranch !== null && routeBranch !== lastBranch) setLastBranch(routeBranch)
  const branch = routeBranch ?? lastBranch

  // A name the server does not know. Compared with `branch` when shown, so a stale answer never sticks.
  const [unknown, setUnknown] = useState<string | null>(null)

  const redirect =
    view !== route.name || (route.name === 'board' && route.branch !== branch) ? branchPath(branch) : null
  useEffect(() => {
    if (redirect !== null) navigate(redirect, { replace: true })
  }, [redirect])

  useEffect(() => {
    rememberBranch(branch)
    let stale = false
    Promise.resolve(board.open(branch)).then(
      () => {
        if (!stale) setUnknown((u) => (u === branch ? null : u))
      },
      (e: unknown) => {
        if (!stale && errorStatus(e) === 404) setUnknown(branch)
      },
    )
    return () => {
      stale = true
    }
  }, [branch])

  useEffect(() => {
    if (!isGuest) {
      void Promise.resolve(members.reload()).catch(ignore)
      void Promise.resolve(branches.reload()).catch(ignore)
    }
    return () => {
      board.close()
      rememberBranch(MAIN)
    }
  }, [isGuest])

  const missing = unknown === branch

  // ⌘, / Ctrl+, opens Settings from anywhere (a field included: it types nothing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ',' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.defaultPrevented) return
      e.preventDefault()
      if (parseRoute(currentPath()).name !== 'settings') navigate(SETTINGS_PATH)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The AI sidebar takes a column from the work area on every screen. Guests have none.
  const aiOpen = useAiPanel((s) => s.open) && !isGuest
  // The Board decides which of its side panels stays when both are opened; it cannot see the sidebar take its room.
  // If Suggestions and a Page are both open and no longer fit, Suggestions gives way (the Page is what the AI is asked about).
  const work = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!aiOpen) return
    const width = work.current?.clientWidth ?? 0
    if (width === 0 || sidePanelsFit(width)) return // 0: not laid out, nothing to go by
    if (useSuggestionsPanel.getState().open && usePagePanel.getState().cardId !== null) suggestionsPanel.close()
  }, [aiOpen])

  return (
    <div className={aiOpen ? 'q-shell has-ai' : 'q-shell'} data-branch={branch}>
      <TopBar member={member} branch={branch} available={!missing} />
      {/* A Merge starts from the Branches screen, so that is where the rail points. */}
      <Rail member={member} route={view === 'merge' ? 'branches' : view} branch={branch} />
      <main className="q-work" ref={work}>
        {view === 'members' ? (
          <Members me={member} />
        ) : view === 'branches' ? (
          <Branches current={branch} />
        ) : view === 'todos' ? (
          <Todos me={member} />
        ) : view === 'settings' && route.name === 'settings' ? (
          <Settings member={member} section={route.section} />
        ) : view === 'merge' && route.name === 'merge' ? (
          <MergeReview key={`${route.from}\n${route.into}`} from={route.from} into={route.into} />
        ) : missing ? (
          <div className="q-missing" role="status">
            <p className="q-missing__text">There is no Branch called “{branch}”.</p>
            <Link href="/">Go to main</Link>
          </div>
        ) : (
          <div className="q-board-host" data-tour="board">
            <BoardView />
          </div>
        )}
      </main>
      {aiOpen && <AiSidebar branch={branch} />}
      {/* Keyed by Member: the offer and its answer are each person's own. A Tutorial Workspace has the Tutorial instead of the offer. */}
      <Tour key={member.id} member={member} view={missing ? 'missing' : view} offer={!tutorialWorkspace} />
      {tutorialWorkspace && <Tutorial key={member.id} />}
    </div>
  )
}
