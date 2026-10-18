import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, Member, SessionSnapshot } from '../../lib'

const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  board: {} as unknown as BoardSnapshot,
  people: [] as Member[],
  refresh: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  reload: vi.fn(),
  lookup: vi.fn(),
  list: vi.fn(),
}))

// M7: no AI set up. The sidebar and the AI settings card have their own tests.
const noAi = vi.hoisted(() => ({
  snapshot: { setup: { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }, conversations: [], current: null, busy: false },
}))

vi.mock('../../lib', () => ({
  useAi: () => noAi.snapshot,
  ai: { refresh: async () => {}, models: async () => [] },
  useSession: () => h.session,
  useBoard: () => h.board,
  useSuggestions: () => [],
  useRuns: () => ({ runner: { available: false, reason: 'browser' }, live: null, last: null }), // nothing runs: the top bar has no Runner monitor
  useMembers: () => h.people,
  useBranches: () => [],
  mergeOptions: () => ({}),
  useHistory: () => ({ status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }),
  branches: { reload: async () => {}, create: vi.fn() },
  history: { open: async () => {}, close: () => {}, preview: () => {}, createCheckpoint: vi.fn(), restore: vi.fn() },
  session: { refresh: h.refresh, logout: vi.fn(), login: vi.fn(), acceptInvite: vi.fn() },
  board: { open: h.open, close: h.close },
  members: { reload: h.reload, remove: vi.fn() },
  invites: { lookup: h.lookup, list: h.list, create: vi.fn(), remove: vi.fn() },
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))

import { boardBridge } from '../bridge'
import { App } from './App'
import { resetThemeCache } from './theme'

const ADMIN: Member = { id: 'a', name: 'Elena Varga', role: 'admin', color: '#aaa', email: 'e@lab.org' }
const MEMBER: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc', access_until: new Date(2026, 10, 30).getTime() }

const card = (id: string, title: string, summary = '') => ({ id, title, summary, status: 'idea' as const, x: 0, y: 0, w: 224, h: 132, blocks: 0, sources: 0 })

function snapshot(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    status: 'live',
    seq: 1,
    cards: [card('c1', 'Surface code threshold', 'about decoders'), card('c2', 'Noise models'), card('c3', 'Decoders', 'minimum weight')],
    frames: [{ id: 'f1', title: 'Surface codes', x: -10, y: -10, w: 600, h: 400 }],
    connections: [],
    presence: [ADMIN, MEMBER],
    pending: 0,
    readOnly: false,
    ...over,
  }
}

const go = (path: string) => window.history.replaceState(null, '', path)

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  h.refresh.mockReset()
  h.open.mockReset().mockResolvedValue(undefined)
  h.close.mockReset()
  h.reload.mockReset().mockResolvedValue(undefined)
  h.lookup.mockReset().mockRejectedValue({ status: 404, code: 'not_found' })
  h.list.mockReset().mockResolvedValue([])
  h.board = snapshot()
  h.people = [ADMIN, MEMBER]
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const signedIn = (member: Member) => (h.session = { status: 'signed_in', member })

describe('App routing', () => {
  it('refreshes the session once; shows nothing for 150 ms, then Loading…', () => {
    vi.useFakeTimers()
    h.session = { status: 'loading' }
    const { container } = render(<App />)
    expect(h.refresh).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
    act(() => void vi.advanceTimersByTime(160))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows Login when signed out', () => {
    h.session = { status: 'signed_out' }
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
  })

  it('keeps /invite/<token> public, even though signed out', async () => {
    go('/invite/x')
    h.session = { status: 'signed_out' }
    render(<App />)
    expect(await screen.findByText('This invite is no longer valid. Ask your Admin for a new one.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in to Infall' })).toBeNull()
    expect(h.lookup).toHaveBeenCalledWith('x')
  })

  it('shows the Login for /members when signed out', () => {
    go('/members')
    h.session = { status: 'signed_out' }
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
  })

  it('redirects a non-Admin from /members to the Board', () => {
    go('/members')
    signedIn(MEMBER)
    render(<App />)
    expect(window.location.pathname).toBe('/')
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
  })

  it('leaves an Admin on /members with the nav item marked current', async () => {
    go('/members')
    signedIn(ADMIN)
    render(<App />)
    expect(window.location.pathname).toBe('/members')
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Board' })).not.toHaveAttribute('aria-current')
    expect(screen.queryByTestId('board')).toBeNull()
  })

  it('navigates client-side from the rail and with the back button', async () => {
    signedIn(ADMIN)
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('link', { name: 'Members' }))
    expect(window.location.pathname).toBe('/members')
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument()
    act(() => {
      window.history.back()
    })
    await vi.waitFor(() => expect(screen.getByTestId('board')).toBeInTheDocument())
  })

  it('opens the Board and loads Members on entering the shell, closes on leaving', () => {
    signedIn(MEMBER)
    const { unmount } = render(<App />)
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.open).toHaveBeenCalledWith('main')
    expect(h.reload).toHaveBeenCalledTimes(1)
    unmount()
    expect(h.close).toHaveBeenCalled()
  })
})

describe('Guest', () => {
  beforeEach(() => {
    signedIn(GUEST)
    h.board = snapshot({ readOnly: true, presence: [GUEST] })
  })

  it('sees the access badge, "read-only", no Members link, no add-Frame, and no Members request', () => {
    render(<App />)
    expect(screen.getByText('Guest')).toBeInTheDocument()
    expect(screen.getByText('— access until 30 Nov')).toBeInTheDocument()
    expect(screen.getByText('read-only')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add Frame' })).toBeNull()
    expect(h.open).toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
  })
})

describe('top bar and rail', () => {
  it('tints by Branch, shows presence with names and initials, and Admin-only menu entries', async () => {
    signedIn(ADMIN)
    go('/b/try-QEC')
    h.board = snapshot({ branch: { id: 'b', name: 'try-QEC', seq: 1, checkpoints: 0 } })
    const user = userEvent.setup()
    const { container } = render(<App />)
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'try-QEC')
    expect(screen.getByTitle('On try-QEC')).toHaveTextContent('On try-QEC')
    expect(screen.getByTitle('Mei Lin')).toHaveTextContent('ML')
    await user.click(screen.getByRole('button', { name: /Elena Varga/ }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Admin')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Members' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: /Elena Varga/ })).toHaveFocus()
  })

  it('closes the account menu on an outside click', async () => {
    signedIn(MEMBER)
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Mei Lin/ }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Members' })).toBeNull()
    await user.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists Frames with computed Card counts, jumps on click, adds a Frame', async () => {
    signedIn(MEMBER)
    const focus = vi.spyOn(boardBridge, 'focus')
    const create = vi.spyOn(boardBridge, 'createFrame')
    const user = userEvent.setup()
    render(<App />)
    const frame = screen.getByRole('button', { name: 'Surface codes, 3 Cards' })
    await user.click(frame)
    expect(focus).toHaveBeenCalledWith('frame', 'f1')
    await user.click(screen.getByRole('button', { name: 'Add Frame' }))
    expect(create).toHaveBeenCalled()
  })

  it.each([
    ['live', 'Synced'],
    ['reconnecting', 'Reconnecting…'],
    ['error', 'Offline'],
  ] as const)('shows %s as the word "%s" and the host', (status, word) => {
    signedIn(MEMBER)
    h.board = snapshot({ status })
    render(<App />)
    expect(within(screen.getByRole('complementary')).getByText(word)).toBeInTheDocument()
    expect(within(screen.getByRole('complementary')).getByText(window.location.host)).toBeInTheDocument()
  })

  it('cycles the theme, stores it and applies it to <html>', async () => {
    signedIn(MEMBER)
    const user = userEvent.setup()
    render(<App />)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    await user.click(screen.getByRole('button', { name: /^Theme: Dark/ }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(window.localStorage.getItem('qoop-theme')).toBe('light')
    await user.click(screen.getByRole('button', { name: /^Theme: Light/ }))
    expect(screen.getByRole('button', { name: /^Theme: Follow system/ })).toBeInTheDocument()
  })
})

describe('search', () => {
  it('focuses on Ctrl-K and on Cmd-K', async () => {
    signedIn(MEMBER)
    const user = userEvent.setup()
    render(<App />)
    const input = screen.getByRole('combobox', { name: 'Search Cards' })
    await user.keyboard('{Control>}k{/Control}')
    expect(input).toHaveFocus()
    input.blur()
    await user.keyboard('{Meta>}k{/Meta}')
    expect(input).toHaveFocus()
  })

  it('filters by title and summary, navigates with arrows, Enter jumps to the Card', async () => {
    signedIn(MEMBER)
    const focus = vi.spyOn(boardBridge, 'focus')
    const user = userEvent.setup()
    render(<App />)
    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('DECODERS')
    const list = screen.getByRole('listbox')
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Decodersminimum weight', 'Surface code thresholdabout decoders'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(focus).toHaveBeenCalledWith('card', 'c1')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Esc and returns focus to the field, and on an outside click', async () => {
    signedIn(MEMBER)
    const user = userEvent.setup()
    render(<App />)
    const input = screen.getByRole('combobox', { name: 'Search Cards' })
    await user.click(input)
    await user.keyboard('noise')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveFocus()
    await user.keyboard('{Backspace}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('says when nothing matches', async () => {
    signedIn(MEMBER)
    const user = userEvent.setup()
    render(<App />)
    await user.type(screen.getByRole('combobox', { name: 'Search Cards' }), 'zzz')
    expect(screen.getByText('No Cards match.')).toBeInTheDocument()
  })
})
