// Settings in the shell: how it opens, which sections each person sees, and that every control applies at once.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, HistorySnapshot, Member, RunnerSetup, SessionSnapshot } from '../../lib'

const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  kind: 'team' as 'team' | 'local',
  preset: null as string | null,
  runner: { available: false, reason: 'browser' } as RunnerSetup,
  configure: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
  exportFile: vi.fn(async () => ({ name: 'Physics group.infall', bytes: new Uint8Array([1, 2, 3]) })),
}))
const noAi = vi.hoisted(() => ({
  snapshot: { setup: { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }, conversations: [], current: null, busy: false },
}))

vi.mock('../../lib', () => ({
  useForYou: () => ({ status: 'ready', items: [], unseen: 0 }),
  forYou: { reload: async () => {}, seen: async () => {}, onMention: () => () => {} },
  useWorkspace: () => ({ status: 'ready', kind: h.kind, preset: h.preset }),
  workspace: { load: async () => {}, current: () => ({ status: 'ready', kind: h.kind, preset: h.preset }), rename: async (n: string) => n, loadTutorial: async () => null, saveTutorial: async () => {}, exportFile: () => h.exportFile() },
  useAi: () => noAi.snapshot,
  ai: { refresh: async () => {}, models: async () => [] },
  useSession: () => h.session,
  useBoard: (): BoardSnapshot => ({ status: 'live', seq: 1, branch: { id: 'b', name: 'main', seq: 1, checkpoints: 0 }, cards: [], frames: [], connections: [], presence: [], pending: 0, readOnly: false }) as unknown as BoardSnapshot,
  useSuggestions: () => [],
  // M19: the search box asks for words in PDFs; nothing is found here.
  useSources: () => [],
  pdfFiles: { search: async () => [] },
  useRuns: () => ({ runner: h.runner, live: null, last: null }),
  runs: { configure: h.configure },
  useMembers: () => [],
  useBranches: () => [],
  useHistory: (): HistorySnapshot => ({ status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }),
  mergeOptions: () => ({}),
  session: { refresh: async () => {}, logout: h.logout },
  board: { open: async () => {}, close: () => {} },
  members: { reload: async () => {} },
  branches: { reload: async () => {}, create: async () => ({}) },
  history: { open: async () => {}, close: () => {}, preview: () => {}, restore: async () => {}, createCheckpoint: async () => ({}) },
  tokens: { list: async () => [], create: async () => ({}), remove: async () => {} },
  toolEndpoint: () => 'https://qoop.test/mcp',
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))
vi.mock('../todos', () => ({ Todos: () => <div data-testid="todos" /> }))

const { App } = await import('../shell/App')
const { prefs, usePrefs } = await import('./prefs')

const ADMIN: Member = { id: 'a', name: 'Elena Varga', role: 'admin', color: '#aaa' }
const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }

const go = (path: string) => window.history.replaceState(null, '', path)
const signedIn = (m: Member) => (h.session = { status: 'signed_in', member: m })
const nav = () => within(screen.getByRole('navigation', { name: 'Settings' }))
const root = document.documentElement

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('qoop-tour:m', 'declined')
  window.localStorage.setItem('qoop-tour:a', 'declined')
  window.localStorage.setItem('qoop-tour:g', 'declined')
  prefs.reload()
  h.kind = 'team'
  h.preset = null
  h.runner = { available: false, reason: 'browser' }
  h.configure.mockClear()
  h.logout.mockClear()
  signedIn(MEI)
  go('/')
})
afterEach(() => {
  cleanup()
  delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  root.removeAttribute('data-motion')
  root.removeAttribute('style')
})

describe('opening Settings', () => {
  it('opens from the account menu', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Mei Lin/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(window.location.pathname).toBe('/settings')
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeInTheDocument()
    expect(nav().getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens with ⌘, and with Ctrl+, — even from a field', () => {
    render(<App />)
    fireEvent.keyDown(document.body, { key: ',', metaKey: true })
    expect(window.location.pathname).toBe('/settings')
    act(() => go('/'))
    cleanup()
    render(<App />)
    const field = screen.getByRole('combobox', { name: /Search Cards/ })
    field.focus()
    const notPrevented = fireEvent.keyDown(field, { key: ',', ctrlKey: true })
    expect(notPrevented).toBe(false)
    expect(window.location.pathname).toBe('/settings')
  })

  it('a plain "," does nothing', () => {
    render(<App />)
    fireEvent.keyDown(document.body, { key: ',' })
    expect(window.location.pathname).toBe('/')
  })
})

describe('which sections', () => {
  it('a Member sees all six; the AI access section is the old screen, with its access tokens', async () => {
    go('/settings/ai')
    render(<App />)
    expect(nav().getAllByRole('link').map((l) => l.textContent)).toEqual(['Appearance', 'Board', 'AI access', 'Runs', 'Workspace', 'About'])
    expect(screen.getByRole('heading', { level: 1, name: 'AI access' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Access tokens' })).toBeInTheDocument()
    expect(await screen.findByText('No access tokens yet.')).toBeInTheDocument()
  })

  it('a Guest has no AI access and no Runs, and is sent to the Board from them', async () => {
    signedIn(GUEST)
    go('/settings')
    render(<App />)
    expect(nav().getAllByRole('link').map((l) => l.textContent)).toEqual(['Appearance', 'Board', 'Workspace', 'About'])
    cleanup()
    go('/settings/runs')
    render(<App />)
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  it('moves focus to the heading of the section chosen in the list', async () => {
    const user = userEvent.setup()
    go('/settings')
    render(<App />)
    await user.click(nav().getByRole('link', { name: 'Board' }))
    expect(window.location.pathname).toBe('/settings/board')
    expect(screen.getByRole('heading', { level: 1, name: 'Board' })).toHaveFocus()
  })
})

describe('Appearance', () => {
  beforeEach(() => go('/settings/appearance'))

  it('Theme is the same setting as the top bar toggle, applied at once', async () => {
    const user = userEvent.setup()
    render(<App />)
    const theme = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(within(theme).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Light', 'Dark', 'Match system'])
    await user.click(within(theme).getByRole('radio', { name: 'Light' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(screen.getByRole('button', { name: /^Theme: Light/ })).toBeInTheDocument() // the toggle followed
    await user.click(screen.getByRole('button', { name: /^Theme: Light/ }))
    expect(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: 'Match system' })).toHaveAttribute('aria-checked', 'true')
  })

  it('Theme works from the keyboard: arrow keys move and choose', async () => {
    const user = userEvent.setup()
    render(<App />)
    const dark = screen.getByRole('radio', { name: 'Dark' })
    dark.focus()
    await user.keyboard('{ArrowRight}')
    expect(usePrefs.getState().theme).toBe('system')
    await waitFor(() => expect(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: 'Match system' })).toHaveFocus())
    await user.keyboard('{Home}')
    expect(usePrefs.getState().theme).toBe('light')
  })

  it('Interface scale, Text size and Reduce motion apply at once and are kept', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByLabelText('Interface scale'), '125')
    expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('1.25')
    expect(root.style.getPropertyValue('--q-ui-unzoom')).toBe('0.8')
    await user.selectOptions(screen.getByLabelText('Text size'), '120')
    expect(root.style.getPropertyValue('--q-text')).toBe('1.2')
    await user.click(within(screen.getByRole('radiogroup', { name: 'Reduce motion' })).getByRole('radio', { name: 'On' }))
    expect(root).toHaveAttribute('data-motion', 'reduce')
    expect(JSON.parse(window.localStorage.getItem('infall-settings')!)).toMatchObject({ interfaceScale: 125, textSize: 120, reduceMotion: 'reduce' })
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
  })

  it('every control has a visible label, and "Reset to default" only when it differs', async () => {
    const user = userEvent.setup()
    render(<App />)
    const reset = screen.getByRole('button', { name: 'Reset Interface scale to default' })
    expect(reset).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Interface scale'), '80')
    expect(reset).toBeEnabled()
    await user.click(reset)
    expect(usePrefs.getState().interfaceScale).toBe(100)
    expect(screen.getByLabelText('Interface scale')).toHaveValue('100')
    expect(screen.getByLabelText('Interface scale')).toHaveAccessibleDescription(/The Board keeps its own scale/)
  })

  it('"Reset Appearance to defaults" resets the section and leaves the Board alone', async () => {
    const user = userEvent.setup()
    prefs.set({ theme: 'light', textSize: 130, boardScale: 150 })
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Reset Appearance to defaults' }))
    expect(usePrefs.getState()).toMatchObject({ theme: 'dark', textSize: 100, boardScale: 150 })
  })
})

describe('Board', () => {
  it('Board scale is its own setting, with its keys named', async () => {
    const user = userEvent.setup()
    go('/settings/board')
    render(<App />)
    await user.selectOptions(screen.getByLabelText('Board scale'), '150')
    expect(usePrefs.getState()).toMatchObject({ boardScale: 150, interfaceScale: 100 })
    expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('1') // the interface did not move
    expect(screen.getByText('Larger')).toBeInTheDocument()
    expect(screen.getByText('Back to 100%')).toBeInTheDocument()
  })
})

describe('Runs', () => {
  beforeEach(() => go('/settings/runs'))

  it('in a browser: one line, no button', () => {
    render(<App />)
    expect(screen.getByText(/Code can only run in the Infall desktop app/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Runner settings/ })).toBeNull()
  })

  it('in an old app: says to update', () => {
    h.runner = { available: false, reason: 'old_app' }
    render(<App />)
    expect(screen.getByText('This version of the desktop app cannot run code. Update the app.')).toBeInTheDocument()
  })

  it('in the desktop app: what Python is chosen, and the app\'s own Runner settings window', async () => {
    h.runner = { available: true, python: { path: '/usr/bin/python3', version: '3.12.1' } }
    render(<App />)
    expect(screen.getByText('3.12.1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open Runner settings…' }))
    expect(h.configure).toHaveBeenCalledTimes(1)
  })
})

describe('Workspace and About', () => {
  it('a Team Workspace: where it is, Members for an Admin, and Sign out', async () => {
    signedIn(ADMIN)
    go('/settings/workspace')
    render(<App />)
    expect(screen.getByText(/Team Workspace at/)).toHaveTextContent(`Team Workspace at ${window.location.host}`)
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/members')
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign out' }))
    expect(h.logout).toHaveBeenCalledTimes(1)
  })

  it('M18: an Admin exports the Workspace file through the app’s binary save when it has one', async () => {
    const saveBinaryFile = vi.fn(async () => true)
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '0.13.0', saveBinaryFile }
    signedIn(ADMIN)
    go('/settings/workspace')
    render(<App />)
    const card = screen.getByRole('group', { name: 'Workspace file' })
    expect(card).toHaveTextContent(/Members come as names only/)
    await userEvent.click(within(card).getByRole('button', { name: 'Export Workspace file…' }))
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Exported “Physics group.infall”.'))
    expect(saveBinaryFile).toHaveBeenCalledWith({ suggestedName: 'Physics group.infall', bytes: new Uint8Array([1, 2, 3]) })
    delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  })

  it('M18: in a browser the Workspace file is downloaded; a failure says so in plain words', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    signedIn(ADMIN)
    go('/settings/workspace')
    render(<App />)
    const card = screen.getByRole('group', { name: 'Workspace file' })
    await userEvent.click(within(card).getByRole('button', { name: 'Export Workspace file…' }))
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Downloaded “Physics group.infall”.'))
    expect(click).toHaveBeenCalledOnce()
    h.exportFile.mockRejectedValueOnce(Object.assign(new Error('Cannot reach the server.'), { status: 0, code: 'network' }))
    await userEvent.click(within(card).getByRole('button', { name: 'Export Workspace file…' }))
    await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent("The Workspace file could not be exported. Can't reach the server. Check your connection and try again."))
  })

  it('M18: a Member, and a Local Workspace, have no Export', () => {
    go('/settings/workspace')
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Export Workspace file…' })).toBeNull()
  })

  it('a Member has no Members link there', () => {
    go('/settings/workspace')
    render(<App />)
    expect(within(screen.getByRole('main')).queryByRole('link', { name: 'Members' })).toBeNull()
  })

  it('About: the desktop app\'s version when there is one, the Tour, and the font licences', () => {
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '0.12.0' }
    go('/settings/about')
    render(<App />)
    expect(screen.getByText('0.12.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tour of Infall' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'IBM Plex Sans' })).toHaveAttribute('href', '/licenses/LICENSE-IBM-Plex-Sans.txt')
    expect(screen.getByRole('link', { name: 'Source Serif 4' })).toHaveAttribute('href', '/licenses/LICENSE-Source-Serif-4.txt')
  })

  it('About in a browser', () => {
    go('/settings/about')
    render(<App />)
    expect(screen.getByText('In a browser')).toBeInTheDocument()
  })
})
