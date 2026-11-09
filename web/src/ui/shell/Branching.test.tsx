// M2 in the shell: Branch routes, the switcher, Checkpoint and History buttons, the Branches screen.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, BranchInfo, HistorySnapshot, Member, SessionSnapshot } from '../../lib'

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
type Fn = (...a: unknown[]) => Promise<unknown>
const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  board: {} as unknown as BoardSnapshot,
  hist: {} as unknown as HistorySnapshot,
  people: [] as Member[],
  list: [] as BranchInfo[],
  open: (async () => {}) as Fn,
  create: (async () => ({})) as Fn,
  checkpoint: (async () => ({})) as Fn,
  calls: { open: [] as unknown[][], close: 0, create: [] as unknown[][], checkpoint: [] as unknown[][], branchesReload: 0, membersReload: 0, historyOpen: 0, historyClose: 0 },
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
  useRuns: () => ({ runner: { available: false, reason: 'browser' }, live: null, last: null }), // nothing runs: the top bar has no Runner monitor
  useMembers: () => h.people,
  useBranches: () => h.list,
  useHistory: () => h.hist,
  mergeOptions: () => ({}), // the Merge entry points have their own tests (Merging.test.tsx)
  session: { refresh: async () => {}, logout: async () => {}, login: async () => {}, acceptInvite: async () => {} },
  board: {
    open: (...a: unknown[]) => {
      h.calls.open.push(a)
      return h.open(...a)
    },
    close: () => void h.calls.close++,
  },
  members: { reload: async () => void h.calls.membersReload++, remove: async () => {} },
  invites: { lookup: async () => ({}), list: async () => [], create: async () => ({}), remove: async () => {} },
  branches: {
    reload: async () => void h.calls.branchesReload++,
    create: (...a: unknown[]) => {
      h.calls.create.push(a)
      return h.create(...a)
    },
  },
  history: {
    open: async () => void h.calls.historyOpen++,
    close: () => void h.calls.historyClose++,
    preview: () => {},
    restore: async () => {},
    createCheckpoint: (...a: unknown[]) => {
      h.calls.checkpoint.push(a)
      return h.checkpoint(...a)
    },
  },
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))
// The Branch Graph has its own tests against the data layer (ui/branches/BranchGraph.test.tsx).
vi.mock('../branches', () => ({
  BranchGraph: ({ current }: { current: string }) => (
    <div data-testid="branch-graph" data-current={current}>
      <h1>Branches</h1>
    </div>
  ),
}))

import { historyPanel, useHistoryPanel } from '../bridge'
import { App } from './App'
import { newBranchIntent, useNewBranchIntent } from './newBranchIntent'
import { rememberBranch } from './router'
import { resetThemeCache } from './theme'

const ADMIN: Member = { id: 'a', name: 'Elena Varga', role: 'admin', color: '#aaa' }
const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const ANA: Member = { id: 'n', name: 'Ana Ruiz', role: 'member', color: '#ddd' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc', access_until: new Date(2030, 10, 30).getTime() }

const at = (d: number, hh = 10, mm = 2) => new Date(new Date().getFullYear(), 10, d, hh, mm).getTime()

const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }
const QEC: BranchInfo = { id: 'b-qec', name: 'try-QEC', seq: 14, checkpoints: 0, parent: { branch: 'b-main', seq: 30 }, created_by: 'm', created_at: at(14) }
const CART: BranchInfo = { id: 'b-cart', name: 'ana/cartpole lr', seq: 3, checkpoints: 0, parent: { branch: 'b-main', seq: 12 }, created_by: 'n', created_at: at(19, 16, 40) }

function snapshot(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return { status: 'live', seq: 40, branch: MAIN, cards: [], frames: [], connections: [], presence: [MEI], pending: 0, readOnly: false, ...over }
}
const IDLE: HistorySnapshot = { status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }

const go = (path: string) => window.history.replaceState(null, '', path)
const signedIn = (member: Member) => (h.session = { status: 'signed_in', member })
const opened = () => h.calls.open.map((a) => a[0])

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  rememberBranch('main')
  newBranchIntent.clear()
  useHistoryPanel.setState({ open: false })
  h.board = snapshot()
  h.hist = IDLE
  h.people = [ADMIN, MEI, ANA]
  h.list = [QEC, MAIN, CART]
  h.open = async () => {}
  h.create = async () => ({})
  h.checkpoint = async () => ({})
  h.calls = { open: [], close: 0, create: [], checkpoint: [], branchesReload: 0, membersReload: 0, historyOpen: 0, historyClose: 0 }
  signedIn(MEI)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Branch routes', () => {
  it('opens main at /, and the named Branch at /b/<name>', () => {
    go('/b/ana%2Fcartpole%20lr')
    const { container } = render(<App />)
    expect(opened()).toEqual(['ana/cartpole lr'])
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'ana/cartpole lr')
    expect(screen.getByRole('button', { name: 'Branch ana/cartpole lr' })).toBeInTheDocument()
    expect(screen.getByTitle('On ana/cartpole lr')).toBeInTheDocument()
    expect(h.calls.branchesReload).toBe(1)
  })

  it('opens another Branch when the route changes, also with the back button', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(opened()).toEqual(['main'])
    await user.click(screen.getByRole('button', { name: 'Branch main' }))
    await user.click(screen.getByRole('menuitem', { name: /try-QEC/ }))
    expect(window.location.pathname).toBe('/b/try-QEC')
    expect(opened()).toEqual(['main', 'try-QEC'])
    act(() => window.history.back())
    await waitFor(() => expect(opened()).toEqual(['main', 'try-QEC', 'main']))
    expect(h.calls.close).toBe(0)
  })

  it('keeps the Branch open on /branches and /members, and links back to it', async () => {
    signedIn(ADMIN)
    go('/b/try-QEC')
    const user = userEvent.setup()
    const { container, unmount } = render(<App />)
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    expect(window.location.pathname).toBe('/branches')
    expect(screen.getByRole('link', { name: 'Branches' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('link', { name: 'Members' }))
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument()
    expect(opened()).toEqual(['try-QEC'])
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'try-QEC')
    expect(screen.getByRole('button', { name: 'Branch try-QEC' })).toBeInTheDocument()
    const back = screen.getByRole('link', { name: 'Board' })
    expect(back).toHaveAttribute('href', '/b/try-QEC')
    await user.click(back)
    expect(window.location.pathname).toBe('/b/try-QEC')
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(opened()).toEqual(['try-QEC'])
    unmount()
    expect(h.calls.close).toBeGreaterThan(0)
  })

  it('returns to the open Branch when a Board action is asked for from another screen', async () => {
    go('/b/try-QEC')
    h.board = snapshot({ branch: QEC, cards: [{ id: 'c1', title: 'Decoders', summary: '', status: 'idea', x: 0, y: 0, w: 224, h: 132, blocks: 0, sources: 0 }] })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    await user.type(screen.getByRole('combobox', { name: 'Search Cards' }), 'deco{Enter}')
    expect(window.location.pathname).toBe('/b/try-QEC')
  })

  it('says so when the Branch does not exist, with a way to main', async () => {
    go('/b/nope')
    h.board = snapshot({ status: 'error', branch: undefined })
    h.open = async (name) => {
      if (name === 'nope') throw { status: 404, code: 'not_found' }
    }
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByText('There is no Branch called “nope”.')).toBeInTheDocument()
    expect(screen.queryByTestId('board')).toBeNull()
    expect(screen.queryByRole('button', { name: /Checkpoint/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /History/ })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Go to main' }))
    expect(window.location.pathname).toBe('/')
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.queryByText(/There is no Branch/)).toBeNull()
    expect(opened()).toEqual(['nope', 'main'])
  })

  it('leaves other failures to the Board', async () => {
    go('/b/try-QEC')
    h.open = async () => {
      throw { status: 0, code: 'network' }
    }
    render(<App />)
    await act(async () => {})
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.queryByText(/There is no Branch/)).toBeNull()
  })
})

describe('Branch switcher', () => {
  it('lists Branches with main first, describes them and marks the open one', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    render(<App />)
    const pill = screen.getByRole('button', { name: 'Branch try-QEC' })
    expect(pill).toHaveAttribute('aria-haspopup', 'menu')
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    await user.click(pill)
    expect(pill).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Branches' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'maindefault Branch',
      '✓try-QECfrom main · Mei · 14 Nov',
      'ana/cartpole lrfrom main · Ana · 19 Nov',
      'New Branch…',
      'All Branches…',
    ])
    expect(items[1]).toHaveAttribute('aria-current', 'true')
    expect(items[0]).not.toHaveAttribute('aria-current')
    expect(items[2]).toHaveAttribute('href', '/b/ana%2Fcartpole%20lr')
    await waitFor(() => expect(items[1]).toHaveFocus())
  })

  it('moves with the arrow keys, chooses with Enter and navigates', async () => {
    const user = userEvent.setup()
    render(<App />)
    const pill = screen.getByRole('button', { name: 'Branch main' })
    pill.focus()
    await user.keyboard('{Enter}')
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    await waitFor(() => expect(items[0]).toHaveFocus())
    await user.keyboard('{ArrowUp}')
    expect(items[4]).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(items[0]).toHaveFocus()
    await user.keyboard('{End}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(window.location.pathname).toBe('/b/ana%2Fcartpole%20lr')
    expect(opened()).toEqual(['main', 'ana/cartpole lr'])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Branch ana/cartpole lr' })).toHaveFocus()
  })

  it('closes on Esc and returns focus to the pill; opens with ArrowDown; closes on an outside click', async () => {
    const user = userEvent.setup()
    render(<App />)
    const pill = screen.getByRole('button', { name: 'Branch main' })
    pill.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(pill).toHaveFocus()
    expect(window.location.pathname).toBe('/')
    await user.click(pill)
    await user.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('"New Branch…" goes to the Branch Graph and asks it for the name field; "All Branches…" just goes there', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Branch try-QEC' }))
    await user.click(screen.getByRole('menuitem', { name: 'All Branches…' }))
    expect(window.location.pathname).toBe('/branches')
    expect(screen.getByTestId('branch-graph')).toHaveAttribute('data-current', 'try-QEC')
    expect(useNewBranchIntent.getState().pending).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Branch try-QEC' }))
    await user.click(screen.getByRole('menuitem', { name: 'New Branch…' }))
    expect(window.location.pathname).toBe('/branches')
    expect(useNewBranchIntent.getState().pending).toBe(true) // the graph selects the newest dot of try-QEC, cursor in the field
  })

  it('asks for the list again when it is still empty', async () => {
    h.list = []
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Branch main' }))
    expect(screen.getByText('Loading Branches…')).toBeInTheDocument()
    expect(h.calls.branchesReload).toBe(2)
  })
})

describe('Checkpoint', () => {
  const openPopover = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByTitle('Name this moment of the Branch'))
    return screen.getByRole('dialog', { name: 'Create Checkpoint' })
  }

  it('creates a Checkpoint on Enter, closes and reads "◆ Created" for 2 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    const button = screen.getByTitle('Name this moment of the Branch')
    expect(button).toHaveTextContent('Checkpoint')
    const pop = await openPopover(user)
    const field = within(pop).getByRole('textbox', { name: 'Checkpoint name' })
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('placeholder', 'e.g. Before decoder rewrite')
    await user.keyboard('  Before decoder rewrite {Enter}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(h.calls.checkpoint).toEqual([['Before decoder rewrite']])
    expect(button).toHaveTextContent('◆ Created')
    expect(button.querySelector('[aria-live="polite"]')).toHaveTextContent('◆ Created')
    expect(button).toHaveFocus()
    act(() => void vi.advanceTimersByTime(2100))
    expect(button).toHaveTextContent('Checkpoint')
    expect(button).not.toHaveTextContent('Created')
  })

  it('says when the name is taken, and keeps the popover open', async () => {
    h.checkpoint = async () => {
      throw { status: 409, code: 'name_taken' }
    }
    const user = userEvent.setup()
    render(<App />)
    const pop = await openPopover(user)
    await user.keyboard('Kick-off')
    await user.click(within(pop).getByRole('button', { name: 'Create Checkpoint' }))
    expect(await within(pop).findByText('This Branch already has a Checkpoint with that name.')).toBeInTheDocument()
    expect(within(pop).getByRole('textbox', { name: 'Checkpoint name' })).toHaveAttribute('aria-invalid', 'true')
    await user.keyboard(' 2')
    expect(within(pop).queryByText(/already has a Checkpoint/)).toBeNull()
  })

  it('puts other failures in a plain sentence; an empty name is not sent', async () => {
    h.checkpoint = async () => {
      throw { status: 0, code: 'network' }
    }
    const user = userEvent.setup()
    render(<App />)
    const pop = await openPopover(user)
    await user.keyboard('{Enter}')
    expect(within(pop).getByText('Give the Checkpoint a name.')).toBeInTheDocument()
    expect(h.calls.checkpoint).toEqual([])
    await user.keyboard('x{Enter}')
    expect(await within(pop).findByText("Can't reach the server. Check your connection and try again.")).toBeInTheDocument()
  })

  it('closes on Cancel and on Esc, returning focus to the button', async () => {
    const user = userEvent.setup()
    render(<App />)
    const button = screen.getByTitle('Name this moment of the Branch')
    const pop = await openPopover(user)
    await user.click(within(pop).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
    await openPopover(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
    expect(h.calls.checkpoint).toEqual([])
  })
})

describe('History button', () => {
  it('toggles the History panel and reflects it in aria-pressed', async () => {
    const user = userEvent.setup()
    render(<App />)
    const button = screen.getByRole('button', { name: 'History' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    expect(useHistoryPanel.getState().open).toBe(true)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await user.click(button)
    expect(useHistoryPanel.getState().open).toBe(false)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    act(() => historyPanel.toggle())
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })

  it('goes to the Board of the open Branch first when another screen is showing', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    const button = screen.getByRole('button', { name: 'History' })
    await user.click(button)
    expect(window.location.pathname).toBe('/b/try-QEC')
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(useHistoryPanel.getState().open).toBe(true)
    // already open: coming back from another screen shows it rather than hiding it
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    expect(useHistoryPanel.getState().open).toBe(true)
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Branches screen', () => {
  it('is the Branch Graph, told which Branch the Board has open; it loads no History of its own', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    expect(window.location.pathname).toBe('/branches')
    expect(screen.getByRole('heading', { name: 'Branches', level: 1 })).toBeInTheDocument()
    expect(screen.getByTestId('branch-graph')).toHaveAttribute('data-current', 'try-QEC')
    expect(opened()).toEqual(['try-QEC'])
    expect(h.calls.historyOpen).toBe(0)
    await user.click(screen.getByRole('link', { name: 'Board' }))
    expect(h.calls.historyClose).toBe(0)
  })
})

describe('Guest', () => {
  beforeEach(() => {
    signedIn(GUEST)
    h.board = snapshot({ readOnly: true, presence: [GUEST] })
    h.list = []
  })

  it('sees no switcher, Checkpoint, History or Branches item', () => {
    render(<App />)
    expect(screen.getByText('read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Branch/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Checkpoint/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /History/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Branches' })).toBeNull()
    expect(h.calls.branchesReload).toBe(0)
    expect(opened()).toEqual(['main'])
  })

  it('is sent from /branches to the Board', () => {
    go('/branches')
    render(<App />)
    expect(window.location.pathname).toBe('/')
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Branches' })).toBeNull()
    expect(h.calls.historyOpen).toBe(0)
  })

  it('is sent from another Branch to main, which is the only one opened', () => {
    go('/b/try-QEC')
    const { container } = render(<App />)
    expect(window.location.pathname).toBe('/')
    expect(opened()).toEqual(['main'])
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'main')
  })
})
