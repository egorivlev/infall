// History of the Branch the Board has open: its Changes read as Activities, its Checkpoints, and a preview of
// the Board at an earlier moment. Loaded once over HTTP, then kept current by what the Board layer confirms.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { byMoment, groupActivities, replay } from './activities'
import type { Entities, SnapshotParts } from './board-state'
import { toSnapshotParts } from './board-state'
import type { BoardSync, SyncEvent } from './board-sync'
import { sync } from './board-sync'
import { isGuest } from './branches-store'
import { ApiError, request } from './http'
import type {
  Activity,
  BoardPreview,
  BoardResponse,
  BoardStatus,
  Change,
  ChangesResponse,
  Checkpoint,
  HistorySnapshot,
} from './types'

export { groupActivities, describeChanges, replay, ACTIVITY_GAP_MS, MAX_LINES } from './activities'
export type { GroupOptions } from './activities'

const NO_ACTIVITIES: Activity[] = []
const NO_CHECKPOINTS: Checkpoint[] = []

const IDLE: HistorySnapshot = {
  status: 'idle',
  head: 0,
  activities: NO_ACTIVITIES,
  checkpoints: NO_CHECKPOINTS,
  preview: null,
}

function clampSeq(seq: number, head: number): number {
  return Math.min(Math.max(Math.trunc(seq), 0), head)
}

/**
 * The Board as it was after the first `seq` of `changes`, replayed on `baseEntities` (the Branch at seq 0).
 * `seq` is clamped to `[0, changes.length]`. Items equal to those in `prev` keep their identity.
 */
export function previewAt(
  baseEntities: Entities,
  changes: readonly Change[],
  seq: number,
  prev?: SnapshotParts,
): BoardPreview {
  const at = clampSeq(seq, changes.length)
  const entities = replay(baseEntities, changes.slice(0, at).map((c) => c.op))
  return toPreview(entities, changes, at, prev)
}

function toPreview(entities: Entities, changes: readonly Change[], seq: number, prev?: SnapshotParts): BoardPreview {
  const parts = toSnapshotParts(entities, prev)
  return {
    seq,
    at: seq > 0 ? changes[seq - 1]!.at : null,
    cards: parts.cards,
    frames: parts.frames,
    connections: parts.connections,
  }
}

function sameSnapshot(a: HistorySnapshot, b: HistorySnapshot): boolean {
  const ka = Object.keys(a) as (keyof HistorySnapshot)[]
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]))
}

export function createHistory(boardSync: BoardSync) {
  const store = createStore<{ snapshot: HistorySnapshot }>(() => ({ snapshot: IDLE }))

  let gen = 0 // bumped by open(), close() and when the Board leaves the Branch; older async work is dropped
  let branchId = '' // '' while idle
  let token = -1 // the Board layer's token for the Branch this History belongs to
  let status: HistorySnapshot['status'] = 'idle'
  let error: string | undefined
  let changes: Change[] = []
  let base: Entities = {} // the Branch's Board at seq 0
  let checkpoints: Checkpoint[] = NO_CHECKPOINTS
  let activities: Activity[] = NO_ACTIVITIES
  let tailBase: Entities = base // the Board just before the last Activity, so only that one is regrouped
  let preview: BoardPreview | null = null
  let previewWorld: { seq: number; entities: Entities } | null = null
  let buffer: SyncEvent[] | null = null // events held back while a load is running
  let opening: Promise<void> | null = null
  let boardStatus: BoardStatus = 'idle'

  const path = () => `/api/branches/${encodeURIComponent(branchId)}`

  function publish() {
    const next: HistorySnapshot = { status, head: changes.length, activities, checkpoints, preview }
    if (error !== undefined) next.error = error
    const branch = branchId === '' ? undefined : boardSync.store.getState().snapshot.branch
    if (branch) next.branch = branch
    const prev = store.getState().snapshot
    if (!sameSnapshot(prev, next)) store.setState({ snapshot: next })
  }

  function clear() {
    gen++
    branchId = ''
    token = -1
    status = 'idle'
    error = undefined
    changes = []
    base = {}
    checkpoints = NO_CHECKPOINTS
    activities = NO_ACTIVITIES
    tailBase = base
    preview = null
    previewWorld = null
    buffer = null
    opening = null
  }

  function showPreview(seq: number, force = false) {
    const at = clampSeq(seq, changes.length)
    if (preview && preview.seq === at && !force) return
    const from = previewWorld && previewWorld.seq <= at ? previewWorld : { seq: 0, entities: base }
    const entities = replay(from.entities, changes.slice(from.seq, at).map((c) => c.op))
    previewWorld = { seq: at, entities }
    // The first preview starts from the live Board's items so that unchanged Cards keep their identity.
    preview = toPreview(entities, changes, at, preview ?? boardSync.store.getState().snapshot)
  }

  function regroupAll() {
    activities = groupActivities(changes, checkpoints, base)
    const last = activities[activities.length - 1]
    tailBase = last ? replay(base, changes.slice(0, last.fromSeq).map((c) => c.op)) : base
  }

  function append(fresh: Change[]) {
    if (fresh.length === 0) return
    const last = activities[activities.length - 1]
    const tailSeq = last ? last.fromSeq : changes.length
    changes.push(...fresh)
    const tail = groupActivities(changes.slice(tailSeq), checkpoints, tailBase, { startSeq: tailSeq })
    if (last && tail[0] && tail[0].toSeq === last.toSeq) tail[0] = last // untouched: keep the object
    activities = [...activities.slice(0, Math.max(activities.length - 1, 0)), ...tail]
    const newLast = activities[activities.length - 1]!
    if (newLast.fromSeq > tailSeq) {
      tailBase = replay(tailBase, changes.slice(tailSeq, newLast.fromSeq).map((c) => c.op))
    }
  }

  function addCheckpoint(cp: Checkpoint) {
    if (checkpoints.some((c) => c.name === cp.name)) return
    checkpoints = [...checkpoints, cp].sort(byMoment)
    const seq = cp.moment.seq
    activities = activities.map((a) =>
      seq > a.fromSeq && seq <= a.toSeq ? { ...a, checkpoints: [...a.checkpoints, cp].sort(byMoment) } : a,
    )
  }

  function handle(e: SyncEvent) {
    if (branchId === '' || boardSync.internal.target()?.token !== token) return
    if (buffer) {
      buffer.push(e)
      return
    }
    if (status !== 'ready') return
    if (e.type === 'checkpoint') {
      addCheckpoint(e.checkpoint)
    } else {
      const head = changes.length
      const start = e.seq - e.changes.length
      if (e.seq <= head) return
      if (start > head) {
        resync() // Changes we never saw: load again
        return
      }
      append(e.changes.slice(head - start))
    }
    publish()
  }

  async function load(g: number): Promise<void> {
    const [log, cps, board0] = await Promise.all([
      request<ChangesResponse>('GET', `${path()}/changes?after=0`),
      request<{ checkpoints: Checkpoint[] }>('GET', `${path()}/checkpoints`),
      request<BoardResponse>('GET', `${path()}/board?at=0`),
    ])
    if (g !== gen) return
    changes = [...log.changes]
    base = board0.entities
    checkpoints = [...cps.checkpoints].sort(byMoment)
    regroupAll()
    status = 'ready'
    error = undefined
    boardSync.internal.checkpoints(token, checkpoints, true)
    const held = buffer ?? []
    buffer = null
    for (const e of held) handle(e)
    if (g !== gen) return
    if (preview) {
      previewWorld = null // the log was replaced: replay from seq 0
      showPreview(preview.seq, true)
    }
    publish()
  }

  function fail(g: number, e: unknown) {
    if (g !== gen) return
    status = 'error'
    error = e instanceof Error ? e.message : String(e)
    buffer = null
    publish()
  }

  // Reloads everything in place (the view stays as it is meanwhile). One at a time: a non-null buffer means a
  // load is running, and it handles what was held back when it ends.
  function resync() {
    if (buffer) return
    buffer = []
    const g = gen
    load(g).catch((e: unknown) => fail(g, e))
  }

  // After a reconnect: `checkpoint` frames sent while the socket was down are not repeated.
  async function refreshCheckpoints(g: number): Promise<void> {
    const cps = await request<{ checkpoints: Checkpoint[] }>('GET', `${path()}/checkpoints`)
    if (g !== gen || status !== 'ready') return
    cps.checkpoints.forEach(addCheckpoint)
    boardSync.internal.checkpoints(token, checkpoints, true)
    publish()
  }

  boardSync.internal.listen(handle)
  boardSync.store.subscribe(({ snapshot }) => {
    if (branchId === '') return
    if (boardSync.internal.target()?.token !== token) {
      clear() // the Board closed or switched Branch
      publish()
      return
    }
    if (snapshot.status === 'live' && boardStatus === 'reconnecting' && status === 'ready') {
      void refreshCheckpoints(gen).catch(() => {})
    }
    boardStatus = snapshot.status
    publish() // keeps `branch` current
  })

  function requireTarget() {
    if (isGuest()) throw new ApiError(403, 'forbidden', 'Guests cannot see or change history.')
    const t = boardSync.internal.target()
    if (!t) throw new ApiError(400, 'board_not_open', 'The Board is not open.')
    return t
  }

  async function open(): Promise<void> {
    const t = requireTarget()
    if (branchId === t.id && token === t.token && status !== 'error') {
      if (opening) await opening
      return
    }
    clear()
    const g = gen
    branchId = t.id
    token = t.token
    status = 'loading'
    buffer = []
    boardStatus = boardSync.store.getState().snapshot.status
    publish()
    const run = load(g).catch((e: unknown) => {
      fail(g, e)
      if (g === gen) throw e
    })
    opening = run
    try {
      await run
    } finally {
      if (opening === run) opening = null
    }
  }

  function close() {
    if (branchId === '') return
    clear()
    publish()
  }

  function setPreview(seq: number | null) {
    if (status !== 'ready') return
    if (seq === null) {
      preview = null
      previewWorld = null
    } else if (Number.isFinite(seq)) {
      showPreview(seq)
    }
    publish()
  }

  async function createCheckpoint(name: string, seq?: number): Promise<Checkpoint> {
    const t = requireTarget()
    const body = seq === undefined ? { name } : { name, seq }
    const { checkpoint } = await request<{ checkpoint: Checkpoint }>(
      'POST',
      `/api/branches/${encodeURIComponent(t.id)}/checkpoints`,
      body,
    )
    boardSync.internal.checkpoints(t.token, [checkpoint], false) // the socket frame for it is then ignored
    return checkpoint
  }

  async function restore(toSeq: number): Promise<void> {
    const t = requireTarget()
    const r = await request<ChangesResponse>('POST', `/api/branches/${encodeURIComponent(t.id)}/restore`, {
      to_seq: toSeq,
    })
    boardSync.internal.confirm(t.token, r.seq, r.changes) // the socket frame for them is then stale
  }

  return { store, open, close, preview: setPreview, createCheckpoint, restore }
}

const instance = createHistory(sync)

export const history = {
  open: instance.open,
  close: instance.close,
  preview: instance.preview,
  createCheckpoint: instance.createCheckpoint,
  restore: instance.restore,
}

export function useHistory(): HistorySnapshot {
  return useStore(instance.store, (s) => s.snapshot)
}
