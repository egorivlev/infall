import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '../../lib'

vi.mock('../../lib', async (orig) => ({ ...(await orig<typeof import('../../lib')>()), session: { logout: vi.fn() } }))

import { AccountMenu } from '../shell/AccountMenu'
import { tour } from './store'
import { Tour } from './Tour'

const MEMBER: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }

function Screen({ member }: { member: Member }) {
  const names = member.role === 'guest' ? ['board', 'card', 'search', 'guest'] : ['board', 'add', 'card', 'search', 'rail', 'branch', 'checkpoint', 'history', 'ai']
  return (
    <>
      {names.map((name) => (
        <div key={name} data-tour={name} />
      ))}
      <AccountMenu member={member} />
      <Tour member={member} view="board" />
    </>
  )
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}
const trigger = () => screen.getByRole('button', { name: /Mei Lin|Priya Nair/ })
const item = () => screen.getByRole('menuitem', { name: 'Tour of Infall' })

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('qoop-tour:m', 'declined') // asked before: only the menu is left
  window.localStorage.setItem('qoop-tour:g', 'declined')
  window.history.replaceState(null, '', '/')
  setWidth(1440)
})

afterEach(() => {
  cleanup()
  tour.end()
  vi.restoreAllMocks()
})

describe('"Tour of Infall" in the account menu', () => {
  it('starts the tour from its first step, and closes the menu', async () => {
    render(<Screen member={MEMBER} />)
    await userEvent.click(trigger())
    await userEvent.click(item())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'The Board' })).toHaveFocus()
    expect(screen.getByText('Step 1 of 11')).toBeInTheDocument() // the account button is the eleventh control

    // Again, after going some way: from the first step.
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Skip the tour' }))
    await userEvent.click(trigger())
    await userEvent.click(item())
    expect(screen.getByRole('dialog', { name: 'The Board' })).toBeInTheDocument()
  })

  it('gives focus back to the account button when the tour ends', async () => {
    render(<Screen member={MEMBER} />)
    await userEvent.click(trigger())
    await userEvent.click(item())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('is reached and chosen with the keyboard like the other items', async () => {
    render(<Screen member={MEMBER} />)
    trigger().focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}')
    expect(item()).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(item()).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'The Board' })).toBeInTheDocument()
  })

  it('a Guest has it too, and gets the short tour', async () => {
    render(<Screen member={GUEST} />)
    await userEvent.click(trigger())
    await userEvent.click(item())
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
  })

  it('works when storage does not', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    render(<Screen member={MEMBER} />)
    expect(screen.queryByText(/New here\?/)).toBeNull()
    await userEvent.click(trigger())
    await userEvent.click(item())
    expect(screen.getByRole('dialog', { name: 'The Board' })).toBeInTheDocument()
  })

  it('cannot be taken while a Merge is open or the window is too narrow, and says why', async () => {
    window.history.replaceState(null, '', '/merge?from=a&into=main')
    const merge = render(<Screen member={MEMBER} />)
    await userEvent.click(trigger())
    expect(item()).toHaveAttribute('aria-disabled', 'true')
    expect(item()).toHaveAttribute('title', 'Finish or leave the Merge first')
    await userEvent.click(item())
    expect(screen.queryByRole('dialog')).toBeNull()
    merge.unmount()

    window.history.replaceState(null, '', '/')
    setWidth(880)
    render(<Screen member={MEMBER} />)
    await userEvent.click(trigger())
    expect(item()).toHaveAttribute('title', 'Make the window wider to take the tour')
    await userEvent.click(item())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
