// M6 — the Guest view across screens (DESIGN.md "Guest view (10a)"): what a Guest sees and, mostly, what a Guest does not.
// The whole app is rendered with the real Board, inspector and Page panel over a stand-in data layer.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockVM, Invite, Member, PageVM, Role, SessionSnapshot } from '../../lib'

const fake = await vi.hoisted(async () => (await import('../history/testkit')).createFakeLib())
const h = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    session: create<SessionSnapshot>(() => ({ status: 'signed_out' })),
    opened: [] as string[],
    reloads: [] as string[],
    lookup: (async () => ({})) as (token: string) => Promise<unknown>,
    pending: [] as Invite[],
    blocks: [] as BlockVM[],
  }
})

vi.mock('../../lib', async (orig) => {
  const { boardStore } = fake
  const noPage: PageVM = { card: null, blocks: [], sources: [], connections: [], editor: null }
  return {
    ...(await orig<typeof import('../../lib')>()),
    ...fake.lib,
    useSession: () => h.session(),
    useBranches: () => [],
    useSuggestions: () => [],
    useTodos: () => [],
    usePage: (cardId: string | null): PageVM => {
      const cards = boardStore((s) => s.cards)
      const card = cards.find((c) => c.id === cardId) ?? null
      return card ? { ...noPage, card, blocks: h.blocks.filter((b) => b.card === card.id) } : noPage
    },
    session: {
      refresh: async () => {},
      login: async () => {},
      acceptInvite: async () => {},
      logout: async () => h.session.setState({ status: 'signed_out' }, true),
    },
    board: { open: async (name: string) => void h.opened.push(name), close: () => {}, submit: async () => {} },
    members: { reload: async () => void h.reloads.push('members'), remove: async () => {} },
    branches: { reload: async () => void h.reloads.push('branches'), create: async () => ({}) },
    invites: {
      lookup: (token: string) => h.lookup(token),
      list: async () => h.pending,
      create: async () => ({ invite: {}, url: 'https://infall.test/invite/T' }),
      remove: async () => {},
    },
    tokens: { list: async () => [], create: async () => ({}), remove: async () => {} },
    toolEndpoint: () => 'https://infall.test/mcp',
  }
})

const { App } = await import('../shell/App')
const { Members } = await import('../shell/Members')
const { resetThemeCache } = await import('../shell/theme')
const { ui } = await import('../board/uiStore')
const { toasts } = await import('../board/toastStore')
const { pagePanel, historyPanel, useSuggestionsPanel } = await import('../bridge')
const { card } = await import('../history/testkit')

const YEAR = new Date().getFullYear()
const UNTIL = new Date(YEAR, 10, 30, 23, 59, 59, 999).getTime() // "30 Nov"
const ADMIN: Member = { id: 'e', name: 'Elena Varga', role: 'admin', color: '#aaa', email: 'e@lab.org' }
const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb', email: 'mei@lab.org' }
const PRIYA: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc', email: 'priya@cqt.example', access_until: UNTIL }

const ENDED = "Your Guest access has ended. Ask the team's Admin if you need more time."

const go = (path: string) => window.history.replaceState(null, '', path)
const signIn = (member: Member) => act(() => h.session.setState({ status: 'signed_in', member }, true))
/** What the data layer does when any request answers 401. */
const answer401 = () => act(() => h.session.setState({ status: 'signed_out' }, true))

function seedBoard(readOnly: boolean, presence: Member[] = []) {
  fake.boardStore.setState({
    readOnly,
    presence,
    cards: [
      card('c1', 'Surface code threshold', { summary: 'About one per cent under circuit noise.', status: 'understood', x: 40, y: 40 }),
      card('c2', 'MWPM decoder', { x: 400, y: 40 }),
    ],
    frames: [{ id: 'f1', title: 'Surface codes', x: 0, y: 0, w: 700, h: 360 }],
    connections: [{ id: 'k1', from: 'c1', to: 'c2', kind: 'directed', label: 'decoded by' }],
  })
}

beforeAll(() => {
  // React Flow measures its container; jsdom has no layout.
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
})

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  fake.reset()
  h.session.setState({ status: 'signed_out' }, true)
  h.opened.length = 0
  h.reloads.length = 0
  h.pending = []
  h.blocks = []
  h.lookup = async () => {
    throw { status: 404, code: 'not_found' }
  }
  fake.membersStore.setState({ list: [ADMIN, MEI, PRIYA] })
  seedBoard(true)
})
afterEach(() => {
  cleanup()
  act(() => {
    toasts.clear()
    ui.reset()
    pagePanel.close()
    historyPanel.close()
    useSuggestionsPanel.setState({ open: false, preview: null })
  })
  // Leave no Guest behind: the shell remembers the last role in memory.
  h.session.setState({ status: 'signed_out' }, true)
})

function renderAs(member: Member, path = '/') {
  go(path)
  h.session.setState({ status: 'signed_in', member }, true)
  return render(<App />)
}

describe('Guest: top bar', () => {
  it('shows plain "main · read-only" instead of the Branch switcher, and no Checkpoint or History', () => {
    renderAs(PRIYA)
    const bar = screen.getByRole('banner')
    expect(within(bar).getByText('read-only').parentElement).toHaveTextContent('main · read-only')
    expect(within(bar).queryByRole('button', { name: /^Branch/i })).toBeNull()
    expect(within(bar).queryByRole('button', { name: /Checkpoint/ })).toBeNull()
    expect(within(bar).queryByRole('button', { name: /History/ })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows the badge with the date and the explaining title', () => {
    renderAs(PRIYA)
    const badge = screen.getByTitle('Read-only access to the main Branch. It ends automatically.')
    expect(badge).toHaveTextContent('Guest · access until 30 Nov')
  })

  it('shows no presence list, even when the data layer has people in it', () => {
    seedBoard(true, [ADMIN, MEI, PRIYA])
    renderAs(PRIYA)
    const bar = screen.getByRole('banner')
    expect(within(bar).queryByRole('list')).toBeNull()
    expect(within(bar).queryByText(/^On$/)).toBeNull()
    expect(within(bar).queryByTitle('Elena Varga')).toBeNull()
    expect(within(bar).queryByTitle('Mei Lin')).toBeNull()
  })

  it('keeps search, the theme toggle, and an account menu with only the name, "Guest", Settings, the tour and "Sign out"', async () => {
    const user = userEvent.setup()
    renderAs(PRIYA)
    expect(screen.getByRole('combobox', { name: /Search Cards/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Priya Nair/ }))
    const menu = screen.getByRole('menu', { name: 'Account' })
    expect(menu).toHaveTextContent('Priya Nair')
    expect(within(menu).getByText('Guest')).toBeInTheDocument()
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.firstChild?.textContent)).toEqual(['Settings', 'Tour of Infall', 'Sign out']) // Settings (this device's appearance) and the tour are everybody's
    expect(within(menu).queryByText('AI access')).toBeNull()
    expect(within(menu).queryByText('Members')).toBeNull()
  })

  it('a Member still has the switcher, Checkpoint, History and presence', () => {
    seedBoard(false, [ADMIN, MEI])
    renderAs(MEI)
    const bar = screen.getByRole('banner')
    expect(within(bar).getByRole('button', { name: /^Branch/i })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: /Checkpoint/ })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: /History/ })).toBeInTheDocument()
    expect(within(bar).getByTitle('Elena Varga')).toBeInTheDocument()
    expect(within(bar).queryByText('read-only')).toBeNull()
    expect(screen.queryByTitle('Read-only access to the main Branch. It ends automatically.')).toBeNull()
  })
})

describe('Guest: rail', () => {
  it('has "Board" and the Frames list only', () => {
    renderAs(PRIYA)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Board'])
    expect(within(nav).queryByRole('button')).toBeNull() // Suggestions is a button
    for (const name of ['To-dos', 'Suggestions', 'Branches', 'Members']) expect(within(nav).queryByText(name)).toBeNull()
    expect(screen.getByRole('button', { name: 'Surface codes, 2 Cards' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Frame' })).toBeNull()
  })

  it('reads "Read-only" in the footer, and "Reconnecting…" while the socket is down', () => {
    renderAs(PRIYA)
    const foot = screen.getByRole('complementary').querySelector('footer')!
    expect(within(foot).getByRole('status')).toHaveTextContent('Read-only')
    expect(foot).not.toHaveTextContent('Synced')
    act(() => fake.boardStore.setState({ status: 'reconnecting' }))
    expect(within(foot).getByRole('status')).toHaveTextContent('Reconnecting…')
  })

  it('reads "Synced" for a Member', () => {
    seedBoard(false)
    renderAs(MEI)
    const foot = screen.getAllByRole('complementary')[0]!.querySelector('footer')!
    expect(within(foot).getByRole('status')).toHaveTextContent('Synced')
  })

  it('asks the data layer for main only, and never for Members or Branches', () => {
    renderAs(PRIYA)
    expect(h.opened).toEqual(['main'])
    expect(h.reloads).toEqual([])
  })
})

describe('Guest: Board, inspector and Page', () => {
  it('shows the Cards with no "+ Card" or "+ Frame"', () => {
    renderAs(PRIYA)
    expect(screen.getByTestId('card-c1')).toBeInTheDocument()
    expect(screen.getByTestId('board')).toHaveClass('is-readonly')
    expect(screen.queryByRole('toolbar', { name: 'Add to the Board' })).toBeNull()
    expect(screen.queryByText('+ Card')).toBeNull()
    expect(screen.queryByText('+ Frame')).toBeNull()
  })

  it('an empty Board offers nothing to add', () => {
    fake.boardStore.setState({ cards: [], frames: [], connections: [] })
    renderAs(PRIYA)
    expect(screen.getByText('Nothing on this Board yet')).toBeInTheDocument()
    expect(screen.queryByText('+ Card')).toBeNull()
    expect(screen.queryByText(/Double-click/)).toBeNull()
  })

  it('the inspector shows the fields as text: nothing editable, no status picker, no "Delete Card"', () => {
    renderAs(PRIYA)
    act(() => ui.select(['c1']))
    const inspector = screen.getByTestId('inspector')
    expect(within(inspector).getByRole('heading', { name: 'Surface code threshold' })).toBeInTheDocument()
    expect(within(inspector).getByText('About one per cent under circuit noise.')).toBeInTheDocument()
    expect(within(inspector).getByText('Understood')).toBeInTheDocument()
    expect(inspector.querySelector('input, textarea, select, [contenteditable="true"]')).toBeNull()
    expect(within(inspector).queryByRole('textbox')).toBeNull()
    expect(within(inspector).queryByRole('button', { name: /Status/ })).toBeNull()
    expect(within(inspector).queryByRole('button', { name: 'Delete Card' })).toBeNull()
    expect(screen.queryByText('Delete Card')).toBeNull()
    // What is left: close, open the Page, walk the Connections.
    expect(within(inspector).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Close',
      'Open Page',
      '→MWPM decoderdecoded by',
    ])
  })

  it('Delete and Backspace remove nothing', () => {
    renderAs(PRIYA)
    act(() => ui.select(['c1']))
    fireEvent.keyDown(screen.getByTestId('board'), { key: 'Delete' })
    fireEvent.keyDown(screen.getByTestId('board'), { key: 'Backspace' })
    expect(screen.getByTestId('card-c1')).toBeInTheDocument()
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('the Page panel says "Read-only" and has no To-dos section and nothing to edit', () => {
    h.blocks = [{ id: 'b1', card: 'c1', type: 'text', title: '', text: 'The threshold is **about 1%**.', order: '1' }]
    renderAs(PRIYA)
    act(() => ui.select(['c1']))
    fireEvent.click(within(screen.getByTestId('inspector')).getByRole('button', { name: 'Open Page' }))
    const panel = screen.getByTestId('page-panel')
    expect(within(panel.querySelector('header')!).getByText('Read-only')).toBeInTheDocument()
    expect(within(panel).getByText('about 1%')).toBeInTheDocument()
    fireEvent.click(within(panel).getByText('about 1%'))
    expect(within(panel).queryByRole('textbox')).toBeNull()
    expect(within(panel).queryByRole('region', { name: /To-dos/ })).toBeNull()
    expect(within(panel).queryByText(/To-do/)).toBeNull()
    expect(within(panel).queryByRole('button', { name: /Add block|Add Source|Move block|Delete block|Edit|Change status/ })).toBeNull()
  })

  it('a Member has the toolbar, editable fields and "Delete Card" in the same places', () => {
    seedBoard(false)
    renderAs(MEI)
    expect(screen.getByText('+ Card')).toBeInTheDocument()
    expect(screen.getByText('+ Frame')).toBeInTheDocument()
    act(() => ui.select(['c1']))
    const inspector = screen.getByTestId('inspector')
    expect(within(inspector).getByRole('textbox', { name: 'Title' })).toBeInTheDocument()
    expect(within(inspector).getByRole('button', { name: 'Delete Card' })).toBeInTheDocument()
  })
})

describe('Guest: Member-only routes', () => {
  const ROUTES = ['/todos', '/branches', '/b/try-QEC', '/b/ana%2Ffit', '/merge?from=try-QEC&into=main', '/members', '/settings/ai']

  it.each(ROUTES)('%s redirects to /', async (path) => {
    renderAs(PRIYA, path)
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/'))
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull() // no screen title: To-dos, Branches, Members, AI access, Merge
    expect(h.opened).toEqual(['main'])
    expect(h.reloads).toEqual([])
  })

  it('a Member is not redirected from the same routes', () => {
    seedBoard(false)
    renderAs(MEI, '/branches')
    expect(window.location.pathname).toBe('/branches')
    expect(screen.getByRole('heading', { level: 1, name: 'Branches' })).toBeInTheDocument()
  })
})

describe('when access ends (a request answers 401)', () => {
  it('returns a Guest to the login screen with the reason', () => {
    renderAs(PRIYA)
    answer401()
    expect(screen.getByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(ENDED)
  })

  it('says nothing of the kind when a Member session expires', () => {
    seedBoard(false)
    renderAs(MEI)
    answer401()
    expect(screen.getByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
    expect(screen.queryByText(ENDED)).toBeNull()
  })

  it('says nothing when nobody was signed in', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
    expect(screen.queryByText(ENDED)).toBeNull()
  })

  it('says nothing when the Guest pressed "Sign out"', async () => {
    const user = userEvent.setup()
    renderAs(PRIYA)
    await user.click(screen.getByRole('button', { name: /Priya Nair/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
    expect(screen.queryByText(ENDED)).toBeNull()
  })

  it('a Guest who signed out, came back and then lost access is told', async () => {
    const user = userEvent.setup()
    renderAs(PRIYA)
    await user.click(screen.getByRole('button', { name: /Priya Nair/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Sign in to Infall' })
    signIn(PRIYA)
    answer401()
    expect(screen.getByText(ENDED)).toBeInTheDocument()
  })

  it('forgets the reason once someone signs in again', () => {
    renderAs(PRIYA)
    answer401()
    expect(screen.getByText(ENDED)).toBeInTheDocument()
    seedBoard(false)
    signIn(MEI)
    expect(screen.queryByText(ENDED)).toBeNull()
    answer401()
    expect(screen.getByRole('heading', { name: 'Sign in to Infall' })).toBeInTheDocument()
    expect(screen.queryByText(ENDED)).toBeNull()
  })
})

describe('accept-invite and login', () => {
  const invite = (role: Role, access_until?: number) => {
    h.lookup = async () => ({ email: 'priya@cqt.example', role, ...(access_until === undefined ? {} : { access_until }) })
    go('/invite/TOKEN')
    render(<App />)
  }

  it('a Guest invite says what it gives and until when, above the fields', async () => {
    invite('guest', UNTIL)
    expect(await screen.findByRole('heading', { name: "You're invited as a Guest" })).toBeInTheDocument()
    expect(screen.getByText('priya@cqt.example')).toBeInTheDocument()
    const line = screen.getByText("Read-only access to the team's Board until 30 Nov.")
    expect(line.compareDocumentPosition(screen.getByLabelText('Name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join Infall' })).toBeInTheDocument()
  })

  it('a Guest invite without a date (older server) still says read-only', async () => {
    invite('guest')
    await screen.findByRole('heading', { name: "You're invited as a Guest" })
    expect(screen.getByText("Read-only access to the team's Board.")).toBeInTheDocument()
  })

  it('a Member invite has no read-only line and no date', async () => {
    invite('member')
    expect(await screen.findByRole('heading', { name: "You're invited as a Member" })).toBeInTheDocument()
    expect(screen.queryByText(/Read-only access/)).toBeNull()
    expect(screen.queryByText(/until/)).toBeNull()
  })

  it('the login screen points invited people at their link', () => {
    render(<App />)
    expect(screen.getByText('Got an invite? Open the link you were sent.')).toBeInTheDocument()
    expect(screen.getByText('Forgot your password? Ask your Admin.')).toBeInTheDocument()
  })
})

describe('Members screen (Admin)', () => {
  const OVER = new Date(2020, 5, 1, 23, 59, 59, 999).getTime()
  const LATER = new Date(2099, 2, 5, 23, 59, 59, 999).getTime()
  const TOMAS: Member = { id: 't', name: 'Tomas Okafor', role: 'guest', color: '#ddd', email: 't.okafor@uni-delft.nl', access_until: OVER }
  const LIN: Member = { id: 'l', name: 'Lin Chen', role: 'guest', color: '#eee', email: 'lin@cqt.example', access_until: LATER }

  it('lists Guests after Members: active ones with "until", ended ones with "ended"', async () => {
    fake.membersStore.setState({ list: [TOMAS, ADMIN, LIN, MEI] })
    render(<Members me={ADMIN} />)
    const rows = within(screen.getByRole('table', { name: 'Members' })).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      expect.stringContaining('Elena Varga'),
      expect.stringContaining('Mei Lin'),
      expect.stringContaining('Lin Chen'),
      expect.stringContaining('Tomas Okafor'),
    ])
    const active = within(rows[2]!).getByText('Guest · until 5 Mar 2099')
    expect(active).toHaveClass('q-role--guest')
    expect(active).not.toHaveClass('q-role--ended')
    const ended = within(rows[3]!).getByText('Guest · ended 1 Jun 2020')
    expect(ended).toHaveClass('q-role--guest', 'q-role--ended')
    expect(within(rows[0]!).getByText('Admin')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Member')).toBeInTheDocument()
    expect(screen.getByText(/2 Members · 2 Guests/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Tomas Okafor' })).toBeInTheDocument()
    await screen.findByText('No pending invites.')
  })

  it('shows the one-line note for the chosen role under the role choice', async () => {
    const user = userEvent.setup()
    render(<Members me={ADMIN} />)
    await screen.findByText('No pending invites.')
    const group = screen.getByRole('group', { name: 'Role' })
    expect(within(group).getByText('Full access: edit, Branch, Merge, To-dos and their own AI.')).toBeInTheDocument()
    await user.click(within(group).getByRole('radio', { name: 'Guest' }))
    expect(within(group).getByText('Read-only Board and Pages on main. No editing, To-dos, AI or History.')).toBeInTheDocument()
    expect(within(group).queryByText(/Full access/)).toBeNull()
    await user.click(within(group).getByRole('radio', { name: 'Member' }))
    expect(within(group).getByText('Full access: edit, Branch, Merge, To-dos and their own AI.')).toBeInTheDocument()
  })
})
