// M5 in the shell: the AI access route and its account-menu entry, who may use them, and the Suggestions rail item.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessToken, BoardSnapshot, BranchInfo, HistorySnapshot, Member, SessionSnapshot, SuggestionVM } from '../../lib'

const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  board: {} as unknown as BoardSnapshot,
  suggestions: [] as SuggestionVM[],
  tokens: [] as AccessToken[],
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
  useSuggestions: () => h.suggestions,
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
  tokens: {
    list: async () => h.tokens,
    create: async (name: string) => ({ token: { id: 'new', name, created_at: 1 }, secret: 'qoop_at_ROUTE-SECRET-42' }),
    remove: async () => {},
  },
  toolEndpoint: () => 'https://qoop.test/mcp',
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))
vi.mock('../todos', () => ({ Todos: () => <div data-testid="todos" /> }))

import { suggestionsPanel, useSuggestionsPanel } from '../bridge'
import { App } from './App'
import { AI_ACCESS_PATH, navigate, parseRoute, rememberBranch } from './router'
import { resetThemeCache } from './theme'

const SECRET = 'qoop_at_ROUTE-SECRET-42'
const ADMIN: Member = { id: 'a', name: 'Elena Varga', role: 'admin', color: '#aaa' }
const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }
const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }

const suggestion = (id: string, state: 'pending' | 'accepted' | 'rejected'): SuggestionVM => ({
  suggestion: { id, branch: 'b-main', kind: 'source', card: 'c1', reason: 'r', created_by: 'm', created_at: 1, state },
  title: 'T',
  meta: '',
  target: 'for Card: X',
  cards: ['c1'],
  stale: false,
})

const go = (path: string) => window.history.replaceState(null, '', path)
const signedIn = (member: Member) => (h.session = { status: 'signed_in', member })
const rail = () => within(screen.getByRole('navigation', { name: 'Main' }))
const item = () => rail().getByRole('button', { name: /^Suggestions/ })
const badge = () => item().querySelector('.q-rail__badge')!

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  rememberBranch('main')
  suggestionsPanel.close()
  h.opened = []
  h.suggestions = []
  h.tokens = []
  h.board = { status: 'live', seq: 40, branch: MAIN, cards: [], frames: [], connections: [], presence: [], pending: 0, readOnly: false }
  signedIn(MEI)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AI access route', () => {
  it('parses and builds /settings/ai', () => {
    expect(AI_ACCESS_PATH).toBe('/settings/ai')
    // AI access is now the "AI access" section of Settings, at the address it always had.
    const ai = { name: 'settings', section: 'ai' }
    expect(parseRoute(AI_ACCESS_PATH)).toEqual(ai)
    expect(parseRoute('/settings/ai/')).toEqual(ai)
    expect(parseRoute('/settings/ai?x=1#top')).toEqual(ai)
    expect(parseRoute('/settings')).toEqual({ name: 'settings', section: 'appearance' })
    expect(parseRoute('/settings/other')).toEqual({ name: 'board', branch: 'main' })
    expect(parseRoute('/settings/ai/more')).toEqual({ name: 'board', branch: 'main' })
  })

  it('shows the screen for a Member, with no rail item current', async () => {
    go('/settings/ai')
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'AI access' })).toBeInTheDocument()
    expect(screen.queryByTestId('board')).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings/ai')
    expect(rail().queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
    expect(await screen.findByText('No access tokens yet.')).toBeInTheDocument()
  })

  it('shows it for an Admin too, and keeps the last Branch open', async () => {
    signedIn(ADMIN)
    go('/b/try-QEC')
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(screen.getByRole('button', { name: /Elena Varga/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(window.location.pathname).toBe('/settings')
    await user.click(screen.getByRole('link', { name: 'AI access' }))
    expect(window.location.pathname).toBe('/settings/ai')
    expect(screen.getByRole('heading', { level: 1, name: 'AI access' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(h.opened).toEqual(['try-QEC'])
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'try-QEC')
    expect(rail().getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/b/try-QEC')
    await screen.findByText('No access tokens yet.')
  })

  it('is reached from the account menu: a real link "Settings", then the "AI access" section', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Mei Lin/ }))
    const menu = within(screen.getByRole('menu'))
    expect(menu.queryByRole('menuitem', { name: 'AI access' })).not.toBeInTheDocument()
    const entry = menu.getByRole('menuitem', { name: 'Settings' })
    expect(entry).toHaveAttribute('href', '/settings')
    expect(entry.tagName).toBe('A')
    await user.click(entry)
    expect(within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('link', { name: 'AI access' })).toHaveAttribute('href', '/settings/ai')
  })

  it('sends a Guest back to the Board; a Guest sees neither the menu entry nor the rail item', async () => {
    signedIn(GUEST)
    h.board = { ...h.board, readOnly: true }
    go('/settings/ai')
    const user = userEvent.setup()
    render(<App />)
    expect(screen.queryByRole('heading', { name: 'AI access' })).not.toBeInTheDocument()
    expect(screen.getByTestId('board')).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(rail().queryByRole('button', { name: /Suggestions/ })).not.toBeInTheDocument()
    expect(rail().queryByText('Suggestions')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Priya Nair/ }))
    const menu = within(screen.getByRole('menu'))
    expect(menu.queryByRole('menuitem', { name: 'AI access' })).not.toBeInTheDocument()
    expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })
})

describe('AI access: the secret does not outlive the screen', () => {
  async function createOnScreen() {
    go('/settings/ai')
    const user = userEvent.setup()
    const view = render(<App />)
    await screen.findByText('No access tokens yet.')
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Cursor')
    await user.click(screen.getByRole('button', { name: 'Create access token' }))
    await screen.findByRole('group', { name: 'New access token' })
    expect(document.body.innerHTML).toContain(SECRET)
    return { user, ...view }
  }

  it('is gone after leaving the screen and coming back', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { user } = await createOnScreen()
    await user.click(rail().getByRole('link', { name: 'Board' }))
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(SECRET)

    act(() => navigate(AI_ACCESS_PATH))
    await screen.findByText('No access tokens yet.')
    expect(screen.queryByRole('group', { name: 'New access token' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Command to connect Claude Code').textContent).toContain('Bearer <YOUR_TOKEN>')
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(window.location.href).not.toContain(SECRET)
    for (const call of setItem.mock.calls) expect(call.join(' ')).not.toContain(SECRET)
  })

  it('is gone after the browser Back button, too', async () => {
    go('/')
    const user = userEvent.setup()
    render(<App />)
    act(() => navigate(AI_ACCESS_PATH))
    await screen.findByText('No access tokens yet.')
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Cursor')
    await user.click(screen.getByRole('button', { name: 'Create access token' }))
    await screen.findByRole('group', { name: 'New access token' })
    act(() => navigate('/todos'))
    expect(screen.getByTestId('todos')).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('is gone on sign-out, and is not there for whoever signs in next', async () => {
    const { rerender } = await createOnScreen()
    h.session = { status: 'signed_out' } as SessionSnapshot
    rerender(<App />)
    expect(document.body.innerHTML).not.toContain(SECRET)
    signedIn(ADMIN)
    rerender(<App />)
    await screen.findByText('No access tokens yet.')
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(screen.queryByRole('group', { name: 'New access token' })).not.toBeInTheDocument()
  })
})

describe('Rail: Suggestions', () => {
  it('sits after To-dos and shows how many Suggestions are pending, in accent when there are any', () => {
    h.suggestions = [suggestion('1', 'pending'), suggestion('2', 'accepted'), suggestion('3', 'pending'), suggestion('4', 'rejected')]
    render(<App />)
    expect(badge()).toHaveTextContent(/^2$/)
    expect(badge()).toHaveClass('q-rail__badge--hot')
    expect(item()).toHaveAccessibleName('Suggestions, 2 pending')
    const order = Array.from(screen.getByRole('navigation', { name: 'Main' }).children).map((el) => el.querySelector('span')?.textContent)
    expect(order).toEqual(['Board', 'To-dos', 'For you', 'Suggestions', 'Branches'])
  })

  it('shows a quiet 0 when nothing is pending', () => {
    h.suggestions = [suggestion('2', 'accepted')]
    render(<App />)
    expect(badge()).toHaveTextContent(/^0$/)
    expect(badge()).not.toHaveClass('q-rail__badge--hot')
  })

  it('toggles the panel on the Board and reflects it in aria-pressed', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(item()).toHaveAttribute('aria-pressed', 'false')
    await user.click(item())
    expect(useSuggestionsPanel.getState().open).toBe(true)
    expect(item()).toHaveAttribute('aria-pressed', 'true')
    expect(window.location.pathname).toBe('/')
    await user.click(item())
    expect(useSuggestionsPanel.getState().open).toBe(false)
    expect(item()).toHaveAttribute('aria-pressed', 'false')
  })

  it('follows the panel when something else opens or closes it', () => {
    render(<App />)
    act(() => suggestionsPanel.open())
    expect(item()).toHaveAttribute('aria-pressed', 'true')
    act(() => suggestionsPanel.close())
    expect(item()).toHaveAttribute('aria-pressed', 'false')
  })

  it('from another screen goes to the Board of the open Branch and opens the panel', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    render(<App />)
    await user.click(rail().getByRole('link', { name: 'To-dos' }))
    expect(item()).toHaveAttribute('aria-pressed', 'false')
    await user.click(item())
    expect(window.location.pathname).toBe('/b/try-QEC')
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(useSuggestionsPanel.getState().open).toBe(true)
    expect(item()).toHaveAttribute('aria-pressed', 'true')
  })

  it('from another screen keeps a panel that was already open, and is not pressed while the Board is not showing', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(item())
    act(() => navigate(AI_ACCESS_PATH))
    await screen.findByText('No access tokens yet.')
    expect(item()).toHaveAttribute('aria-pressed', 'false')
    await user.click(item())
    expect(window.location.pathname).toBe('/')
    expect(useSuggestionsPanel.getState().open).toBe(true)
    expect(item()).toHaveAttribute('aria-pressed', 'true')
  })

  it('is there for an Admin', () => {
    signedIn(ADMIN)
    render(<App />)
    expect(item()).toBeInTheDocument()
  })
})
