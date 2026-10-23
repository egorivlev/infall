// The Branch Graph's words, worked out lazily: only for the rows asked for (those on screen and a margin), from one
// Board and one range of Changes per Branch, run forward with `describeChanges` (branch-graph.md §3 "Text lazily").
import { createStore } from 'zustand/vanilla'
import { describeChanges, MAX_LINES, replay } from './activities'
import type { Entities } from './board-state'
import { activityKey } from './graph-layout'
import { request as httpRequest } from './http'
import type { BoardResponse, Change, ChangesResponse, GraphActivity, GraphBranch, GraphChangeLine, GraphResponse } from './types'

export type Requester = <T>(method: string, path: string, body?: unknown) => Promise<T>

export type GraphTextOptions = {
  request?: Requester
  maxLines?: number // default 6, as History
  /** How many Changes past what is already known are read rather than fetching a Board again. Default 2000. */
  reach?: number
}

/** The words of one Activity, as History says them; a Merge names both Branches first. */
export function activityLines(
  graph: GraphResponse,
  branch: GraphBranch,
  activity: GraphActivity,
  before: Entities,
  after: Entities,
  changes: readonly Change[],
  maxLines = MAX_LINES,
): string[] {
  if (activity.kind === 'restore') return ['Restored to an earlier moment']
  if (activity.kind === 'merge') {
    const source = graph.branches.find((b) => b.id === activity.source?.branch)
    const head = `Merged ${source ? source.name : 'another Branch'} into ${branch.name}`
    const said = describeChanges(before, after, changes, Math.max(maxLines - 1, 1))
    return [head, ...said]
  }
  return describeChanges(before, after, changes, maxLines)
}

const path = (branch: string) => `/api/branches/${encodeURIComponent(branch)}`

export function createGraphText(options: GraphTextOptions = {}) {
  const request: Requester = options.request ?? httpRequest
  const maxLines = options.maxLines ?? MAX_LINES
  const reach = options.reach ?? 2000
  const store = createStore<{ lines: ReadonlyMap<string, string[]> }>(() => ({ lines: new Map() }))
  let gen = 0
  const pending = new Set<string>()
  // Per Branch: the Board at the furthest moment worked out so far, to go on from without another Board.
  const frontier = new Map<string, { seq: number; entities: Entities }>()

  async function loadRange(graph: GraphResponse, b: GraphBranch, lo: number, hi: number, g: number): Promise<void> {
    const acts = b.activities
    const from = acts[lo]!.from_seq
    const to = acts[hi]!.to_seq
    const known = frontier.get(b.id)
    const fromKnown = known !== undefined && known.seq <= from && from - known.seq <= reach
    const start = fromKnown ? known.seq : from
    const keys: string[] = []
    for (let i = lo; i <= hi; i++) {
      const k = activityKey(b.id, acts[i]!)
      if (!store.getState().lines.has(k) && !pending.has(k)) keys.push(k)
    }
    keys.forEach((k) => pending.add(k))
    try {
      const [board, log] = await Promise.all([
        fromKnown ? Promise.resolve(null) : request<BoardResponse>('GET', `${path(b.id)}/board?at=${start}`),
        request<ChangesResponse>('GET', `${path(b.id)}/changes?after=${start}&before=${to}`),
      ])
      if (g !== gen) return
      const changes = log.changes
      let world: Entities = board ? board.entities : known!.entities
      let seq = start
      const found = new Map<string, string[]>()
      for (let i = lo; i <= hi; i++) {
        const a = acts[i]!
        if (a.from_seq > seq) world = replay(world, changes.slice(seq - start, a.from_seq - start).map((c) => c.op))
        const run = changes.slice(a.from_seq - start, a.to_seq - start)
        const before = world
        world = replay(world, run.map((c) => c.op))
        seq = a.to_seq
        const k = activityKey(b.id, a)
        if (!store.getState().lines.has(k)) found.set(k, activityLines(graph, b, a, before, world, run, maxLines))
      }
      const prev = frontier.get(b.id)
      if (!prev || prev.seq < seq) frontier.set(b.id, { seq, entities: world })
      if (found.size > 0) {
        const next = new Map(store.getState().lines)
        found.forEach((v, k) => next.set(k, v))
        store.setState({ lines: next })
      }
    } catch {
      // Left without words; asked for again, it is tried again.
    } finally {
      if (g === gen) keys.forEach((k) => pending.delete(k))
    }
  }

  /**
   * Works out the words of the given Activities (`index` into their Branch's `activities`) that are not known yet:
   * per Branch, one Board at the earliest of them (none when the moment is a little past what is already known) and
   * one range of Changes up to the latest. Never rejects; what failed is simply not known.
   */
  async function need(graph: GraphResponse, wanted: readonly { branch: string; index: number }[]): Promise<void> {
    const lines = store.getState().lines
    const byBranch = new Map<string, number[]>()
    for (const w of wanted) {
      const b = graph.branches.find((x) => x.id === w.branch)
      const a = b?.activities[w.index]
      if (!b || !a) continue
      const k = activityKey(b.id, a)
      if (lines.has(k) || pending.has(k)) continue
      const list = byBranch.get(b.id)
      if (list) list.push(w.index)
      else byBranch.set(b.id, [w.index])
    }
    const g = gen
    const work: Promise<void>[] = []
    byBranch.forEach((indices, id) => {
      const b = graph.branches.find((x) => x.id === id)!
      work.push(loadRange(graph, b, Math.min(...indices), Math.max(...indices), g))
    })
    await Promise.all(work)
  }

  /** "Show every Change": each Change of the Activity in one line of plain words, in order. Rejects with the ApiError. */
  async function changesOf(branch: GraphBranch, activity: GraphActivity): Promise<GraphChangeLine[]> {
    const [board, log] = await Promise.all([
      request<BoardResponse>('GET', `${path(branch.id)}/board?at=${activity.from_seq}`),
      request<ChangesResponse>('GET', `${path(branch.id)}/changes?after=${activity.from_seq}&before=${activity.to_seq}`),
    ])
    let world = board.entities
    return log.changes.map((c) => {
      const before = world
      world = replay(world, [c.op])
      return { id: c.id, author: c.author, at: c.at, line: describeChanges(before, world, [c], Infinity).join('; ') }
    })
  }

  function clear() {
    gen++
    pending.clear()
    frontier.clear()
    if (store.getState().lines.size > 0) store.setState({ lines: new Map() })
  }

  return {
    store,
    need,
    changesOf,
    clear,
    lines: (key: string) => store.getState().lines.get(key),
  }
}

export type GraphText = ReturnType<typeof createGraphText>
