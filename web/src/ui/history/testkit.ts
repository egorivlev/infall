// Test helpers: a stand-in for the parts of `../../lib` the History UI uses. Only imported by tests.
import { vi } from 'vitest'
import { create } from 'zustand'
import type { Activity, BoardPreview, BoardSnapshot, CardVM, Checkpoint, HistorySnapshot, Member } from '../../lib'

const YEAR = new Date().getFullYear()
/** A local time in November of the current year. */
export const at = (day: number, hour: number, minute = 0) => new Date(YEAR, 10, day, hour, minute).getTime()

export const ANA: Member = { id: 'ana', name: 'Ana Ruiz', role: 'member', color: 'rgb(200, 120, 40)' }
export const MEI: Member = { id: 'mei', name: 'Mei Tanaka', role: 'admin', color: 'rgb(40, 120, 200)' }

export const MAIN = { id: 'main-id', name: 'main', seq: 9, checkpoints: 3 }

const moment = (seq: number) => ({ branch: MAIN.id, seq })
export const CHECKPOINTS: Checkpoint[] = [
  { name: 'Start', moment: moment(0), author: 'ana', at: at(14, 8, 55) },
  { name: 'Kick-off', moment: moment(4), author: 'mei', at: at(14, 10, 30) },
  { name: 'Reading group', moment: moment(6), author: 'gone', at: at(15, 11, 5) },
]

export const ACTIVITIES: Activity[] = [
  {
    id: 'a1',
    author: 'ana',
    kind: 'edit',
    fromSeq: 0,
    toSeq: 3,
    startedAt: at(14, 9, 0),
    endedAt: at(14, 9, 12),
    count: 3,
    lines: ['Added Card Surface code basics', 'Added Card MWPM decoder', 'Connected Surface code basics → MWPM decoder'],
    checkpoints: [],
  },
  {
    id: 'a2',
    author: 'mei',
    kind: 'edit',
    fromSeq: 3,
    toSeq: 5,
    startedAt: at(14, 10, 0),
    endedAt: at(14, 10, 0),
    count: 2,
    lines: ['Status: MWPM decoder → Understood', 'Moved 1 Card'],
    checkpoints: [CHECKPOINTS[1]!],
  },
  {
    id: 'a3',
    author: 'gone',
    kind: 'edit',
    fromSeq: 5,
    toSeq: 6,
    startedAt: at(15, 11, 0),
    endedAt: at(15, 11, 0),
    count: 1,
    lines: ['Removed Card MWPM decoder'],
    checkpoints: [CHECKPOINTS[2]!],
  },
  {
    id: 'a4',
    author: 'ana',
    kind: 'restore',
    fromSeq: 6,
    toSeq: 9,
    startedAt: at(15, 12, 0),
    endedAt: at(15, 12, 0),
    count: 3,
    lines: ['Restored to an earlier moment'],
    checkpoints: [],
  },
]

export const READY: HistorySnapshot = {
  status: 'ready',
  branch: MAIN,
  head: 9,
  activities: ACTIVITIES,
  checkpoints: CHECKPOINTS,
  preview: null,
}

export const IDLE: HistorySnapshot = { status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }

export const card = (id: string, title: string, extra: Partial<CardVM> = {}): CardVM => ({
  id,
  title,
  summary: '',
  status: 'idea',
  x: 0,
  y: 0,
  w: 224,
  h: 132,
  blocks: 0,
  sources: 0,
  ...extra,
})

const BOARD: BoardSnapshot = {
  status: 'live',
  branch: MAIN,
  seq: 9,
  cards: [],
  frames: [],
  connections: [],
  presence: [],
  pending: 0,
  readOnly: false,
}

/** Stores the tests drive, plus mocks with the shape of the real `history`, `useHistory`, `useBoard`, `useMembers`. */
export function createFakeLib() {
  const historyStore = create<HistorySnapshot>(() => READY)
  const boardStore = create<BoardSnapshot>(() => BOARD)
  const membersStore = create<{ list: Member[] }>(() => ({ list: [ANA, MEI] }))
  /** What the Board looked like at a moment; tests may replace it. */
  const boardAt = { fn: (_seq: number): Pick<BoardPreview, 'cards' | 'frames' | 'connections'> => ({ cards: [], frames: [], connections: [] }) }

  const previewOf = (seq: number): BoardPreview => {
    const s = historyStore.getState()
    // Time of the last Change before this moment: the Activity that reaches it.
    const reached = s.activities.filter((a) => a.fromSeq < seq)
    const last = reached[reached.length - 1]
    return { seq, at: last ? last.endedAt : null, ...boardAt.fn(seq) }
  }

  const history = {
    open: vi.fn(async (): Promise<void> => {}),
    close: vi.fn((): void => {}),
    preview: vi.fn((seq: number | null): void => {
      historyStore.setState({ preview: seq === null ? null : previewOf(seq) })
    }),
    restore: vi.fn(async (_toSeq: number): Promise<void> => {}),
    createCheckpoint: vi.fn(),
  }

  return {
    historyStore,
    boardStore,
    membersStore,
    boardAt,
    history,
    reset() {
      historyStore.setState(READY, true)
      boardStore.setState(BOARD, true)
      membersStore.setState({ list: [ANA, MEI] }, true)
      boardAt.fn = () => ({ cards: [], frames: [], connections: [] })
      for (const fn of Object.values(history)) fn.mockClear()
      history.open.mockImplementation(async () => {})
      history.restore.mockImplementation(async () => {})
    },
    /** Spread over the real module in `vi.mock('../../lib', …)`. */
    lib: {
      history,
      useHistory: () => historyStore(),
      useBoard: () => boardStore(),
      useMembers: () => membersStore((s) => s.list),
    },
  }
}
