import { describe, expect, it } from 'vitest'
import type { CardVM, ConnectionVM } from '../../../lib'
import { arrowPath, barPath, route } from '../geometry'
import { overviewPaths } from './overview'

const card = (id: string, x: number, y: number): CardVM => ({ id, title: id, summary: '', status: 'idea', x, y, w: 224, h: 132, blocks: 0, sources: 0 })
const conn = (id: string, from: string, to: string, kind: ConnectionVM['kind']): ConnectionVM => ({ id, from, to, kind, label: '' })

describe('overviewPaths', () => {
  const a = card('a', 0, 0)
  const b = card('b', 600, 0)
  const c = card('c', 0, 500)
  const cards = new Map([a, b, c].map((x) => [x.id, x]))

  it('draws the same lines and ends as the Connections one by one', () => {
    const p = overviewPaths([conn('1', 'a', 'b', 'related'), conn('2', 'a', 'c', 'directed'), conn('3', 'b', 'c', 'contradicts')], cards, new Map())
    const ab = route(a, b)
    const ac = route(a, c)
    const bc = route(b, c)
    expect(p.lines).toBe([ab.d, ac.d, bc.d].join(' '))
    expect(p.caps).toBe([arrowPath(ac.end), barPath(bc.start, 1), barPath(bc.end, -1)].join(' '))
  })

  it('follows a Card being dragged and leaves out a Connection whose Card is gone', () => {
    const moved = new Map([['b', { x: 900, y: 40 }]])
    const p = overviewPaths([conn('1', 'a', 'b', 'related'), conn('2', 'a', 'gone', 'related')], cards, moved)
    expect(p.lines).toBe(route(a, { ...b, x: 900, y: 40 }).d)
    expect(p.caps).toBe('')
  })
})
