import type { CardVM, ConnectionVM } from '../../../lib'
import { arrowPath, barPath, route } from '../geometry'
import type { Rect } from '../geometry'
import type { Transient } from '../uiStore'

function rectOf(card: CardVM, transient: ReadonlyMap<string, Transient>): Rect {
  const t = transient.get(card.id)
  return { x: t?.x ?? card.x, y: t?.y ?? card.y, w: card.w, h: card.h }
}

/** The two paths of the overview: every line, and every end (arrow heads and bars), each as one `d`. */
export function overviewPaths(
  connections: readonly ConnectionVM[],
  cards: ReadonlyMap<string, CardVM>,
  transient: ReadonlyMap<string, Transient>,
): { lines: string; caps: string } {
  const lines: string[] = []
  const caps: string[] = []
  for (const c of connections) {
    const a = cards.get(c.from)
    const b = cards.get(c.to)
    if (!a || !b) continue
    const r = route(rectOf(a, transient), rectOf(b, transient))
    lines.push(r.d)
    if (c.kind === 'directed') caps.push(arrowPath(r.end))
    else if (c.kind === 'contradicts') caps.push(barPath(r.start, 1), barPath(r.end, -1))
  }
  return { lines: lines.join(' '), caps: caps.join(' ') }
}
