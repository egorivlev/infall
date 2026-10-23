// The Branch Graph's layout: which column each Branch gets and where each Activity's row goes. A pure function of
// the `GET /api/graph` response (docs/specs/branch-graph.md §1 "Columns", §3 "Web").
import type {
  GraphActivity,
  GraphBranch,
  GraphCheckpoint,
  GraphEdge,
  GraphLane,
  GraphLayout,
  GraphResponse,
  GraphRow,
  Moment,
} from './types'

/** The key of an Activity's row (and of its text): the same while the Activity is unchanged. */
export function activityKey(branch: string, a: GraphActivity): string {
  return `${branch}:${a.from_seq}:${a.to_seq}`
}

/** Index of the Activity of `acts` holding the moment `seq` (`from_seq < seq <= to_seq`); -1 for seq 0 or none. */
export function holderOf(acts: readonly GraphActivity[], seq: number): number {
  if (seq <= 0 || acts.length === 0) return -1
  let lo = 0
  let hi = acts.length - 1
  if (seq > acts[hi]!.to_seq) return hi // past the head: the newest dot
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (acts[mid]!.to_seq >= seq) hi = mid
    else lo = mid + 1
  }
  return lo
}

// A min-heap of [branch, activity] by (ended_at, branch order, activity index).
class Heap {
  private items: [number, number][] = []
  private readonly ended: (b: number, a: number) => number
  constructor(ended: (b: number, a: number) => number) {
    this.ended = ended
  }
  get size() {
    return this.items.length
  }
  private less(x: [number, number], y: [number, number]) {
    const ex = this.ended(x[0], x[1])
    const ey = this.ended(y[0], y[1])
    return ex !== ey ? ex < ey : x[0] !== y[0] ? x[0] < y[0] : x[1] < y[1]
  }
  push(item: [number, number]) {
    const h = this.items
    h.push(item)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(h[i]!, h[p]!)) break
      ;[h[i], h[p]] = [h[p]!, h[i]!]
      i = p
    }
  }
  pop(): [number, number] | undefined {
    const h = this.items
    const top = h[0]
    const last = h.pop()
    if (h.length > 0 && last) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r
        if (m === i) break
        ;[h[i], h[m]] = [h[m]!, h[i]!]
        i = m
      }
    }
    return top
  }
}

/**
 * Lays the graph out.
 *
 * Rows, newest first: every Activity of every Branch, by the time it ended; within one Branch always in the
 * Branch's own order, whatever the clocks say. A Branch's first dot also stays above the dot it was started from,
 * and a Merge above the dot it brought in. Below all of them is the start row: main at seq 0.
 *
 * Columns: main has column 0 for good. Every other Branch holds a column from its fork (the parent's dot holding
 * the moment it was started from) up to its newest dot — or, when that dot was merged into the parent, up to that
 * Merge. Branches are placed in the order of their forks, each in the lowest column free from its fork upwards, so a
 * column freed below a fork is reused and the graph is as wide as the most Branches being worked on at once.
 */
export function layoutGraph(graph: GraphResponse): GraphLayout {
  const branches = graph.branches
  const B = branches.length
  const indexOf = new Map<string, number>()
  branches.forEach((b, i) => indexOf.set(b.id, i))

  // The [branch, activity] a moment depends on: the dot holding it, or — at seq 0 — where that Branch started.
  const dep = (branch: string | undefined, seq: number): [number, number] | null => {
    for (let guard = 0; branch !== undefined && guard <= B; guard++) {
      const bi = indexOf.get(branch)
      if (bi === undefined) return null
      const b = branches[bi]!
      if (seq > 0) {
        const ai = holderOf(b.activities, seq)
        if (ai >= 0) return [bi, ai]
      }
      if (!b.parent) return null
      branch = b.parent.branch
      seq = b.parent.seq
    }
    return null
  }

  // ---- rows: a merge of the Branches' own orders, by end time, respecting forks and Merges ----
  const ended = (b: number, a: number) => branches[b]!.activities[a]!.ended_at
  // The first dot of another Branch this Activity must stay above and that is not placed yet: the dot its Branch
  // was started from (for its first Activity), the dot a Merge brought in.
  const crossDep = (b: number, a: number): [number, number] | null => {
    const br = branches[b]!
    const act = br.activities[a]!
    const unmet = (d: [number, number] | null) => d !== null && d[0] !== b && next[d[0]]! <= d[1]
    if (act.kind === 'merge' && act.source) {
      const d = dep(act.source.branch, act.source.seq)
      if (unmet(d)) return d
    }
    if (a === 0 && br.parent) {
      const d = dep(br.parent.branch, br.parent.seq)
      if (unmet(d)) return d
    }
    return null
  }
  const next = new Array<number>(B).fill(0) // next Activity to place, per Branch
  const placedAt: number[][] = branches.map((b) => new Array<number>(b.activities.length))
  const waiting = new Map<string, number[]>() // "b:a" → Branches whose next Activity waits for it
  const heap = new Heap(ended)
  const order: [number, number][] = [] // oldest first
  const offer = (b: number) => {
    const a = next[b]!
    if (a >= branches[b]!.activities.length) return
    const d = crossDep(b, a)
    if (d) {
      const k = `${d[0]}:${d[1]}`
      const list = waiting.get(k)
      if (list) list.push(b)
      else waiting.set(k, [b])
      return
    }
    heap.push([b, a])
  }
  for (let b = 0; b < B; b++) offer(b)
  let total = 0
  for (const b of branches) total += b.activities.length
  while (order.length < total) {
    let item = heap.pop()
    if (item && next[item[0]] !== item[1]) continue // already placed by the fallback below
    if (!item) {
      // Nothing is ready: only possible with a response that contradicts itself. Take the earliest next Activity.
      let best: [number, number] | null = null
      for (let b = 0; b < B; b++) {
        const a = next[b]!
        if (a >= branches[b]!.activities.length) continue
        if (!best || ended(b, a) < ended(best[0], best[1])) best = [b, a]
      }
      item = best!
    }
    const [b, a] = item
    placedAt[b]![a] = order.length + 1 // position from the bottom; 0 is the start row
    order.push(item)
    next[b] = a + 1
    offer(b)
    const woken = waiting.get(`${b}:${a}`)
    if (woken) {
      waiting.delete(`${b}:${a}`)
      for (const w of woken) if (next[w]! < branches[w]!.activities.length) offer(w)
    }
  }
  const n = order.length + 1 // with the start row
  const rowOfPos = (pos: number) => n - 1 - pos
  const startRow = n - 1

  // The row of the dot holding a moment (its Branch's fork point at seq 0, the start row for main).
  const rowOfMoment = (branch: string | undefined, seq: number): number => {
    const d = dep(branch, seq)
    return d ? rowOfPos(placedAt[d[0]]![d[1]]!) : startRow
  }

  // ---- lanes and columns ----
  const lanes: GraphLane[] = branches.map((b, bi) => {
    const forkRow = b.parent ? rowOfMoment(b.parent.branch, b.parent.seq) : startRow
    let forkExact = true
    if (b.parent) {
      const p = indexOf.get(b.parent.branch)
      const ai = p === undefined ? -1 : holderOf(branches[p]!.activities, b.parent.seq)
      forkExact = ai < 0 || branches[p!]!.activities[ai]!.to_seq === b.parent.seq
    }
    const rows: number[] = []
    for (let a = b.activities.length - 1; a >= 0; a--) rows.push(rowOfPos(placedAt[bi]![a]!))
    const lastRow = rows.length > 0 ? rows[0]! : forkRow
    return {
      branch: b.id,
      name: b.name,
      column: 0,
      ...(b.parent ? { parent: b.parent.branch } : {}),
      forkRow,
      forkExact,
      lastRow,
      topRow: lastRow,
      rows,
      startCheckpoints: b.checkpoints.filter((c) => c.seq === 0),
    }
  })
  // Where a Branch's last dot was merged into its parent, its line ends there.
  branches.forEach((b, i) => {
    const lane = lanes[i]!
    const p = b.parent ? indexOf.get(b.parent.branch) : undefined
    if (p === undefined || b.activities.length === 0) return
    const parent = branches[p]!
    const took = parent.activities.findIndex((a) => a.kind === 'merge' && a.source?.branch === b.id && a.source.seq === b.seq)
    if (took < 0) return
    const row = rowOfPos(placedAt[p]![took]!)
    if (row < lane.topRow) {
      lane.endsIn = row
      lane.topRow = row
    }
  })
  // main keeps column 0 for good. The others, from the lowest fork up, take the lowest column whose lines all end
  // strictly below their fork. `held[c]` is the highest row column c holds so far.
  const held: number[] = [-1]
  const byFork = lanes
    .map((lane, i) => ({ lane, i }))
    .filter((x) => x.i > 0)
    .sort((x, y) => y.lane.forkRow - x.lane.forkRow || x.i - y.i)
  for (const { lane } of byFork) {
    let c = 1
    while (c < held.length && held[c]! <= lane.forkRow) c++
    lane.column = c
    held[c] = lane.topRow
  }

  // ---- rows ----
  const rows: GraphRow[] = new Array(n)
  const main = branches[0]
  rows[startRow] = {
    key: 'start',
    kind: 'start',
    branch: main ? main.id : '',
    column: 0,
    index: -1,
    activity: null,
    moment: { branch: main ? main.id : '', seq: 0 },
    checkpoints: main ? main.checkpoints.filter((c) => c.seq === 0) : [],
    forks: [],
  }
  order.forEach(([b, a], k) => {
    const br = branches[b]!
    const act = br.activities[a]!
    const row: GraphRow = {
      key: activityKey(br.id, act),
      kind: act.kind,
      branch: br.id,
      column: lanes[b]!.column,
      index: a,
      activity: act,
      moment: { branch: br.id, seq: act.to_seq },
      checkpoints: checkpointsIn(br, act),
      forks: [],
    }
    if (act.kind === 'merge' && act.source) {
      const s = indexOf.get(act.source.branch)
      if (s !== undefined) {
        row.source = {
          row: rowOfMoment(act.source.branch, act.source.seq),
          column: lanes[s]!.column,
          branch: act.source.branch,
          seq: act.source.seq,
        }
      }
    }
    rows[rowOfPos(k + 1)] = row
  })
  lanes.forEach((lane) => {
    if (lane.parent !== undefined) rows[lane.forkRow]!.forks.push(lane.branch)
  })

  // ---- edges ----
  const edges: GraphEdge[] = []
  for (const lane of lanes) {
    if (lane.parent === undefined) continue
    const p = indexOf.get(lane.parent)
    const from = { row: lane.forkRow, column: p === undefined ? 0 : lanes[p]!.column }
    edges.push({ kind: 'fork', branch: lane.branch, from, to: { row: lane.forkRow, column: lane.column } })
  }
  rows.forEach((row, r) => {
    if (row.source) {
      edges.push({
        kind: 'merge',
        branch: row.branch,
        from: { row: row.source.row, column: row.source.column },
        to: { row: r, column: row.column },
      })
    }
  })

  return { columns: Math.max(held.length, 1), rows, lanes, edges }
}

function checkpointsIn(b: GraphBranch, a: GraphActivity): GraphCheckpoint[] {
  const out: GraphCheckpoint[] = []
  for (const c of b.checkpoints) if (c.seq > a.from_seq && c.seq <= a.to_seq) out.push(c)
  return out
}

/** The columns whose line passes through (or ends or starts on) `row`. */
export function linesAt(layout: GraphLayout, row: number): number[] {
  const out: number[] = []
  for (const lane of layout.lanes) if (lane.topRow <= row && row <= lane.forkRow && !out.includes(lane.column)) out.push(lane.column)
  return out.sort((a, b) => a - b)
}

/** The row of the dot holding `moment`: the Activity it falls in, or its Branch's fork point at seq 0. -1 if unknown. */
export function rowOf(layout: GraphLayout, moment: Moment): number {
  const lane = layout.lanes.find((l) => l.branch === moment.branch)
  if (!lane) return -1
  if (moment.seq <= 0) return lane.forkRow
  // `rows` is top first, so the Activities are newest first along it.
  let best = -1
  for (const r of lane.rows) {
    const a = layout.rows[r]!.activity!
    if (a.from_seq < moment.seq) {
      best = r
      break
    }
  }
  return best
}

/**
 * For ←/→: the dot on the neighbouring line (the nearest column to the left or right that has a line there) nearest
 * to `row`, preferring the same row, then the closest above or below. null when there is none on that side.
 */
export function nearestDot(layout: GraphLayout, row: number, direction: -1 | 1): number | null {
  const here = layout.rows[row]
  if (!here) return null
  const column = here.column
  let best: { row: number; column: number; distance: number } | null = null
  for (const lane of layout.lanes) {
    if (direction < 0 ? lane.column >= column : lane.column <= column) continue
    if (lane.rows.length === 0) continue
    for (const r of lane.rows) {
      const distance = Math.abs(r - row)
      const nearer =
        !best ||
        Math.abs(lane.column - column) < Math.abs(best.column - column) ||
        (lane.column === best.column && distance < best.distance)
      if (nearer) best = { row: r, column: lane.column, distance }
    }
  }
  return best ? best.row : null
}
