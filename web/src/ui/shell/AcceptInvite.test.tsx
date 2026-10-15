import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
type Fn = (...a: unknown[]) => Promise<unknown>
const h = vi.hoisted(() => ({ lookup: (async () => ({})) as Fn, accept: (async () => {}) as Fn, lookups: [] as unknown[][], accepts: [] as unknown[][] }))
vi.mock('../../lib', () => ({
  invites: {
    lookup: (...a: unknown[]) => {
      h.lookups.push(a)
      return h.lookup(...a)
    },
  },
  session: {
    acceptInvite: (...a: unknown[]) => {
      h.accepts.push(a)
      return h.accept(...a)
    },
  },
}))

import { AcceptInvite } from './AcceptInvite'

afterEach(cleanup)
beforeEach(() => {
  h.lookups = []
  h.accepts = []
})

const failWith = (status: number, code: string) => Promise.reject(Object.assign(new Error(code), { status, code }))
const INVALID = 'This invite is no longer valid. Ask your Admin for a new one.'

describe('AcceptInvite', () => {
  it('shows the invalid-invite message for a 404', async () => {
    h.lookup = () => failWith(404, 'not_found')
    render(<AcceptInvite token="x" />)
    expect(await screen.findByText(INVALID)).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('shows the invalid-invite message for an expired or used invite', async () => {
    h.lookup = () => failWith(410, 'invite_expired')
    render(<AcceptInvite token="x" />)
    expect(await screen.findByText(INVALID)).toBeInTheDocument()
  })

  it('shows a network failure as such, with a retry', async () => {
    let first = true
    h.lookup = () => {
      if (!first) return Promise.resolve({ email: 'a@b.org', role: 'member' })
      first = false
      return failWith(0, 'network')
    }
    const user = userEvent.setup()
    render(<AcceptInvite token="x" />)
    expect(await screen.findByText("Can't reach the server. Check your connection and try again.")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('a@b.org')).toBeInTheDocument()
  })

  it('names the role and email and states the password rule up front', async () => {
    h.lookup = async () => ({ email: 'priya@cqt.example', role: 'guest' })
    render(<AcceptInvite token="tok" />)
    expect(await screen.findByRole('heading', { name: "You're invited as a Guest" })).toBeInTheDocument()
    expect(screen.getByText('priya@cqt.example')).toBeInTheDocument()
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    expect(password).toHaveAccessibleDescription('At least 12 characters')
    expect(h.lookups[0]).toEqual(['tok'])
  })

  it('rejects a password under 12 characters and keeps the rule visible', async () => {
    h.lookup = async () => ({ email: 'a@b.org', role: 'member' })
    const user = userEvent.setup()
    render(<AcceptInvite token="tok" />)
    await user.type(await screen.findByLabelText('Name'), 'Ana Ruiz')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Join Sheaf' }))
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument()
    expect(screen.getByText('At least 12 characters')).toBeInTheDocument()
    expect(h.accepts).toHaveLength(0)
    await user.type(screen.getByLabelText('Password'), '-and-longer')
    expect(screen.queryByText('Use at least 12 characters.')).toBeNull()
  })

  it('calls session.acceptInvite on success and ignores double submits', async () => {
    h.lookup = async () => ({ email: 'a@b.org', role: 'member' })
    let finish: () => void = () => {}
    const pending = new Promise<void>((r) => (finish = r))
    h.accept = () => pending
    const user = userEvent.setup()
    render(<AcceptInvite token="tok" />)
    await user.type(await screen.findByLabelText('Name'), ' Ana Ruiz ')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Join Sheaf' }))
    await user.click(await screen.findByRole('button', { name: 'Joining…' }))
    expect(h.accepts).toHaveLength(1)
    expect(h.accepts[0]).toEqual(['tok', 'Ana Ruiz', 'correct horse battery'])
    finish()
  })
})
