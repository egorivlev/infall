// The bar for a pending move this server cannot take (pendingMove.ts): why, and Cancel the move.
import { desktopMove } from '../bridge'
import { dismissPendingMove, pendingMoveLine } from './pendingMove'

export function PendingMoveBar({ name, admin }: { name: string; admin: boolean }) {
  const cancel = () => {
    dismissPendingMove()
    // `cancel` drops the pending move and its file (the Local Workspace stays as it was); an older app ignores it and
    // keeps the move, which is harmless: the bar stays away for this window either way.
    void desktopMove()
      ?.done({ ok: false, cancel: true })
      .catch(() => {})
  }
  return (
    <div className="q-moved" role="region" aria-label="Move from this computer" data-testid="pending-move-bar">
      <p className="q-moved__text">
        <span className="q-moved__line">{pendingMoveLine(name, admin)}</span>
      </p>
      <button type="button" className="q-btn q-btn--sm" onClick={cancel}>
        Cancel the move
      </button>
    </div>
  )
}
