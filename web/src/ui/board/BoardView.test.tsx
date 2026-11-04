import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('../history/testkit')).createFakeLib())
const submit = vi.fn<(ops: unknown[]) => Promise<void>>()
vi.mock('../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib')>()),
  ...fake.lib,
  board: { open: vi.fn(), close: vi.fn(), submit: (ops: unknown[]) => submit(ops) },
}))

const { BoardView } = await import('./index')
const { toasts } = await import('./toastStore')
const { ui, useBoardUi } = await import('./uiStore')
const { historyPanel, useHistoryPanel } = await import('../bridge')
const { card } = await import('../history/testkit')

const { history, boardStore } = fake

const LIVE = [card('live1', 'Surface code basics'), card('live2', 'MWPM decoder', { x: 300 })]
const EARLIER = {
  cards: [card('old1', 'Toric code', { x: 40, y: 40 })],
  frames: [{ id: 'oldf', title: 'Reading', x: 0, y: 0, w: 520, h: 360 }],
  connections: [],
}

beforeAll(() => {
  // React Flow measures its container; jsdom has no layout.
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
})

beforeEach(() => {
  fake.reset()
  submit.mockReset()
  submit.mockResolvedValue(undefined)
  boardStore.setState({ cards: LIVE })
  fake.boardAt.fn = () => EARLIER
  useHistoryPanel.setState({ open: false })
})
afterEach(() => {
  cleanup()
  act(() => {
    toasts.clear()
    ui.reset()
    historyPanel.close()
  })
})

const viewport = () => document.querySelector<HTMLElement>('.react-flow__viewport')!

describe('BoardView', () => {
  it('shows the live Board with its creation affordances and no banner', () => {
    render(<BoardView />)
    expect(screen.getByTestId('card-live1')).toBeInTheDocument()
    expect(screen.getByTestId('card-live2')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-add-card')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-banner')).toBeNull()
    expect(screen.queryByTestId('history-panel')).toBeNull()
    expect(screen.getByTestId('board')).not.toHaveClass('is-preview')
  })

  it('puts the History panel under the Board while it is open', () => {
    render(<BoardView />)
    act(() => historyPanel.toggle())
    const panel = screen.getByTestId('history-panel')
    const board = screen.getByTestId('board')
    expect(board.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(history.open).toHaveBeenCalledTimes(1)

    act(() => historyPanel.toggle())
    expect(screen.queryByTestId('history-panel')).toBeNull()
    expect(history.close).toHaveBeenCalledTimes(1)
  })

  it('closes History when the Board unmounts', () => {
    useHistoryPanel.setState({ open: true })
    const view = render(<BoardView />)
    expect(history.open).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(history.close).toHaveBeenCalledTimes(1)
  })

  it('never shows History to a Guest', () => {
    boardStore.setState({ readOnly: true })
    useHistoryPanel.setState({ open: true })
    render(<BoardView />)
    expect(screen.queryByTestId('history-panel')).toBeNull()
    expect(history.open).not.toHaveBeenCalled()
  })

  it('Esc in the panel closes it and returns focus to the Board', () => {
    useHistoryPanel.setState({ open: true })
    render(<BoardView />)
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'Escape' })
    expect(screen.queryByTestId('history-panel')).toBeNull()
    expect(screen.getByTestId('board')).toHaveFocus()
  })

  it('“+ Card” and “+ Frame” put the new thing beside what is in the middle of the view, never on it', () => {
    type Created = { Create: { kind: string; fields: Record<string, unknown> } }
    const made = (kind: string) => {
      const op = submit.mock.calls.flatMap((c) => c[0] as Created[]).find((o) => o.Create?.kind === kind)!
      const num = (k: string) => (op.Create.fields[k] as { Float: number }).Float
      const at = { x: num('x'), y: num('y') }
      expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true)
      return at
    }
    const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    // A Card right on the middle (jsdom's view is a point at 0, 0) and a Frame around it.
    const middle = card('mid', 'In the middle', { x: -112, y: -66 })
    const frame = { id: 'f1', title: 'Reading', x: -400, y: -300, w: 800, h: 600 }
    boardStore.setState({ cards: [...LIVE, middle], frames: [frame], connections: [] })
    render(<BoardView />)

    fireEvent.click(screen.getByTestId('toolbar-add-card'))
    const c = made('Card')
    for (const other of [...LIVE, middle]) expect(overlaps({ ...c, w: 224, h: 132 }, other)).toBe(false)
    expect(overlaps({ ...c, w: 224, h: 132 }, { ...frame, y: frame.y - 40, h: frame.h + 40 })).toBe(false)

    act(() => ui.reset())
    fireEvent.click(screen.getByTestId('toolbar-add-frame'))
    const f = made('Frame')
    const box = { x: f.x, y: f.y - 40, w: 520, h: 360 + 40 } // with its title
    for (const other of [...LIVE, middle]) expect(overlaps(box, other)).toBe(false)
    expect(overlaps(box, { ...frame, y: frame.y - 40, h: frame.h + 40 })).toBe(false)
  })
})

describe('BoardView in preview', () => {
  it('renders the previewed Cards and Frames instead of the live Board', () => {
    render(<BoardView />)
    act(() => history.preview(3))
    expect(screen.getByTestId('card-old1')).toHaveTextContent('Toric code')
    expect(screen.getByTestId('frame-oldf')).toHaveTextContent('Reading')
    expect(screen.queryByTestId('card-live1')).toBeNull()
    expect(screen.queryByTestId('card-live2')).toBeNull()
    expect(screen.getByTestId('board')).toHaveClass('is-preview', 'is-readonly')
  })

  it('shows the banner with the Branch, the moment and "read-only"', () => {
    render(<BoardView />)
    act(() => history.preview(3))
    const banner = screen.getByTestId('preview-banner')
    expect(banner).toHaveTextContent('Previewing main at 14 Nov, 09:12')
    expect(banner).toHaveTextContent('read-only')

    act(() => history.preview(0))
    expect(screen.getByTestId('preview-banner')).toHaveTextContent('Previewing main at the start')
  })

  it('hides creation and edit affordances', () => {
    render(<BoardView />)
    act(() => history.preview(3))
    expect(screen.queryByTestId('toolbar-add-card')).toBeNull()
    expect(screen.queryByTestId('toolbar-add-frame')).toBeNull()
    expect(useBoardUi.getState().readOnly).toBe(true)

    // Double-click on empty space adds nothing; Delete removes nothing; no title editor opens.
    const pane = document.querySelector('.react-flow__pane')!
    fireEvent.doubleClick(pane)
    fireEvent.doubleClick(screen.getByText('Toric code'))
    act(() => ui.select(['old1']))
    fireEvent.keyDown(screen.getByTestId('board'), { key: 'Delete' })
    fireEvent.keyDown(screen.getByTestId('board'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByTestId('board'), { key: 'ArrowRight' })
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(useBoardUi.getState().editing).toBeNull()
    // No inspector, even with a Card selected; no status button on the Card.
    expect(screen.queryByTestId('inspector')).toBeNull()
    expect(screen.queryByRole('button', { name: /Change status/ })).toBeNull()
    expect(document.querySelector('.react-flow__node.draggable')).toBeNull()
  })

  it('shows a quiet empty Board when the moment had nothing on it', () => {
    fake.boardAt.fn = () => ({ cards: [], frames: [], connections: [] })
    render(<BoardView />)
    act(() => history.preview(0))
    expect(screen.getByText('Nothing on this Board yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Card' })).toBeNull()
  })

  it('clears the selection (and the inspector) on entering the preview', () => {
    render(<BoardView />)
    act(() => ui.select(['live1']))
    expect(screen.getByTestId('inspector')).toBeInTheDocument()
    act(() => history.preview(3))
    expect(useBoardUi.getState().selected.size).toBe(0)
    expect(screen.queryByTestId('inspector')).toBeNull()
  })

  it('"Back to now" calls history.preview(null) and the live Board returns', () => {
    render(<BoardView />)
    act(() => history.preview(3))
    history.preview.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }))
    expect(history.preview).toHaveBeenCalledTimes(1)
    expect(history.preview).toHaveBeenCalledWith(null)
    expect(screen.queryByTestId('preview-banner')).toBeNull()
    expect(screen.getByTestId('card-live1')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-add-card')).toBeInTheDocument()
    expect(useBoardUi.getState().readOnly).toBe(false)
  })

  it('does not move the viewport while scrubbing', () => {
    useHistoryPanel.setState({ open: true })
    render(<BoardView />)
    const before = viewport().style.transform
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } })
    expect(screen.getByTestId('card-old1')).toBeInTheDocument()
    expect(viewport().style.transform).toBe(before)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } })
    fireEvent.change(screen.getByRole('slider'), { target: { value: screen.getByRole('slider').getAttribute('max') } }) // now
    expect(screen.getByTestId('card-live1')).toBeInTheDocument()
    expect(viewport().style.transform).toBe(before)
  })
})
