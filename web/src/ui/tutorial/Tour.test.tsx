import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '../../lib'
import { aiPanel, useAiPanel } from '../bridge'
import { tourKey } from './memory'
import { startTour } from './start'
import { tour, useTour } from './store'
import { GONE_AFTER_MS, Tour } from './Tour'

const MEMBER: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const OTHER: Member = { id: 'o', name: 'Omar Haddad', role: 'member', color: '#ddd' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }

const MEMBER_SCREEN = ['board', 'add', 'card', 'search', 'rail', 'branch', 'checkpoint', 'history', 'ai', 'account']
const GUEST_SCREEN = ['board', 'card', 'search', 'guest', 'account']

/** A stand-in for the shell: the controls the tour points at, and the tour itself. */
function Screen({ member, view = 'board', controls }: { member: Member; view?: string; controls?: string[] }) {
  const names = controls ?? (member.role === 'guest' ? GUEST_SCREEN : MEMBER_SCREEN)
  return (
    <>
      {names.map((name) => (
        <button key={name} type="button" data-tour={name}>
          {name}
        </button>
      ))}
      <input aria-label="Somewhere to type" />
      <Tour key={member.id} member={member} view={view} />
    </>
  )
}

const offer = () => screen.queryByText('New here? Take a two-minute tour of Infall.')
const dialog = () => screen.queryByRole('dialog')
const title = () => screen.queryByRole('heading')?.textContent
const press = (name: string) => userEvent.click(screen.getByRole('button', { name }))
const begin = (member: Member) => act(() => startTour(member))

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  setWidth(1440)
})

afterEach(() => {
  cleanup()
  tour.end()
  aiPanel.close()
  vi.restoreAllMocks()
  delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
})

describe('the offer', () => {
  it('is shown to a Member who was never asked on this device', () => {
    render(<Screen member={MEMBER} />)
    expect(offer()).toBeInTheDocument()
    expect(dialog()).toBeNull() // only offered: nothing starts by itself
  })

  it('"Not now" is remembered for that Member, and another Member is still asked', async () => {
    const first = render(<Screen member={MEMBER} />)
    await press('Not now')
    expect(offer()).toBeNull()
    expect(dialog()).toBeNull()
    expect(window.localStorage.getItem(tourKey('m'))).toBe('declined')
    first.unmount()

    const again = render(<Screen member={MEMBER} />)
    expect(offer()).toBeNull()
    again.unmount()

    render(<Screen member={OTHER} />)
    expect(offer()).toBeInTheDocument()
  })

  it('"Start the tour" starts it and is remembered: the offer does not come back', async () => {
    const first = render(<Screen member={MEMBER} />)
    await press('Start the tour')
    expect(offer()).toBeNull()
    expect(title()).toBe('The Board')
    expect(window.localStorage.getItem(tourKey('m'))).toBe('started')
    await press('Skip the tour')
    expect(dialog()).toBeNull()
    expect(offer()).toBeNull()
    first.unmount()

    render(<Screen member={MEMBER} />)
    expect(offer()).toBeNull()
  })

  it('a tour started from elsewhere counts as the answer', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    await press('Skip the tour')
    expect(offer()).toBeNull()
    expect(window.localStorage.getItem(tourKey('m'))).toBe('started')
  })

  it('is not shown when storage cannot be read, and the tour can still be started', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    render(<Screen member={MEMBER} />)
    expect(offer()).toBeNull()
    await begin(MEMBER)
    expect(title()).toBe('The Board')
    await press('Skip the tour')
    expect(offer()).toBeNull()
  })

  it('is not shown when storage cannot be written, and the tour can still be started', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    render(<Screen member={MEMBER} />)
    expect(offer()).toBeNull()
    await begin(MEMBER)
    expect(title()).toBe('The Board')
  })

  it('is not shown over a Merge, nor in a window narrower than the layout supports', () => {
    const merge = render(<Screen member={MEMBER} view="merge" />)
    expect(offer()).toBeNull()
    merge.unmount()

    setWidth(880)
    render(<Screen member={MEMBER} />)
    expect(offer()).toBeNull()
  })
})

describe('starting', () => {
  it('a Member gets eleven steps', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    expect(screen.getByText('Step 1 of 11')).toBeInTheDocument()
  })

  it('a Guest gets the short tour', async () => {
    render(<Screen member={GUEST} />)
    await begin(GUEST)
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    await press('Next')
    expect(title()).toBe('A Card and its Page')
    await press('Next')
    expect(title()).toBe('Search')
    await press('Next')
    expect(title()).toBe('Reading as a Guest')
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('leaves out the steps whose control is not on screen', async () => {
    render(<Screen member={MEMBER} controls={MEMBER_SCREEN.filter((n) => n !== 'rail' && n !== 'ai')} />)
    await begin(MEMBER)
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument()
    expect(useTour.getState().steps.map((s) => s.id)).not.toContain('rail')
    expect(useTour.getState().steps.map((s) => s.id)).not.toContain('ai')
  })

  it('does not start with fewer than three steps left', async () => {
    render(<Screen member={GUEST} controls={['board', 'search', 'account']} />)
    await begin(GUEST)
    expect(dialog()).toBeNull()
    expect(window.localStorage.getItem(tourKey('g'))).toBeNull()
  })

  it('does not start in a narrow window or over a Merge', async () => {
    render(<Screen member={MEMBER} />)
    await press('Not now')
    setWidth(880)
    await begin(MEMBER)
    expect(dialog()).toBeNull()
    setWidth(1440)
    window.history.replaceState(null, '', '/merge?from=a&into=main')
    await begin(MEMBER)
    expect(dialog()).toBeNull()
  })

  it('goes to the Board first when another screen is showing', async () => {
    window.history.replaceState(null, '', '/todos')
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    expect(window.location.pathname).toBe('/')
    await waitFor(() => expect(title()).toBe('The Board'))
  })
})

describe('moving through the steps', () => {
  it('Next and Back move; the first step has no Back; the last one has Done, which ends the tour', async () => {
    render(<Screen member={GUEST} />)
    await begin(GUEST)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    await press('Next')
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    await press('Back')
    expect(title()).toBe('The Board')
    await press('Next')
    await press('Next')
    await press('Next')
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    await press('Done')
    expect(dialog()).toBeNull()
  })

  it('"Skip the tour" ends it on any step', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    await press('Next')
    await press('Skip the tour')
    expect(dialog()).toBeNull()
    expect(useTour.getState().steps).toEqual([])
  })

  it('Esc ends the tour', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    await userEvent.keyboard('{Escape}')
    expect(dialog()).toBeNull()
  })

  it('Esc pressed while typing elsewhere is not the tour’s', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    await userEvent.click(screen.getByLabelText('Somewhere to type'))
    await userEvent.keyboard('{Escape}')
    expect(dialog()).toBeInTheDocument()
  })

  it('the arrow keys go forward and back while focus is in the popover, and nowhere else', async () => {
    render(<Screen member={GUEST} />)
    await begin(GUEST)
    await userEvent.keyboard('{ArrowLeft}') // nothing before the first step
    expect(title()).toBe('The Board')
    await userEvent.keyboard('{ArrowRight}')
    expect(title()).toBe('A Card and its Page')
    await userEvent.keyboard('{ArrowLeft}')
    expect(title()).toBe('The Board')
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(title()).toBe('Reading as a Guest')
    await userEvent.keyboard('{ArrowRight}') // the last step: only Done ends it
    expect(title()).toBe('Reading as a Guest')

    await userEvent.click(screen.getByLabelText('Somewhere to type'))
    await userEvent.keyboard('{ArrowLeft}')
    expect(title()).toBe('Reading as a Guest')
  })

  it('the AI step opens the sidebar the way its button does, and closes it again', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    for (let i = 0; i < 8; i++) await press('Next')
    expect(title()).toBe('The AI sidebar')
    expect(useAiPanel.getState().open).toBe(true)
    await press('Next')
    expect(title()).toBe('Runs')
    expect(useAiPanel.getState().open).toBe(false)
  })

  it('the Runs step reads differently in the desktop app', async () => {
    const view = render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    for (let i = 0; i < 9; i++) await press('Next')
    expect(screen.getByText('Here in the browser you see the result of the last Run.')).toBeInTheDocument()
    await press('Skip the tour')
    view.unmount()

    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = {}
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    for (let i = 0; i < 9; i++) await press('Next')
    expect(title()).toBe('Runs')
    expect(screen.getByText(/on your own computer, after you have seen it and approved it/)).toBeInTheDocument()
    expect(screen.queryByText(/browser/)).toBeNull()
  })

  it('the last step says where to read more and where the tour is kept', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    for (let i = 0; i < 10; i++) await press('Next')
    expect(title()).toBe('Where to read more')
    expect(screen.getByText(/written tutorial your Admin can give you/)).toBeInTheDocument()
    expect(screen.getByText(/account menu, as “Tour of Infall”/)).toBeInTheDocument()
  })
})

describe('focus and the screen reader', () => {
  it('is a dialog that is not modal, named by its title and read with the step count', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    const box = screen.getByRole('dialog', { name: 'The Board' })
    expect(box).toHaveAttribute('aria-modal', 'false')
    expect(box).toHaveAccessibleDescription(/^Step 1 of 11 Each Card is one idea/)
  })

  it('takes focus when a step opens, and leaves Tab to the rest of the app', async () => {
    render(<Screen member={MEMBER} />)
    await press('Not now')
    await begin(MEMBER)
    expect(dialog()).toHaveFocus()
    await press('Next')
    expect(dialog()).toHaveFocus() // the next step's popover
    await userEvent.tab()
    await userEvent.tab()
    await userEvent.tab()
    await userEvent.tab()
    expect(dialog()).not.toContainElement(document.activeElement as HTMLElement) // not trapped
  })

  it('gives focus back to where it was when the tour ends', async () => {
    render(<Screen member={MEMBER} />)
    await press('Not now')
    const search = screen.getByRole('button', { name: 'search' })
    search.focus()
    await begin(MEMBER)
    expect(search).not.toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(search).toHaveFocus()
  })

  it('gives focus to the account menu when the tour was started from the offer', async () => {
    render(<Screen member={MEMBER} />)
    await press('Start the tour')
    await press('Skip the tour')
    expect(screen.getByRole('button', { name: 'account' })).toHaveFocus()
  })

  it('does not take focus from where the Member has put it since', async () => {
    render(<Screen member={MEMBER} />)
    await press('Not now')
    screen.getByRole('button', { name: 'search' }).focus()
    await begin(MEMBER)
    const field = screen.getByLabelText('Somewhere to type')
    await userEvent.click(field)
    act(() => tour.end())
    expect(field).toHaveFocus()
  })
})

describe('following the app', () => {
  it('ends quietly when the Member leaves the Board', async () => {
    const view = render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    view.rerender(<Screen member={MEMBER} view="todos" />)
    expect(dialog()).toBeNull()
    expect(useTour.getState().steps).toEqual([])
  })

  it('ends when the window becomes narrower than the layout supports', async () => {
    render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    setWidth(880)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(dialog()).toBeNull()
  })

  it('moves on when the control of the step goes away', async () => {
    const view = render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    for (let i = 0; i < 4; i++) await press('Next')
    expect(title()).toBe('Search')
    view.rerender(<Screen member={MEMBER} controls={MEMBER_SCREEN.filter((n) => n !== 'search')} />)
    await waitFor(() => expect(title()).toBe('The rail'), { timeout: GONE_AFTER_MS + 1500 })
    expect(screen.getByText('Step 5 of 10')).toBeInTheDocument()
  })

  it('draws the ring where the control is and follows it', async () => {
    render(<Screen member={MEMBER} />)
    const board = screen.getByRole('button', { name: 'board' })
    let box = { left: 300, top: 100, width: 120, height: 30 }
    board.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box })
    await begin(MEMBER)
    const ring = () => document.querySelector<HTMLElement>('.q-tour-ring')
    expect(ring()).toHaveStyle({ left: '296px', top: '96px', width: '128px', height: '38px' })
    expect(dialog()).toHaveStyle({ left: '300px', top: '140px' }) // under it

    box = { ...box, left: 500 }
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    await waitFor(() => expect(ring()).toHaveStyle({ left: '496px' }))
    expect(dialog()).toHaveStyle({ left: '500px' })
  })

  it('the tour goes with the Member who signs out', async () => {
    const view = render(<Screen member={MEMBER} />)
    await begin(MEMBER)
    view.unmount()
    expect(useTour.getState().steps).toEqual([])
  })
})
