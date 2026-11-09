// M4: opening a Card's Page from the Board, and what the Board does while the panel is open.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('../page/testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

// jsdom has no layout, so the Board would fit itself down to the smallest zoom; pin the level instead.
const zoom = vi.hoisted(() => ({ level: 'full' as 'full' | 'compact' | 'tile' }))
vi.mock('./useZoomLevel', () => ({ useZoomLevel: () => zoom.level }))

const { BoardView } = await import('./index')
const { toasts } = await import('./toastStore')
const { ui, useBoardUi } = await import('./uiStore')
const { historyPanel, pagePanel, usePagePanel } = await import('../bridge')
const { editLock } = await import('../page/lock')
const { GUEST, block, card } = await import('../page/testkit')

const { history, boardStore, pageStore, sessionStore, submit } = fake

const A = card('a', 'Surface code basics', { summary: 'Stabilizers on a lattice.', blocks: 4, sources: 3 })
const B = card('b', 'MWPM decoder', { x: 300, blocks: 1, sources: 1 })
const C = card('c', 'Toric code', { x: 600 })

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
  boardStore.setState({ cards: [A, B, C], connections: [{ id: 'k1', from: 'a', to: 'b', kind: 'directed', label: 'decoded by' }] })
  pageStore.setState({ blocks: [block('b1', 'a', '1', 'A first paragraph'), block('b2', 'b', '1', 'About decoders')] })
  fake.boardAt.fn = () => ({ cards: [card('old', 'Earlier Card')], frames: [], connections: [] })
})
afterEach(() => {
  cleanup()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
    ui.reset()
    historyPanel.close()
    pagePanel.close()
  })
})

const board = () => screen.getByTestId('board')
const panel = () => screen.queryByTestId('page-panel')
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node-card[data-id="${id}"]`)!

describe('opening a Page from the Board', () => {
  it('the inspector’s "Open Page" button opens the Page of the selected Card', () => {
    render(<BoardView />)
    expect(panel()).toBeNull()
    act(() => ui.select(['a']))
    const button = within(screen.getByTestId('inspector')).getByRole('button', { name: 'Open Page' })
    expect(button).toHaveClass('q-btn--primary')
    fireEvent.click(button)
    expect(usePagePanel.getState().cardId).toBe('a')
    expect(screen.getByRole('region', { name: 'Page of Surface code basics' })).toBeInTheDocument()
    expect(within(panel()!).getByText('A first paragraph')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Surface code basics' })).toHaveFocus()
  })

  it('hides the inspector while the panel shows that Card, and shows it again for another Card', () => {
    render(<BoardView />)
    act(() => ui.select(['a']))
    fireEvent.click(screen.getByRole('button', { name: 'Open Page' }))
    expect(screen.queryByTestId('inspector')).toBeNull()
    expect(board()).toHaveClass('has-page')
    expect(board()).not.toHaveClass('has-inspector')

    act(() => ui.select(['b']))
    expect(within(screen.getByTestId('inspector')).getByDisplayValue('MWPM decoder')).toBeInTheDocument()
    expect(board()).toHaveClass('has-page', 'has-inspector')
    expect(panel()).toHaveAccessibleName('Page of Surface code basics') // the Page stays on its Card

    act(() => ui.select(['a']))
    expect(screen.queryByTestId('inspector')).toBeNull()

    act(() => pagePanel.close())
    expect(screen.getByTestId('inspector')).toBeInTheDocument()
    expect(board()).not.toHaveClass('has-page')
  })

  it('a double-click on a Card outside its title and summary opens the Page', () => {
    render(<BoardView />)
    fireEvent.doubleClick(screen.getByTestId('card-b'))
    expect(usePagePanel.getState().cardId).toBe('b')
    expect(panel()).toHaveAccessibleName('Page of MWPM decoder')
    expect(submit).not.toHaveBeenCalled() // and it did not add a Card
    expect(useBoardUi.getState().editing).toBeNull()

    act(() => pagePanel.close())
    fireEvent.doubleClick(within(screen.getByTestId('card-a')).getByText('Idea')) // the status word
    expect(usePagePanel.getState().cardId).toBe('a')
  })

  it('a double-click on the title or the summary edits in place instead', () => {
    render(<BoardView />)
    fireEvent.doubleClick(within(screen.getByTestId('card-a')).getByText('Surface code basics'))
    expect(useBoardUi.getState().editing).toEqual({ id: 'a', field: 'title' })
    expect(panel()).toBeNull()
    act(() => ui.stopEditing('a'))

    fireEvent.doubleClick(within(screen.getByTestId('card-a')).getByText('Stabilizers on a lattice.'))
    expect(useBoardUi.getState().editing).toEqual({ id: 'a', field: 'summary' })
    expect(usePagePanel.getState().cardId).toBeNull()
  })

  it('a double-click on empty Board space still adds a Card and opens nothing', () => {
    render(<BoardView />)
    fireEvent.doubleClick(document.querySelector('.react-flow__pane')!)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(usePagePanel.getState().cardId).toBeNull()
  })

  it('O opens the Page when exactly one Card is selected', () => {
    render(<BoardView />)
    fireEvent.keyDown(board(), { key: 'o' })
    expect(usePagePanel.getState().cardId).toBeNull()

    act(() => ui.select(['a', 'b']))
    fireEvent.keyDown(board(), { key: 'o' })
    expect(usePagePanel.getState().cardId).toBeNull()

    act(() => ui.select(['b']))
    fireEvent.keyDown(board(), { key: 'o', metaKey: true }) // ⌘O is the browser’s
    fireEvent.keyDown(board(), { key: 'o', ctrlKey: true })
    expect(usePagePanel.getState().cardId).toBeNull()

    fireEvent.keyDown(board(), { key: 'O', shiftKey: true })
    expect(usePagePanel.getState().cardId).toBe('b')
    expect(panel()).toHaveAccessibleName('Page of MWPM decoder')
  })

  it('an "o" typed into a title, or into the inspector, is just a letter', () => {
    render(<BoardView />)
    act(() => {
      ui.select(['a'])
      ui.edit('a', 'title')
    })
    fireEvent.keyDown(within(screen.getByTestId('card-a')).getByRole('textbox', { name: 'Title' }), { key: 'o' })
    fireEvent.keyDown(within(screen.getByTestId('inspector')).getByLabelText('Summary'), { key: 'o' })
    expect(usePagePanel.getState().cardId).toBeNull()
  })

  it('a Guest can open and read a Page, by button, key and double-click', () => {
    boardStore.setState({ readOnly: true })
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    render(<BoardView />)
    act(() => ui.select(['a']))
    fireEvent.click(within(screen.getByTestId('inspector')).getByRole('button', { name: 'Open Page' }))
    expect(within(panel()!).getByText('A first paragraph')).toBeInTheDocument()
    expect(within(panel()!).getByText('Read-only')).toBeInTheDocument()
    expect(within(panel()!).queryByRole('button', { name: /Add block/ })).toBeNull()

    act(() => pagePanel.close())
    act(() => ui.select(['b']))
    fireEvent.keyDown(board(), { key: 'o' })
    expect(usePagePanel.getState().cardId).toBe('b')

    act(() => pagePanel.close())
    fireEvent.doubleClick(within(screen.getByTestId('card-a')).getByText('Surface code basics')) // nothing to edit for a Guest
    expect(usePagePanel.getState().cardId).toBe('a')
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('the Page panel beside the Board', () => {
  const openA = () => {
    render(<BoardView />)
    act(() => ui.select(['a']))
    act(() => pagePanel.open('a'))
  }

  it('is mounted in the Board area, after the Board, and the Board stays usable', () => {
    openA()
    const area = document.querySelector('.qb-area__canvas')!
    expect(area).toContainElement(panel())
    expect(board()).not.toContainElement(panel())
    expect(board().compareDocumentPosition(panel()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The Board still answers: select another Card, nudge it.
    act(() => ui.select(['c']))
    fireEvent.keyDown(board(), { key: 'ArrowRight' })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(panel()).toBeInTheDocument()
  })

  it('✕ closes the panel and returns focus to the Card', () => {
    openA()
    fireEvent.click(screen.getByRole('button', { name: 'Close Page' }))
    expect(panel()).toBeNull()
    expect(usePagePanel.getState()).toEqual({ cardId: null, full: false, comment: null })
    expect(node('a')).toHaveFocus()
    expect(screen.getByTestId('inspector')).toBeInTheDocument()
  })

  it('Esc inside the panel closes it; Esc on the Board does not', () => {
    openA()
    fireEvent.keyDown(board(), { key: 'Escape' })
    expect(panel()).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('heading', { level: 1, name: 'Surface code basics' }), { key: 'Escape' })
    expect(panel()).toBeNull()
    expect(node('a')).toHaveFocus()
  })

  it('keys typed in the panel never reach the Board (Delete does not remove the selected Card)', () => {
    openA()
    fireEvent.click(within(panel()!).getByRole('group', { name: 'Block 1. Press Enter to edit.' }))
    const field = within(panel()!).getByRole('textbox', { name: 'Block 1, Markdown' })
    for (const key of ['Delete', 'Backspace', 'o', 'ArrowLeft', 'a']) fireEvent.keyDown(field, { key })
    fireEvent.keyDown(within(panel()!).getByRole('heading', { level: 1 }), { key: 'Delete' })
    expect(submit).not.toHaveBeenCalled()
    expect(boardStore.getState().cards).toHaveLength(3)
  })

  it('⤢ fills the Board area; the Board’s overlays stop moving aside', () => {
    openA()
    fireEvent.click(screen.getByRole('button', { name: 'Open full width' }))
    expect(panel()).toHaveClass('is-full')
    expect(board()).not.toHaveClass('has-page')
    fireEvent.click(screen.getByRole('button', { name: 'Open full width' }))
    expect(panel()).not.toHaveClass('is-full')
    expect(board()).toHaveClass('has-page')
  })

  it('shows toasts in one place only — inside the panel while it is open', async () => {
    openA()
    expect(document.querySelectorAll('.qb-toasts')).toHaveLength(1)
    expect(panel()).toContainElement(document.querySelector<HTMLElement>('.qb-toasts'))
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Delete block' }))
    expect(screen.getAllByTestId('toast')).toHaveLength(1)
    expect(within(panel()!).getByTestId('toast')).toHaveTextContent('Deleted 1 block.')

    act(() => pagePanel.close())
    expect(document.querySelectorAll('.qb-toasts')).toHaveLength(1)
    expect(board()).toContainElement(screen.getByTestId('toast')) // the Undo offer is still there
    await act(async () => {})
  })

  it('a Connection in the Page selects the other Card on the Board and keeps the Page open', () => {
    openA()
    fireEvent.click(within(panel()!).getByRole('button', { name: 'decoded by → MWPM decoder' }))
    expect([...useBoardUi.getState().selected]).toEqual(['b'])
    expect(panel()).toHaveAccessibleName('Page of Surface code basics')
    expect(within(screen.getByTestId('inspector')).getByDisplayValue('MWPM decoder')).toBeInTheDocument()
  })

  it('says the Card was removed when it is deleted from the Board while its Page is open', () => {
    openA()
    fireEvent.keyDown(board(), { key: 'Delete' })
    act(() => boardStore.setState({ cards: [B, C] })) // the fake Board applies the removal
    expect(within(panel()!).getByText('This Card was removed.')).toBeInTheDocument()
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Close' }))
    expect(panel()).toBeNull()
    expect(board()).toHaveFocus()
  })

  it('switching to another Card’s Page starts it afresh', () => {
    openA()
    fireEvent.click(within(panel()!).getByRole('group', { name: 'Block 1. Press Enter to edit.' }))
    expect(fake.page.startEditing).toHaveBeenCalledWith('a')
    act(() => pagePanel.open('b'))
    expect(panel()).toHaveAccessibleName('Page of MWPM decoder')
    expect(within(panel()!).queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(fake.page.stopEditing).toHaveBeenCalledTimes(1)
    expect(within(panel()!).getByText('About decoders')).toBeInTheDocument()
  })
})

describe('the Page panel and History', () => {
  it('closes when a History preview starts', () => {
    render(<BoardView />)
    act(() => pagePanel.open('a'))
    expect(panel()).toBeInTheDocument()
    act(() => history.preview(3))
    expect(panel()).toBeNull()
    expect(usePagePanel.getState().cardId).toBeNull()
    expect(screen.getByTestId('preview-banner')).toBeInTheDocument()
  })

  it('lets go of the soft lock when the preview closes it mid-edit', () => {
    render(<BoardView />)
    act(() => pagePanel.open('a'))
    fireEvent.click(within(panel()!).getByRole('group', { name: 'Block 1. Press Enter to edit.' }))
    act(() => history.preview(3))
    expect(fake.page.stopEditing).toHaveBeenCalledTimes(1)
  })

  it('cannot be opened while previewing: not by key, double-click or request', () => {
    render(<BoardView />)
    act(() => history.preview(3))
    act(() => ui.select(['old']))
    fireEvent.keyDown(board(), { key: 'o' })
    fireEvent.doubleClick(screen.getByTestId('card-old'))
    expect(usePagePanel.getState().cardId).toBeNull()

    act(() => pagePanel.open('a'))
    expect(panel()).toBeNull()
    expect(usePagePanel.getState().cardId).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Page' })).toBeNull() // no inspector in the preview
  })

  it('does not come back by itself when the preview ends', () => {
    render(<BoardView />)
    act(() => pagePanel.open('a'))
    act(() => history.preview(3))
    act(() => history.preview(null))
    expect(panel()).toBeNull()
    expect(document.querySelectorAll('.qb-toasts')).toHaveLength(1)
  })

  it('stays open beside the History panel when nothing is previewed', () => {
    render(<BoardView />)
    act(() => pagePanel.open('a'))
    act(() => historyPanel.toggle())
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(panel()).toBeInTheDocument()
    expect(document.querySelector('.qb-area__canvas')).not.toContainElement(screen.getByTestId('history-panel'))
  })
})

describe('Card footer row', () => {
  it('shows the block and Source counts of a Card that has a Page or Sources', () => {
    render(<BoardView />)
    const a = within(screen.getByTestId('card-a'))
    expect(a.getByText('¶ 4')).toBeInTheDocument()
    expect(a.getByText('Page: 4 blocks')).toBeInTheDocument() // what a screen reader hears instead of "¶ 4"
    expect(a.getByText('¶ 4')).toHaveAttribute('aria-hidden', 'true')
    expect(a.getByText('3 Sources')).toBeInTheDocument()
    expect(a.getByText('¶ 4').closest('.qb-card__foot')).not.toBeNull()
  })

  it('uses the singular for one', () => {
    render(<BoardView />)
    const b = within(screen.getByTestId('card-b'))
    expect(b.getByText('¶ 1')).toBeInTheDocument()
    expect(b.getByText('Page: 1 block')).toBeInTheDocument()
    expect(b.getByText('1 Source')).toBeInTheDocument()
  })

  it('shows only the part there is, and no row at all for a Card with neither', () => {
    boardStore.setState({ cards: [card('p', 'Only a Page', { blocks: 2 }), card('s', 'Only Sources', { x: 300, sources: 5 }), C] })
    render(<BoardView />)
    expect(within(screen.getByTestId('card-p')).getByText('¶ 2')).toBeInTheDocument()
    expect(within(screen.getByTestId('card-p')).queryByText(/Source/)).toBeNull()
    expect(within(screen.getByTestId('card-s')).getByText('5 Sources')).toBeInTheDocument()
    expect(within(screen.getByTestId('card-s')).queryByText(/¶/)).toBeNull()
    expect(screen.getByTestId('card-c').querySelector('.qb-card__foot')).toBeNull()
  })

  it('follows the counts as they change', () => {
    render(<BoardView />)
    act(() => boardStore.setState({ cards: [{ ...A, blocks: 5, sources: 0 }, B, C] }))
    const a = within(screen.getByTestId('card-a'))
    expect(a.getByText('¶ 5')).toBeInTheDocument()
    expect(a.queryByText(/Sources/)).toBeNull()
  })

  it('is left out on compact Cards and tiles; there a double-click anywhere on the Card opens the Page', () => {
    zoom.level = 'compact'
    render(<BoardView />)
    expect(document.querySelector('.qb-card__foot')).toBeNull()
    fireEvent.doubleClick(within(screen.getByTestId('card-a')).getByText('Surface code basics'))
    expect(useBoardUi.getState().editing).toBeNull() // titles are edited on full Cards only
    expect(usePagePanel.getState().cardId).toBe('a')
  })

  it('double-clicking the footer opens the Page', () => {
    render(<BoardView />)
    fireEvent.doubleClick(within(screen.getByTestId('card-a')).getByText('3 Sources'))
    expect(usePagePanel.getState().cardId).toBe('a')
  })
})
