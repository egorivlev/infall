// The Board store: server truth (`confirmed` + `seq`) plus a queue of optimistic batches.
// What the UI sees is `confirmed` with the pending batches re-applied on top.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Entities, SnapshotParts } from './board-state'
import { applyOps, toSnapshotParts } from './board-state'
import { branchesStore, setBranches } from './branches-store'
import { ApiError, request } from './http'
import { membersStore, members as membersApi } from './people'
import { sessionStore } from './session-store'
import type {
  BoardResponse,
  BoardSnapshot,
  BoardStatus,
  BranchInfo,
  Change,
  ChangesResponse,
  Checkpoint,
  ClientFrame,
  Member,
  Op,
  ServerFrame,
} from './types'

export type SocketLike = {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export type BoardSyncOptions = {
  WebSocketCtor?: new (url: string) => SocketLike
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  socketUrl?: () => string
}

type Batch = {
  ops: Op[]
  resolve: () => void
  reject: (e: unknown) => void
  inflight: boolean
  echoed: boolean // its Changes already arrived over the socket; hidden from the overlay
}

type Applied = 'applied' | 'stale' | 'gap' | 'bad'

/**
 * What the Board layer tells History (internal, not part of the UI surface).
 * `changes`: Changes the server confirmed, each exactly once and in order; `seq` is the head after them, so
 * `seq - changes.length` is the head before. An empty list with a higher `seq` means the Board was refetched
 * and the Changes in between were never seen here.
 */
export type SyncEvent =
  | { type: 'changes'; seq: number; changes: Change[] }
  | { type: 'checkpoint'; checkpoint: Checkpoint }

const MAX_OPS = 200
const BACKOFF_START = 1000
const BACKOFF_CAP = 15000
const NO_ITEMS: never[] = []

function defaultSocketUrl(): string {
  const { protocol, host } = globalThis.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/api/ws`
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function sameSnapshot(a: BoardSnapshot, b: BoardSnapshot): boolean {
  const ka = Object.keys(a) as (keyof BoardSnapshot)[]
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]))
}

const IDLE: BoardSnapshot = {
  status: 'idle',
  seq: 0,
  cards: NO_ITEMS,
  frames: NO_ITEMS,
  connections: NO_ITEMS,
  presence: NO_ITEMS,
  pending: 0,
  readOnly: false,
}

export function createBoardSync(options: BoardSyncOptions = {}) {
  const store = createStore<{ snapshot: BoardSnapshot }>(() => ({ snapshot: IDLE }))

  const setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => globalThis.clearTimeout(h as number))
  const socketUrl = options.socketUrl ?? defaultSocketUrl
  const createSocket = (url: string): SocketLike => {
    const Ctor = options.WebSocketCtor ?? (globalThis.WebSocket as unknown as new (u: string) => SocketLike)
    return new Ctor(url)
  }

  let gen = 0 // bumped by open() and close(); async work from an older generation is dropped
  let loaded = false
  let status: BoardStatus = 'idle'
  let error: string | undefined
  let branch: BranchInfo | undefined
  let branchId = ''
  let confirmed: Entities = {}
  let seq = 0
  let queue: Batch[] = []
  let presenceIds: string[] = []
  let presence: Member[] = NO_ITEMS
  let parts: SnapshotParts = { cards: NO_ITEMS, frames: NO_ITEMS, connections: NO_ITEMS }
  let view: Entities = confirmed
  let dirty = true
  let socket: SocketLike | null = null
  let timer: unknown = null
  let attempt = 0
  let catching: Promise<void> | null = null
  let gapAgain = false
  let unsubscribe: (() => void)[] = []
  const reloadTried = new Set<string>()
  const checkpointNames = new Set<string>() // Checkpoints of the open Branch met so far, for counting each once
  const listeners = new Set<(e: SyncEvent) => void>()
  let wasLive = false // the socket has been subscribed at least once since open()

  function emit(e: SyncEvent) {
    for (const fn of [...listeners]) fn(e)
  }

  const readOnly = () => {
    const s = sessionStore.getState()
    return s.status === 'signed_in' && s.member.role === 'guest'
  }
  const base = () => `/api/branches/${encodeURIComponent(branchId)}`

  function resolvePresence(): Member[] {
    const list = membersStore.getState().members
    const s = sessionStore.getState()
    const out: Member[] = []
    for (const id of presenceIds) {
      const m = list.find((x) => x.id === id) ?? (s.status === 'signed_in' && s.member.id === id ? s.member : undefined)
      if (m) out.push(m)
    }
    return sameItems(presence, out) ? presence : out
  }

  function recomputeView() {
    let v = confirmed
    for (const b of queue) {
      if (b.echoed) continue
      const r = applyOps(v, b.ops)
      if (r.ok) v = r.entities // a batch that no longer applies is skipped
    }
    view = v
    parts = toSnapshotParts(view, parts)
    dirty = false
  }

  function rebuild() {
    if (dirty) recomputeView()
    if (branch && branch.seq !== seq) branch = { ...branch, seq }
    presence = resolvePresence()
    const next: BoardSnapshot = {
      status,
      seq,
      cards: parts.cards,
      frames: parts.frames,
      connections: parts.connections,
      presence,
      pending: queue.reduce((n, b) => (b.echoed ? n : n + b.ops.length), 0),
      readOnly: readOnly(),
    }
    if (error !== undefined) next.error = error
    if (branch) next.branch = branch
    const prev = store.getState().snapshot
    if (!sameSnapshot(prev, next)) store.setState({ snapshot: next })
  }

  function currentView(): Entities {
    if (dirty) recomputeView()
    return view
  }

  // Drops queued (not yet sent) batches that can no longer apply on top of what precedes them.
  function prune() {
    let v = confirmed
    const keep: Batch[] = []
    for (const b of queue) {
      if (b.echoed) {
        keep.push(b)
        continue
      }
      const r = applyOps(v, b.ops)
      if (r.ok) {
        v = r.entities
        keep.push(b)
      } else if (b.inflight) {
        keep.push(b) // already on the wire: the server decides
      } else {
        b.reject(new ApiError(409, 'rejected', r.rejection.message, r.rejection))
      }
    }
    queue = keep
    dirty = true
  }

  function markEcho(fresh: Change[]) {
    const head = queue[0]
    const s = sessionStore.getState()
    if (!head || !head.inflight || head.echoed || s.status !== 'signed_in') return
    const mine = fresh.map((c) => (c.author === s.member.id ? JSON.stringify(c.op) : null))
    const want = head.ops.map((o) => JSON.stringify(o))
    for (let i = 0; i + want.length <= mine.length; i++) {
      if (want.every((w, j) => mine[i + j] === w)) {
        head.echoed = true
        return
      }
    }
  }

  // Applies server Changes ending at `endSeq` to `confirmed`. Does not rebuild.
  function applyIncoming(endSeq: number, changes: Change[]): Applied {
    const start = endSeq - changes.length
    if (endSeq <= seq) return 'stale'
    if (start > seq) return 'gap'
    const fresh = start < seq ? changes.slice(seq - start) : changes
    const r = applyOps(confirmed, fresh.map((c) => c.op))
    if (!r.ok) return 'bad'
    confirmed = r.entities
    seq = endSeq
    markEcho(fresh)
    prune()
    emit({ type: 'changes', seq, changes: fresh })
    return 'applied'
  }

  async function reload(g: number): Promise<void> {
    const b = await request<BoardResponse>('GET', `${base()}/board`)
    if (g !== gen) return
    if (b.seq >= seq) {
      const jumped = b.seq > seq
      confirmed = b.entities
      seq = b.seq
      prune()
      rebuild()
      if (jumped) emit({ type: 'changes', seq, changes: [] })
    }
  }

  // ---- Branch info ----

  // Takes the newest facts about the open Branch from the Branch list. Checkpoints only ever grow.
  function adoptBranchInfo() {
    if (!branch) return
    const fresh = branchesStore.getState().branches.find((b) => b.id === branchId)
    if (!fresh) return
    const next: BranchInfo = { ...fresh, seq, checkpoints: Math.max(fresh.checkpoints ?? 0, branch.checkpoints) }
    if (JSON.stringify(next) !== JSON.stringify(branch)) branch = next
  }

  async function refreshBranches(g: number): Promise<void> {
    const list = await request<{ branches: BranchInfo[] }>('GET', '/api/branches')
    if (g !== gen) return
    setBranches(list.branches) // the store subscription adopts it
  }

  // Counts Checkpoints of the open Branch, each name once, and tells History about the new ones.
  // `full` means `list` is every Checkpoint the Branch had when it was fetched.
  function noteCheckpoints(list: readonly Checkpoint[], full: boolean) {
    if (!branch) return
    const fresh = list.filter((c) => !checkpointNames.has(c.name))
    fresh.forEach((c) => checkpointNames.add(c.name))
    const count = full ? Math.max(branch.checkpoints, checkpointNames.size) : branch.checkpoints + fresh.length
    if (count !== branch.checkpoints) branch = { ...branch, checkpoints: count }
    rebuild()
    if (!full) for (const c of fresh) emit({ type: 'checkpoint', checkpoint: c })
  }

  function catchUp(): Promise<void> {
    if (catching) {
      gapAgain = true
      return catching
    }
    const g = gen
    const run = async () => {
      try {
        do {
          gapAgain = false
          const r = await request<ChangesResponse>('GET', `${base()}/changes?after=${seq}`)
          if (g !== gen) return
          const res = applyIncoming(r.seq, r.changes)
          rebuild()
          if (res === 'gap' || res === 'bad') await reload(g)
        } while (gapAgain && g === gen)
      } catch {
        if (g === gen) await reload(g).catch(() => {})
      } finally {
        catching = null
      }
    }
    catching = run()
    return catching
  }

  function onChanges(f: { seq: number; changes: Change[] }) {
    const res = applyIncoming(f.seq, f.changes)
    if (res === 'applied') rebuild()
    else if (res === 'gap') void catchUp()
    else if (res === 'bad') void reload(gen).catch(() => {})
  }

  function pump() {
    const b = queue[0]
    if (!b || b.inflight) return
    b.inflight = true
    const g = gen
    request<ChangesResponse>('POST', `${base()}/ops`, { ops: b.ops }).then(
      async (r) => {
        if (g !== gen) return
        const res = applyIncoming(r.seq, r.changes)
        try {
          if (res === 'gap') await catchUp()
          else if (res === 'bad') await reload(g)
        } catch {
          // The socket or the next frame will resync us.
        }
        if (g !== gen) return
        queue = queue.filter((x) => x !== b)
        prune()
        rebuild()
        b.resolve()
        pump()
      },
      (e: unknown) => {
        if (g !== gen) return
        queue = queue.filter((x) => x !== b)
        prune()
        rebuild()
        b.reject(e)
        pump()
      },
    )
  }

  // ---- socket ----

  function send(frame: ClientFrame) {
    socket?.send(JSON.stringify(frame))
  }

  function handleFrame(f: ServerFrame) {
    switch (f.type) {
      case 'subscribed':
        attempt = 0
        status = 'live'
        error = undefined
        if (f.seq < seq) void reload(gen).catch(() => {})
        // Frames about Branches and Checkpoints sent while we were away are not repeated: ask again.
        if (wasLive && !readOnly()) void refreshBranches(gen).catch(() => {})
        wasLive = true
        rebuild()
        break
      case 'changes':
        if (f.branch === branchId || f.branch === branch?.name) onChanges(f)
        break
      case 'presence':
        if (f.branch === branchId || f.branch === branch?.name) {
          presenceIds = f.members
          const unknown = f.members.filter(
            (id) => !membersStore.getState().members.some((m) => m.id === id) && !reloadTried.has(id),
          )
          if (unknown.length > 0 && !readOnly()) {
            unknown.forEach((id) => reloadTried.add(id))
            membersApi.reload().catch(() => {})
          }
          rebuild()
        }
        break
      case 'error':
        status = 'error'
        error = f.message
        stopSocket()
        rebuild()
        break
      case 'checkpoint':
        if (f.branch === branchId || f.branch === branch?.name) noteCheckpoints([f.checkpoint], false)
        break
      case 'branches':
        setBranches(f.branches)
        break
      default:
        break // a frame type this build does not know
    }
  }

  function stopSocket() {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (socket) {
      const s = socket
      socket = null
      s.onopen = s.onmessage = s.onclose = s.onerror = null
      s.close()
    }
    presenceIds = []
  }

  function connect() {
    const ws = createSocket(socketUrl())
    socket = ws
    ws.onopen = () => {
      if (socket === ws) send({ type: 'subscribe', branch: branchId, after: seq })
    }
    ws.onmessage = (ev) => {
      if (socket !== ws || typeof ev.data !== 'string') return
      let f: unknown
      try {
        f = JSON.parse(ev.data)
      } catch {
        return
      }
      if (typeof f === 'object' && f !== null && 'type' in f) handleFrame(f as ServerFrame)
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      presenceIds = []
      status = 'reconnecting'
      const delay = Math.min(BACKOFF_START * 2 ** attempt, BACKOFF_CAP)
      attempt++
      timer = setTimer(() => {
        timer = null
        connect()
      }, delay)
      rebuild()
    }
    ws.onerror = () => {} // a close always follows
  }

  // ---- lifecycle ----

  function teardown() {
    stopSocket()
    unsubscribe.forEach((u) => u())
    unsubscribe = []
    const rest = queue
    queue = []
    for (const b of rest) b.reject(new ApiError(0, 'closed', 'The Board was closed.'))
  }

  function reset() {
    loaded = false
    status = 'idle'
    error = undefined
    branch = undefined
    branchId = ''
    confirmed = {}
    seq = 0
    queue = []
    presenceIds = []
    attempt = 0
    catching = null
    gapAgain = false
    reloadTried.clear()
    checkpointNames.clear()
    wasLive = false
    dirty = true
  }

  function close() {
    gen++
    teardown()
    reset()
    rebuild()
  }

  async function open(branchName = 'main'): Promise<void> {
    gen++
    teardown()
    reset()
    const g = gen
    status = 'loading'
    rebuild()
    unsubscribe = [
      membersStore.subscribe(() => rebuild()),
      sessionStore.subscribe((s) => {
        if (s.status === 'signed_out') close()
        else rebuild()
      }),
      branchesStore.subscribe(() => {
        adoptBranchInfo()
        rebuild()
      }),
    ]
    try {
      let info: BranchInfo | undefined
      try {
        const list = await request<{ branches: BranchInfo[] }>('GET', '/api/branches')
        if (g !== gen) return
        setBranches(list.branches)
        info = list.branches.find((b) => b.name === branchName) ?? list.branches.find((b) => b.id === branchName)
        if (!info) throw new ApiError(404, 'not_found', `No Branch named ${branchName}.`)
      } catch (e) {
        // Some roles may not be allowed to list Branches; fall back to the name as the id.
        if (!(e instanceof ApiError) || (e.status !== 403 && e.code !== 'forbidden')) throw e
        info = { id: branchName, name: branchName, seq: 0, checkpoints: 0 }
      }
      if (g !== gen) return
      branchId = info.id
      const b = await request<BoardResponse>('GET', `${base()}/board`)
      if (g !== gen) return
      branch = { ...info, checkpoints: info.checkpoints ?? 0 }
      confirmed = b.entities
      seq = b.seq
      loaded = true
      dirty = true
      rebuild()
      connect()
    } catch (e) {
      if (g !== gen) return
      status = 'error'
      error = e instanceof Error ? e.message : String(e)
      rebuild()
      throw e
    }
  }

  async function submit(opsIn: Op[]): Promise<void> {
    if (readOnly()) throw new ApiError(403, 'forbidden', 'Guests cannot edit the Board.')
    if (!loaded) throw new ApiError(400, 'board_not_open', 'The Board is not open.')
    if (opsIn.length === 0) return
    if (opsIn.length > MAX_OPS) throw new ApiError(400, 'bad_request', `At most ${MAX_OPS} operations per batch.`)
    const r = applyOps(currentView(), opsIn)
    if (!r.ok) throw new ApiError(409, 'rejected', r.rejection.message, r.rejection)
    await new Promise<void>((resolve, reject) => {
      queue.push({ ops: [...opsIn], resolve, reject, inflight: false, echoed: false })
      dirty = true
      rebuild()
      pump()
    })
  }

  // ---- for History and Branches (internal) ----

  // The Branch that is loaded now, and a token that stops being valid when the Board closes or switches.
  function target(): { id: string; seq: number; token: number } | null {
    return loaded ? { id: branchId, seq, token: gen } : null
  }

  // Changes the server confirmed by another route (a Restore answered over HTTP). `seq` is the head after them.
  function confirm(token: number, endSeq: number, changes: Change[]) {
    if (token === gen && loaded) onChanges({ seq: endSeq, changes })
  }

  function checkpoints(token: number, list: readonly Checkpoint[], full: boolean) {
    if (token === gen && loaded) noteCheckpoints(list, full)
  }

  function listen(fn: (e: SyncEvent) => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }

  return { store, open, close, submit, internal: { target, confirm, checkpoints, listen } }
}

export type BoardSync = ReturnType<typeof createBoardSync>

export const sync = createBoardSync()

export const board = { open: sync.open, close: sync.close, submit: sync.submit }

export function useBoard(): BoardSnapshot {
  return useStore(sync.store, (s) => s.snapshot)
}
