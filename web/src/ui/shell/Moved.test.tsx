// M18 (team-move.md, decision 3): a Local Workspace moved to a Team server opens read-only. The whole shell against
// the real data layer and the fake server: the bar, and every editing control gone or disabled.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ops, todos } from '../../lib'
import { movedRefusals } from '../../lib/http'
import { membersStore } from '../../lib/people'
import { sessionStore } from '../../lib/session-store'
import { FakeServer, FakeSocket, installDesktop, ME, settle } from '../../lib/testing'
import { workspaceStore } from '../../lib/workspace'
import { historyPanel, pagePanel } from '../bridge'
import { App } from './App'
import { navigate, rememberBranch } from './router'

let server: FakeServer
let uninstall: (() => void) | null = null

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => settle())
}

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  rememberBranch('main')
  server = new FakeServer()
  server.members = [ME]
  server.workspace = { kind: 'local', preset: 'blank', read_only: true, moved_to: 'https://lab.example.org' }
  server.commit([ops.createCard({ id: 'a', x: 0, y: 0, title: 'Axions' })], ME.id)
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  // The app asks /api/me first; the fake server has no such route, so the session is set as a Local app sets it.
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME] })
})

afterEach(() => {
  cleanup()
  uninstall?.()
  uninstall = null
  act(() => {
    pagePanel.close()
    historyPanel.close()
    sessionStore.setState({ status: 'signed_out' }, true)
  })
  movedRefusals.reset()
  vi.stubGlobal('fetch', server.fetch)
})

async function open() {
  render(<App />)
  await flush()
  const ws = FakeSocket.last()
  act(() => {
    ws.open()
    ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
  })
  await flush()
}

describe('an empty Team server', () => {
  beforeEach(() => {
    server.workspace = { kind: 'team', preset: null, empty: true }
    server.all[0]!.log = []
    server.all[0]!.entities = {}
  })

  it('greets its Admin with the first screen instead of the Board', async () => {
    const admin = { ...ME, role: 'admin' as const }
    act(() => sessionStore.setState({ status: 'signed_in', member: admin }, true))
    await open()
    expect(screen.getByRole('heading', { name: 'This Team server is empty' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start empty' }))
    expect(screen.queryByTestId('first-screen')).toBeNull()
    expect(screen.getByText('Nothing on this Board yet')).toBeInTheDocument()
  })

  it('a Member sees the ordinary empty Board', async () => {
    await open()
    expect(screen.queryByTestId('first-screen')).toBeNull()
    expect(screen.getByText('Nothing on this Board yet')).toBeInTheDocument()
  })
})

describe('a moved copy', () => {
  it('says where it went, quietly, with Open on the server when the app can go back', async () => {
    const switchWorkspace = vi.fn(async () => {})
    uninstall = installDesktop({ switchWorkspace })
    await open()
    const bar = screen.getByRole('region', { name: 'Moved Workspace' })
    expect(bar).toHaveTextContent('Moved to lab.example.org. This copy is read-only.')
    const button = within(bar).getByRole('button', { name: 'Open on the server' })
    expect(button).toHaveAccessibleDescription('Goes back to the start screen, where this Workspace’s row has Open on the server.')
    fireEvent.click(button)
    expect(switchWorkspace).toHaveBeenCalledOnce()
  })

  it('in a browser there is no button; without moved_to the server stays unnamed', async () => {
    server.workspace = { kind: 'local', preset: null, read_only: true }
    await open()
    const bar = screen.getByRole('region', { name: 'Moved Workspace' })
    expect(bar).toHaveTextContent('Moved to a Team server. This copy is read-only.')
    expect(within(bar).queryByRole('button')).toBeNull()
  })

  it('has no editing controls: no Card or Frame to add, no Checkpoint, no Undo, no Suggestions; History still reads', async () => {
    await open()
    expect(screen.queryByRole('toolbar', { name: 'Add to the Board' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Checkpoint/ })).toBeNull()
    expect(screen.queryByTestId('undo-button')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add Frame' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Suggestions/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' }).closest('aside')).toHaveTextContent('Read-only')
    // Undo has nothing to do here: the desktop Edit menu reads nothing.
    const bridge = (window as { __infallUndo?: { state(): unknown } }).__infallUndo
    expect(bridge?.state()).toEqual({ undo: null, redo: null })
    // The Page of a Card reads, and offers nothing to change.
    act(() => pagePanel.open('a'))
    await flush()
    const page = screen.getByTestId('page-panel')
    expect(within(page).getByText('Read-only')).toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: 'Edit the title' })).toBeNull()
    expect(within(page).queryByText(/Add block/)).toBeNull()
    expect(within(page).queryByRole('combobox')).toBeNull() // no Comment to write
    expect(within(page).queryByText(/To-dos on this Card/)).toBeNull()
  })

  it('To-dos are read, not ticked, added or changed', async () => {
    server.addTodo({ owner: ME.id, text: 'Read the paper' })
    await open()
    act(() => navigate('/todos'))
    await flush()
    expect(screen.getByText('Read the paper')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.queryByRole('textbox', { name: /Add a To-do/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('a refused write shows the server’s sentence once, however many writes were refused', async () => {
    server.workspace = { kind: 'local', preset: null }
    await open()
    expect(screen.queryByRole('region', { name: 'Moved Workspace' })).toBeNull()
    expect(screen.getByRole('toolbar', { name: 'Add to the Board' })).toBeInTheDocument() // the controls the moved copy loses
    expect(screen.getByRole('button', { name: /Checkpoint/ })).toBeInTheDocument()
    // Moved while open (another window did it): the server refuses from now on.
    server.workspace = { kind: 'local', preset: null, read_only: true }
    server.addTodo({ owner: ME.id, text: 'x' })
    await act(async () => todos.reload())
    for (let i = 0; i < 3; i++) await act(async () => void (await todos.setDone(server.todos[0]!.id, true).catch(() => {})))
    await flush()
    const bar = screen.getByRole('region', { name: 'Moved Workspace' })
    const status = within(bar).getByRole('status')
    expect(status).toHaveTextContent('This Workspace was moved to a Team server; open it there to make changes.')
    expect(bar.textContent!.match(/open it there/g)).toHaveLength(1)
    expect(workspaceStore.getState().readOnly).toBe(true)
    expect(screen.queryByRole('toolbar', { name: 'Add to the Board' })).toBeNull()
  })
})
