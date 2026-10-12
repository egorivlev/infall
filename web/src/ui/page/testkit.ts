// Test helpers: a stand-in for the parts of `../../lib` the Page panel uses. Only imported by tests.
// Blocks, Sources and Attachments live in a small store that `board.submit` updates at once, the
// way the real Board applies ops optimistically. The M4 op builders are replaced by tagged objects
// (`{ fake: 'setBlockText', … }`) so tests can say exactly what was submitted.
import { useMemo } from 'react'
import { vi } from 'vitest'
import { create } from 'zustand'
import type { BlockVM, CardVM, Member, PageVM, RunResult, RunsSnapshot, SessionSnapshot, SourceVM, Todo } from '../../lib'
import { ANA, MEI, createFakeLib } from '../history/testkit'

export { ANA, MEI }
export const GUEST: Member = { id: 'gus', name: 'Gus Visitor', role: 'guest', color: 'rgb(90, 90, 90)' }

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

export const block = (id: string, cardId: string, order: string, text: string): BlockVM => ({ id, card: cardId, type: 'text', text, title: '', order })

/** A text Block pinned from an AI Conversation. */
export const pinned = (id: string, cardId: string, order: string, text: string, ai: NonNullable<BlockVM['ai']>): BlockVM => ({
  ...block(id, cardId, order, text),
  ai,
})

/** A Visual: `source` is its HTML/JavaScript. */
export const visual = (id: string, cardId: string, order: string, title: string, source: string): BlockVM => ({
  id,
  card: cardId,
  type: 'visual',
  text: source,
  title,
  order,
})

/** A Run: `code` is its Python; `result` the captured output of its last execution (null: never executed). */
export const run = (id: string, cardId: string, order: string, title: string, code: string, result: RunResult | null = null, broken = false): BlockVM => ({
  id,
  card: cardId,
  type: 'run',
  text: code,
  title,
  order,
  run: { result, broken },
})

/** A recorded result: by Mei, exit 0, 3.0 s, no figures. */
export const runResult = (extra: Partial<RunResult> = {}): RunResult => ({
  v: 1,
  by: MEI.id,
  at: new Date(new Date().getFullYear(), 10, 12, 14, 2).getTime(),
  code_sha256: 'a'.repeat(64),
  exit: 0,
  duration_ms: 3000,
  output: 'episode 500  reward 176.4\n',
  figures: [],
  ...extra,
})

/** What `useRuns()` says in a browser with nothing going on — the same as the real one under jsdom. */
const NO_RUNS: RunsSnapshot = { runner: { available: false, reason: 'browser' }, live: null, last: null }

export const source = (id: string, extra: Partial<SourceVM> = {}): SourceVM => ({
  id,
  url: '',
  doi: '',
  title: '',
  authors: '',
  year: '',
  note: '',
  cards: [],
  ...extra,
})

export const todo = (id: string, owner: string, text: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  owner,
  text,
  done: false,
  created_by: owner,
  created_at: 1,
  ...extra,
})

type Attachment = { id: string; card: string; source: string }
type PageState = {
  blocks: BlockVM[]
  sources: SourceVM[]
  attachments: Attachment[]
  deleted: ReadonlySet<string>
  editors: Record<string, PageVM['editor']>
}
/** Either one of the tagged fakes below (`fake` is set) or a real wire op from the M1 builders. */
type AnyOp = {
  fake?: string
  Delete?: { entity: string }
  Undelete?: { entity: string }
  Set?: { entity: string; field: string; value: unknown }
} & Record<string, unknown>

const EMPTY: PageState = { blocks: [], sources: [], attachments: [], deleted: new Set(), editors: {} }
const NO_PAGE: PageVM = { card: null, blocks: [], sources: [], connections: [], editor: null }

export function createFakePageLib() {
  const base = createFakeLib()
  const { boardStore } = base
  const pageStore = create<PageState>(() => EMPTY)
  const todoStore = create<{ list: Todo[] }>(() => ({ list: [] }))
  const sessionStore = create<SessionSnapshot>(() => ({ status: 'signed_in', member: ANA }))
  const runsStore = create<RunsSnapshot>(() => NO_RUNS)
  /** What `useRunStale` answers per Block id; without an entry: false when there is a result, else null. */
  const staleStore = create<{ by: Record<string, boolean | null> }>(() => ({ by: {} }))
  let made = 0

  const fakeOps = {
    addBlock: (input: { id?: string; card: string; type?: 'text' | 'visual' | 'run'; title?: string; text: string; order: string }) => ({
      fake: 'addBlock',
      ...input,
    }),
    setBlockTitle: (id: string, title: string) => ({ fake: 'setBlockTitle', block: id, title }),
    setRunResult: (id: string, result: RunResult | null) => ({ fake: 'setRunResult', block: id, result }),
    setBlockText: (id: string, text: string) => ({ fake: 'setBlockText', block: id, text }),
    moveBlock: (id: string, order: string) => ({ fake: 'moveBlock', block: id, order }),
    markReviewed: (id: string, memberId: string) => ({ fake: 'markReviewed', block: id, member: memberId }),
    createSource: (input: Record<string, string | undefined>) => ({ fake: 'createSource', ...input }),
    setSourceField: (id: string, field: string, text: string) => ({ fake: 'setSourceField', source: id, field, text }),
    attach: (input: { id?: string; card: string; source: string }) => ({ fake: 'attach', ...input }),
  }

  function apply(op: AnyOp) {
    const s = pageStore.getState()
    if (op.Delete) return pageStore.setState({ deleted: new Set(s.deleted).add(op.Delete.entity) })
    if (op.Undelete) {
      const deleted = new Set(s.deleted)
      deleted.delete(op.Undelete.entity)
      return pageStore.setState({ deleted })
    }
    if (op.Set) {
      const { entity, field, value } = op.Set
      const text = value === 'Null' ? '' : ((value as { Text?: string }).Text ?? '')
      if (field !== 'title' && field !== 'status') return
      return boardStore.setState((b) => ({ cards: b.cards.map((c) => (c.id === entity ? { ...c, [field]: text } : c)) }))
    }
    switch (op.fake) {
      case 'addBlock':
        return pageStore.setState({
          blocks: [
            ...s.blocks,
            op.type === 'visual'
              ? visual(String(op.id), String(op.card), String(op.order), String(op.title ?? ''), String(op.text))
              : op.type === 'run'
                ? run(String(op.id), String(op.card), String(op.order), String(op.title ?? ''), String(op.text))
                : block(String(op.id), String(op.card), String(op.order), String(op.text)),
          ],
        })
      case 'setBlockTitle':
        return pageStore.setState({ blocks: s.blocks.map((b) => (b.id === op.block ? { ...b, title: String(op.title) } : b)) })
      case 'setRunResult':
        return pageStore.setState({
          blocks: s.blocks.map((b) => (b.id === op.block ? { ...b, run: { result: (op.result as RunResult | null) ?? null, broken: false } } : b)),
        })
      case 'setBlockText':
        return pageStore.setState({ blocks: s.blocks.map((b) => (b.id === op.block ? { ...b, text: String(op.text) } : b)) })
      case 'markReviewed':
        return pageStore.setState({
          blocks: s.blocks.map((b) => (b.id === op.block && b.ai ? { ...b, ai: { ...b.ai, reviewedBy: String(op.member) } } : b)),
        })
      case 'moveBlock':
        return pageStore.setState({ blocks: s.blocks.map((b) => (b.id === op.block ? { ...b, order: String(op.order) } : b)) })
      case 'createSource': {
        const { fake: _fake, id, ...fields } = op
        return pageStore.setState({ sources: [...s.sources, source(String(id), fields as Partial<SourceVM>)] })
      }
      case 'setSourceField':
        return pageStore.setState({ sources: s.sources.map((x) => (x.id === op.source ? { ...x, [String(op.field)]: String(op.text) } : x)) })
      case 'attach':
        return pageStore.setState({
          attachments: [...s.attachments, { id: String(op.id ?? `att-${++made}`), card: String(op.card), source: String(op.source) }],
        })
    }
  }

  /** Applies at once, like the real optimistic Board; resolves like a confirmed submit. */
  const submit = vi.fn(async (batch: unknown[]): Promise<void> => {
    for (const op of batch) apply(op as AnyOp)
  })

  const liveSources = () => {
    const s = pageStore.getState()
    return s.sources.filter((x) => !s.deleted.has(x.id))
  }

  function usePage(cardId: string | null): PageVM {
    const board = boardStore()
    const s = pageStore()
    return useMemo(() => {
      if (!cardId) return NO_PAGE
      const here = board.cards.find((c) => c.id === cardId) ?? null
      const byId = new Map(board.cards.map((c) => [c.id, c]))
      return {
        card: here,
        blocks: s.blocks
          .filter((b) => b.card === cardId && !s.deleted.has(b.id))
          .sort((a, b) => Number(a.order) - Number(b.order) || a.id.localeCompare(b.id)),
        sources: s.attachments
          .filter((a) => a.card === cardId && !s.deleted.has(a.id))
          .flatMap((a) => {
            const src = s.sources.find((x) => x.id === a.source && !s.deleted.has(x.id))
            return src ? [{ ...src, attachment: a.id }] : []
          }),
        connections: board.connections.flatMap((c) => {
          if (c.from !== cardId && c.to !== cardId) return []
          const other = byId.get(c.from === cardId ? c.to : c.from)
          if (!other) return []
          const direction = c.kind !== 'directed' ? ('none' as const) : c.from === cardId ? ('out' as const) : ('in' as const)
          return [{ id: c.id, other, direction, kind: c.kind, label: c.label }]
        }),
        editor: s.editors[cardId] ?? null,
      }
    }, [cardId, board.cards, board.connections, s])
  }

  const page = {
    startEditing: vi.fn((_cardId: string): void => {}),
    stopEditing: vi.fn((): void => {}),
    findSource: vi.fn((input: { url?: string; doi?: string }): SourceVM | undefined =>
      liveSources().find((x) => (input.doi ? x.doi === input.doi : input.url ? x.url === input.url : false)),
    ),
  }

  const runs = {
    refresh: vi.fn(async (): Promise<void> => {}),
    configure: vi.fn(async (): Promise<void> => {}),
    run: vi.fn(async (_block: string): Promise<void> => {}),
    stop: vi.fn((): void => {}),
    saveAgain: vi.fn(async (): Promise<void> => {}),
    dismiss: vi.fn((): void => {
      runsStore.setState({ last: null })
    }),
  }
  const useRunStale = (b: BlockVM): boolean | null => {
    const by = staleStore((s) => s.by)
    return b.id in by ? by[b.id]! : b.run?.result ? false : null
  }

  const todos = {
    reload: vi.fn(async (): Promise<void> => {}),
    add: vi.fn(async (input: { owner: string; text: string; card?: Todo['card'] }): Promise<Todo> => {
      const me = sessionStore.getState()
      const created: Todo = todo(`todo-${++made}`, input.owner, input.text, {
        card: input.card,
        created_by: me.status === 'signed_in' ? me.member.id : input.owner,
      })
      todoStore.setState((s) => ({ list: [...s.list, created] }))
      return created
    }),
    setDone: vi.fn(async (id: string, done: boolean): Promise<void> => {
      todoStore.setState((s) => ({ list: s.list.map((t) => (t.id === id ? { ...t, done } : t)) }))
    }),
    edit: vi.fn(async (): Promise<void> => {}),
    remove: vi.fn(async (): Promise<void> => {}),
  }

  const people = { reload: vi.fn(async (): Promise<void> => {}), remove: vi.fn(async (): Promise<void> => {}) }

  /** Order keys in tests are plain numbers: '1', '2', '2.5'. */
  const orderBetween = vi.fn((before?: string, after?: string): string => {
    if (before !== undefined && after !== undefined) return String((Number(before) + Number(after)) / 2)
    if (before !== undefined) return String(Number(before) + 1)
    if (after !== undefined) return String(Number(after) - 1)
    return '1'
  })

  const normalizeDoi = (text: string): string => {
    const m = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i.exec(text.trim())
    return m ? m[1]!.toLowerCase() : ''
  }
  const normalizeUrl = (text: string): string => {
    const t = text.trim()
    if (!/^https?:\/\//i.test(t)) return ''
    try {
      const url = new URL(t)
      url.hash = ''
      return url.href.replace(/\/$/, '')
    } catch {
      return ''
    }
  }

  return {
    ...base,
    pageStore,
    todoStore,
    sessionStore,
    runsStore,
    staleStore,
    runs,
    submit,
    page,
    todos,
    people,
    orderBetween,
    reset() {
      base.reset()
      pageStore.setState(EMPTY, true)
      todoStore.setState({ list: [] }, true)
      sessionStore.setState({ status: 'signed_in', member: ANA }, true)
      runsStore.setState(NO_RUNS, true)
      staleStore.setState({ by: {} }, true)
      made = 0
      for (const fn of Object.values(runs)) fn.mockReset()
      runs.refresh.mockImplementation(async () => {})
      runs.configure.mockImplementation(async () => {})
      runs.run.mockImplementation(async () => {})
      runs.saveAgain.mockImplementation(async () => {})
      runs.dismiss.mockImplementation(() => {
        runsStore.setState({ last: null })
      })
      for (const group of [page, todos, people]) for (const fn of Object.values(group)) fn.mockClear()
      submit.mockClear()
      orderBetween.mockClear()
    },
    /** `vi.mock('../../lib', async (orig) => fake.module(await orig()))`. */
    module<T extends { ops: object }>(real: T) {
      return {
        ...real,
        ...base.lib,
        ops: { ...real.ops, ...fakeOps },
        VISUAL_FRAME_PATH: '/visual-frame',
        board: { open: vi.fn(), close: vi.fn(), submit: (batch: unknown[]) => submit(batch) },
        usePage,
        useSources: () => {
          const s = pageStore()
          return s.sources.filter((x) => !s.deleted.has(x.id))
        },
        page,
        useTodos: () => todoStore((s) => s.list),
        todos,
        useSession: () => sessionStore(),
        useRuns: () => runsStore(),
        runs,
        useRunStale,
        members: people,
        orderBetween,
        normalizeDoi,
        normalizeUrl,
      }
    },
  }
}
