// M5: the Suggestions panel in the Board area, and the Connection it previews on the Board.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('../suggestions/testkit')).createFakeSuggestionsLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

// jsdom has no layout, so the Board would fit itself down to the smallest zoom; pin the level instead.
const zoom = vi.hoisted(() => ({ level: 'full' as 'full' | 'compact' | 'tile' }))
vi.mock('./useZoomLevel', () => ({ useZoomLevel: () => zoom.level }))

const { BoardView } = await import('./index')
const { toasts } = await import('./toastStore')
const { ui } = await import('./uiStore')
const { historyPanel, pagePanel, suggestionsPanel, usePagePanel, useSuggestionsPanel } = await import('../bridge')
const { editLock } = await import('../page/lock')
const { card, connectionSuggestion, sourceSuggestion } = await import('../suggestions/testkit')

const { history, boardStore, suggestions } = fake

const A = card('c1', 'Noise-induced plateaus')
const B = card('c2', 'Reward plateaus', { x: 400 })
const C = card('c3', 'Barren plateaus', { x: 800 })
const REAL = { id: 'real', from: 'c2', to: 'c3', kind: 'related' as const, label: 'see also' }
const K1 = { id: 'k1', from: 'c1', to: 'c2', kind: 'directed' as const, label: 'may explain' }

const node = (id: string) => screen.getByTestId(`card-${id}`).closest('.react-flow__node')
const settle = () => act(async () => {})
/** The Board area as wide as it would be laid out; jsdom itself reports 0. */
const areaWidth = (px: number) => vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(px)

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
})

beforeEach(() => {
  fake.reset()
  zoom.level = 'full'
  boardStore.setState({ cards: [A, B, C], connections: [REAL] })
  fake.show(connectionSuggestion('k1'), sourceSuggestion('s1'))
  fake.boardAt.fn = () => ({ cards: [card('old', 'Earlier Card')], frames: [], connections: [] })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
    ui.reset()
    historyPanel.close()
    pagePanel.close()
    suggestionsPanel.close()
  })
})

describe('the Suggestions panel in the Board area', () => {
  it('shows when the bridge says open, left of the Board, and goes when it says closed', async () => {
    render(<BoardView />)
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
    act(() => suggestionsPanel.open())
    await settle()
    const panel = screen.getByTestId('suggestions-panel')
    expect(panel).toHaveTextContent('2 pending')
    // Before the Board in the row, so the Board and its overlays sit beside it.
    const board = screen.getByTestId('board').closest('.qb-area__board')
    expect(panel.nextElementSibling).toBe(board)
    expect(panel.contains(screen.getByTestId('board'))).toBe(false)
    act(() => suggestionsPanel.toggle())
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
  })

  it('is not there for a Guest, and closes itself', async () => {
    boardStore.setState({ readOnly: true })
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
    expect(useSuggestionsPanel.getState().open).toBe(false)
    expect(suggestions.reload).not.toHaveBeenCalled()
  })

  it('closes itself when History starts previewing an earlier moment, and stays closed afterwards', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    expect(screen.getByTestId('suggestions-panel')).toBeInTheDocument()
    act(() => history.preview(3))
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
    expect(useSuggestionsPanel.getState().open).toBe(false)
    act(() => history.preview(null))
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
  })

  it('cannot be opened while History is previewing', async () => {
    render(<BoardView />)
    act(() => history.preview(3))
    act(() => suggestionsPanel.open())
    await settle()
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
    expect(useSuggestionsPanel.getState().open).toBe(false)
  })

  it('sits above the History panel, not over it', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    act(() => historyPanel.toggle())
    await settle()
    const row = screen.getByTestId('suggestions-panel').parentElement
    expect(row).toHaveClass('qb-area__canvas')
    expect(screen.getByTestId('history-panel').parentElement).toHaveClass('qb-area')
    expect(row?.contains(screen.getByTestId('history-panel'))).toBe(false)
  })

  it('Esc in the panel closes it and returns focus to the Board', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    fireEvent.keyDown(within(screen.getByTestId('suggestion-k1')).getByRole('button', { name: 'Reject' }), { key: 'Escape' })
    expect(screen.queryByTestId('suggestions-panel')).toBeNull()
    expect(screen.getByTestId('board')).toHaveFocus()
  })

  it('a Card name in the panel selects that Card on the Board', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    fireEvent.click(within(screen.getByTestId('suggestion-s1')).getByRole('button', { name: 'Noise-induced plateaus' }))
    expect(node('c1')).toHaveClass('selected')
  })
})

describe('room for the Board between the side panels', () => {
  it('opening Suggestions closes the Page panel when the Board would be left narrower than 320px', async () => {
    areaWidth(1056) // a 1280px window
    render(<BoardView />)
    act(() => pagePanel.open('c1'))
    await settle()
    expect(screen.getByTestId('page-panel')).toBeInTheDocument()
    act(() => suggestionsPanel.open())
    await settle()
    expect(usePagePanel.getState().cardId).toBeNull()
    expect(screen.queryByTestId('page-panel')).toBeNull()
    expect(screen.getByTestId('suggestions-panel')).toBeInTheDocument()
  })

  it('opening a Page then closes Suggestions: the one opened last stays', async () => {
    areaWidth(1056)
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    act(() => pagePanel.open('c1'))
    await settle()
    expect(useSuggestionsPanel.getState().open).toBe(false)
    expect(screen.getByTestId('page-panel')).toBeInTheDocument()
  })

  it('keeps both where there is room', async () => {
    areaWidth(1220)
    render(<BoardView />)
    act(() => pagePanel.open('c1'))
    act(() => suggestionsPanel.open())
    await settle()
    expect(screen.getByTestId('page-panel')).toBeInTheDocument()
    expect(screen.getByTestId('suggestions-panel')).toBeInTheDocument()
  })

  it('both asked for before the Board shows, without room: Suggestions stays', async () => {
    areaWidth(1056)
    usePagePanel.setState({ cardId: 'c1' })
    useSuggestionsPanel.setState({ open: true })
    render(
      <StrictMode>
        <BoardView />
      </StrictMode>,
    )
    await settle()
    expect(usePagePanel.getState().cardId).toBeNull()
    expect(useSuggestionsPanel.getState().open).toBe(true)
  })
})

describe('the previewed Connection on the Board', () => {
  it('draws it dashed with the label "Suggested · …" and rings its two Cards', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
    act(() => suggestionsPanel.preview(K1))
    const line = screen.getByTestId('suggested-connection')
    expect(line).toHaveAttribute('data-kind', 'directed')
    expect(line.querySelector('.qb-sug__dash')).toHaveAttribute('d', expect.stringMatching(/^M224,66 C/))
    expect(line.querySelectorAll('path')).toHaveLength(2) // the curve and the chevron
    expect(screen.getByTestId('suggested-connection-label')).toHaveTextContent('Suggested · may explain')
    expect(node('c1')).toHaveClass('is-suggested')
    expect(node('c2')).toHaveClass('is-suggested')
    expect(node('c3')).not.toHaveClass('is-suggested')

    act(() => suggestionsPanel.preview(null))
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
    expect(screen.queryByTestId('suggested-connection-label')).toBeNull()
    expect(node('c1')).not.toHaveClass('is-suggested')
  })

  it('is not one of the Board’s Connections: no edge, nothing to select, nothing submitted', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    act(() => suggestionsPanel.preview(K1))
    // (jsdom has no layout, so React Flow draws no edges at all here; what can be said is where the preview is not.)
    expect(screen.queryByTestId('connection-k1')).toBeNull()
    const line = screen.getByTestId('suggested-connection')
    expect(line.closest('.react-flow__edge, .react-flow__edges')).toBeNull()
    expect(line.closest('.react-flow__viewport-portal')).not.toBeNull()
    expect(line.querySelector('.qb-conn__hit')).toBeNull()
    expect(line).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByTestId('suggested-connection-label'))
    expect(document.querySelector('.qb-popover')).toBeNull()
    expect(boardStore.getState().connections).toEqual([REAL])
    expect(fake.submit).not.toHaveBeenCalled()
  })

  it('falls back to the kind for the label, and draws the caps of the kind', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    act(() => suggestionsPanel.preview({ ...K1, kind: 'contradicts', label: '' }))
    expect(screen.getByTestId('suggested-connection-label')).toHaveTextContent('Suggested · contradicts')
    expect(screen.getByTestId('suggested-connection').querySelectorAll('path')).toHaveLength(3)
    act(() => suggestionsPanel.preview({ ...K1, kind: 'related', label: '' }))
    expect(screen.getByTestId('suggested-connection-label')).toHaveTextContent('Suggested · related')
    expect(screen.getByTestId('suggested-connection').querySelectorAll('path')).toHaveLength(1)
  })

  it('hides the label when zoomed out to tiles, like every Connection label', async () => {
    zoom.level = 'tile'
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    act(() => suggestionsPanel.preview(K1))
    expect(screen.getByTestId('suggested-connection')).toBeInTheDocument()
    expect(screen.queryByTestId('suggested-connection-label')).toBeNull()
  })

  it('draws nothing when one of the two Cards is not on the Board', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    act(() => suggestionsPanel.preview({ ...K1, to: 'nope' }))
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
    expect(node('c1')).not.toHaveClass('is-suggested')
  })

  it('appears on hover and on keyboard focus in the panel, and goes on leave and blur', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    const block = screen.getByTestId('suggestion-k1')
    fireEvent.mouseEnter(block)
    expect(screen.getByTestId('suggested-connection-label')).toHaveTextContent('Suggested · may explain')
    fireEvent.mouseLeave(block)
    expect(screen.queryByTestId('suggested-connection')).toBeNull()

    const accept = within(block).getByRole('button', { name: 'Accept' })
    act(() => accept.focus())
    expect(screen.getByTestId('suggested-connection')).toBeInTheDocument()
    act(() => accept.blur())
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
  })

  it('disappears with the panel', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    fireEvent.mouseEnter(screen.getByTestId('suggestion-k1'))
    expect(screen.getByTestId('suggested-connection')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close Suggestions' }))
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
    expect(useSuggestionsPanel.getState().preview).toBeNull()
  })

  it('is gone once the Suggestion is accepted — the real Connection arrives through the Board', async () => {
    useSuggestionsPanel.setState({ open: true })
    render(<BoardView />)
    await settle()
    const block = screen.getByTestId('suggestion-k1')
    fireEvent.mouseEnter(block)
    fireEvent.click(within(block).getByRole('button', { name: 'Accept' }))
    await settle()
    expect(suggestions.accept).toHaveBeenCalledExactlyOnceWith('k1')
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
  })

  it('leaving the Board clears the preview, also under StrictMode', async () => {
    useSuggestionsPanel.setState({ open: true })
    const view = render(
      <StrictMode>
        <BoardView />
      </StrictMode>,
    )
    await settle()
    fireEvent.mouseEnter(screen.getByTestId('suggestion-k1'))
    expect(screen.getByTestId('suggested-connection')).toBeInTheDocument() // the simulated unmount left nothing finished
    view.unmount()
    expect(useSuggestionsPanel.getState().preview).toBeNull()
  })

  it('is not drawn while the panel is closed', async () => {
    render(<BoardView />)
    act(() => useSuggestionsPanel.setState({ open: false, preview: K1 }))
    expect(screen.queryByTestId('suggested-connection')).toBeNull()
    expect(node('c1')).not.toHaveClass('is-suggested')
  })
})
