// Merge review: plans a Merge of one Branch into another, shows what lands by itself and what must be decided,
// collects the choices and applies it. Independent of the Board that is open: everything is fetched by Branch.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Entities } from './board-state'
import type { BoardSync } from './board-sync'
import { sync } from './board-sync'
import { isGuest, setBranches } from './branches-store'
import { ApiError, request } from './http'
import { buildAuto, buildConflicts, countLayoutKept, defaultCheckpointName, toDecisions } from './merge-view'
import { sessionStore } from './session-store'
import type {
  AutoLine,
  BoardResponse,
  BranchInfo,
  Change,
  ChangesResponse,
  Checkpoint,
  Choice,
  ConflictVM,
  MergePlan,
  MergeSnapshot,
  Moment,
} from './types'

export { mergeOptions } from './merge-view'

const NO_LINES: AutoLine[] = []
const NO_CONFLICTS: ConflictVM[] = []

const IDLE: MergeSnapshot = {
  status: 'idle',
  auto: NO_LINES,
  autoSummary: '',
  layoutKept: 0,
  conflicts: NO_CONFLICTS,
  decided: 0,
  nothingToMerge: false,
  checkpointName: '',
  replanned: false,
}

const SENTENCES: Record<string, string> = {
  not_parent_and_child: 'A Branch can only be merged with the Branch it was made from.',
  forbidden: 'Guests cannot merge Branches.',
}

type MergeResponse = { seq: number; changes: Change[]; checkpoint?: Checkpoint }
type Kept = Map<string, { choice: Choice; print: string }>

const branchPath = (id: string) => `/api/branches/${encodeURIComponent(id)}`

export function createMerge(boardSync: BoardSync) {
  const store = createStore<{ snapshot: MergeSnapshot }>(() => ({ snapshot: IDLE }))

  let gen = 0 // bumped by open(), close() and refresh(); answers to older requests are dropped
  let names: { source: string; target: string } | null = null
  let plan: MergePlan | null = null
  let prints = new Map<string, string>() // Conflict id → what it was about when planned
  let logs: { source: Change[]; target: Change[] } = { source: [], target: [] }
  let nameTouched = false // the Checkpoint name was typed by hand: planning again keeps it

  const snap = () => store.getState().snapshot
  const set = (patch: Partial<MergeSnapshot>) => store.setState({ snapshot: { ...snap(), ...patch } })

  function reset() {
    gen++
    names = null
    plan = null
    prints = new Map()
    logs = { source: [], target: [] }
    nameTouched = false
  }

  function fail(e: unknown) {
    plan = null
    prints = new Map()
    const { source, target } = snap()
    const code = e instanceof ApiError ? e.code : 'error'
    const next: MergeSnapshot = {
      ...IDLE,
      status: 'error',
      error: SENTENCES[code] ?? (e instanceof Error ? e.message : String(e)),
      errorCode: code,
    }
    if (source) next.source = source
    if (target) next.target = target
    store.setState({ snapshot: next })
  }

  // The Branch's own Changes up to `seq`, fetching only what is not here yet. Who changed what is a nicety:
  // a failure leaves the log as it is.
  async function logUpTo(g: number, side: 'source' | 'target', id: string, seq: number): Promise<void> {
    if (logs[side].length >= seq) return
    const after = logs[side].length
    try {
      const r = await request<ChangesResponse>('GET', `${branchPath(id)}/changes?after=${after}`)
      if (g === gen && logs[side].length === after) logs[side].push(...r.changes)
    } catch {
      // authors stay unknown
    }
  }

  async function boardAt(head: BoardResponse, moment: Moment): Promise<Entities> {
    if (head.seq === moment.seq) return head.entities
    const r = await request<BoardResponse>('GET', `${branchPath(moment.branch)}/board?at=${moment.seq}`)
    return r.entities
  }

  // Plans the Merge and builds the review from it. Throws when it cannot; does nothing once `g` is outdated.
  // `kept`: choices from the plan before, each used again if its Conflict is still about the same values.
  async function load(g: number, source: BranchInfo, target: BranchInfo, kept: Kept, replanned: boolean): Promise<void> {
    const query = `source=${encodeURIComponent(source.id)}&target=${encodeURIComponent(target.id)}`
    const [planned, sourceHead, targetHead, cps] = await Promise.all([
      request<{ plan: MergePlan }>('GET', `/api/merges/plan?${query}`),
      request<BoardResponse>('GET', `${branchPath(source.id)}/board`),
      request<BoardResponse>('GET', `${branchPath(target.id)}/board`),
      request<{ checkpoints: Checkpoint[] }>('GET', `${branchPath(target.id)}/checkpoints`),
      logUpTo(g, 'source', source.id, Number.MAX_SAFE_INTEGER),
      logUpTo(g, 'target', target.id, Number.MAX_SAFE_INTEGER),
    ])
    if (g !== gen) return
    const next = planned.plan
    // A Branch may have moved between the requests: read each Board and log at the planned moment.
    const needsBase = next.conflicts.some((c) => 'EditVsDelete' in c)
    const [sourceBoard, targetBoard, base] = await Promise.all([
      boardAt(sourceHead, next.source),
      boardAt(targetHead, next.target),
      needsBase
        ? request<BoardResponse>('GET', `${branchPath(next.base.branch)}/board?at=${next.base.seq}`).then(
            (r) => r.entities,
            () => null,
          )
        : null,
      logUpTo(g, 'source', source.id, next.source.seq),
      logUpTo(g, 'target', target.id, next.target.seq),
    ])
    if (g !== gen) return

    const built = buildConflicts(next, {
      sourceName: source.name,
      targetName: target.name,
      source: sourceBoard,
      target: targetBoard,
      base,
      sourceChanges: logs.source.slice(0, next.source.seq),
      targetChanges: logs.target.slice(0, next.target.seq),
    })
    const conflicts = built.map(({ vm, print }) => {
      const before = kept.get(vm.id)
      return before && before.print === print ? { ...vm, choice: before.choice } : vm
    })
    const auto = buildAuto(next, sourceBoard, targetBoard)
    const taken = cps.checkpoints.map((c) => c.name)
    const snapshot: MergeSnapshot = {
      status: 'ready',
      source: source.seq === next.source.seq ? source : { ...source, seq: next.source.seq },
      target: target.seq === next.target.seq ? target : { ...target, seq: next.target.seq },
      auto: auto.lines.length > 0 ? auto.lines : NO_LINES,
      autoSummary: auto.summary,
      layoutKept: countLayoutKept(next, sourceBoard, targetBoard),
      conflicts: conflicts.length > 0 ? conflicts : NO_CONFLICTS,
      decided: conflicts.filter((c) => c.choice !== null).length,
      nothingToMerge: next.auto.length === 0 && next.conflicts.length === 0,
      checkpointName: nameTouched ? snap().checkpointName : defaultCheckpointName(source.name, taken),
      replanned,
    }
    plan = next
    prints = new Map(built.map(({ vm, print }) => [vm.id, print]))
    store.setState({ snapshot })
  }

  function keptChoices(): Kept {
    const kept: Kept = new Map()
    for (const c of snap().conflicts) {
      const print = prints.get(c.id)
      if (c.choice !== null && print !== undefined) kept.set(c.id, { choice: c.choice, print })
    }
    return kept
  }

  async function open(sourceName: string, targetName: string): Promise<void> {
    reset()
    const g = gen
    names = { source: sourceName, target: targetName }
    if (isGuest()) {
      store.setState({ snapshot: IDLE })
      fail(new ApiError(403, 'forbidden', SENTENCES.forbidden!))
      return
    }
    store.setState({ snapshot: { ...IDLE, status: 'loading' } })
    try {
      const { branches: list } = await request<{ branches: BranchInfo[] }>('GET', '/api/branches')
      if (g !== gen) return
      setBranches(list)
      const source = list.find((b) => b.name === sourceName)
      const target = list.find((b) => b.name === targetName)
      if (!source || !target) {
        throw new ApiError(404, 'not_found', `There is no Branch named ${source ? targetName : sourceName}.`)
      }
      set({ source, target })
      await load(g, source, target, new Map(), false)
    } catch (e) {
      if (g === gen) fail(e)
    }
  }

  function close() {
    reset()
    if (snap() !== IDLE) store.setState({ snapshot: IDLE })
  }

  async function refresh(): Promise<void> {
    const s = snap()
    if (!names || s.status === 'idle' || s.status === 'loading' || s.status === 'applying' || s.status === 'merged') return
    if (s.status === 'error' || !s.source || !s.target || !plan) {
      await open(names.source, names.target) // nothing to keep: start over
      return
    }
    const g = ++gen
    const before = JSON.stringify(plan)
    set({ status: 'loading' })
    try {
      await load(g, s.source, s.target, keptChoices(), s.replanned)
      if (g === gen && JSON.stringify(plan) !== before) set({ replanned: true })
    } catch (e) {
      if (g === gen) fail(e)
    }
  }

  function decide(conflictId: string, choice: Choice | null): void {
    const s = snap()
    if (s.status !== 'ready') return
    const at = s.conflicts.findIndex((c) => c.id === conflictId)
    const current = s.conflicts[at]
    if (!current) return
    if (choice !== null && typeof choice === 'object' && !current.canEdit) return
    const conflicts = s.conflicts.slice()
    conflicts[at] = { ...current, choice }
    set({ conflicts, decided: conflicts.filter((c) => c.choice !== null).length, replanned: false })
  }

  function setCheckpointName(name: string): void {
    const s = snap()
    if (s.status !== 'ready' || s.checkpointName === name) return
    nameTouched = true
    set({ checkpointName: name })
  }

  async function apply(): Promise<void> {
    const s = snap()
    if (isGuest()) throw new ApiError(403, 'forbidden', SENTENCES.forbidden!)
    if (s.status !== 'ready' || !plan || !s.source || !s.target) {
      throw new ApiError(400, 'not_ready', 'There is no Merge ready to apply.')
    }
    const { decisions, undecided } = toDecisions(s.conflicts)
    if (undecided.length > 0) {
      throw new ApiError(400, 'undecided', 'Decide every Conflict before merging.', undecided)
    }
    const checkpoint = s.checkpointName.trim()
    if (checkpoint === '') throw new ApiError(400, 'bad_request', 'Give the Checkpoint a name.')
    const g = gen
    const { source, target } = s
    set({ status: 'applying' })
    let r: MergeResponse
    try {
      r = await request<MergeResponse>('POST', '/api/merges', { plan, decisions, checkpoint })
    } catch (e) {
      if (g !== gen) throw e
      if (e instanceof ApiError && e.code === 'stale') {
        // A Branch changed under the review: plan again and keep the choices that are still about the same thing.
        try {
          await load(g, source, target, keptChoices(), true)
        } catch (again) {
          if (g === gen) fail(again)
        }
      } else {
        set({ status: 'ready' })
      }
      throw e
    }
    if (g !== gen) return
    const result: NonNullable<MergeSnapshot['result']> = { seq: r.seq, changes: r.changes.length }
    if (r.checkpoint) result.checkpoint = r.checkpoint
    plan = null
    set({
      status: 'merged',
      result,
      replanned: false,
      target: { ...target, seq: r.seq, checkpoints: target.checkpoints + (r.checkpoint ? 1 : 0) },
    })
    // If the Board shows the target, it gets the Merge now instead of waiting for the socket.
    const shown = boardSync.internal.target()
    if (shown && shown.id === target.id) {
      if (r.checkpoint) boardSync.internal.checkpoints(shown.token, [r.checkpoint], false)
      boardSync.internal.confirm(shown.token, r.seq, r.changes)
    }
    try {
      const { branches: list } = await request<{ branches: BranchInfo[] }>('GET', '/api/branches')
      setBranches(list)
    } catch {
      // the `branches` frame brings the list too
    }
  }

  // A Merge under review does not outlive the session.
  sessionStore.subscribe((session) => {
    if (session.status === 'signed_out') close()
  })

  return { store, open, close, decide, setCheckpointName, apply, refresh }
}

const instance = createMerge(sync)

export const merge = {
  open: instance.open,
  close: instance.close,
  decide: instance.decide,
  setCheckpointName: instance.setCheckpointName,
  apply: instance.apply,
  refresh: instance.refresh,
}

export function useMerge(): MergeSnapshot {
  return useStore(instance.store, (s) => s.snapshot)
}
