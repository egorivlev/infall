// Test helpers: a stand-in for the parts of `../../lib` the Merge review uses. Only imported by tests.
import { create } from 'zustand'
import type { BranchInfo, Choice, ConflictVM, Member, MergeSnapshot } from '../../lib'

const YEAR = new Date().getFullYear()
/** A local time in November of the current year. */
export const at = (day: number, hour = 10, minute = 0) => new Date(YEAR, 10, day, hour, minute).getTime()

export const ELENA: Member = { id: 'elena', name: 'Elena Varga', role: 'admin', color: '#aaa' }
export const MEI: Member = { id: 'mei', name: 'Mei Lin', role: 'member', color: '#bbb' }

export const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }
export const QEC: BranchInfo = { id: 'b-qec', name: 'try-QEC', seq: 14, checkpoints: 0, parent: { branch: 'b-main', seq: 30 }, created_by: 'mei', created_at: at(14) }

export const TITLE: ConflictVM = {
  id: 'c1:title',
  key: { entity: 'c1', field: 'title' },
  type: 'field',
  entityKind: 'Card',
  entityTitle: 'Threshold ≈ 1%',
  field: 'title',
  headline: 'Title changed on both',
  target: { text: 'Threshold ≈ 1% (circuit noise)', author: 'elena', at: at(15) },
  source: { text: 'Threshold ≈ 0.57% (MWPM)', author: 'mei', at: at(18) },
  canEdit: true,
  choice: null,
}
export const STATUS: ConflictVM = {
  id: 'c2:status',
  key: { entity: 'c2', field: 'status' },
  type: 'field',
  entityKind: 'Card',
  entityTitle: 'Union-find decoder',
  field: 'status',
  headline: 'Status changed on both',
  target: { text: 'Idea', status: 'idea', author: 'gone', at: at(16) },
  source: { text: 'Understood', status: 'understood', author: 'mei', at: at(19) },
  canEdit: false,
  choice: null,
}
export const DELETED: ConflictVM = {
  id: 'c3:',
  key: { entity: 'c3', field: null },
  type: 'edit_vs_delete',
  entityKind: 'Card',
  entityTitle: 'Neural decoders?',
  field: null,
  headline: 'Deleted on main, edited on try-QEC',
  target: { text: 'Delete the Card' },
  source: { text: 'Keep the Card with its edits: summary', author: 'mei' },
  canEdit: false,
  choice: null,
}

export const IDLE: MergeSnapshot = {
  status: 'idle',
  auto: [],
  autoSummary: '',
  layoutKept: 0,
  conflicts: [],
  decided: 0,
  nothingToMerge: false,
  checkpointName: '',
  replanned: false,
}

export const READY: MergeSnapshot = {
  status: 'ready',
  source: QEC,
  target: MAIN,
  auto: [
    { kind: 'Card added', what: 'Union-find vs MWPM benchmark' },
    { kind: 'Change', what: 'Lattice surgery CNOT · summary' },
    { kind: 'Connection added', what: 'Stim noise model → Threshold ≈ 1% · calibrates' },
  ],
  autoSummary: '3 Changes · 1 Card added, 1 other Change, 1 Connection added',
  layoutKept: 6,
  conflicts: [TITLE, STATUS, DELETED],
  decided: 0,
  nothingToMerge: false,
  checkpointName: 'Before merging try-QEC',
  replanned: false,
}

/** READY with some Conflicts already decided. */
export function decidedWith(choices: Record<string, Choice>): MergeSnapshot {
  const conflicts = READY.conflicts.map((c) => ({ ...c, choice: choices[c.id] ?? null }))
  return { ...READY, conflicts, decided: conflicts.filter((c) => c.choice !== null).length }
}
export const ALL_DECIDED = decidedWith({ [TITLE.id]: 'source', [STATUS.id]: 'target', [DELETED.id]: 'source' })

/** A failure shaped like the data layer's ApiError. */
export const apiError = (status: number, code: string) => Object.assign(new Error(code), { status, code })

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
export function createFakeLib() {
  const store = create<MergeSnapshot>(() => READY)
  const people = create<{ list: Member[] }>(() => ({ list: [ELENA, MEI] }))
  const known = create<{ list: BranchInfo[] }>(() => ({ list: [MAIN, QEC] }))
  const calls = {
    lifecycle: [] as string[], // "open try-QEC main", "close"
    decide: [] as [string, Choice | null][],
    checkpoint: [] as string[],
    apply: 0,
  }
  const impl = {
    open: async (_from: string, _into: string): Promise<void> => {},
    apply: async (): Promise<void> => {},
  }

  const merge = {
    open(from: string, into: string): Promise<void> {
      calls.lifecycle.push(`open ${from} ${into}`)
      return impl.open(from, into)
    },
    close(): void {
      calls.lifecycle.push('close')
    },
    decide(id: string, choice: Choice | null): void {
      calls.decide.push([id, choice])
      store.setState((s) => {
        const conflicts = s.conflicts.map((c) => (c.id === id ? { ...c, choice } : c))
        return { conflicts, decided: conflicts.filter((c) => c.choice !== null).length, replanned: false }
      })
    },
    setCheckpointName(name: string): void {
      calls.checkpoint.push(name)
      store.setState({ checkpointName: name })
    },
    apply(): Promise<void> {
      calls.apply++
      return impl.apply()
    },
    refresh: async (): Promise<void> => {},
  }

  return {
    store,
    people,
    known,
    calls,
    impl,
    reset() {
      store.setState(READY, true)
      people.setState({ list: [ELENA, MEI] }, true)
      known.setState({ list: [MAIN, QEC] }, true)
      calls.lifecycle = []
      calls.decide = []
      calls.checkpoint = []
      calls.apply = 0
      impl.open = async () => {}
      impl.apply = async () => {}
    },
    /** The whole of `../../lib` as far as the Merge review is concerned. */
    lib: {
      merge,
      useMerge: () => store(),
      useMembers: () => people((s) => s.list),
      useBranches: () => known((s) => s.list),
    },
  }
}
