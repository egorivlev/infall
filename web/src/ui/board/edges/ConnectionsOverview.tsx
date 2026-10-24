import { memo, useMemo } from 'react'
import { ViewportPortal } from '@xyflow/react'
import type { CardVM, ConnectionVM } from '../../../lib'
import type { Transient } from '../uiStore'
import { overviewPaths } from './overview'

type Props = {
  connections: readonly ConnectionVM[]
  cards: ReadonlyMap<string, CardVM>
  transient: ReadonlyMap<string, Transient>
}

/**
 * Every Connection of a large Board seen from far away (docs/specs/scale.md): the same lines and ends as
 * ConnectionEdge, drawn as two paths in one SVG instead of one SVG per Connection. At that distance Connections
 * have no labels and are not picked one by one, and thousands of separate SVGs are what made panning slow.
 */
export const ConnectionsOverview = memo(function ConnectionsOverview({ connections, cards, transient }: Props) {
  const { lines, caps } = useMemo(() => overviewPaths(connections, cards, transient), [connections, cards, transient])

  return (
    <ViewportPortal>
      <svg className="qb-overview" data-testid="connections-overview" aria-hidden="true" focusable="false">
        <path className="qb-conn__line" d={lines} />
        <path className="qb-conn__line qb-conn__cap" d={caps} />
      </svg>
    </ViewportPortal>
  )
})
