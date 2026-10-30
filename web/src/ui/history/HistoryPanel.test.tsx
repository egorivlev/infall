import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakeLib())
vi.mock('../../lib', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib')>()), ...fake.lib }))

const { ApiError } = await import('../../lib')
const { HistoryPanel, RESTORE_FAILED, RESTORE_OFFLINE } = await import('./HistoryPanel')
const { Toast } = await import('../board/Toast')
const { toasts } = await import('../board/toastStore')
const { historyPanel, useHistoryPanel } = await import('../bridge')
const { useGraphPreview } = await import('./fromGraph')
const { ACTIVITIES, IDLE, MAIN, READY, at } = await import('./testkit')

const { history, historyStore, boardStore, membersStore } = fake

function renderPanel(onClose?: () => void) {
  return render(
    <>
      <HistoryPanel onClose={onClose} />
      <Toast />
    </>,
  )
}
const range = () => screen.getByRole('slider', { name: 'Moment in History' })
const scrub = (k: number) => fireEvent.change(range(), { target: { value: String(k) } })
const block = (id: string) => screen.getByTestId(`activity-${id}`)
const detail = () => screen.getByTestId('history-detail')
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  fake.reset()
  useHistoryPanel.setState({ open: true })
})
afterEach(() => {
  cleanup()
  act(() => toasts.clear())
  vi.useRealTimers()
})

describe('timeline', () => {
  it('shows the Branch and the counts', () => {
    renderPanel()
    expect(screen.getByRole('region', { name: 'History of main' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'History of main' })).toBeInTheDocument()
    expect(screen.getByTestId('history-counts')).toHaveTextContent('5 Activities · 9 Changes · 3 Checkpoints')
  })

  it('counts in the singular', () => {
    historyStore.setState({ head: 1, activities: [ACTIVITIES[3]!], checkpoints: [READY.checkpoints[0]!] })
    renderPanel()
    expect(screen.getByTestId('history-counts')).toHaveTextContent('1 Activity · 1 Change · 1 Checkpoint')
  })

  it('has one lane per author, with a Former Member in neutral grey', () => {
    renderPanel()
    expect(screen.getByRole('group', { name: 'Activities by Ana Ruiz' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Activities by Mei Tanaka' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Activities by Former Member' })).toBeInTheDocument()
    expect(screen.getAllByTestId(/^lane-/)).toHaveLength(3)

    expect(screen.getByTestId('lane-ana')).toHaveTextContent('AR')
    expect(within(screen.getByTestId('lane-ana')).getByTitle('Ana Ruiz')).toHaveStyle({ background: 'rgb(200, 120, 40)' })
    const former = within(screen.getByTestId('lane-gone')).getByTitle('Former Member')
    expect(former).toHaveClass('is-former')
    expect(former.style.background).toBe('')
  })

  it('renders each Activity as a button with a full label, in its author’s lane', () => {
    renderPanel()
    const ana = screen.getByRole('group', { name: 'Activities by Ana Ruiz' })
    expect(within(ana).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Ana Ruiz · 14 Nov, 09:00–09:12 · 3 Changes',
      'Ana Ruiz · 15 Nov, 12:00 · Restore · 3 Changes',
    ])
    expect(block('a2')).toHaveAccessibleName('Mei Tanaka · 14 Nov, 10:00 · 1 Change')
    expect(block('a2')).toHaveAttribute('title', 'Mei Tanaka · 14 Nov, 10:00 · 1 Change')
    expect(block('a3')).toHaveAccessibleName('Mei Tanaka · 14 Nov, 10:00 · 1 Change')
    expect(block('a4')).toHaveAccessibleName('Former Member · 15 Nov, 11:00 · 1 Change')
    // width 6 + 3 × count; a Restore shows the glyph instead of a plain block
    expect(block('a1')).toHaveStyle({ width: '15px' })
    expect(block('a5')).toHaveTextContent('↺')
    expect(block('a1')).toHaveTextContent('')
  })

  it('colours blocks at or before the scrub position with the Member colour, and the rest neutral', () => {
    renderPanel()
    expect(block('a1')).toHaveClass('is-past')
    expect(block('a1').style.getPropertyValue('--qh-tint')).toBe('rgb(200, 120, 40)')
    expect(block('a4').style.getPropertyValue('--qh-tint')).toBe('var(--q-ink-3)')

    scrub(1)
    expect(block('a1')).toHaveClass('is-past')
    expect(block('a2')).not.toHaveClass('is-past')
    expect(block('a2').style.getPropertyValue('--qh-tint')).toBe('')
  })

  it('renders Checkpoint markers as buttons with a full label and the name as a tooltip', () => {
    renderPanel()
    const kick = screen.getByRole('button', { name: 'Checkpoint Kick-off · named by Mei Tanaka, 14 Nov, 10:30' })
    expect(kick).toHaveAttribute('title', 'Kick-off')
    expect(kick).toHaveTextContent('Kick-off')
    expect(screen.getByRole('button', { name: /^Checkpoint Start · named by Ana Ruiz/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Checkpoint Reading group · named by Former Member/ })).toBeInTheDocument()
    expect(screen.getAllByTestId(/^checkpoint-/)).toHaveLength(3)
  })

  it('labels the first Activity of each day', () => {
    renderPanel()
    const timeline = screen.getByTestId('history-timeline')
    expect(within(timeline).getByText('14 Nov')).toBeInTheDocument()
    expect(within(timeline).getByText('15 Nov')).toBeInTheDocument()
  })

  it('stays usable with hundreds of Activities', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ...ACTIVITIES[0]!,
      id: `m${i}`,
      author: i % 2 ? 'ana' : 'mei',
      fromSeq: i,
      toSeq: i + 1,
      count: 1,
      startedAt: at(1, 0, 0) + i * 3_600_000,
      endedAt: at(1, 0, 0) + i * 3_600_000,
    }))
    historyStore.setState({ head: 400, activities: many, checkpoints: [] })
    renderPanel()
    expect(screen.getAllByTestId(/^activity-/)).toHaveLength(400)
    expect(range()).toHaveAttribute('max', '400')
    scrub(200)
    expect(history.preview).toHaveBeenLastCalledWith(200)
    expect(block('m199')).toHaveAttribute('aria-current', 'true')
    expect(block('m200')).not.toHaveClass('is-past')
  })
})

describe('scrubber', () => {
  it('is a range with one step per Activity boundary, at "now" to begin with', () => {
    renderPanel()
    expect(range()).toHaveAttribute('type', 'range')
    expect(range()).toHaveAttribute('min', '0')
    expect(range()).toHaveAttribute('max', '5')
    expect(range()).toHaveValue('5')
    expect(range()).toHaveAttribute('aria-valuetext', 'now')
  })

  it('previews seq 0 at the start, an Activity’s toSeq in between, and null at the end', () => {
    renderPanel()
    scrub(0)
    expect(history.preview).toHaveBeenLastCalledWith(0)
    expect(range()).toHaveValue('0')
    expect(range()).toHaveAttribute('aria-valuetext', 'the start')

    scrub(2)
    expect(history.preview).toHaveBeenLastCalledWith(4) // the moment of Kick-off, which ends Mei's first Activity
    expect(range()).toHaveValue('2')
    expect(range()).toHaveAttribute('aria-valuetext', '14 Nov, 10:00')

    scrub(3)
    expect(history.preview).toHaveBeenLastCalledWith(5)

    scrub(4)
    expect(history.preview).toHaveBeenLastCalledWith(6)

    scrub(5)
    expect(history.preview).toHaveBeenLastCalledWith(null)
    expect(range()).toHaveAttribute('aria-valuetext', 'now')
    expect(history.preview).toHaveBeenCalledTimes(5)
  })

  it('follows a preview set elsewhere (e.g. "Back to now" on the Board)', () => {
    renderPanel()
    act(() => history.preview(3))
    expect(range()).toHaveValue('1')
    act(() => history.preview(null))
    expect(range()).toHaveValue('5')
  })
})

describe('selecting', () => {
  it('clicking a block scrubs to the end of that Activity and selects it', () => {
    renderPanel()
    fireEvent.click(block('a3'))
    expect(history.preview).toHaveBeenLastCalledWith(5)
    expect(block('a3')).toHaveAttribute('aria-current', 'true')
    expect(block('a3')).toHaveClass('is-selected')
    expect(block('a1')).not.toHaveAttribute('aria-current')
    expect(range()).toHaveValue('3')
    expect(detail()).toHaveTextContent('Mei Tanaka')
  })

  it('clicking the latest block is "now"', () => {
    renderPanel()
    fireEvent.click(block('a2'))
    fireEvent.click(block('a5'))
    expect(history.preview).toHaveBeenLastCalledWith(null)
    expect(detail()).toHaveTextContent('This is the Board as it is now.')
  })

  it('clicking a Checkpoint scrubs to exactly its moment: the end of the Activity it ends', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('checkpoint-Kick-off'))
    expect(history.preview).toHaveBeenLastCalledWith(4)
    expect(screen.getByTestId('checkpoint-Kick-off')).toHaveAttribute('aria-current', 'true')
    expect(block('a2')).toHaveAttribute('aria-current', 'true')
    expect(block('a3')).not.toHaveAttribute('aria-current')
    expect(range()).toHaveValue('2')
    expect(detail()).toHaveTextContent('Checkpoint Kick-off')
    expect(detail()).toHaveTextContent('1 Change in this Activity')
    expect(detail()).not.toHaveTextContent('partway') // a Checkpoint never falls inside an Activity any more

    fireEvent.click(screen.getByTestId('checkpoint-Start'))
    expect(history.preview).toHaveBeenLastCalledWith(0)
    expect(detail()).toHaveTextContent('The start of main')
    expect(detail()).toHaveTextContent('Checkpoint Start')

    fireEvent.click(screen.getByTestId('checkpoint-Reading group'))
    expect(history.preview).toHaveBeenLastCalledWith(6)
    expect(block('a4')).toHaveAttribute('aria-current', 'true')
    expect(detail()).not.toHaveTextContent('partway')
  })

  it('a moment inside an Activity — not a step of the scrubber, set from elsewhere — reads as partway through it', () => {
    renderPanel()
    act(() => history.preview(8)) // two of the three Changes of Ana's Restore
    expect(block('a5')).toHaveAttribute('aria-current', 'true')
    expect(range()).toHaveValue('5') // the scrubber rounds up to the end of that Activity
    expect(range()).toHaveAttribute('aria-valuetext', '15 Nov, 12:00')
    expect(detail()).toHaveTextContent('Restored to an earlier moment')
    expect(detail()).toHaveTextContent('This moment is partway through the Activity.')
    expect(detail()).not.toHaveTextContent('Checkpoint')

    scrub(4) // any step of the scrubber is the end of an Activity
    expect(detail()).not.toHaveTextContent('partway')
  })
})

describe('detail column', () => {
  it('describes the selected Activity and offers Restore', () => {
    renderPanel()
    scrub(1)
    const d = within(detail())
    expect(d.getByText('Ana Ruiz')).toBeInTheDocument()
    expect(d.getByText('14 Nov, 09:00–09:12')).toBeInTheDocument()
    expect(d.getByText('3 Changes in this Activity')).toBeInTheDocument()
    expect(d.getAllByRole('listitem').map((li) => li.textContent)).toEqual(ACTIVITIES[0]!.lines)
    expect(d.getByRole('button', { name: 'Restore main to here' })).toBeEnabled()
    expect(
      d.getByText(
        'Restoring adds new Changes that bring the Board back to this moment. Nothing is deleted — undo it from History at any time.',
      ),
    ).toBeInTheDocument()
  })

  it('uses the singular for one Change, and shows a Former Member', () => {
    renderPanel()
    scrub(4)
    expect(detail()).toHaveTextContent('Former Member')
    expect(detail()).toHaveTextContent('1 Change in this Activity')
  })

  it('says so at "now", with no Restore', () => {
    renderPanel()
    expect(detail()).toHaveTextContent('This is the Board as it is now.')
    expect(within(detail()).queryByRole('button')).toBeNull()
  })

  it('has an empty state', () => {
    historyStore.setState({ head: 0, activities: [], checkpoints: [] })
    renderPanel()
    expect(detail()).toHaveTextContent('No Changes on this Branch yet.')
    expect(screen.getByTestId('history-counts')).toHaveTextContent('0 Activities · 0 Changes · 0 Checkpoints')
    expect(within(detail()).queryByRole('button')).toBeNull()
  })
})

describe('Restore', () => {
  it('restores to the previewed moment, shows the in-flight state, then returns to now with a toast', async () => {
    let land!: () => void
    history.restore.mockImplementation(() => new Promise<void>((resolve) => (land = resolve)))
    renderPanel()
    scrub(1)
    history.preview.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    expect(history.restore).toHaveBeenCalledTimes(1)
    expect(history.restore).toHaveBeenCalledWith(3)
    const busy = screen.getByRole('button', { name: 'Restoring…' })
    expect(busy).toBeDisabled()
    fireEvent.click(busy)
    expect(history.restore).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('toast')).toBeNull()
    expect(history.preview).not.toHaveBeenCalled()

    await act(async () => land())
    await flush()
    expect(history.preview).toHaveBeenLastCalledWith(null)
    expect(range()).toHaveValue('5')
    expect(range()).toHaveFocus()
    expect(screen.getByTestId('toast')).toHaveTextContent('Restored main to 14 Nov, 09:12.')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('Undo restores to the head from just before', async () => {
    renderPanel()
    scrub(3)
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    expect(history.restore).toHaveBeenLastCalledWith(5)
    // The Restore itself added Changes; Undo still goes back to the head it started from.
    act(() => historyStore.setState({ head: 11 }))

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(history.restore).toHaveBeenCalledTimes(2)
    expect(history.restore).toHaveBeenLastCalledWith(9)
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('restores to the very start', async () => {
    renderPanel()
    scrub(0)
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    expect(history.restore).toHaveBeenCalledWith(0)
    expect(screen.getByTestId('toast')).toHaveTextContent('Restored main to the start.')
  })

  it('keeps the Undo offer for 10 seconds', async () => {
    vi.useFakeTimers()
    renderPanel()
    scrub(1)
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    expect(screen.getByTestId('toast')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(9_999))
    expect(screen.getByTestId('toast')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('raises a plain failure toast and stays where it was', async () => {
    history.restore.mockRejectedValueOnce(new ApiError(409, 'rejected', 'seq 3 is ahead of head', null))
    renderPanel()
    scrub(1)
    history.preview.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    const toast = screen.getByTestId('toast')
    expect(toast).toHaveTextContent(RESTORE_FAILED)
    expect(toast).toHaveAttribute('title', 'seq 3 is ahead of head')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(history.preview).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Restore main to here' })).toBeEnabled()
  })

  it('says when the server could not be reached', async () => {
    history.restore.mockRejectedValueOnce(new ApiError(0, 'network', 'Failed to fetch', null))
    renderPanel()
    scrub(1)
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    expect(screen.getByTestId('toast')).toHaveTextContent(RESTORE_OFFLINE)
  })

  it('withdraws the Undo offer when History closes', async () => {
    const view = renderPanel()
    scrub(1)
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    view.rerender(<Toast />)
    expect(screen.queryByTestId('toast')).toBeNull()
  })
})

describe('opening and closing History', () => {
  it('opens History on mount and closes it on unmount', () => {
    const view = renderPanel()
    expect(history.open).toHaveBeenCalledTimes(1)
    expect(history.close).not.toHaveBeenCalled()
    view.unmount()
    expect(history.open).toHaveBeenCalledTimes(1)
    expect(history.close).toHaveBeenCalledTimes(1)
  })

  it('ends up open under StrictMode, where effects run twice', () => {
    const view = render(
      <StrictMode>
        <HistoryPanel />
      </StrictMode>,
    )
    // open → close → open: every close is followed by an open while the panel is shown.
    expect(history.open).toHaveBeenCalledTimes(2)
    expect(history.close).toHaveBeenCalledTimes(1)
    const lastOpen = Math.max(...history.open.mock.invocationCallOrder)
    const lastClose = Math.max(...history.close.mock.invocationCallOrder)
    expect(lastOpen).toBeGreaterThan(lastClose)

    view.unmount()
    expect(history.close).toHaveBeenCalledTimes(2)
    expect(Math.max(...history.close.mock.invocationCallOrder)).toBeGreaterThan(lastOpen)
  })

  it('reopens History when the Board switches Branch', () => {
    renderPanel()
    act(() => boardStore.setState({ branch: { id: 'b2', name: 'try-QEC', seq: 0, checkpoints: 0 } }))
    expect(history.close).toHaveBeenCalledTimes(1)
    expect(history.open).toHaveBeenCalledTimes(2)
    expect(history.open.mock.invocationCallOrder[1]).toBeGreaterThan(history.close.mock.invocationCallOrder[0]!)
  })

  it('waits for the Board to have a Branch', () => {
    boardStore.setState({ branch: undefined, status: 'loading' })
    historyStore.setState(IDLE, true)
    renderPanel()
    expect(history.open).not.toHaveBeenCalled()
    act(() => boardStore.setState({ branch: MAIN, status: 'live' }))
    expect(history.open).toHaveBeenCalledTimes(1)
  })

  it('does not fail when history.open rejects', async () => {
    history.open.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'no', null))
    renderPanel()
    await flush()
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
  })

  it('Esc inside the panel closes it', () => {
    const onClose = vi.fn()
    renderPanel(onClose)
    fireEvent.keyDown(block('a1'), { key: 'Escape' })
    expect(useHistoryPanel.getState().open).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('other keys do not close it, and the close button does', () => {
    renderPanel()
    fireEvent.keyDown(range(), { key: 'ArrowLeft' })
    expect(useHistoryPanel.getState().open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close History' }))
    expect(useHistoryPanel.getState().open).toBe(false)
    act(() => historyPanel.close())
  })
})

describe('a preview asked for by the Branch Graph', () => {
  const ask = (seq: number, hadPanel = false, branchId = MAIN.id) =>
    useGraphPreview.setState({ current: { branch: 'main', branchId, seq, back: '/branches', hadPanel, phase: 'opening' } })
  beforeEach(() => window.history.replaceState(null, '', '/'))
  afterEach(() => useGraphPreview.setState({ current: null }))

  it('shows that moment once History of that Branch is loaded, and "Back to now" returns to the graph', () => {
    ask(4)
    renderPanel()
    expect(history.preview).toHaveBeenLastCalledWith(4)
    expect(useGraphPreview.getState().current?.phase).toBe('shown')
    expect(block('a2')).toHaveAttribute('aria-current', 'true')
    expect(window.location.pathname).toBe('/')

    act(() => history.preview(null)) // the Board's "Back to now"
    expect(window.location.pathname).toBe('/branches')
    expect(useGraphPreview.getState().current).toBeNull()
    expect(useHistoryPanel.getState().open).toBe(false) // it was opened for the preview
  })

  it('waits for History of the Branch it is about', () => {
    ask(2, false, 'other-id')
    renderPanel()
    expect(history.preview).not.toHaveBeenCalled()
    act(() => historyStore.setState({ branch: { id: 'other-id', name: 'exp-A', seq: 9, checkpoints: 0 } }))
    expect(history.preview).toHaveBeenLastCalledWith(2)
  })

  it('scrubbing to another moment stays; scrubbing to now goes back, leaving a History panel that was open before', () => {
    ask(4, true)
    renderPanel()
    scrub(1)
    expect(window.location.pathname).toBe('/')
    scrub(5)
    expect(window.location.pathname).toBe('/branches')
    expect(useHistoryPanel.getState().open).toBe(true)
  })

  it('"Back to Branches" and closing History both go back to the graph', () => {
    ask(4)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Branches' }))
    expect(window.location.pathname).toBe('/branches')
    cleanup()

    window.history.replaceState(null, '', '/')
    useHistoryPanel.setState({ open: true })
    ask(4)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close History' }))
    expect(window.location.pathname).toBe('/branches')
  })

  it('a Restore from it stays on the Board with its Undo offer', async () => {
    ask(4)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Restore main to here' }))
    await flush()
    expect(history.restore).toHaveBeenCalledWith(4)
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(useGraphPreview.getState().current).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to Branches' })).toBeNull()
  })

  it('is forgotten when History closes another way (the Member went elsewhere)', () => {
    ask(4)
    const view = renderPanel()
    view.unmount()
    expect(useGraphPreview.getState().current).toBeNull()
    expect(window.location.pathname).toBe('/')
  })
})

describe('loading and errors', () => {
  it('shows nothing for 150 ms, then "Loading History…"', () => {
    vi.useFakeTimers()
    historyStore.setState({ ...IDLE, status: 'loading' }, true)
    renderPanel()
    expect(screen.queryByText('Loading History…')).toBeNull()
    expect(screen.queryByTestId('history-counts')).toBeNull()
    act(() => vi.advanceTimersByTime(149))
    expect(screen.queryByText('Loading History…')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Loading History…')).toBeInTheDocument()

    act(() => historyStore.setState(READY, true))
    expect(screen.queryByText('Loading History…')).toBeNull()
    expect(screen.getByTestId('history-timeline')).toBeInTheDocument()
  })

  it('shows a plain sentence with "Try again" on error', () => {
    historyStore.setState({ ...IDLE, status: 'error', error: 'HTTP 500' }, true)
    renderPanel()
    expect(screen.getByRole('alert')).toHaveTextContent('History could not be loaded.')
    expect(screen.getByText('History could not be loaded.')).toHaveAttribute('title', 'HTTP 500')
    expect(history.open).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(history.open).toHaveBeenCalledTimes(2)
  })

  it('uses Member names as they load', () => {
    membersStore.setState({ list: [] })
    renderPanel()
    expect(screen.getAllByRole('group', { name: 'Activities by Former Member' })).toHaveLength(3)
    act(() => membersStore.setState({ list: [{ id: 'gone', name: 'Kofi Boateng', role: 'member', color: 'rgb(1, 2, 3)' }] }))
    expect(screen.getByRole('group', { name: 'Activities by Kofi Boateng' })).toBeInTheDocument()
  })
})
