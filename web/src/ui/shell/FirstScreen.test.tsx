// M18 (team-move.md, decision 4): the first screen of an empty Team server, for its Admin — against the real data
// layer, the fake server and a fake desktop bridge.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '../../lib'
import { membersStore } from '../../lib/people'
import { sessionStore } from '../../lib/session-store'
import { FakeServer, FakeSocket, installDesktop, ME, settle } from '../../lib/testing'
import { workspace, workspaceStore } from '../../lib/workspace'
import { FirstScreen } from './FirstScreen'
import { formatSize, useFirstScreen } from './moved'

const ADMIN: Member = { ...ME, name: 'Elena Varga', role: 'admin' }
let server: FakeServer
let uninstall: (() => void) | null = null

async function flush() {
  await act(async () => settle())
}

beforeEach(async () => {
  server = new FakeServer()
  server.actor = ADMIN
  server.members = [ADMIN]
  server.workspace = { kind: 'team', preset: null, empty: true }
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('XMLHttpRequest', server.xhr())
  sessionStore.setState({ status: 'signed_out' }, true)
  sessionStore.setState({ status: 'signed_in', member: ADMIN }, true)
  membersStore.setState({ members: [ADMIN] })
  await act(async () => workspace.load())
})

afterEach(() => {
  cleanup()
  uninstall?.()
  uninstall = null
  useFirstScreen.setState({ holding: false })
  act(() => sessionStore.setState({ status: 'signed_out' }, true))
  vi.unstubAllGlobals()
})

const file = (bytes = 2048, name = 'Physics group.infall') => new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' })

describe('the choice', () => {
  it('Start empty steps aside, asking nothing of the server', async () => {
    render(<FirstScreen />)
    expect(screen.getByRole('heading', { name: 'This Team server is empty' })).toBeInTheDocument()
    const before = server.requests.length
    fireEvent.click(screen.getByRole('button', { name: 'Start empty' }))
    expect(workspaceStore.getState().empty).toBe(false)
    expect(useFirstScreen.getState().holding).toBe(false)
    expect(server.requests.length).toBe(before)
  })

  it('Bring in a Workspace file… opens the picker; the file goes up with progress, then the answer', async () => {
    server.importAnswer = {
      members: [
        { id: ADMIN.id, name: 'Elena Varga', claimed: true },
        { id: 'ana', name: 'Ana Ruiz', claimed: false },
        { id: 'ben', name: 'Ben Okafor', claimed: false },
      ],
      you_were: 'Elena on her laptop',
    }
    let release!: () => void
    server.uploadGate = new Promise<void>((r) => (release = r))
    const user = userEvent.setup()
    render(<FirstScreen />)
    const input = screen.getByLabelText('Workspace file') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    await user.click(screen.getByRole('button', { name: 'Bring in a Workspace file…' }))
    expect(click).toHaveBeenCalled()
    fireEvent.change(input, { target: { files: [file(4096)] } })
    await flush()
    expect(screen.getByText('Bringing in Physics group.infall…')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('1 KB of 4 KB')).toBeInTheDocument()
    release()
    await flush()
    expect(screen.getByRole('heading', { name: 'The Workspace is in' })).toHaveFocus()
    expect(screen.getByText('Your earlier work as Elena on her laptop is now yours.')).toBeInTheDocument()
    const names = within(screen.getByRole('region', { name: 'Names that came with the file' }))
    expect(names.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Ana Ruiz — not signed in yetInvite', 'Ben Okafor — not signed in yetInvite'])
    expect(names.getByRole('link', { name: 'Invite Ana Ruiz' })).toHaveAttribute('href', '/members?claim=ana')
    expect((server.imported[0] as Blob).size).toBe(4096)
    // The answer stays up after the server is no longer empty, until the Admin goes on.
    expect(workspaceStore.getState().empty).toBe(false)
    expect(useFirstScreen.getState().holding).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open the Board' }))
    expect(useFirstScreen.getState().holding).toBe(false)
  })

  it('a refusal shows the server’s sentence and what to do next; the choice comes back', async () => {
    server.importFail = { status: 400, code: 'not_a_workspace_file', message: 'This is not a Workspace file.' }
    render(<FirstScreen />)
    fireEvent.change(screen.getByLabelText('Workspace file'), { target: { files: [file()] } })
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('This is not a Workspace file. Choose another file, or try again.')
    expect(screen.getByRole('button', { name: 'Bring in a Workspace file…' })).toBeInTheDocument()
  })

  it('Stop takes the upload back to the choice', async () => {
    server.uploadGate = new Promise<void>(() => {})
    render(<FirstScreen />)
    fireEvent.change(screen.getByLabelText('Workspace file'), { target: { files: [file()] } })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeInTheDocument()
    expect(server.imported).toEqual([])
  })
})

describe('a move handed over by the desktop app', () => {
  function bridge(handover: { name: string; size: number } | null) {
    const desk = {
      moveHandover: vi.fn(async () => handover),
      moveFile: vi.fn(async () => new Uint8Array(3_400_000)),
      moveDone: vi.fn(async () => {}),
    }
    uninstall = installDesktop(desk)
    return desk
  }

  it('offers it in one press: the file from the app, the upload, then moveDone({ ok: true })', async () => {
    const desk = bridge({ name: 'Tutorial', size: 3_400_000 })
    render(<FirstScreen />)
    await flush()
    const press = screen.getByRole('button', { name: 'Bring in Tutorial from this computer (3.2 MB)' })
    expect(press).toHaveClass('q-btn--primary')
    expect(screen.getByRole('button', { name: 'Bring in a Workspace file…' })).not.toHaveClass('q-btn--primary')
    fireEvent.click(press)
    await flush()
    expect(desk.moveFile).toHaveBeenCalledOnce()
    expect((server.imported[0] as Blob).size).toBe(3_400_000)
    expect(desk.moveDone).toHaveBeenCalledWith({ ok: true })
    expect(screen.getByText('Your earlier work as Me on my laptop is now yours.')).toBeInTheDocument()
  })

  it('a failed import tells the app moveDone({ ok: false }), so the Admin can try again', async () => {
    const desk = bridge({ name: 'Tutorial', size: 10 })
    server.importFail = { status: 422, code: 'newer_version', message: 'This file was made by a newer Infall. Update the server first.' }
    render(<FirstScreen />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Bring in Tutorial from this computer/ }))
    await flush()
    expect(desk.moveDone).toHaveBeenCalledWith({ ok: false })
    expect(screen.getByRole('alert')).toHaveTextContent('This file was made by a newer Infall. Update the server first.')
    expect(screen.getByRole('button', { name: /Bring in Tutorial from this computer/ })).toBeInTheDocument()
  })

  it('no pending move: only the ordinary choice', async () => {
    bridge(null)
    render(<FirstScreen />)
    await flush()
    expect(screen.queryByRole('button', { name: /from this computer/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Bring in a Workspace file…' })).toHaveClass('q-btn--primary')
  })
})

it('sizes read in powers of 1024', () => {
  expect([formatSize(512), formatSize(1), formatSize(2048), formatSize(3_400_000), formatSize(52 * 1024 ** 2), formatSize(1.1 * 1024 ** 3)]).toEqual([
    '512 bytes',
    '1 byte',
    '2 KB',
    '3.2 MB',
    '52 MB',
    '1.1 GB',
  ])
})
