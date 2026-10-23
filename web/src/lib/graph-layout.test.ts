import { describe, expect, it } from 'vitest'
import { activityKey, holderOf, layoutGraph, linesAt, nearestDot, rowOf } from './graph-layout'
import type { GraphActivity, GraphBranch, GraphCheckpoint, GraphLayout, GraphResponse, Moment } from './types'

const MIN = 60_000

function act(kind: GraphActivity['kind'], from: number, to: number, ended: number, extra: Partial<GraphActivity> = {}): GraphActivity {
  return { kind, author: 'ana', from_seq: from, to_seq: to, started_at: ended, ended_at: ended, ...extra }
}
const edit = (from: number, to: number, ended: number, author = 'ana') => act('edit', from, to, ended, { author })
const mergeOf = (from: number, to: number, ended: number, source: Moment) => act('merge', from, to, ended, { source })
const cp = (name: string, seq: number): GraphCheckpoint => ({ name, seq, author: 'ana', at: 0 })

function branch(id: string, activities: GraphActivity[], parent?: Moment, checkpoints: GraphCheckpoint[] = []): GraphBranch {
  const b: GraphBranch = { id, name: id, seq: activities.at(-1)?.to_seq ?? 0, checkpoints, activities }
  if (parent) b.parent = parent
  return b
}
const graphOf = (...branches: GraphBranch[]): GraphResponse => ({ branches })

/** Rows top first as "branch:to_seq" ("start" for the start row). */
const order = (l: GraphLayout) => l.rows.map((r) => (r.kind === 'start' ? 'start' : `${r.branch}:${r.moment.seq}`))
const lane = (l: GraphLayout, id: string) => l.lanes.find((x) => x.branch === id)!
const rowAt = (l: GraphLayout, b: string, seq: number) => l.rows.findIndex((r) => r.branch === b && r.moment.seq === seq && r.kind !== 'start')

describe('holderOf', () => {
  const acts = [edit(0, 2, 1), edit(2, 5, 2), edit(5, 6, 3)]
  it('finds the Activity whose (from_seq, to_seq] holds a moment', () => {
    expect([1, 2, 3, 5, 6].map((s) => holderOf(acts, s))).toEqual([0, 0, 1, 1, 2])
  })
  it('has none at seq 0, and takes the newest past the head', () => {
    expect(holderOf(acts, 0)).toBe(-1)
    expect(holderOf([], 3)).toBe(-1)
    expect(holderOf(acts, 99)).toBe(2)
  })
})

describe('layoutGraph: rows', () => {
  it('lays out a lone main newest first, with the start row last', () => {
    const l = layoutGraph(graphOf(branch('main', [edit(0, 2, 10), edit(2, 3, 20, 'egor')], undefined, [cp('zero', 0)])))
    expect(order(l)).toEqual(['main:3', 'main:2', 'start'])
    expect(l.columns).toBe(1)
    expect(l.rows[0]).toMatchObject({ kind: 'edit', branch: 'main', column: 0, index: 1, moment: { branch: 'main', seq: 3 } })
    expect(l.rows[0]!.key).toBe(activityKey('main', l.rows[0]!.activity!))
    expect(l.rows[2]).toMatchObject({ key: 'start', kind: 'start', index: -1, activity: null, moment: { branch: 'main', seq: 0 } })
    expect(l.rows[2]!.checkpoints.map((c) => c.name)).toEqual(['zero'])
    expect(lane(l, 'main')).toMatchObject({ column: 0, forkRow: 2, lastRow: 0, topRow: 0, rows: [0, 1] })
    expect(l.edges).toEqual([])
  })
  it('gives an empty Workspace only the start row', () => {
    const l = layoutGraph(graphOf(branch('main', [])))
    expect(order(l)).toEqual(['start'])
    expect(lane(l, 'main')).toMatchObject({ forkRow: 0, lastRow: 0, topRow: 0, rows: [] })
  })
  it('orders rows across Branches by end time: the example of the spec', () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 9 * 60 * MIN, 'egor'), edit(1, 2, 11 * 60 * MIN), edit(2, 3, 13 * 60 * MIN + 50 * MIN)], undefined, [
        cp('before-review', 2),
      ]),
      branch('exp-A', [edit(0, 3, 13 * 60 * MIN + 20 * MIN, 'egor'), edit(3, 5, 14 * 60 * MIN + 7 * MIN, 'egor')], { branch: 'main', seq: 2 }),
    )
    const l = layoutGraph(g)
    expect(order(l)).toEqual(['exp-A:5', 'main:3', 'exp-A:3', 'main:2', 'main:1', 'start'])
    expect(l.rows.map((r) => r.column)).toEqual([1, 0, 1, 0, 0, 0])
    expect(l.columns).toBe(2)
    expect(l.rows[3]!.checkpoints.map((c) => c.name)).toEqual(['before-review'])
    expect(l.rows[3]!.forks).toEqual(['exp-A'])
    expect(lane(l, 'exp-A')).toMatchObject({ column: 1, parent: 'main', forkRow: 3, forkExact: true, lastRow: 0, topRow: 0, rows: [0, 2] })
    expect(l.edges).toEqual([{ kind: 'fork', branch: 'exp-A', from: { row: 3, column: 0 }, to: { row: 3, column: 1 } }])
  })
  it("keeps a Branch's own order whatever the clocks say", () => {
    const g = graphOf(branch('main', [edit(0, 1, 50), edit(1, 2, 10, 'egor'), edit(2, 3, 30)]), branch('x', [edit(0, 1, 20)], { branch: 'main', seq: 0 }))
    const l = layoutGraph(g)
    expect(order(l)).toEqual(['main:3', 'main:2', 'main:1', 'x:1', 'start'])
  })
  it("keeps a Branch's first dot above the dot it was started from, and a Merge above its source", () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 100), mergeOf(1, 2, 5, { branch: 'x', seq: 1 })]),
      branch('x', [edit(0, 1, 1)], { branch: 'main', seq: 1 }), // a clock far behind
    )
    const l = layoutGraph(g)
    expect(order(l)).toEqual(['main:2', 'x:1', 'main:1', 'start'])
    expect(l.rows[0]!.source).toEqual({ row: 1, column: 1, branch: 'x', seq: 1 })
  })
  it('breaks ties in end time by Branch order, then by the Branch own order', () => {
    const g = graphOf(branch('main', [edit(0, 1, 7)]), branch('x', [edit(0, 1, 7)], { branch: 'main', seq: 0 }))
    expect(order(layoutGraph(g))).toEqual(['x:1', 'main:1', 'start'])
  })
})

describe('layoutGraph: forks, Merges, Checkpoints', () => {
  it('ends a line in its parent where its last dot was merged into it, and draws both Merges', () => {
    const g = graphOf(
      branch('main', [edit(0, 2, 10), edit(2, 3, 20), mergeOf(3, 5, 50, { branch: 'exp', seq: 4 }), edit(5, 6, 60)]),
      branch('exp', [mergeOf(0, 1, 25, { branch: 'main', seq: 3 }), edit(1, 4, 40)], { branch: 'main', seq: 2 }),
    )
    const l = layoutGraph(g)
    expect(order(l)).toEqual(['main:6', 'main:5', 'exp:4', 'exp:1', 'main:3', 'main:2', 'start'])
    expect(lane(l, 'exp')).toMatchObject({ column: 1, forkRow: 5, lastRow: 2, topRow: 1, endsIn: 1, rows: [2, 3] })
    expect(l.rows[1]!.source).toEqual({ row: 2, column: 1, branch: 'exp', seq: 4 }) // Merge into the parent
    expect(l.rows[3]!.source).toEqual({ row: 4, column: 0, branch: 'main', seq: 3 }) // Update from the parent
    expect(l.edges.filter((e) => e.kind === 'merge')).toEqual([
      { kind: 'merge', branch: 'main', from: { row: 2, column: 1 }, to: { row: 1, column: 0 } },
      { kind: 'merge', branch: 'exp', from: { row: 4, column: 0 }, to: { row: 3, column: 1 } },
    ])
  })
  it('does not end the line in the parent for a Merge of an earlier dot', () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 10), mergeOf(1, 2, 30, { branch: 'exp', seq: 1 })]),
      branch('exp', [edit(0, 1, 20), edit(1, 2, 40)], { branch: 'main', seq: 1 }),
    )
    const l = layoutGraph(g)
    expect(lane(l, 'exp').endsIn).toBeUndefined()
    expect(lane(l, 'exp').topRow).toBe(lane(l, 'exp').lastRow)
  })
  it('reuses a column freed below a fork, so the width is what was worked on at once', () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 10), mergeOf(1, 2, 40, { branch: 'a', seq: 1 }), edit(2, 3, 50), edit(3, 4, 90)]),
      branch('a', [edit(0, 1, 30)], { branch: 'main', seq: 1 }),
      branch('b', [edit(0, 1, 60)], { branch: 'main', seq: 3 }), // after a ended in main
      branch('c', [edit(0, 1, 70)], { branch: 'main', seq: 3 }), // at the same time as b
    )
    const l = layoutGraph(g)
    expect([lane(l, 'a').column, lane(l, 'b').column, lane(l, 'c').column]).toEqual([1, 1, 2])
    expect(l.columns).toBe(3)
  })
  it('does not reuse a column on the very row where a line ends in its parent', () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 10), mergeOf(1, 2, 40, { branch: 'a', seq: 1 })]),
      branch('a', [edit(0, 1, 30)], { branch: 'main', seq: 1 }),
      branch('b', [], { branch: 'main', seq: 2 }), // forked from the Merge's dot itself
    )
    const l = layoutGraph(g)
    expect(lane(l, 'b').forkRow).toBe(lane(l, 'a').endsIn)
    expect(lane(l, 'b').column).toBe(2)
  })
  it('places a Branch without Changes at its fork point, each in its own column', () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 10), edit(1, 2, 20, 'egor')]),
      branch('e1', [], { branch: 'main', seq: 1 }, [cp('e1-start', 0)]),
      branch('e2', [], { branch: 'main', seq: 1 }),
    )
    const l = layoutGraph(g)
    const r = rowAt(l, 'main', 1)
    expect(lane(l, 'e1')).toMatchObject({ forkRow: r, lastRow: r, topRow: r, rows: [] })
    expect(lane(l, 'e1').startCheckpoints.map((c) => c.name)).toEqual(['e1-start'])
    expect([lane(l, 'e1').column, lane(l, 'e2').column]).toEqual([1, 2])
    expect(l.rows[r]!.forks).toEqual(['e1', 'e2'])
    expect(order(l)).toEqual(['main:2', 'main:1', 'start'])
  })
  it('starts a Branch forked from main at seq 0 on the start row, and one forked from a fork point on its grandparent', () => {
    const g = graphOf(
      branch('main', [edit(0, 1, 10)]),
      branch('x', [], { branch: 'main', seq: 0 }),
      branch('y', [], { branch: 'main', seq: 1 }),
      branch('z', [edit(0, 1, 20)], { branch: 'y', seq: 0 }),
    )
    const l = layoutGraph(g)
    expect(lane(l, 'x').forkRow).toBe(l.rows.length - 1)
    expect(l.rows.at(-1)!.forks).toEqual(['x'])
    expect(lane(l, 'z').forkRow).toBe(rowAt(l, 'main', 1))
    expect(l.edges.find((e) => e.branch === 'z')).toMatchObject({ kind: 'fork', from: { column: lane(l, 'y').column } })
  })
  it('says when a Branch was started partway through its parent Activity', () => {
    const g = graphOf(branch('main', [edit(0, 5, 10)]), branch('x', [edit(0, 1, 20)], { branch: 'main', seq: 3 }))
    const l = layoutGraph(g)
    expect(lane(l, 'x')).toMatchObject({ forkRow: 1, forkExact: false })
  })
  it('puts each Checkpoint on the dot it ends, and leaves a Merge from an unknown Branch without a source', () => {
    const g = graphOf(branch('main', [edit(0, 2, 10), mergeOf(2, 3, 20, { branch: 'gone', seq: 4 })], undefined, [cp('a', 2), cp('b', 2), cp('c', 3)]))
    const l = layoutGraph(g)
    expect(l.rows.map((r) => r.checkpoints.map((c) => c.name))).toEqual([['c'], ['a', 'b'], []])
    expect(l.rows[0]!.source).toBeUndefined()
    expect(l.edges).toEqual([])
  })
})

describe('linesAt, rowOf, nearestDot', () => {
  const g = graphOf(
    branch('main', [edit(0, 1, 10), edit(1, 2, 20, 'egor'), edit(2, 3, 50)]),
    branch('a', [edit(0, 2, 30), edit(2, 3, 40, 'egor')], { branch: 'main', seq: 2 }),
    branch('b', [edit(0, 1, 60)], { branch: 'main', seq: 1 }),
  )
  const l = layoutGraph(g)
  it('lays the example out as expected: the lower fork takes the lower column', () => {
    expect(order(l)).toEqual(['b:1', 'main:3', 'a:3', 'a:2', 'main:2', 'main:1', 'start'])
    expect([lane(l, 'a').column, lane(l, 'b').column]).toEqual([2, 1])
  })
  it('linesAt gives the columns with a line on a row; main too stops at its newest dot', () => {
    expect(linesAt(l, 0)).toEqual([1])
    expect(linesAt(l, 2)).toEqual([0, 1, 2])
    expect(linesAt(l, 5)).toEqual([0, 1])
    expect(linesAt(l, 6)).toEqual([0])
  })
  it('rowOf finds the dot holding a moment, the fork point at seq 0, -1 for an unknown Branch', () => {
    expect(rowOf(l, { branch: 'a', seq: 1 })).toBe(3)
    expect(rowOf(l, { branch: 'a', seq: 3 })).toBe(2)
    expect(rowOf(l, { branch: 'a', seq: 0 })).toBe(4)
    expect(rowOf(l, { branch: 'main', seq: 0 })).toBe(6)
    expect(rowOf(l, { branch: 'nope', seq: 1 })).toBe(-1)
  })
  it('nearestDot moves to the nearest dot of the neighbouring line', () => {
    expect(nearestDot(l, 1, 1)).toBe(0) // main:3 → b, the line just right, its only dot
    expect(nearestDot(l, 0, 1)).toBe(2) // b:1 → a's nearest dot
    expect(nearestDot(l, 0, -1)).toBe(1) // b:1 → main's nearest dot
    expect(nearestDot(l, 3, -1)).toBe(0) // a:2 → b, even far away
    expect(nearestDot(l, 2, 1)).toBeNull()
    expect(nearestDot(l, 5, -1)).toBeNull()
    expect(nearestDot(l, 99, 1)).toBeNull()
  })
})

/** A big Workspace's graph: `n` Changes in Activities of ~10 over `branches` Branches with Merges both ways. */
function bigGraph(n: number, branches: number): GraphResponse {
  let seed = 11
  const rnd = (m: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % m
  }
  const list: GraphBranch[] = [branch('main', [])]
  const perBranch = Math.floor(n / branches)
  let clock = 0
  const grow = (b: GraphBranch, count: number) => {
    let seq = b.seq
    const until = seq + count
    while (seq < until) {
      const size = Math.min(1 + rnd(19), until - seq)
      clock += 1 + rnd(5 * MIN)
      const parent = b.parent ? list.find((x) => x.id === b.parent!.branch) : undefined
      if (parent && rnd(15) === 0 && parent.seq > 0) {
        b.activities.push(mergeOf(seq, seq + size, clock, { branch: parent.id, seq: parent.seq }))
      } else b.activities.push(edit(seq, seq + size, clock, ['ana', 'egor', 'mei'][rnd(3)]))
      seq += size
      b.seq = seq
      if (rnd(40) === 0) b.checkpoints.push(cp(`${b.id}-${seq}`, seq))
    }
  }
  grow(list[0]!, perBranch)
  for (let i = 1; i < branches; i++) {
    const parent = list[rnd(Math.min(list.length, 4))]!
    const b = branch(`b${i}`, [], { branch: parent.id, seq: rnd(parent.seq + 1) })
    list.push(b)
    grow(b, Math.floor(perBranch / 2))
    grow(list[0]!, Math.floor(perBranch / 4))
    grow(b, Math.floor(perBranch / 2))
    if (rnd(2) === 0) {
      clock += 1000
      list[0]!.activities.push(mergeOf(list[0]!.seq, list[0]!.seq + 3, clock, { branch: b.id, seq: b.seq }))
      list[0]!.seq += 3
    }
  }
  return { branches: list }
}

describe('layoutGraph at scale', () => {
  it('lays out 50 000 Changes in thousands of Activities quickly, and sanely', () => {
    const g = bigGraph(50_000, 60)
    const changes = g.branches.reduce((n, b) => n + b.seq, 0)
    const activities = g.branches.reduce((n, b) => n + b.activities.length, 0)
    expect(changes).toBeGreaterThanOrEqual(50_000)
    layoutGraph(g) // warm up
    const t0 = performance.now()
    const l = layoutGraph(g)
    const ms = performance.now() - t0
    process.stderr.write(`layoutGraph: ${changes} Changes, ${activities} Activities, ${g.branches.length} Branches, ${l.columns} columns: ${ms.toFixed(1)} ms\n`)
    expect(ms).toBeLessThan(250)
    expect(l.rows).toHaveLength(activities + 1)
    // Every Branch's own order holds, every first dot is above its fork, every Merge above its source.
    for (const lane of l.lanes) {
      for (let i = 1; i < lane.rows.length; i++) expect(lane.rows[i - 1]!).toBeLessThan(lane.rows[i]!)
      if (lane.rows.length > 0) expect(lane.rows.at(-1)!).toBeLessThan(lane.forkRow)
    }
    l.rows.forEach((r, i) => {
      if (r.source) expect(i).toBeLessThan(r.source.row)
    })
    // No two lines share a column on any row.
    const byColumn = new Map<number, [number, number][]>()
    for (const lane of l.lanes) {
      const list = byColumn.get(lane.column) ?? []
      for (const [top, bottom] of list) expect(lane.topRow > bottom || lane.forkRow < top).toBe(true)
      list.push([lane.topRow, lane.forkRow])
      byColumn.set(lane.column, list)
    }
    expect(l.columns).toBeLessThan(g.branches.length)
  })
})
