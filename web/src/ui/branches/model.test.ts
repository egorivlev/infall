import { describe, expect, it } from 'vitest'
import { layoutGraph } from '../../lib'
import type { GraphActivity, GraphResponse } from '../../lib'
import {
  buildDisplay,
  colourOf,
  firstName,
  linesWidth,
  moveSideways,
  moveVertical,
  place,
  rowsIn,
  selectFork,
  selectNow,
  selectRow,
  spokenName,
  windowOf,
  xOf,
} from './model'

const edit = (author: string, from: number, to: number, ended: number): GraphActivity => ({
  kind: 'edit',
  author,
  from_seq: from,
  to_seq: to,
  started_at: ended,
  ended_at: ended,
})

// main: (0,2] ◆cp, (2,4], (4,5]; exp from main at 2: (0,1], (1,3]; empty from main at 4, no Changes.
const G: GraphResponse = {
  branches: [
    {
      id: 'm',
      name: 'main',
      seq: 5,
      checkpoints: [{ name: 'cp', seq: 2, author: 'ana', at: 1500 }],
      activities: [edit('ana', 0, 2, 1000), edit('mei', 2, 4, 3000), edit('ana', 4, 5, 6000)],
    },
    {
      id: 'e',
      name: 'exp',
      seq: 3,
      parent: { branch: 'm', seq: 2 },
      checkpoints: [],
      activities: [edit('ana', 0, 1, 2000), edit('ana', 1, 3, 4000)],
    },
    { id: 'z', name: 'empty', seq: 0, parent: { branch: 'm', seq: 4 }, checkpoints: [], activities: [] },
  ],
}
const L = layoutGraph(G)
const keys = () => L.rows.map((r) => r.key)

describe('the rows as shown', () => {
  it('has the layout the rest of these tests rely on', () => {
    expect(keys()).toEqual(['m:4:5', 'e:1:3', 'm:2:4', 'e:0:1', 'm:0:2', 'start'])
    expect(L.lanes.map((l) => [l.name, l.column, l.forkRow, l.lastRow])).toEqual([
      ['main', 0, 5, 0],
      ['exp', 1, 4, 1],
      ['empty', 2, 2, 2],
    ])
  })

  it('puts a label row above the newest dot of each Branch (its fork point when it has no Changes)', () => {
    const d = buildDisplay(L)
    expect(d.items).toEqual([
      { kind: 'label', lane: 0 },
      { kind: 'row', row: 0 },
      { kind: 'label', lane: 1 },
      { kind: 'row', row: 1 },
      { kind: 'label', lane: 2 },
      { kind: 'row', row: 2 },
      { kind: 'row', row: 3 },
      { kind: 'row', row: 4 },
      { kind: 'row', row: 5 },
    ])
    expect([...d.at]).toEqual([1, 3, 5, 6, 7, 8])
    expect([...d.labelAt]).toEqual([0, 2, 4])
  })

  it('stacks several labels above one row left to right', () => {
    const g: GraphResponse = {
      branches: [
        { id: 'm', name: 'main', seq: 1, checkpoints: [], activities: [edit('ana', 0, 1, 1000)] },
        { id: 'b', name: 'b', seq: 0, parent: { branch: 'm', seq: 1 }, checkpoints: [], activities: [] },
        { id: 'a', name: 'a', seq: 0, parent: { branch: 'm', seq: 1 }, checkpoints: [], activities: [] },
      ],
    }
    const l = layoutGraph(g)
    const d = buildDisplay(l)
    expect(d.items.filter((i) => i.kind === 'label').map((i) => (i.kind === 'label' ? l.lanes[i.lane]!.column : -1))).toEqual([0, 1, 2])
    expect(d.items.at(-2)).toEqual({ kind: 'row', row: 0 })
  })

  it('knows the window of items for a scroll position, and the rows among them', () => {
    expect(windowOf(0, 100, 20, 1000, 2)).toEqual([0, 7])
    expect(windowOf(400, 100, 20, 1000, 2)).toEqual([18, 27])
    expect(windowOf(19_990, 100, 20, 1000, 2)).toEqual([997, 999])
    expect(windowOf(0, 100, 20, 0)).toEqual([0, -1])
    const d = buildDisplay(L)
    expect(rowsIn(d, 0, 2)).toEqual([0])
    expect(rowsIn(d, 3, 4, 1)).toEqual([1, 2])
    expect(rowsIn(d, 3, 4, 2)).toEqual([0, 1, 2, 3])
  })

  it('places columns and colours', () => {
    expect(linesWidth(1)).toBe(38)
    expect(linesWidth(3)).toBe(74)
    expect(xOf(0)).toBe(19)
    expect(xOf(2)).toBe(55)
    expect([0, 1, 2, 6, 7, 13].map(colourOf)).toEqual([0, 1, 2, 6, 1, 1])
  })
})

describe('selecting', () => {
  it('a row: its moment, and "follow" for the newest dot of its Branch', () => {
    expect(selectRow(L, 2)).toEqual({ key: 'm:2:4', moment: { branch: 'm', seq: 4 } })
    expect(selectRow(L, 0)).toEqual({ key: 'm:4:5', moment: { branch: 'm', seq: 5 }, follow: true })
    expect(selectRow(L, 4, 'cp')).toEqual({ key: 'm:0:2', moment: { branch: 'm', seq: 2 }, checkpoint: 'cp' })
    expect(selectRow(L, 4, 'nope')).toEqual({ key: 'm:0:2', moment: { branch: 'm', seq: 2 } })
    expect(selectRow(L, 5)).toEqual({ key: 'start', moment: { branch: 'm', seq: 0 } })
    expect(selectRow(L, 9)).toBeNull()
  })

  it('a fork point, and "now" on a Branch', () => {
    expect(selectFork(L, 2)).toEqual({ key: 'fork:z', moment: { branch: 'z', seq: 0 } })
    expect(selectNow(L, 'z')).toEqual({ key: 'fork:z', moment: { branch: 'z', seq: 0 } })
    expect(selectNow(L, 'e')).toEqual({ key: 'e:1:3', moment: { branch: 'e', seq: 3 }, follow: true })
    expect(selectNow(L, 'gone')).toBeNull()
  })

  it('finds a selection again on a new layout: by key, by the moment when its Activity changed, by Branch when following', () => {
    expect(place(L, selectRow(L, 2)!)).toEqual({ row: 2, moment: { branch: 'm', seq: 4 }, checkpoint: undefined })
    expect(place(L, selectFork(L, 2)!)).toEqual({ row: 2, fork: 2, moment: { branch: 'z', seq: 0 }, checkpoint: undefined })

    // A Checkpoint at 3 splits main's (2,4]: the dot holding the moment 4 is now (3,4].
    const split: GraphResponse = {
      branches: [
        {
          ...G.branches[0]!,
          checkpoints: [...G.branches[0]!.checkpoints, { name: 'mid', seq: 3, author: 'mei', at: 3500 }],
          activities: [edit('ana', 0, 2, 1000), edit('mei', 2, 3, 2900), edit('mei', 3, 4, 3000), edit('ana', 4, 5, 6000)],
        },
        G.branches[1]!,
        G.branches[2]!,
      ],
    }
    const l2 = layoutGraph(split)
    const p = place(l2, selectRow(L, 2)!)!
    expect(l2.rows[p.row]!.key).toBe('m:3:4')
    expect(p.moment).toEqual({ branch: 'm', seq: 4 })

    // main went on: "now" follows its newest dot.
    const on: GraphResponse = { branches: [{ ...G.branches[0]!, seq: 7, activities: [...G.branches[0]!.activities, edit('ana', 5, 7, 9000)] }, G.branches[1]!, G.branches[2]!] }
    const l3 = layoutGraph(on)
    const now = place(l3, selectRow(L, 0)!)!
    expect(l3.rows[now.row]!.key).toBe('m:5:7')
    expect(now.moment).toEqual({ branch: 'm', seq: 7 })

    expect(place(L, { key: 'x:0:1', moment: { branch: 'x', seq: 1 } })).toBeNull()
  })
})

describe('moving with the keyboard', () => {
  const at = (row: number) => place(L, selectRow(L, row)!)!

  it('↑ and ↓ go one row up or down and stop at the ends; from a fork point, from the row it sits on', () => {
    expect(moveVertical(L, at(2), -1)?.key).toBe('e:1:3')
    expect(moveVertical(L, at(2), 1)?.key).toBe('e:0:1')
    expect(moveVertical(L, at(0), -1)).toBeNull()
    expect(moveVertical(L, at(5), 1)).toBeNull()
    expect(moveVertical(L, place(L, selectFork(L, 2)!), -1)?.key).toBe('e:1:3')
    expect(moveVertical(L, place(L, selectFork(L, 2)!), 1)?.key).toBe('e:0:1')
    expect(moveVertical(L, null, 1)?.key).toBe('m:4:5')
  })

  it('← and → go to the nearest dot of the neighbouring line, the upper one on a tie, fork points included', () => {
    expect(moveSideways(L, at(2), 1)?.key).toBe('e:1:3') // rows 1 and 3 are as near: the upper
    expect(moveSideways(L, at(1), 1)?.key).toBe('fork:z')
    expect(moveSideways(L, place(L, selectFork(L, 2)!)!, -1)?.key).toBe('e:1:3')
    expect(moveSideways(L, at(1), -1)?.key).toBe('m:4:5')
    expect(moveSideways(L, at(4), 1)?.key).toBe('e:0:1')
    expect(moveSideways(L, at(4), -1)).toBeNull()
    expect(moveSideways(L, place(L, selectFork(L, 2)!)!, 1)).toBeNull()
  })
})

describe('words', () => {
  it('speaks a dot: Branch, who, when, the first line or "loading", and its Checkpoints', () => {
    expect(spokenName({ branch: 'main', who: 'Ana Ruiz', when: '13:50', first: 'Added Card Axions', checkpoints: ['before-review'] })).toBe(
      'main, Ana Ruiz, 13:50, Added Card Axions, Checkpoint before-review',
    )
    expect(spokenName({ branch: 'exp-A', who: 'Ana Ruiz', when: '12 Nov, 13:50', checkpoints: [] })).toBe('exp-A, Ana Ruiz, 12 Nov, 13:50, loading')
    expect(firstName('  Ana   Ruiz ')).toBe('Ana')
  })
})
