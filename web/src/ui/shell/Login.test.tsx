import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
const h = vi.hoisted(() => ({ impl: (async () => {}) as (...a: unknown[]) => Promise<void>, calls: [] as unknown[][] }))
vi.mock('../../lib', () => ({
  session: {
    login: (...a: unknown[]) => {
      h.calls.push(a)
      return h.impl(...a)
    },
  },
}))

import { Login } from './Login'

afterEach(cleanup)
beforeEach(() => {
  h.impl = async () => {}
  h.calls = []
})

const failWith = (status: number, code: string) => Promise.reject(Object.assign(new Error(code), { status, code }))

async function fill(user: ReturnType<typeof userEvent.setup>, email = 'mei@lab.org', password = 'hunter2hunter2') {
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
}

describe('Login', () => {
  it('states the screen, has the right autocomplete and no sign-up link', () => {
    render(<Login />)
    expect(screen.getByRole('heading', { name: 'Sign in to Sheaf' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByText('Forgot your password? Ask your Admin.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText(/sign up|create account|register/i)).toBeNull()
  })

  it('shows the mapped error in plain words', async () => {
    h.impl = () => failWith(401, 'bad_credentials')
    const user = userEvent.setup()
    render(<Login />)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("That email and password don't match.")
    expect(h.calls[0]).toEqual(['mei@lab.org', 'hunter2hunter2'])
  })

  it.each([
    ['too_many_attempts', 'Too many attempts. Try again in a few minutes.'],
    ['network', "Can't reach the server. Check your connection and try again."],
    ['internal', 'Something went wrong on our side. Try again.'],
  ])('maps %s', async (code, text) => {
    h.impl = () => failWith(0, code)
    const user = userEvent.setup()
    render(<Login />)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.getByRole('alert').textContent).not.toContain(code)
  })

  it('ignores a second submit while the request is in flight and shows the busy label', async () => {
    let finish: () => void = () => {}
    const pending = new Promise<void>((r) => (finish = r))
    h.impl = () => pending
    const user = userEvent.setup()
    render(<Login />)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const busy = await screen.findByRole('button', { name: 'Signing in…' })
    expect(busy).not.toBeDisabled()
    await user.click(busy)
    await user.keyboard('{Enter}')
    expect(h.calls).toHaveLength(1)
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument())
  })

  it('keeps the button clickable and says what is missing; clears errors once fixed', async () => {
    const user = userEvent.setup()
    render(<Login />)
    const button = screen.getByRole('button', { name: 'Sign in' })
    expect(button).not.toBeDisabled()
    await user.click(button)
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveFocus()
    expect(h.calls).toHaveLength(0)
    await user.type(screen.getByLabelText('Email'), 'mei@lab.org')
    expect(screen.queryByText('Enter your email address.')).toBeNull()
    await user.click(screen.getByLabelText('Password'))
    await user.tab()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
  })
})
