// M7 in the shell: the top-bar "AI" button and the column the sidebar takes on every screen.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSnapshot, BoardSnapshot, BranchInfo, HistorySnapshot, Member, SessionSnapshot } from '../../lib'

const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  board: {} as unknown as BoardSnapshot,
  ai: {} as unknown as AiSnapshot,
}))

vi.mock('../../lib', () => ({
  useSession: () => h.session,
  useBoard: () => h.board,
  useAi: () => h.ai,
  useSuggestions: () => [],
  useRuns: () => ({ runner: { available: false, reason: 'browser' }, live: null, last: null }), // nothing runs: the top bar has no Runner monitor
  useMembers: () => [],
  useBranches: (): BranchInfo[] => [],
  useHistory: (): HistorySnapshot => ({ status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }),
  mergeOptions: () => ({}),
  session: { refresh: async () => {}, logout: async () => {} },
  board: { open: async () => {}, close: () => {} },
  members: { reload: async () => {} },
  branches: { reload: async () => {}, create: async () => ({}) },
  history: { open: async () => {}, close: () => {}, preview: () => {}, restore: async () => {}, createCheckpoint: async () => ({}) },
  ai: { refresh: async () => {}, newConversation: () => {}, send: async () => {}, stop: () => {} },
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))
vi.mock('../todos', () => ({ Todos: () => <div data-testid="todos" /> }))

import { aiPanel, useAiPanel } from '../bridge'
import { App } from './App'
import { navigate, rememberBranch } from './router'
import { resetThemeCache } from './theme'

const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }
const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }

const go = (path: string) => window.history.replaceState(null, '', path)
const signedIn = (member: Member) => (h.session = { status: 'signed_in', member })
const aiButton = () => within(screen.getByRole('banner')).getByRole('button', { name: 'AI' })
const sidebar = () => screen.queryByRole('complementary', { name: 'AI' })
const shell = (container: HTMLElement) => container.querySelector('.q-shell')!

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  rememberBranch('main')
  h.board = { status: 'live', seq: 40, branch: MAIN, cards: [], frames: [], connections: [], presence: [], pending: 0, readOnly: false }
  h.ai = { setup: { provider: 'claude-code', label: 'Claude Code', version: '2.1.0', desktop: true, openrouter: { enabled: false } }, conversations: [], current: null, busy: false }
  signedIn(MEI)
})
afterEach(() => {
  cleanup()
  act(() => aiPanel.close())
  vi.restoreAllMocks()
})

describe('top-bar AI button', () => {
  it('toggles the sidebar and says whether it is showing', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(aiButton()).toHaveAttribute('aria-pressed', 'false')
    expect(aiButton()).toHaveAttribute('title', 'AI sidebar')
    await user.click(aiButton())
    expect(useAiPanel.getState().open).toBe(true)
    expect(aiButton()).toHaveAttribute('aria-pressed', 'true')
    await user.click(aiButton())
    expect(useAiPanel.getState().open).toBe(false)
    expect(aiButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('follows the bridge when something else opens the sidebar', () => {
    render(<App />)
    act(() => aiPanel.toggle())
    expect(aiButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('is not there for a Guest, and neither is the sidebar even if it was left open', () => {
    signedIn(GUEST)
    h.board = { ...h.board, readOnly: true }
    act(() => aiPanel.toggle())
    const { container } = render(<App />)
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: 'AI' })).toBeNull()
    expect(sidebar()).toBeNull()
    expect(shell(container)).not.toHaveClass('has-ai')
  })
})

describe('the sidebar column', () => {
  it('is not there until asked for', () => {
    const { container } = render(<App />)
    expect(sidebar()).toBeNull()
    expect(shell(container)).not.toHaveClass('has-ai')
  })

  it('appears beside the Board, after the work area', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(aiButton())
    expect(shell(container)).toHaveClass('has-ai')
    expect(sidebar()).toBeInTheDocument()
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.getByRole('main').nextElementSibling).toBe(sidebar())
    expect(within(sidebar()!).getByText('Claude Code')).toBeInTheDocument()
  })

  it('appears on another screen too, and stays while moving between screens', async () => {
    go('/todos')
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(aiButton())
    expect(screen.getByTestId('todos')).toBeInTheDocument()
    expect(shell(container)).toHaveClass('has-ai')
    expect(sidebar()).toBeInTheDocument()
    expect(window.location.pathname).toBe('/todos') // the button does not send the Member to the Board

    act(() => navigate('/branches'))
    expect(sidebar()).toBeInTheDocument()
    act(() => navigate('/'))
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(sidebar()).toBeInTheDocument()
  })

  it('names the open Branch in the composer', async () => {
    go('/b/try-QEC')
    h.board = { ...h.board, branch: { id: 'b-try', name: 'try-QEC', seq: 1, checkpoints: 0 } }
    const user = userEvent.setup()
    render(<App />)
    await user.click(aiButton())
    expect(within(sidebar()!).getByLabelText('Ask the AI')).toHaveAttribute('placeholder', 'Ask about Board: try-QEC…')
  })
})

describe('focus', () => {
  it('goes to the composer when the sidebar opens and back to the AI button when it collapses', async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await user.click(aiButton())
    expect(within(sidebar()!).getByLabelText('Ask the AI')).toHaveFocus()
    await user.click(within(sidebar()!).getByRole('button', { name: 'Collapse the AI sidebar' }))
    expect(sidebar()).toBeNull()
    expect(aiButton()).toHaveFocus()
  })

  it('does not take focus from elsewhere when the sidebar is closed from outside', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(aiButton())
    const search = screen.getByRole('combobox', { name: /Search Cards/ })
    search.focus()
    act(() => aiPanel.close())
    expect(search).toHaveFocus()
  })
})
