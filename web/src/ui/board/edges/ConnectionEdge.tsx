import { memo } from 'react'
import { EdgeLabelRenderer, useInternalNode } from '@xyflow/react'
import type { EdgeProps, InternalNode } from '@xyflow/react'
import { arrowPath, barPath, route } from '../geometry'
import type { Rect } from '../geometry'
import type { BoardNode, ConnectionEdgeType } from '../types'
import { ui } from '../uiStore'
import { useZoomLevel } from '../useZoomLevel'

function rectOf(n: InternalNode<BoardNode>): Rect {
  const p = n.internals.positionAbsolute
  return { x: p.x, y: p.y, w: n.width ?? n.measured.width ?? 0, h: n.height ?? n.measured.height ?? 0 }
}

function ConnectionEdgeImpl({ id, source, target, data, selected }: EdgeProps<ConnectionEdgeType>) {
  const a = useInternalNode<BoardNode>(source)
  const b = useInternalNode<BoardNode>(target)
  const level = useZoomLevel()
  if (!a || !b || !data) return null
  const { conn } = data
  const r = route(rectOf(a), rectOf(b))
  const touch = Boolean(a.selected || b.selected)
  const cls = `qb-conn${touch ? ' is-touch' : ''}${selected ? ' is-selected' : ''}`

  return (
    <>
      <g className={cls} data-testid={`connection-${id}`} data-kind={conn.kind}>
        <path className="qb-conn__hit" d={r.d} />
        <path className="qb-conn__line" d={r.d} />
        {conn.kind === 'directed' && <path className="qb-conn__line qb-conn__cap" d={arrowPath(r.end)} />}
        {conn.kind === 'contradicts' && (
          <>
            <path className="qb-conn__line qb-conn__cap" d={barPath(r.start, 1)} />
            <path className="qb-conn__line qb-conn__cap" d={barPath(r.end, -1)} />
          </>
        )}
      </g>
      {conn.label && level !== 'tile' && (
        <EdgeLabelRenderer>
          <div
            className={`qb-conn-label${selected ? ' is-selected' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${r.mx}px, ${r.my}px)` }}
            onClick={(e) => {
              e.stopPropagation()
              ui.select([id])
            }}
          >
            {conn.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const ConnectionEdge = memo(ConnectionEdgeImpl)
