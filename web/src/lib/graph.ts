// The Branch Graph: the shape of every Branch from `GET /api/graph`, its layout, its words (loaded lazily, see
// graph-text.ts), and staying current (branch-graph.md §1 "Staying current").
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import { ACTIVITY_GAP_MS, groupShapes } from './activities'
import type { BoardSync, SyncEvent } from './board-sync'
import { sync } from './board-sync'
import { branchesStore } from './branches-store'
import { layoutGraph } from './graph-layout'
import { createGraphText } from './graph-text'
import type { Requester } from './graph-text'
import { ApiError, request as httpRequest } from './http'
import { sessionStore } from './session-store'
import type { BranchInfo, Change, Checkpoint, GraphActivity, GraphChangeLine, GraphResponse, GraphSnapshot, SessionSnapshot } from './types'

/** The `gap_ms` the client sends: History's constant, so the number lives in one place. */
export const GRAPH_GAP_MS = ACTIVITY_GAP_MS

/**
 * The graph with Changes the open Branch gained since: `changes` are the Changes `(fromSeq, fromSeq + n]` of Branch
 * `branchId`. Grouped by the same rule as the server's, so the result equals a fresh `GET /api/graph` — except that a
 * Restore or Merge batch split over two calls becomes two Activities (the server never sends one that way).
 * Returns `graph` itself when it already has those Changes, and null when they do not follow on from what it has
 * (fetch again) or the Branch is not in it.
 */
export function extendGraph(
  graph: GraphResponse,
  branchId: string,
  fromSeq: number,
  changes: readonly Change[],
  gapMs: number = GRAPH_GAP_MS,
): GraphResponse | null {
  const bi = graph.branches.findIndex((b) => b.id === branchId)
  if (bi < 0) return null
  const b = graph.branches[bi]!
  const end = fromSeq + changes.length
  if (end <= b.seq) return graph
  if (fromSeq > b.seq) return null
  const fresh = changes.slice(b.seq - fromSeq)
  if (fresh.length === 0) return graph
  const acts = b.activities.slice()
  const cuts = b.checkpoints.map((c) => c.seq)
  const last = acts[acts.length - 1]
  const first = fresh[0]!
  // The last Activity goes on when the first new Change would have joined it on the server.
  const joins =
    last !== undefined &&
    last.kind === 'edit' &&
    first.origin === 'Edit' &&
    first.author === last.author &&
    first.at - last.ended_at <= gapMs &&
    !cuts.includes(b.seq)
  const shapes = groupShapes(fresh, cuts, { gapMs, startSeq: b.seq })
  if (joins) {
    const head = shapes[0]!
    acts[acts.length - 1] = { ...last, to_seq: head.toSeq, ended_at: head.endedAt }
    shapes.shift()
  }
  for (const s of shapes) {
    const a: GraphActivity = {
      kind: s.kind,
      author: s.author,
      from_seq: s.fromSeq,
      to_seq: s.toSeq,
      started_at: s.startedAt,
      ended_at: s.endedAt,
    }
    if (s.source) a.source = s.source
    if (s.to !== undefined) a.to = s.to
    acts.push(a)
  }
  const branches = graph.branches.slice()
  branches[bi] = { ...b, seq: end, activities: acts }
  return { branches }
}

export type GraphOptions = {
  request?: Requester
  /** Where the window's `focus` is heard; default `window` when there is one. null: never. */
  focusTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  branches?: StoreApi<{ branches: BranchInfo[] }>
  session?: StoreApi<SessionSnapshot>
  gapMs?: number
}

const IDLE: GraphSnapshot = { status: 'idle', graph: null, layout: null }

export function createGraph(boardSync: BoardSync, options: GraphOptions = {}) {
  const request: Requester = options.request ?? httpRequest
  const gapMs = options.gapMs ?? GRAPH_GAP_MS
  const focusTarget =
    options.focusTarget !== undefined ? options.focusTarget : typeof window === 'undefined' ? null : window
  const branchList = options.branches ?? branchesStore
  const session = options.session ?? sessionStore
  const store = createStore<{ snapshot: GraphSnapshot }>(() => ({ snapshot: IDLE }))
  const text = createGraphText({ request })

  let opened = false
  let gen = 0
  let fetching: Promise<void> | null = null
  let again = false
  let stop: (() => void)[] = []

  function publish(next: GraphSnapshot) {
    store.setState({ snapshot: next })
  }

  function setGraph(graph: GraphResponse) {
    const prev = store.getState().snapshot
    if (prev.graph === graph && prev.status === 'ready') return
    publish({ status: 'ready', graph, layout: layoutGraph(graph) })
  }

  async function fetchOnce(g: number): Promise<void> {
    const sent = store.getState().snapshot.graph
    const got = await request<GraphResponse>('GET', `/api/graph?gap_ms=${gapMs}`)
    if (g !== gen) return
    // A Branch that gained Changes here while the request was on its way keeps them.
    const now = store.getState().snapshot.graph
    let graph = got
    if (now && now !== sent) {
      const mine = new Map(now.branches.map((b) => [b.id, b]))
      graph = {
        branches: got.branches.map((b) => {
          const m = mine.get(b.id)
          return m && m.seq > b.seq ? m : b
        }),
      }
    }
    setGraph(graph)
  }

  /** Fetches the graph again. One request at a time: asked again meanwhile, it fetches exactly once more after. */
  function refresh(): Promise<void> {
    if (!opened) return Promise.resolve()
    if (fetching) {
      again = true
      return fetching
    }
    const run = loop(gen)
    fetching = run
    run.then(
      () => {
        if (fetching === run) fetching = null
      },
      () => {
        if (fetching === run) fetching = null
      },
    )
    return run
  }

  async function loop(g: number): Promise<void> {
    do {
      again = false
      try {
        await fetchOnce(g)
      } catch (e) {
        if (g !== gen) return
        const prev = store.getState().snapshot
        const error = e instanceof Error ? e.message : String(e)
        publish({ ...prev, status: prev.graph ? 'ready' : 'error', error })
        if (!prev.graph) throw e
      }
    } while (again && g === gen)
  }

  function onSync(e: SyncEvent) {
    const graph = store.getState().snapshot.graph
    if (!opened || !graph) return
    if (e.type === 'checkpoint') {
      void refresh().catch(() => {}) // the Activity it falls in is split: its times come from the server
      return
    }
    const t = boardSync.internal.target()
    if (!t) return
    const next = e.changes.length > 0 ? extendGraph(graph, t.id, e.seq - e.changes.length, e.changes, gapMs) : null
    if (next) setGraph(next)
    else void refresh().catch(() => {})
  }

  function listen() {
    stop.push(boardSync.internal.listen(onSync))
    stop.push(
      boardSync.internal.watch((e) => {
        if (e.type === 'reconnected') void refresh().catch(() => {})
        if (e.type === 'opened') {
          // Another Branch is now open: its Changes are followed from here on; catch up if it moved.
          const t = boardSync.internal.target()
          const known = store.getState().snapshot.graph?.branches.find((b) => b.id === t?.id)
          if (t && (!known || known.seq !== t.seq)) void refresh().catch(() => {})
        }
      }),
    )
    // The `branches` frame (a Branch or a Merge was added), and every other new Branch list.
    stop.push(branchList.subscribe(() => void refresh().catch(() => {})))
    stop.push(
      session.subscribe((s) => {
        if (s.status === 'signed_out' || (s.status === 'signed_in' && s.member.role === 'guest')) close()
      }),
    )
    if (focusTarget) {
      const onFocus = () => void refresh().catch(() => {})
      focusTarget.addEventListener('focus', onFocus)
      stop.push(() => focusTarget.removeEventListener('focus', onFocus))
    }
  }

  /**
   * Loads the graph and keeps it current until `close()`. Called again while open, it fetches again (opening the
   * graph is when other Branches' new dots appear). Guests: rejects with 403 `forbidden` without a request.
   */
  async function open(): Promise<void> {
    if (isGuestOf(session.getState())) throw new ApiError(403, 'forbidden', 'Guests have no Branch Graph.')
    if (!opened) {
      opened = true
      gen++
      listen()
      publish({ ...store.getState().snapshot, status: store.getState().snapshot.graph ? 'ready' : 'loading' })
    }
    await refresh()
  }

  function close() {
    if (!opened) return
    opened = false
    gen++
    stop.forEach((f) => f())
    stop = []
    fetching = null
    again = false
    text.clear()
    publish(IDLE)
  }

  /** Works out the words of these rows of the current layout (those on screen and a margin). Never rejects. */
  function need(rows: readonly number[]): Promise<void> {
    const { graph, layout } = store.getState().snapshot
    if (!graph || !layout) return Promise.resolve()
    const wanted: { branch: string; index: number }[] = []
    for (const r of rows) {
      const row = layout.rows[r]
      if (row && row.index >= 0) wanted.push({ branch: row.branch, index: row.index })
    }
    return text.need(graph, wanted)
  }

  /** "Show every Change" of a row's Activity. Rejects with the ApiError; [] for the start row. */
  async function changesOf(row: number): Promise<GraphChangeLine[]> {
    const { graph, layout } = store.getState().snapshot
    const r = layout?.rows[row]
    const b = graph?.branches.find((x) => x.id === r?.branch)
    if (!r || !b || !r.activity) return []
    return text.changesOf(b, r.activity)
  }

  /**
   * "Add Checkpoint here": names the moment `seq` of any Branch (`POST …/checkpoints`), then fetches the graph again
   * so the dot gets its ◆ and its Activity is split there. When that Branch is open on the Board, the Board and
   * History hear of it at once. Throws ApiError (409 name_taken, 400); Guests 403 locally.
   */
  async function addCheckpoint(branchId: string, name: string, seq: number): Promise<Checkpoint> {
    if (isGuestOf(session.getState())) throw new ApiError(403, 'forbidden', 'Guests cannot add Checkpoints.')
    const { checkpoint } = await request<{ checkpoint: Checkpoint }>(
      'POST',
      `/api/branches/${encodeURIComponent(branchId)}/checkpoints`,
      { name, seq },
    )
    const t = boardSync.internal.target()
    if (t && t.id === branchId) boardSync.internal.checkpoints(t.token, [checkpoint], false)
    await refresh().catch(() => {})
    return checkpoint
  }

  return {
    store,
    text,
    open,
    close,
    refresh,
    need,
    changesOf,
    addCheckpoint,
  }
}

function isGuestOf(s: SessionSnapshot): boolean {
  return s.status === 'signed_in' && s.member.role === 'guest'
}

const instance = createGraph(sync)

export const graph = {
  open: instance.open,
  close: instance.close,
  refresh: instance.refresh,
  need: instance.need,
  changesOf: instance.changesOf,
  addCheckpoint: instance.addCheckpoint,
}

/** The graph, its layout and status. The same object until something changes. */
export function useGraph(): GraphSnapshot {
  return useStore(instance.store, (s) => s.snapshot)
}

/** The words of one row (`GraphRow.key`): undefined until worked out (show author, time and a quiet placeholder). */
export function useGraphLines(key: string): string[] | undefined {
  return useStore(instance.text.store, (s) => s.lines.get(key))
}
