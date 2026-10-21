/// <reference types="node" />
// The Board never lets a press turn into a browser text selection (see textSelection.ts for why).
// What jsdom cannot show (a press really moving a Card, nothing highlighted) was checked by hand in Chrome.
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const boardCss = readFileSync(`${process.cwd()}/src/ui/board/board.css`, 'utf8')
// jsdom has no layout, so the Board would fit itself down to the smallest zoom; pin the level instead.
vi.mock('./useZoomLevel', () => ({ useZoomLevel: () => 'full' }))

const fake = await vi.hoisted(async () => (await import('../history/testkit')).createFakeLib())
vi.mock('../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib')>()),
  ...fake.lib,
  board: { open: vi.fn(), close: vi.fn(), submit: vi.fn(async () => undefined) },
}))

const { BoardView } = await import('./index')
const { ui } = await import('./uiStore')
const { card } = await import('../history/testkit')
const { selectsText } = await import('./textSelection')

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
  fake.boardStore.setState({ cards: [card('c1', 'Surface code basics', { summary: 'Why it works' })] })
})
afterEach(() => {
  cleanup()
  act(() => ui.reset())
  document.getSelection()?.removeAllRanges()
  document.querySelectorAll('[data-outside]').forEach((n) => n.remove())
})

/** Dispatches `selectstart` the way the browser does and says whether the Board let it through. */
function selectionAllowedAt(el: Node): boolean {
  const e = new Event('selectstart', { bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return !e.defaultPrevented
}

/** Text selected outside the Board, as after selecting a line in the rail or the Page panel. */
function selectOutside(): HTMLElement {
  const p = document.createElement('p')
  p.dataset.outside = ''
  p.textContent = 'Frames in the rail'
  document.body.append(p)
  const r = document.createRange()
  r.selectNodeContents(p)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(r)
  return p
}

describe('text selection on the Board', () => {
  it('refuses a selection starting on a Card, its text, the background or the Board controls', () => {
    render(<BoardView />)
    const cardEl = screen.getByTestId('card-c1')
    expect(selectionAllowedAt(cardEl)).toBe(false)
    expect(selectionAllowedAt(within(screen.getByTestId('card-c1')).getByText('Surface code basics').firstChild!)).toBe(false) // a text node
    expect(selectionAllowedAt(within(screen.getByTestId('card-c1')).getByText('Why it works'))).toBe(false)
    expect(selectionAllowedAt(document.querySelector('.react-flow__pane')!)).toBe(false)
    expect(selectionAllowedAt(screen.getByTestId('toolbar-add-card'))).toBe(false)
    expect(selectionAllowedAt(document.querySelector('.qb-hud')!)).toBe(false)
  })

  it('lets text be selected in a field being edited and in the inspector', () => {
    render(<BoardView />)
    act(() => ui.select(['c1']))
    const inspector = document.querySelector('.qb-inspector')!
    expect(selectionAllowedAt(inspector.querySelector('h2, h3, p') ?? inspector)).toBe(true)
    act(() => ui.edit('c1', 'title'))
    expect(selectionAllowedAt(within(screen.getByTestId('card-c1')).getByRole('textbox', { name: 'Title' }))).toBe(true)
  })

  it('drops a selection left over from elsewhere when a Card or the background is pressed', () => {
    render(<BoardView />)
    selectOutside()
    fireEvent.pointerDown(screen.getByTestId('card-c1'))
    expect(document.getSelection()!.toString()).toBe('')

    selectOutside()
    fireEvent.pointerDown(document.querySelector('.react-flow__pane')!)
    expect(document.getSelection()!.toString()).toBe('')
  })

  it('keeps the selection when the press is inside a field being edited', () => {
    render(<BoardView />)
    act(() => ui.edit('c1', 'title'))
    const field = within(screen.getByTestId('card-c1')).getByRole('textbox', { name: 'Title' })
    selectOutside()
    fireEvent.pointerDown(field)
    expect(document.getSelection()!.toString()).toBe('Frames in the rail')
  })

  it('lets a press anywhere on a Card start a drag: only fields being edited opt out', () => {
    render(<BoardView />)
    act(() => ui.select(['c1']))
    // The status chip of a selected Card is a button; pressing and dragging it moves the Card.
    const status = within(screen.getByTestId('card-c1')).getByRole('button', { name: /Change status/ })
    expect(status).not.toHaveClass('nodrag')
    act(() => ui.edit('c1', 'title'))
    const field = within(screen.getByTestId('card-c1')).getByRole('textbox', { name: 'Title' })
    expect(field).toHaveClass('nodrag', 'nopan')
  })

  it('makes the Board unselectable in CSS, with fields and the inspector selectable again', () => {
    const rule = (selector: string) => {
      const at = boardCss.indexOf(`${selector} {`)
      return at === -1 ? '' : boardCss.slice(at, boardCss.indexOf('}', at))
    }
    expect(rule('.qb-board')).toMatch(/-webkit-user-select: none/)
    expect(rule('.qb-board')).toMatch(/[^-]user-select: none/)
    const again = boardCss.slice(boardCss.indexOf('.qb-board :is(input, textarea'))
    expect(again.slice(0, again.indexOf('}'))).toMatch(/\.qb-board \.qb-inspector \{\s*-webkit-user-select: text;\s*user-select: text;/)
  })

  it('knows where text is meant to be selected', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = '<div class="qb-inspector"><p>Summary</p></div><textarea></textarea><div class="qb-card"><span>Title</span></div>'
    expect(selectsText(wrap.querySelector('p'))).toBe(true)
    expect(selectsText(wrap.querySelector('textarea'))).toBe(true)
    expect(selectsText(wrap.querySelector('span'))).toBe(false)
    expect(selectsText(wrap.querySelector('span')!.firstChild)).toBe(false)
    expect(selectsText(null)).toBe(false)
  })
})
