// Test helpers for the Tutorial: a stand-in for the data layer whose state a test sets by hand, so each step can be
// shown to notice what the person did. Use with
//   const h = vi.hoisted(() => ({ kit: null as unknown as Kit }))
//   vi.mock('../../../lib', async () => (h.kit = (await import('./testkit')).makeKit()).module)
import { useSyncExternalStore } from 'react'
import { vi } from 'vitest'
import type {
  AiSetup,
  AiSnapshot,
  BlockVM,
  BoardSnapshot,
  BranchInfo,
  CardVM,
  ConnectionVM,
  FrameVM,
  MergeSnapshot,
  PageVM,
  RunsSnapshot,
  SuggestionVM,
  Todo,
} from '../../../lib'
import { SAMPLE } from './names'

export type World = {
  board: BoardSnapshot
  todos: Todo[]
  suggestions: SuggestionVM[]
  merge: MergeSnapshot
  runs: RunsSnapshot
  ai: AiSnapshot
  branches: BranchInfo[]
  /** Blocks of each Card's Page, by Card id. */
  blocks: Record<string, BlockVM[]>
}

const MAIN: BranchInfo = { id: 'main-id', name: 'main', seq: 10, checkpoints: 1 }
const LONGER: BranchInfo = { id: 'longer-id', name: SAMPLE.branch, seq: 12, checkpoints: 0, parent: { branch: 'main-id', seq: 9 } }

export function card(id: string, title: string, patch: Partial<CardVM> = {}): CardVM {
  return { id, title, summary: '', status: 'idea', x: 0, y: 0, w: 224, h: 132, blocks: 0, sources: 0, ...patch }
}

export function block(id: string, cardId: string, patch: Partial<BlockVM> = {}): BlockVM {
  return { id, card: cardId, type: 'text', text: '', title: '', order: 'U', ...patch }
}

/** The sample Board of a Tutorial Workspace, as far as the steps look at it. */
export function sampleWorld(): World {
  const cards = [
    card('welcome', SAMPLE.welcome, { status: 'understood', x: 0, y: 0 }),
    card('paper-a', 'Pólya 1921', { status: 'reading', x: 600, y: 0, sources: 1 }),
    card('paper-b', 'Einstein 1905', { status: 'reading', x: 900, y: 0 }),
    card('run', SAMPLE.run, { status: 'open_question', x: 0, y: 600 }),
    card('visual', SAMPLE.visual, { x: 300, y: 600 }),
  ]
  const frames: FrameVM[] = [{ id: 'f-start', title: SAMPLE.frames.start, x: -40, y: -40, w: 320, h: 220 }]
  const connections: ConnectionVM[] = [{ id: 'k1', from: 'paper-a', to: 'paper-b', kind: 'related', label: 'both about diffusion' }]
  const result = { v: 1 as const, by: 'me', at: 1000, code_sha256: 'a'.repeat(64), exit: 0, duration_ms: 900, output: 'n=10 msd=10.1\n', figures: [] }
  return {
    board: { status: 'live', branch: MAIN, seq: 10, cards, frames, connections, presence: [], pending: 0, readOnly: false },
    todos: [{ id: 't1', owner: 'me', text: SAMPLE.todo, done: false, created_by: 'me', created_at: 1, card: { id: 'welcome', title: SAMPLE.welcome, branch: 'main-id' } }],
    suggestions: [
      {
        suggestion: { id: 's1', branch: 'main-id', kind: 'connection', connection: { from: 'paper-a', to: 'paper-b', kind: 'directed' }, reason: 'r', created_by: 'me', created_at: 1, state: 'pending' },
        title: 'Pólya 1921 → Einstein 1905',
        meta: 'directed',
        target: 'Board: main',
        cards: ['paper-a', 'paper-b'],
        stale: false,
      },
    ],
    merge: { status: 'idle', auto: [], autoSummary: '', layoutKept: 0, conflicts: [], decided: 0, nothingToMerge: false, checkpointName: '', replanned: false },
    runs: { runner: { available: true, python: { path: '/usr/bin/python3', version: '3.12.3' } }, live: null, last: null },
    ai: { setup: { provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: { enabled: true } }, conversations: [], current: null, busy: false },
    branches: [MAIN, LONGER],
    blocks: {
      welcome: [block('b-w', 'welcome', { text: 'A random walk: $x_n$.' })],
      run: [block('b-run', 'run', { type: 'run', title: 'msd', text: 'print(1)', run: { result, broken: false } })],
      visual: [block('b-vis', 'visual', { type: 'visual', title: 'A walk', text: '<canvas></canvas>' })],
    },
  }
}

export const BRANCHES = { main: MAIN, longer: LONGER }

const NO_BLOCKS: BlockVM[] = []
const EMPTY_PAGE: PageVM = { card: null, blocks: [], sources: [], connections: [], editor: null }

export function makeKit() {
  const listeners = new Set<() => void>()
  const kit = {
    w: sampleWorld(),
    /** What `PUT /api/local/tutorial` was given, in order. */
    saved: [] as unknown[],
    /** What `GET /api/local/tutorial` answers. */
    stored: null as unknown,
    /** When set, `GET /api/local/tutorial` rejects with it. */
    loadFails: null as unknown,
    calls: { runsRefresh: 0, runsConfigure: 0, aiRefresh: 0 },
    pages: new Map<string, PageVM>(),
    set(patch: Partial<World> | ((w: World) => Partial<World>)) {
      kit.w = { ...kit.w, ...(typeof patch === 'function' ? patch(kit.w) : patch) }
      for (const l of listeners) l()
    },
    board(patch: Partial<BoardSnapshot> | ((b: BoardSnapshot) => Partial<BoardSnapshot>)) {
      kit.set((w) => ({ board: { ...w.board, ...(typeof patch === 'function' ? patch(w.board) : patch) } }))
    },
    reset() {
      kit.w = sampleWorld()
      kit.saved = []
      kit.stored = null
      kit.loadFails = null
      kit.calls = { runsRefresh: 0, runsConfigure: 0, aiRefresh: 0 }
      kit.pages.clear()
    },
    setRunner(runner: RunsSnapshot['runner']) {
      kit.set((w) => ({ runs: { ...w.runs, runner } }))
    },
    setAi(setup: AiSetup) {
      kit.set((w) => ({ ai: { ...w.ai, setup } }))
    },
    module: {} as Record<string, unknown>,
  }
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
  const use = <T>(pick: (w: World) => T): T => useSyncExternalStore(subscribe, () => pick(kit.w))
  // A Page keeps its identity while its Card and blocks do, as the real one does.
  const pageOf = (w: World, id: string | null): PageVM => {
    if (id === null) return EMPTY_PAGE
    const c = w.board.cards.find((x) => x.id === id)
    if (!c) return EMPTY_PAGE
    const blocks = w.blocks[id] ?? NO_BLOCKS
    const was = kit.pages.get(id)
    if (was && was.card === c && was.blocks === blocks) return was
    const page: PageVM = { ...EMPTY_PAGE, card: c, blocks }
    kit.pages.set(id, page)
    return page
  }
  kit.module = {
    useBoard: () => use((w) => w.board),
    useTodos: () => use((w) => w.todos),
    useSuggestions: () => use((w) => w.suggestions),
    useMerge: () => use((w) => w.merge),
    useRuns: () => use((w) => w.runs),
    useAi: () => use((w) => w.ai),
    useBranches: () => use((w) => w.branches),
    usePage: (id: string | null) => use((w) => pageOf(w, id)),
    runs: { refresh: vi.fn(async () => void kit.calls.runsRefresh++), configure: vi.fn(async () => void kit.calls.runsConfigure++) },
    ai: { refresh: vi.fn(async () => void kit.calls.aiRefresh++) },
    workspace: {
      loadTutorial: async () => {
        if (kit.loadFails) throw kit.loadFails
        return kit.stored
      },
      saveTutorial: async (state: unknown) => {
        kit.saved.push(JSON.parse(JSON.stringify(state)))
        kit.stored = state
      },
    },
  }
  return kit
}

export type Kit = ReturnType<typeof makeKit>
