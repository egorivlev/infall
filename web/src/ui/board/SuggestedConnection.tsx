import { ViewportPortal } from '@xyflow/react'
import type { ConnectionKind } from '../../lib'
import { arrowPath, barPath, route } from './geometry'
import type { Rect } from './geometry'
import { useZoomLevel } from './useZoomLevel'

type Props = { from: Rect; to: Rect; kind: ConnectionKind; label: string }

/**
 * The Connection a Suggestion proposes, drawn over the Board while it is previewed: dashed, accent,
 * labelled "Suggested · …". A layer of its own — it is not a Connection of the Board, cannot be
 * selected or clicked, and disappears with the preview.
 */
export function SuggestedConnection({ from, to, kind, label }: Props) {
  const level = useZoomLevel()
  const r = route(from, to)
  return (
    <ViewportPortal>
      <svg className="qb-sug" data-testid="suggested-connection" data-kind={kind} width="1" height="1" aria-hidden="true">
        <path className="qb-sug__line qb-sug__dash" d={r.d} />
        {kind === 'directed' && <path className="qb-sug__line" d={arrowPath(r.end)} />}
        {kind === 'contradicts' && (
          <>
            <path className="qb-sug__line" d={barPath(r.start, 1)} />
            <path className="qb-sug__line" d={barPath(r.end, -1)} />
          </>
        )}
      </svg>
      {level !== 'tile' && (
        <div
          className="qb-sug-label"
          data-testid="suggested-connection-label"
          style={{ transform: `translate(-50%, -50%) translate(${r.mx}px, ${r.my}px)` }}
        >
          Suggested · {label || kind}
        </div>
      )}
    </ViewportPortal>
  )
}
