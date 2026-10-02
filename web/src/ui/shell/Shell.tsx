import { useEffect } from 'react'
import { board, members, useBoard } from '../../lib'
import type { Member } from '../../lib'
import { BoardView } from '../board'
import { Members } from './Members'
import { Rail } from './Rail'
import { navigate } from './router'
import type { Route } from './router'
import { TopBar } from './TopBar'

// The data layer may reject (network, 403); the shell shows state via the Board status, so ignore here.
const ignore = () => {}

export function Shell({ member, route }: { member: Member; route: Route }) {
  const snap = useBoard()
  const isGuest = member.role === 'guest'

  // The invite link means nothing once signed in; /members is for Admins only.
  const view: Route['name'] = route.name === 'members' && member.role !== 'admin' ? 'board' : route.name === 'invite' ? 'board' : route.name
  useEffect(() => {
    if (view !== route.name) navigate('/', { replace: true })
  }, [view, route.name])

  useEffect(() => {
    void Promise.resolve(board.open()).catch(ignore)
    if (!isGuest) void Promise.resolve(members.reload()).catch(ignore)
    return () => board.close()
  }, [isGuest])

  const branch = snap.branch?.name ?? 'main'

  return (
    <div className="q-shell" data-branch={branch}>
      <TopBar member={member} branch={branch} />
      <Rail member={member} route={view} />
      <main className="q-work">
        {view === 'members' ? (
          <Members me={member} />
        ) : (
          <div className="q-board-host">
            <BoardView />
          </div>
        )}
      </main>
    </div>
  )
}
