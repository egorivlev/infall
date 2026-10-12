// Test helpers: a stand-in for the parts of `../../lib` the AI sidebar uses (`useAi`, `ai`, `useBoard`).
// Only imported by tests. It does not load the real module.
import { vi } from 'vitest'
import { create } from 'zustand'
import type { AiConversation, AiMessage, AiScope, AiSetup, AiSnapshot, BoardSnapshot, BranchInfo } from '../../lib'

export const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 9, checkpoints: 0 }
export const TRY: BranchInfo = { id: 'b-try', name: 'try-QEC', seq: 3, checkpoints: 0 }

export const CLAUDE: AiSetup = { provider: 'claude-code', label: 'Claude Code', version: '2.1.0', desktop: true, openrouter: { enabled: true } }
export const OPENROUTER: AiSetup = {
  provider: 'openrouter',
  label: 'Claude Sonnet 4.5',
  model: 'anthropic/claude-sonnet-4.5',
  desktop: false,
  openrouter: { enabled: true, key: { last4: 'ab12', added_at: 1 }, model: 'anthropic/claude-sonnet-4.5' },
}
export const none = (reason: Extract<AiSetup, { provider: 'none' }>['reason'], desktop = false): AiSetup => ({
  provider: 'none',
  reason,
  desktop,
  openrouter: { enabled: reason !== 'server_off' },
})

export const BOARD_SCOPE: AiScope = { branch: 'b-main', branchName: 'main' }
export const cardScope = (id: string, title: string): AiScope => ({ ...BOARD_SCOPE, card: { id, title } })

let n = 0
export const asked = (text: string, scope: AiScope = BOARD_SCOPE, extra: Partial<AiMessage> = {}): AiMessage => ({
  id: `u${++n}`,
  role: 'user',
  text,
  at: 1,
  status: 'done',
  scope,
  ...extra,
})
export const answer = (text: string, extra: Partial<AiMessage> = {}): AiMessage => ({
  id: `a${++n}`,
  role: 'assistant',
  text,
  at: 2,
  status: 'done',
  model: 'claude',
  ...extra,
})

const EMPTY: AiSnapshot = { setup: CLAUDE, conversations: [], current: null, busy: false }
const BOARD: BoardSnapshot = { status: 'live', branch: MAIN, seq: 9, cards: [], frames: [], connections: [], presence: [], pending: 0, readOnly: false }

export function createFakeAiLib() {
  const aiStore = create<AiSnapshot>(() => EMPTY)
  const boardStore = create<BoardSnapshot>(() => BOARD)

  const ai = {
    refresh: vi.fn(async (): Promise<void> => {}),
    newConversation: vi.fn((): void => {}),
    open: vi.fn((_id: string): void => {}),
    remove: vi.fn((_id: string): void => {}),
    send: vi.fn(async (_text: string, _scope: AiScope): Promise<void> => {}),
    retry: vi.fn(async (_messageId: string): Promise<void> => {}),
    stop: vi.fn((): void => {}),
    pin: vi.fn(async (_messageId: string, _card: { id: string; title: string }): Promise<{ block: string }> => ({ block: 'blk-1' })),
  }

  const conversation = (messages: AiMessage[], id = 'c1'): AiConversation => ({ id, title: messages[0]?.text ?? '', createdAt: 1, updatedAt: 2, messages })

  return {
    aiStore,
    boardStore,
    ai,
    /** Show these messages as the current Conversation. */
    show(messages: AiMessage[], extra: Partial<AiSnapshot> = {}) {
      aiStore.setState({ current: conversation(messages), ...extra })
    },
    /** Replace one message the way the data layer does: a new object for it, the others untouched. */
    patch(id: string, change: Partial<AiMessage>) {
      aiStore.setState((s) =>
        s.current ? { current: { ...s.current, messages: s.current.messages.map((m) => (m.id === id ? { ...m, ...change } : m)) } } : s,
      )
    },
    reset() {
      aiStore.setState(EMPTY, true)
      boardStore.setState(BOARD, true)
      for (const fn of Object.values(ai)) fn.mockReset()
      ai.refresh.mockImplementation(async () => {})
      ai.send.mockImplementation(async () => {})
      ai.retry.mockImplementation(async () => {})
      ai.pin.mockImplementation(async () => ({ block: 'blk-1' }))
    },
    /** `vi.mock('../../lib', () => fake.module())`. */
    module() {
      return { ai, useAi: () => aiStore(), useBoard: () => boardStore() }
    },
  }
}
