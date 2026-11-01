// Undo (docs/specs/undo.md): the lists of steps of this window, one per Branch, and what Undo and Redo send.
// Steps are recorded where ops are sent: a gesture wraps its `board.submit` calls, and the Board layer tells this
// store about every batch it takes (`internal.observe`). The Changes the Branch receives (`internal.listen`) are kept
// for the check of decision 5. Nothing here is stored or sent anywhere but as ordinary ops.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Entities } from './board-state'
import type { BoardSync } from './board-sync'
import { sync } from './board-sync'
import { request } from './http'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import type { Change, ChangesResponse, Entity, Op } from './types'
import type { Direction, Lists, Logged, Part, Plan } from './undo'
import {
  NOTHING_TO_REDO,
  NOTHING_TO_UNDO,
  PENDING,
  UNDO_DEPTH,
  endsLists,
  entityOf,
  labelFor,
  mergeParts,
  noteFor,
  partsOf,
  planStep,
  pushStep,
  remark,
} from './undo'

/**
 * How a gesture is told apart. `label` names the step instead of History's words (e.g. an Import BibTeX); `key`
 * names the step so a later gesture can `join` it — the text typed into a Card just added becomes part of adding
 * it — as long as it is still the newest step.
 */
export type GestureOptions = { label?: string; key?: string; join?: string }

/** A gesture of several batches sent over time: each `add` sends some of it; `end` closes it. */
export type Gesture = { add<T>(send: () => T): T; end(): void }

/** After an Undo or Redo: whether anything was done, and the note that says what (decision 5 and 11). */
export type UndoResult = { done: boolean; note: string }

/** The open Branch's next Undo and Redo, by the step's name ("Move 3 Cards"); null when there is nothing. */
export type UndoSnapshot = { undo: string | null; redo: string | null }

const MAX_OPS = 200 // the Board layer's limit per batch
const NOTHING: UndoSnapshot = { undo: null, redo: null }
/** How many Changes a Branch's record may hold before the ones no step needs are dropped. */
const PRUNE_FROM = 400

type Chunk = { parts: Part[]; pending: boolean }

type Step = {
  id: number
  key?: string
  label: string
  fixed: boolean // the gesture named it
  chunks: Chunk[] // what it stands for, in order; a gesture adds one per batch
  seen: Map<string, Entity | undefined> // the things it touched as the gesture found them (for its name)
  ops: Op[] // what the gesture sent (for its name)
}

type BranchUndo = {
  lists: Lists<Step>
  log: Logged[] // the Branch's Changes this window received while it had steps, by seq
  logged: Set<string>
  ours: Set<string> // ids of the Changes of this list: its gestures and its Undos and Redos
  seq: number // the last seq of this Branch this window knows of
  inflight: Set<Promise<void>>
  catching: Promise<void> | null // fetching what happened while the Branch was not open
}

type Scope =
  | { kind: 'gesture'; options: GestureOptions; step: Step | null; branch: string | null; closed: boolean }
  | { kind: 'undo'; seqs: (number | null)[] } // the head after each batch Undo or Redo sent, null when refused

function overlay(base: Entities, over: ReadonlyMap<string, Entity | undefined>): Entities {
  const world = Object.create(base) as Record<string, Entity | undefined>
  for (const [id, e] of over) world[id] = e
  return world as Entities
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

export function createUndo(board: Pick<BoardSync, 'internal' | 'submit'>) {
  const store = createStore<UndoSnapshot>(() => NOTHING)
  const branches = new Map<string, BranchUndo>()
  let current: Scope | null = null
  let nextId = 0
  let chain: Promise<unknown> = Promise.resolve()

  const me = () => {
    const s = sessionStore.getState()
    return s.status === 'signed_in' ? s.member.id : ''
  }
  const nameOf = (id: string): string | undefined => {
    const m = membersStore.getState().members.find((x) => x.id === id)
    if (m) return firstName(m.name)
    const s = sessionStore.getState()
    return s.status === 'signed_in' && s.member.id === id ? firstName(s.member.name) : undefined
  }

  function stateOf(branch: string): BranchUndo {
    let b = branches.get(branch)
    if (!b) {
      const t = board.internal.target()
      b = {
        lists: { undo: [], redo: [] },
        log: [],
        logged: new Set(),
        ours: new Set(),
        seq: t && t.id === branch ? t.seq : 0,
        inflight: new Set(),
        catching: null,
      }
      branches.set(branch, b)
    }
    return b
  }

  const hasSteps = (b: BranchUndo) => b.lists.undo.length > 0 || b.lists.redo.length > 0
  const partsOfStep = (s: Step): Part[] => s.chunks.reduce<Part[]>((acc, c) => mergeParts(acc, c.parts), [])

  function clear(b: BranchUndo) {
    b.lists = { undo: [], redo: [] }
    b.log = []
    b.logged.clear()
    b.ours.clear()
  }

  // ---- what the hooks read ----

  function snapshot(): UndoSnapshot {
    const t = board.internal.target()
    const b = t ? branches.get(t.id) : undefined
    if (!b) return NOTHING
    const undo = b.lists.undo[0]?.label ?? null
    const redo = b.lists.redo[0]?.label ?? null
    return undo === null && redo === null ? NOTHING : { undo, redo }
  }

  function publish() {
    const next = snapshot()
    const prev = store.getState()
    if (prev.undo !== next.undo || prev.redo !== next.redo) store.setState(next, true)
  }

  // ---- the Changes of a Branch ----

  // Drops recorded Changes that no step can be checked against any more (older than every step's mark).
  function prune(b: BranchUndo) {
    if (!hasSteps(b)) {
      b.log = []
      b.logged.clear()
      b.ours.clear()
      return
    }
    if (b.log.length < PRUNE_FROM) return
    let min = b.seq
    for (const s of [...b.lists.undo, ...b.lists.redo]) for (const c of s.chunks) for (const p of c.parts) if (p.mark < min) min = p.mark
    const keep = b.log.filter((c) => c.seq > min)
    if (keep.length === b.log.length) return
    b.log = keep
    b.logged = new Set(keep.map((c) => c.id))
  }

  // Changes ending at `endSeq`, in order, as the Board layer confirmed them (or as fetched after a Branch switch).
  function ingest(b: BranchUndo, endSeq: number, changes: readonly Change[]) {
    const start = endSeq - changes.length
    let ended = false
    changes.forEach((c, i) => {
      if (endsLists(c.origin)) ended = true
      else if (hasSteps(b) && !b.logged.has(c.id)) {
        b.logged.add(c.id)
        b.log.push({ seq: start + 1 + i, id: c.id, author: c.author, op: c.op, origin: c.origin })
      }
    })
    // A Merge or a Restore landed on this Branch, by anyone: nothing before it can be undone (decision 4).
    if (ended) clear(b)
    if (endSeq > b.seq) b.seq = endSeq
    b.log.sort((x, y) => x.seq - y.seq)
    prune(b)
  }

  // ---- recording: the Board layer tells of every batch ----

  function observeBatch(batch: { ops: readonly Op[]; before: Entities; after: Entities; branch: string; token: number }) {
    const scope = current
    if (!scope) return // not a gesture (a Run's result, an answer pinned without one): not a step
    const b = stateOf(batch.branch)
    let done: () => void = () => {}
    const flight = new Promise<void>((resolve) => (done = resolve))
    b.inflight.add(flight)
    const land = () => {
      b.inflight.delete(flight)
      done()
    }
    if (scope.kind === 'undo') {
      // Sent by Undo or Redo itself: registers nothing; its Changes are this list's.
      const i = scope.seqs.length
      scope.seqs.push(null)
      return (r: ChangesResponse | null) => {
        if (r) {
          for (const c of r.changes) b.ours.add(c.id)
          scope.seqs[i] = r.seq
        }
        land()
      }
    }
    if (scope.closed || (scope.branch !== null && scope.branch !== batch.branch)) {
      land()
      return
    }
    scope.branch = batch.branch
    const chunk: Chunk = { parts: partsOf(batch.before, batch.ops), pending: true }
    let step = scope.step && b.lists.undo.includes(scope.step) ? scope.step : null
    if (!step && scope.options.join !== undefined && b.lists.undo[0]?.key === scope.options.join) step = b.lists.undo[0]
    if (!step) {
      step = {
        id: ++nextId,
        label: scope.options.label ?? '',
        fixed: scope.options.label !== undefined,
        chunks: [],
        seen: new Map(),
        ops: [],
      }
      if (scope.options.key !== undefined) step.key = scope.options.key
      b.lists = pushStep(b.lists, step)
    }
    scope.step = step
    step.chunks.push(chunk)
    for (const op of batch.ops) {
      const id = entityOf(op)
      if (!step.seen.has(id)) step.seen.set(id, batch.before[id])
    }
    step.ops.push(...batch.ops)
    if (!step.fixed) step.label = labelFor(overlay(batch.after, step.seen), batch.after, step.ops)
    // Made and taken away within one gesture (an empty block left empty): nothing to undo.
    if (partsOfStep(step).length === 0) b.lists = { ...b.lists, undo: b.lists.undo.filter((s) => s !== step) }
    publish()
    const owner = step
    return (r: ChangesResponse | null) => {
      chunk.pending = false
      if (r) {
        chunk.parts = remark(chunk.parts, r.seq)
        for (const c of r.changes) b.ours.add(c.id)
      } else {
        owner.chunks = owner.chunks.filter((c) => c !== chunk)
        if (partsOfStep(owner).length === 0) {
          b.lists = { undo: b.lists.undo.filter((s) => s !== owner), redo: b.lists.redo.filter((s) => s !== owner) }
        }
      }
      land()
      publish()
    }
  }

  function inScope<T>(scope: Scope, send: () => T): T {
    const before = current
    current = scope
    try {
      return send()
    } finally {
      current = before
    }
  }

  /** Every `board.submit` called synchronously inside `send` is part of one step. */
  function gesture<T>(send: () => T, options: GestureOptions = {}): T {
    return inScope({ kind: 'gesture', options, step: null, branch: null, closed: false }, send)
  }

  function begin(options: GestureOptions = {}): Gesture {
    const scope: Scope = { kind: 'gesture', options, step: null, branch: null, closed: false }
    return {
      add: (send) => inScope(scope, send),
      end: () => {
        scope.closed = true
      },
    }
  }

  /**
   * A step made of Changes the server already confirmed by another route (accepting a Suggestion). `token` is the
   * Board's when they were sent: a step never goes to another Branch than the one they were made on.
   */
  function record(token: number, ops: readonly Op[], changes: readonly Change[], seq: number) {
    const t = board.internal.target()
    if (!t || t.token !== token || ops.length === 0) return
    const b = stateOf(t.id)
    const now = board.internal.entities()
    const seen = new Map<string, Entity | undefined>()
    for (const op of ops) {
      const id = entityOf(op)
      if (!seen.has(id)) seen.set(id, 'Create' in op ? undefined : now[id])
    }
    const before = overlay(now, seen)
    const parts = partsOf(before, ops, seq)
    if (parts.length === 0) return
    for (const c of changes) b.ours.add(c.id)
    const step: Step = { id: ++nextId, label: labelFor(before, now, ops), fixed: false, chunks: [{ parts, pending: false }], seen, ops: [...ops] }
    b.lists = pushStep(b.lists, step)
    publish()
  }

  // ---- Undo and Redo ----

  async function settled(b: BranchUndo) {
    while (b.inflight.size > 0 || b.catching) {
      await Promise.allSettled([...b.inflight, ...(b.catching ? [b.catching] : [])])
    }
  }

  // Sends `ops` as the list's own (marked, registering nothing), at most 200 per batch. For each batch: the ops it
  // holds and the head after it, or null when it was refused.
  async function send(ops: readonly Op[]): Promise<{ from: number; to: number; seq: number | null }[]> {
    const scope: Scope = { kind: 'undo', seqs: [] }
    const sent: { from: number; to: number; at: number; promise: Promise<unknown> }[] = []
    inScope(scope, () => {
      for (let i = 0; i < ops.length; i += MAX_OPS) {
        const slice = ops.slice(i, i + MAX_OPS)
        const at = scope.seqs.length
        sent.push({ from: i, to: i + slice.length, at, promise: board.submit(slice).catch(() => {}) })
        if (scope.seqs.length === at) scope.seqs.push(null) // refused before it was taken
      }
    })
    await Promise.all(sent.map((x) => x.promise))
    return sent.map((x) => ({ from: x.from, to: x.to, seq: scope.seqs[x.at] ?? null }))
  }

  async function run(direction: Direction, key?: string): Promise<UndoResult | null> {
    const t = board.internal.target()
    if (!t) return null
    const b = stateOf(t.id)
    await settled(b)
    if (board.internal.target()?.token !== t.token) return null // the Board switched Branch meanwhile
    const from = direction === 'undo' ? b.lists.undo : b.lists.redo
    const step = from[0]
    if (!step) return { done: false, note: direction === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO }
    if (key !== undefined && step.key !== key) return null
    const plan: Plan = planStep(direction, partsOfStep(step), b.log, (id) => b.ours.has(id), board.internal.entities())
    const note = noteFor(direction, step.label, plan, nameOf, me())
    const without = (list: Step[]) => list.filter((s) => s !== step)
    if (plan.done.length === 0) {
      // Every part was left: the step is dropped, the next press goes to the one before it (decision 5).
      b.lists = direction === 'undo' ? { undo: without(b.lists.undo), redo: b.lists.redo } : { undo: b.lists.undo, redo: without(b.lists.redo) }
      publish()
      return { done: false, note }
    }
    // The step moves to the other list at once; the Board shows the Undo at once too (it is optimistic).
    const moved: Step = { ...step, chunks: [{ parts: plan.done.map((p) => ({ ...p, mark: PENDING })), pending: true }] }
    delete moved.key // only a fresh step can be joined
    b.lists =
      direction === 'undo'
        ? { undo: without(b.lists.undo), redo: [moved, ...b.lists.redo].slice(0, UNDO_DEPTH) }
        : { undo: [moved, ...b.lists.undo].slice(0, UNDO_DEPTH), redo: without(b.lists.redo) }
    publish()
    const batches = await send(plan.ops)
    // Each part takes the mark of the batch its op went in.
    const marks = new Map<Part, number | null>()
    for (const batch of batches) for (let i = batch.from; i < batch.to; i++) marks.set(plan.applied[i]!, batch.seq)
    const kept = plan.done.filter((p) => marks.get(p) !== null && marks.get(p) !== undefined)
    if (kept.length === 0) {
      // Nothing went through (the Board changed under it): the step stays where it was.
      b.lists = {
        undo: direction === 'undo' ? [step, ...b.lists.undo] : b.lists.undo.filter((s) => s !== moved),
        redo: direction === 'undo' ? b.lists.redo.filter((s) => s !== moved) : [step, ...b.lists.redo],
      }
      publish()
      return { done: false, note: `Could not ${direction} ${step.label} — the Board was updated meanwhile. Try again.` }
    }
    moved.chunks = [{ parts: kept.map((p) => ({ ...p, mark: marks.get(p)! })), pending: false }]
    prune(b)
    publish()
    return { done: true, note }
  }

  // One at a time, in the order pressed: each one plans against what the one before did.
  function queue(direction: Direction, key?: string): Promise<UndoResult | null> {
    const next = chain.then(() => run(direction, key))
    chain = next.catch(() => {})
    return next
  }

  // ---- keeping up with the Board ----

  function catchUp(branch: string, b: BranchUndo, after: number) {
    const p = request<ChangesResponse>('GET', `/api/branches/${encodeURIComponent(branch)}/changes?after=${after}`).then(
      (r) => {
        if (b.catching === p) ingest(b, r.seq, r.changes)
      },
      () => {
        // What happened meanwhile cannot be known: nothing can be checked, so nothing is offered.
        if (b.catching === p) clear(b)
      },
    )
    b.catching = p
    void p.finally(() => {
      if (b.catching === p) b.catching = null
      publish()
    })
  }

  const stop = [
    board.internal.listen((e) => {
      if (e.type !== 'changes') return
      const t = board.internal.target()
      if (!t) return
      const b = stateOf(t.id)
      if (e.changes.length === 0) {
        // The Board was fetched again: Changes in between were never seen here, so nothing can be checked.
        if (e.seq > b.seq && hasSteps(b)) clear(b)
        if (e.seq > b.seq) b.seq = e.seq
      } else ingest(b, e.seq, e.changes)
      publish()
    }),
    board.internal.watch((e) => {
      if (e.type === 'opened') {
        const t = board.internal.target()
        if (t) {
          const b = stateOf(t.id)
          // Back on a Branch with steps: what others did meanwhile counts, and a Merge or Restore ends them.
          if (hasSteps(b) && t.seq > b.seq) catchUp(t.id, b, b.seq)
          else if (t.seq > b.seq) b.seq = t.seq
        }
      }
      if (e.type === 'opened' || e.type === 'closed') publish()
    }),
    board.internal.observe(observeBatch),
    // A list is the signed-in Member's: another Member, or none, starts from nothing.
    (() => {
      let owner = me()
      return sessionStore.subscribe(() => {
        const now = me()
        if (now === owner) return
        owner = now
        branches.clear()
        publish()
      })
    })(),
  ]

  return {
    store,
    gesture,
    begin,
    undo: (key?: string) => queue('undo', key),
    redo: () => queue('redo'),
    current: () => store.getState(),
    subscribe: (fn: () => void) => store.subscribe(fn),
    internal: { record, dispose: () => stop.forEach((off) => off()) },
  }
}

export type UndoStore = ReturnType<typeof createUndo>

const stores = new WeakMap<object, UndoStore>()

/** The Undo of one Board layer (the app has one; tests make their own Board layers). */
export function undoFor(board: Pick<BoardSync, 'internal' | 'submit'>): UndoStore {
  let u = stores.get(board.internal)
  if (!u) {
    u = createUndo(board)
    stores.set(board.internal, u)
  }
  return u
}

const own = undoFor(sync)

export const undo = {
  gesture: own.gesture,
  begin: own.begin,
  undo: own.undo,
  redo: own.redo,
  current: own.current,
  subscribe: own.subscribe,
}

export function useUndo(): UndoSnapshot {
  return useStore(own.store)
}
