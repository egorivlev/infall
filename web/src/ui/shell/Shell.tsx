import { useEffect, useState } from 'react'
import { board, branches, members } from '../../lib'
import type { Member } from '../../lib'
import { BoardView } from '../board'
import { Branches } from './Branches'
import { errorStatus } from './errorMessages'
import { Link } from './Link'
import { Members } from './Members'
import { Rail } from './Rail'
import { branchPath, MAIN, navigate, rememberBranch } from './router'
import type { Route } from './router'
import { TopBar } from './TopBar'

// The data layer may reject (network, 403); the shell shows state via the Board status, so ignore here.
const ignore = () => {}

export type ShellView = 'board' | 'branches' | 'members'

/** What this person may see for a route; anything else falls back to the Board. */
function viewFor(route: Route, member: Member): ShellView {
  if (route.name === 'members') return member.role === 'admin' ? 'members' : 'board'
  if (route.name === 'branches') return member.role === 'guest' ? 'board' : 'branches'
  return 'board' // the invite link means nothing once signed in
}

export function Shell({ member, route }: { member: Member; route: Route }) {
  const isGuest = member.role === 'guest'
  const view = viewFor(route, member)

  // The Branch in the URL is the truth. Screens without one (/branches, /members) keep the last Branch open.
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

  return (
    <div className="q-shell" data-branch={branch}>
      <TopBar member={member} branch={branch} available={!missing} />
      <Rail member={member} route={view} branch={branch} />
      <main className="q-work">
        {view === 'members' ? (
          <Members me={member} />
        ) : view === 'branches' ? (
          <Branches current={branch} />
        ) : missing ? (
          <div className="q-missing" role="status">
            <p className="q-missing__text">There is no Branch called “{branch}”.</p>
            <Link href="/">Go to main</Link>
          </div>
        ) : (
          <div className="q-board-host">
            <BoardView />
          </div>
        )}
      </main>
    </div>
  )
}
