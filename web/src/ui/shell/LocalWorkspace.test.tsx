// M12: what the account menu and the rail show in a Local Workspace and in a Tutorial Workspace — against the real
// data layer and the fake server.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession, workspace } from '../../lib'
import type { Member } from '../../lib'
import { sessionStore } from '../../lib/session-store'
import { FakeServer } from '../../lib/testing'
import { handsOn, Tour, Tutorial, useHandsOn } from '../tutorial'
import { tour, useTour } from '../tutorial/store'
import { Settings } from '../settings'
import { AccountMenu } from './AccountMenu'
import { Rail } from './Rail'

const ADMIN: Member = { id: 'me', name: 'Mei Lin', role: 'admin', color: '#bbb' }
let server: FakeServer

/** The account menu and the rail, for whoever is signed in, plus the Tour and — in a Tutorial Workspace — the Tutorial. */
function Screen({ tutorial = false, settings = false }: { tutorial?: boolean; settings?: boolean }) {
  const s = useSession()
  if (s.status !== 'signed_in') return null
  return (
    <>
      <div data-tour="board" />
      {settings && <Settings member={s.member} section="workspace" />}
      <AccountMenu member={s.member} />
      <Rail member={s.member} route="board" branch="main" />
      <Tour member={s.member} view="board" offer={!tutorial} />
      {tutorial && <Tutorial />}
    </>
  )
}

async function signIn(kind: 'team' | 'local', preset: string | null = null) {
  server.workspace = { kind, preset }
  server.members = [ADMIN]
  server.actor = ADMIN
  act(() => sessionStore.setState({ status: 'signed_in', member: ADMIN }, true))
  await act(async () => workspace.load())
}

const menu = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Mei Lin|Ana Ruiz/ }))
  return within(screen.getByRole('menu'))
}

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
})

afterEach(() => {
  cleanup()
  tour.end()
  act(() => sessionStore.setState({ status: 'signed_out' }, true))
  vi.unstubAllGlobals()
  delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
})

describe('a Team Workspace', () => {
  it('has Settings, the Tour and Sign out in the menu; Members in the rail and in Settings; no Change name, no Tutorial', async () => {
    await signIn('team')
    render(<Screen settings />)
    expect(screen.getAllByRole('link', { name: 'Members' })).toHaveLength(2) // the rail, and Settings → Workspace
    expect(screen.getByText(/Team Workspace at/)).toHaveTextContent(`Team Workspace at ${window.location.host}`)
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument() // in Settings too
    const m = await menu()
    expect(m.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Settings', 'Tour of Infall', 'Sign out'])
  })

  it('an older server without /api/workspace is a Team Workspace', async () => {
    server.workspace = null
    server.members = [ADMIN]
    act(() => sessionStore.setState({ status: 'signed_in', member: ADMIN }, true))
    await act(async () => workspace.load())
    render(<Screen />)
    expect((await menu()).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })
})

describe('a Local Workspace', () => {
  it('hides what it cannot use: Members, invites and Guests (the Members screen), and Sign out', async () => {
    await signIn('local', 'blank')
    render(<Screen settings />)
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    expect(screen.getByText('Local Workspace, kept on this computer')).toBeInTheDocument()
    const m = await menu()
    expect(m.queryByRole('menuitem', { name: 'Members' })).toBeNull()
    expect(m.queryByRole('menuitem', { name: 'Sign out' })).toBeNull()
    expect(m.queryByRole('menuitem', { name: 'Switch workspace…' })).toBeNull() // no desktop bridge here
    expect(m.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument()
    expect(m.getByRole('menuitem', { name: 'Tour of Infall' })).toBeInTheDocument() // not a Tutorial Workspace: the Tour stays
    expect(m.queryByRole('menuitem', { name: 'Tutorial' })).toBeNull()
  })

  it('offers “Switch workspace…” in the menu and in Settings when the desktop app can', async () => {
    const switchWorkspace = vi.fn(async () => {})
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { switchWorkspace }
    await signIn('local', 'blank')
    render(<Screen settings />)
    await userEvent.click(screen.getByRole('button', { name: 'Switch workspace…' }))
    expect(switchWorkspace).toHaveBeenCalledTimes(1)
    await userEvent.click((await menu()).getByRole('menuitem', { name: 'Switch workspace…' }))
    expect(switchWorkspace).toHaveBeenCalledTimes(2)
  })

  it('“Change name” (Settings → Workspace) changes the name shown everywhere', async () => {
    await signIn('local', 'blank')
    render(<Screen settings />)
    const field = screen.getByLabelText('Your name')
    expect(field).toHaveValue('Mei Lin')
    await userEvent.clear(field)
    await userEvent.type(field, '  Ana Ruiz {Enter}')
    await waitFor(() => expect(screen.getByText('Name changed.')).toBeInTheDocument())
    expect(server.requests.find((r) => r.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/local/member', body: { name: 'Ana Ruiz' } })
    expect(screen.getByRole('button', { name: /Ana Ruiz/ })).toBeInTheDocument() // the account button
    const s = sessionStore.getState()
    expect(s.status === 'signed_in' && s.member.name).toBe('Ana Ruiz')
  })

  it('“Change name” refuses an empty name and says what the server refused', async () => {
    await signIn('local', 'blank')
    render(<Screen settings />)
    const field = () => screen.getByLabelText('Your name')
    await userEvent.clear(field())
    await userEvent.click(screen.getByRole('button', { name: 'Change name' }))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    expect(server.requests.some((r) => r.method === 'PATCH')).toBe(false)

    server.localFail = { status: 500, code: 'internal' }
    await userEvent.type(field(), 'Ana')
    await userEvent.click(screen.getByRole('button', { name: 'Change name' }))
    await waitFor(() => expect(field()).toHaveAttribute('aria-invalid', 'true'))
    expect(field()).toHaveAccessibleDescription(/Something went wrong on our side\. Try again\./)
  })
})

describe('a Tutorial Workspace', () => {
  it('starts the Tutorial by itself, and does not offer the Tour while it runs', async () => {
    await signIn('local', 'tutorial')
    render(<Screen tutorial />)
    await waitFor(() => expect(screen.getByRole('region', { name: 'The Board' })).toBeInTheDocument())
    expect(screen.queryByText(/New here\?/)).toBeNull()
    expect(server.tutorialState).toMatchObject({ v: 1, status: 'running', step: 'look' })
    const m = await menu()
    expect(m.queryByRole('menuitem', { name: 'Tour of Infall' })).toBeNull()
    expect(m.getByRole('menuitem', { name: 'Tutorial' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tutorial' })).toBeInTheDocument() // the progress in the rail
  })

  it('once left, offers the Tour in the menu, and “Tutorial” resumes where it was', async () => {
    await signIn('local', 'tutorial')
    render(<Screen tutorial />)
    await waitFor(() => expect(useHandsOn.getState().phase).toBe('running'))
    act(() => handsOn.skip())
    act(() => handsOn.skip())
    await userEvent.click(screen.getByRole('button', { name: 'Leave the tutorial' }))
    await waitFor(() => expect(server.tutorialState).toMatchObject({ status: 'left', step: 'page' }))
    expect(screen.queryByRole('region', { name: 'Tutorial' })).toBeNull()
    expect(screen.getByRole('button', { name: /Mei Lin/ })).toHaveFocus() // the account menu, where it lives
    expect(screen.queryByText(/New here\?/)).toBeNull() // the offer stays away in a Tutorial Workspace

    let m = await menu()
    expect(m.getByRole('menuitem', { name: 'Tour of Infall' })).toBeInTheDocument()
    await userEvent.click(m.getByRole('menuitem', { name: 'Tutorial' }))
    expect(screen.getByRole('region', { name: 'Its Page' })).toHaveFocus()

    m = await menu()
    expect(m.queryByRole('menuitem', { name: 'Tour of Infall' })).toBeNull()
  })

  it('resuming the Tutorial ends a Tour that was open', async () => {
    await signIn('local', 'tutorial')
    server.tutorialState = { v: 1, status: 'left', step: 'card', results: {} }
    render(<Screen tutorial />)
    await waitFor(() => expect(useHandsOn.getState().phase).toBe('left'))
    await userEvent.click((await menu()).getByRole('menuitem', { name: 'Tour of Infall' }))
    await waitFor(() => expect(useTour.getState().steps.length).toBeGreaterThan(0))
    await userEvent.click((await menu()).getByRole('menuitem', { name: 'Tutorial' }))
    expect(useTour.getState().steps).toEqual([])
    expect(screen.getByRole('region', { name: 'A Card of your own' })).toBeInTheDocument()
  })
})
