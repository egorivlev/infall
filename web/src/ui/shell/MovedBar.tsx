// M18 (team-move.md, decision 3): a Local Workspace that was moved to a Team server stays on this computer,
// read-only. A quiet bar above the work area says so, on every screen, and offers the way to the server.
import { useId } from 'react'
import { useMovedRefusal, useWorkspace } from '../../lib'
import { desktopSwitchWorkspace } from '../bridge'
import { movedLine, OPEN_ON_SERVER_HINT } from './moved'

export function MovedBar() {
  const ws = useWorkspace()
  const refusal = useMovedRefusal()
  const hintId = useId()
  if (ws.readOnly !== true) return null
  const back = desktopSwitchWorkspace()
  return (
    <div className="q-moved" role="region" aria-label="Moved Workspace" data-testid="moved-bar">
      <svg className="q-moved__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <rect x="2.5" y="6" width="9" height="6.5" rx="1" />
        <path d="M4.5 6 V4.2 a2.5 2.5 0 0 1 5 0 V6" />
      </svg>
      <p className="q-moved__text">
        <span className="q-moved__line">{movedLine(ws.movedTo)}</span>
        {/* Said once: the same sentence again (each refused write) changes nothing here, so it is not announced again. */}
        <span className="q-moved__refusal" role="status">
          {refusal.sentence ? ` ${refusal.sentence}` : ''}
        </span>
      </p>
      {back && (
        <>
          <span className="q-moved__hint" id={hintId}>
            {OPEN_ON_SERVER_HINT}
          </span>
          <button type="button" className="q-btn q-btn--sm" aria-describedby={hintId} title={OPEN_ON_SERVER_HINT} onClick={() => void back().catch(() => {})}>
            Open on the server
          </button>
        </>
      )}
    </div>
  )
}
