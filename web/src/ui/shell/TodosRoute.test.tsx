// M4 in the shell: the To-dos route, who may use it, and its rail item.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, BranchInfo, HistorySnapshot, Member, SessionSnapshot } from '../../lib'

const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  board: {} as unknown as BoardSnapshot,
  opened: [] as string[],
}))

// M7: no AI set up. The sidebar and the AI settings card have their own tests.
const noAi = vi.hoisted(() => ({
  snapshot: { setup: { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }, conversations: [], current: null, busy: false },
}))

vi.mock('../../lib', () => ({
  useForYou: () => ({ status: 'ready', items: [], unseen: 0 }),
  forYou: { reload: async () => {}, seen: async () => {}, onMention: () => () => {} },
  useWorkspace: () => ({ status: 'ready', kind: 'team', preset: null }),
  workspace: { load: async () => {}, current: () => ({ status: 'ready', kind: 'team', preset: null }), rename: async (n: string) => n, loadTutorial: async () => null, saveTutorial: async () => {} },
  useAi: () => noAi.snapshot,
  ai: { refresh: async () => {}, models: async () => [] },
  useSession: () => h.session,
  useBoard: () => h.board,
  useSuggestions: () => [],
  // M19: the search box asks for words in PDFs; nothing is found here.
  useSources: () => [],
  pdfFiles: { search: async () => [] },
  useRuns: () => ({ runner: { available: false, reason: 'browser' }, live: null, last: null }), // nothing runs: the top bar has no Runner monitor
  useMembers: () => [],
  useBranches: (): BranchInfo[] => [],
  useHistory: (): HistorySnapshot => ({ status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }),
  mergeOptions: () => ({}),
  session: { refresh: async () => {}, logout: async () => {} },
  board: {
    open: async (name: string) => void h.opened.push(name),
    close: () => {},
  },
  members: { reload: async () => {} },
  branches: { reload: async () => {}, create: async () => ({}) },
  history: { open: async () => {}, close: () => {}, preview: () => {}, restore: async () => {}, createCheckpoint: async () => ({}) },
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))
vi.mock('../todos', () => ({ Todos: ({ me }: { me: Member }) => <div data-testid="todos" data-me={me.id} /> }))

import { App } from './App'
import { rememberBranch } from './router'
import { resetThemeCache } from './theme'

const ADMIN: Member = { id: 'a', name: 'Elena Varga', role: 'admin', color: '#aaa' }
const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }
const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }

const go = (path: string) => window.history.replaceState(null, '', path)
const signedIn = (member: Member) => (h.session = { status: 'signed_in', member })
const rail = () => within(screen.getByRole('navigation', { name: 'Main' }))

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  rememberBranch('main')
  h.opened = []
  h.board = { status: 'live', seq: 40, branch: MAIN, cards: [], frames: [], connections: [], presence: [], pending: 0, readOnly: false }
  signedIn(MEI)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('To-dos route', () => {
  it('shows the To-dos screen at /todos for a Member, with the rail item current', () => {
    go('/todos')
    render(<App />)
    expect(screen.getByTestId('todos')).toHaveAttribute('data-me', 'm')
    expect(screen.queryByTestId('board')).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/todos')
    expect(rail().getByRole('link', { name: 'To-dos' })).toHaveAttribute('aria-current', 'page')
    expect(rail().getByRole('link', { name: 'Board' })).not.toHaveAttribute('aria-current')
  })

  it('shows it for an Admin too', () => {
    signedIn(ADMIN)
    go('/todos')
    render(<App />)
    expect(screen.getByTestId('todos')).toHaveAttribute('data-me', 'a')
  })

  it('keeps the last Branch open and links back to it', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(rail().getByRole('link', { name: 'To-dos' }))
    expect(window.location.pathname).toBe('/todos')
    expect(screen.getByTestId('todos')).toBeInTheDocument()
    expect(h.opened).toEqual(['try-QEC'])
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'try-QEC')
    expect(rail().getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/b/try-QEC')
  })

  it('has a real link to /todos in the rail, after the Board', () => {
    render(<App />)
    const links = rail().getAllByRole('link').map((a) => a.textContent)
    expect(links).toEqual(['Board', 'To-dos', 'For you', 'Branches'])
    expect(rail().getByRole('link', { name: 'To-dos' })).toHaveAttribute('href', '/todos')
  })

  it('sends a Guest back to the Board and hides the rail item', async () => {
    signedIn(GUEST)
    h.board = { ...h.board, readOnly: true }
    go('/todos')
    render(<App />)
    expect(screen.queryByTestId('todos')).not.toBeInTheDocument()
    expect(screen.getByTestId('board')).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(rail().queryByRole('link', { name: 'To-dos' })).not.toBeInTheDocument()
  })
})
