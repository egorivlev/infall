// M18 (team-move.md, Contract C): a move the desktop app holds for this origin that cannot happen here — the server
// has work already, or the person is not its Admin. Only the empty server's first screen can bring a Workspace in;
// anywhere else the pending move was silent and lingered. PendingMoveBar says why, and offers to cancel the move.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { desktopMove } from '../bridge'

/** Dismissed (or cancelled) in this window: not shown again until the page is loaded anew. */
const useDismissed = create<{ dismissed: boolean }>(() => ({ dismissed: false }))

export function dismissPendingMove() {
  useDismissed.setState({ dismissed: true })
}

/** For tests. */
export function resetPendingMove() {
  useDismissed.setState({ dismissed: false })
}

export function pendingMoveLine(name: string, admin: boolean): string {
  return admin
    ? `${name} from this computer was not brought in: a Workspace can only be moved onto an empty Team server.`
    : `${name} from this computer was not brought in: only an Admin of an empty Team server can bring it in.`
}

/** The name of the Workspace a pending move holds for this origin, while `active`; null when there is none or it was dismissed. */
export function usePendingMove(active: boolean): string | null {
  const [name, setName] = useState<string | null>(null)
  const dismissed = useDismissed((s) => s.dismissed)
  useEffect(() => {
    const bridge = active && !dismissed ? desktopMove() : null
    if (!bridge) return
    let stale = false
    bridge.handover().then(
      (h) => {
        if (!stale && h && typeof h.name === 'string' && h.name.trim() !== '') setName(h.name)
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [active, dismissed])
  return active && !dismissed ? name : null
}
