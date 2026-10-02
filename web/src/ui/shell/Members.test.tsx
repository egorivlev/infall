import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Invite, Member } from '../../lib'

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
type Fn = (...a: unknown[]) => Promise<unknown>
const h = vi.hoisted(() => ({
  people: [] as Member[],
  pending: [] as Invite[],
  remove: (async () => {}) as Fn,
  create: (async () => ({})) as Fn,
  revoke: (async () => {}) as Fn,
  removed: [] as unknown[][],
  created: [] as unknown[][],
  revoked: [] as unknown[][],
}))

vi.mock('../../lib', () => ({
  useMembers: () => h.people,
  members: {
    remove: (...a: unknown[]) => {
      h.removed.push(a)
      return h.remove(...a)
    },
  },
  invites: {
    list: async () => h.pending,
    create: (...a: unknown[]) => {
      h.created.push(a)
      return h.create(...a)
    },
    remove: (...a: unknown[]) => {
      h.revoked.push(a)
      return h.revoke(...a)
    },
  },
}))

import { Members } from './Members'

const ELENA: Member = { id: 'e', name: 'Elena Varga', role: 'admin', color: '#aaa', email: 'e@lab.org' }
const ANA: Member = { id: 'a', name: 'Ana Ruiz', role: 'member', color: '#bbb', email: 'ana@lab.org' }
const PRIYA: Member = { id: 'p', name: 'Priya Nair', role: 'guest', color: '#ccc', email: 'priya@cqt.example', access_until: new Date(2030, 11, 15).getTime() }

beforeEach(() => {
  h.people = [ELENA, ANA, PRIYA]
  h.pending = []
  h.remove = async () => {}
  h.create = async () => ({ invite: {}, url: 'https://qoop.test/invite/TOKEN123' })
  h.revoke = async () => {}
  h.removed = []
  h.created = []
  h.revoked = []
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderMembers = () => render(<Members me={ELENA} />)

describe('Members table', () => {
  it('lists people with email and role, counts them, and has no Remove on your own row', async () => {
    renderMembers()
    const table = screen.getByRole('table', { name: 'Members' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(4) // header + 3
    expect(within(rows[1]!).getByText('Elena Varga')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('e@lab.org')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Admin')).toBeInTheDocument()
    expect(within(rows[1]!).queryByRole('button')).toBeNull()
    expect(within(rows[3]!).getByText('until 15 Dec 2030')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Ana Ruiz' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
    expect(screen.getByText(/2 Members · 1 Guest/)).toBeInTheDocument()
    await screen.findByText('No pending invites.')
  })

  it('confirms by name, then calls members.remove', async () => {
    const user = userEvent.setup()
    renderMembers()
    await user.click(screen.getByRole('button', { name: 'Remove Ana Ruiz' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Ana Ruiz?' })
    expect(dialog).toHaveAccessibleDescription('They lose access immediately. Their past Changes stay.')
    expect(h.removed).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(h.removed).toEqual([['a']])
  })

  it('Cancel and Esc close the dialog without removing, and focus returns to the trigger', async () => {
    const user = userEvent.setup()
    renderMembers()
    const trigger = screen.getByRole('button', { name: 'Remove Ana Ruiz' })
    await user.click(trigger)
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(h.removed).toHaveLength(0)
  })

  it('traps Tab focus inside the dialog', async () => {
    const user = userEvent.setup()
    renderMembers()
    await user.click(screen.getByRole('button', { name: 'Remove Ana Ruiz' }))
    const dialog = screen.getByRole('dialog')
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    const confirm = within(dialog).getByRole('button', { name: 'Remove' })
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
  })

  it('shows a plain error in the dialog when removal fails and ignores double clicks', async () => {
    let calls = 0
    h.remove = () => {
      calls++
      return Promise.reject(Object.assign(new Error('x'), { status: 0, code: 'network' }))
    }
    const user = userEvent.setup()
    renderMembers()
    await user.click(screen.getByRole('button', { name: 'Remove Ana Ruiz' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server.")
    expect(calls).toBe(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('Pending invites', () => {
  it('lists them and revokes', async () => {
    h.pending = [{ id: 'i1', email: 't.okafor@uni-delft.nl', role: 'guest', access_until: new Date(2030, 11, 15).getTime(), expires_at: new Date(2030, 10, 1).getTime(), created_by: 'e' }]
    const user = userEvent.setup()
    renderMembers()
    expect(await screen.findByText('t.okafor@uni-delft.nl')).toBeInTheDocument()
    expect(screen.getByText(/Guest · until 15 Dec 2030/)).toBeInTheDocument()
    h.pending = []
    await user.click(screen.getByRole('button', { name: 'Revoke invite for t.okafor@uni-delft.nl' }))
    expect(h.revoked).toEqual([['i1']])
    expect(await screen.findByText('No pending invites.')).toBeInTheDocument()
  })
})

describe('Invite form', () => {
  const emailField = () => screen.getByRole('textbox', { name: 'Email' })

  it('shows "Access until" only for Guest, requires it, and rejects a past date', async () => {
    const user = userEvent.setup()
    renderMembers()
    expect(screen.queryByLabelText('Access until')).toBeNull()
    await user.type(emailField(), 'priya@cqt.example')
    await user.click(screen.getByRole('radio', { name: 'Guest' }))
    const until = screen.getByLabelText('Access until')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(screen.getByText('Choose the date their access ends.')).toBeInTheDocument()
    expect(h.created).toHaveLength(0)
    fireEvent.change(until, { target: { value: '2001-01-01' } })
    expect(screen.queryByText('Choose the date their access ends.')).toBeNull()
    expect(screen.getByText('Choose a date in the future.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(screen.getByText('Choose a date in the future.')).toBeInTheDocument()
    expect(h.created).toHaveLength(0)
    fireEvent.change(until, { target: { value: '2099-06-01' } })
    expect(screen.queryByText('Choose a date in the future.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(h.created).toHaveLength(1))
    const input = h.created[0]![0] as { email: string; role: string; access_until: number }
    expect(input.role).toBe('guest')
    expect(input.email).toBe('priya@cqt.example')
    expect(new Date(input.access_until).getFullYear()).toBe(2099)
    expect(screen.queryByLabelText('Access until')).not.toBeNull()
  })

  it('sends a Member invite without a date and validates the email', async () => {
    const user = userEvent.setup()
    renderMembers()
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument()
    await user.type(emailField(), 'new@lab.org')
    expect(screen.queryByText('Enter an email address.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(h.created).toEqual([[{ email: 'new@lab.org', role: 'member' }]]))
  })

  it('shows the link once in a read-only field with Copy and the expiry line', async () => {
    const user = userEvent.setup()
    renderMembers()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.type(emailField(), 'new@lab.org')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    const url = await screen.findByLabelText('Invite link for new@lab.org')
    expect(url).toHaveValue('https://qoop.test/invite/TOKEN123')
    expect(url).toHaveAttribute('readonly')
    expect(screen.getByText('This is shown once. It expires in 7 days.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(write).toHaveBeenCalledWith('https://qoop.test/invite/TOKEN123')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    // The form is cleared; the next invite replaces the link.
    expect(emailField()).toHaveValue('')
  })

  it('falls back gracefully when the Clipboard API is unavailable', async () => {
    const user = userEvent.setup()
    renderMembers()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    await user.type(emailField(), 'new@lab.org')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    await user.click(await screen.findByRole('button', { name: 'Copy' }))
    expect(await screen.findByText(/Couldn't copy automatically/)).toBeInTheDocument()
  })

  it('maps email_taken onto the email field', async () => {
    h.create = () => Promise.reject(Object.assign(new Error('x'), { status: 409, code: 'email_taken' }))
    const user = userEvent.setup()
    renderMembers()
    await user.type(emailField(), 'ana@lab.org')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(await screen.findByText('Someone with that email already has access.')).toBeInTheDocument()
    expect(emailField()).toHaveAccessibleDescription('Someone with that email already has access.')
    expect(screen.queryByText('This is shown once. It expires in 7 days.')).toBeNull()
  })

  it('shows "Sending invite…" and ignores further clicks while in flight', async () => {
    let finish: (v: unknown) => void = () => {}
    h.create = () => new Promise((r) => (finish = r))
    const user = userEvent.setup()
    renderMembers()
    await user.type(emailField(), 'new@lab.org')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    const busy = await screen.findByRole('button', { name: 'Sending invite…' })
    await user.click(busy)
    expect(h.created).toHaveLength(1)
    finish({ invite: {}, url: 'https://qoop.test/invite/T' })
    await screen.findByLabelText('Invite link for new@lab.org')
  })
})
