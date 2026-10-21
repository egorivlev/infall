// Settings → Board scale on the Board: React Flow's zoom is the person's zoom times the Board scale, the zoom control
// shows the person's part, and Shift + "+" / "−" / 0 change it from the keyboard — never while typing.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { boardScaleKey, typingIn } from './boardScaleKeys'

const fake = await vi.hoisted(async () => (await import('../history/testkit')).createFakeLib())
vi.mock('../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib')>()),
  ...fake.lib,
  board: { open: vi.fn(), close: vi.fn(), submit: vi.fn(async () => undefined) },
}))
vi.mock('./useZoomLevel', () => ({ useZoomLevel: () => 'full' }))

const { BoardView } = await import('./index')
const { ui } = await import('./uiStore')
const { card } = await import('../history/testkit')
const { prefs, usePrefs } = await import('../settings/prefs')

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
})
beforeEach(() => {
  window.localStorage.clear()
  prefs.reload()
  fake.reset()
  fake.boardStore.setState({ cards: [card('c1', 'Surface code basics')] })
})
afterEach(() => {
  cleanup()
  act(() => ui.reset())
})

const key = (init: Partial<KeyboardEvent>) => ({ key: '', code: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...init })

describe('which keys change the Board scale', () => {
  it('US layout: Shift + "=" gives "+", Shift + "-" gives "_", Shift + 0 gives ")"', () => {
    expect(boardScaleKey(key({ key: '+', code: 'Equal', shiftKey: true }))).toBe(1)
    expect(boardScaleKey(key({ key: '_', code: 'Minus', shiftKey: true }))).toBe(-1)
    expect(boardScaleKey(key({ key: ')', code: 'Digit0', shiftKey: true }))).toBe(0)
  })

  it('German layout: "+" has its own key, Shift + 0 gives "=" and is still the reset', () => {
    expect(boardScaleKey(key({ key: '+', code: 'BracketRight' }))).toBe(1)
    expect(boardScaleKey(key({ key: '=', code: 'Digit0', shiftKey: true }))).toBe(0)
    expect(boardScaleKey(key({ key: '_', code: 'Slash', shiftKey: true }))).toBe(-1)
    expect(boardScaleKey(key({ key: ')', code: 'Digit9', shiftKey: true }))).toBeNull() // Shift + 9 there: not a reset
  })

  it('AZERTY: Shift + the 0 key gives "0"', () => {
    expect(boardScaleKey(key({ key: '0', code: 'Digit0', shiftKey: true }))).toBe(0)
  })

  it('the number pad, with Shift', () => {
    expect(boardScaleKey(key({ key: '+', code: 'NumpadAdd', shiftKey: true }))).toBe(1)
    expect(boardScaleKey(key({ key: '-', code: 'NumpadSubtract', shiftKey: true }))).toBe(-1)
  })

  it('leaves alone: a plain "-" or "=", anything with ⌘, Ctrl or Alt (the browser\'s zoom), and composing text', () => {
    expect(boardScaleKey(key({ key: '-', code: 'Minus' }))).toBeNull()
    expect(boardScaleKey(key({ key: '=', code: 'Equal' }))).toBeNull()
    expect(boardScaleKey(key({ key: '0', code: 'Digit0' }))).toBeNull()
    expect(boardScaleKey(key({ key: '+', code: 'Equal', shiftKey: true, metaKey: true }))).toBeNull()
    expect(boardScaleKey(key({ key: '+', code: 'Equal', shiftKey: true, ctrlKey: true }))).toBeNull()
    expect(boardScaleKey(key({ key: '_', code: 'Minus', shiftKey: true, altKey: true }))).toBeNull()
    expect(boardScaleKey(key({ key: '+', code: 'Equal', shiftKey: true, isComposing: true }))).toBeNull()
  })

  it('knows where keys are text', () => {
    const box = document.createElement('div')
    box.innerHTML = '<input id="t"><input id="c" type="checkbox"><textarea></textarea><select></select><div contenteditable="true"><span id="in">x</span></div><div contenteditable="false"><span id="out">y</span></div><button>b</button>'
    expect(typingIn(box.querySelector('#t'))).toBe(true)
    expect(typingIn(box.querySelector('#c'))).toBe(false)
    expect(typingIn(box.querySelector('textarea'))).toBe(true)
    expect(typingIn(box.querySelector('select'))).toBe(true)
    expect(typingIn(box.querySelector('#in'))).toBe(true)
    expect(typingIn(box.querySelector('#out'))).toBe(false)
    expect(typingIn(box.querySelector('button'))).toBe(false)
    expect(typingIn(null)).toBe(false)
  })
})

const pct = () => document.querySelector('.qb-hud__pct')!.textContent
const viewportZoom = () => {
  const m = /scale\(([\d.]+)\)/.exec(document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform)
  return m ? Number(m[1]) : NaN
}

describe('the Board scale on the Board', () => {
  // jsdom has no layout, so the Board fits itself to its smallest zoom: 10% of the Board scale.
  it('draws at the Board scale times the person\'s zoom; the zoom control shows only the person\'s zoom', () => {
    prefs.set({ boardScale: 150 })
    render(<BoardView />)
    expect(viewportZoom()).toBeCloseTo(0.15)
    expect(pct()).toBe('10%')
  })

  it('Shift + "+" / Shift + "−" / Shift + 0 change it, and say so for a moment', () => {
    render(<BoardView />)
    fireEvent.keyDown(screen.getByTestId('board'), { key: '+', code: 'Equal', shiftKey: true })
    expect(usePrefs.getState().boardScale).toBe(110)
    expect(screen.getByText('Board 110%')).toHaveAttribute('role', 'status')
    expect(viewportZoom()).toBeCloseTo(0.11)
    expect(pct()).toBe('10%') // the person's own zoom did not change

    fireEvent.keyDown(document.body, { key: '_', code: 'Minus', shiftKey: true })
    fireEvent.keyDown(document.body, { key: '_', code: 'Minus', shiftKey: true })
    expect(usePrefs.getState().boardScale).toBe(90)
    fireEvent.keyDown(document.body, { key: ')', code: 'Digit0', shiftKey: true })
    expect(usePrefs.getState().boardScale).toBe(100)
    expect(JSON.parse(window.localStorage.getItem('infall-settings')!).boardScale).toBe(100)
  })

  it('never takes "+" or "_" typed into a Card title, an input or something editable', () => {
    render(<BoardView />)
    act(() => ui.edit('c1', 'title'))
    const title = screen.getByRole('textbox', { name: 'Title' })
    fireEvent.keyDown(title, { key: '+', code: 'Equal', shiftKey: true })
    fireEvent.keyDown(title, { key: '_', code: 'Minus', shiftKey: true })

    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(input, editable)
    fireEvent.keyDown(input, { key: '+', code: 'Equal', shiftKey: true })
    fireEvent.keyDown(editable, { key: '_', code: 'Minus', shiftKey: true })
    fireEvent.keyDown(editable, { key: ')', code: 'Digit0', shiftKey: true })
    input.remove()
    editable.remove()

    expect(usePrefs.getState().boardScale).toBe(100)
    expect(screen.queryByText(/^Board \d+%$/)).toBeNull()
  })

  it('leaves ⌘ / Ctrl + "+" to the browser', () => {
    render(<BoardView />)
    const e = fireEvent.keyDown(document.body, { key: '+', code: 'Equal', shiftKey: true, metaKey: true })
    expect(e).toBe(true) // not prevented
    expect(usePrefs.getState().boardScale).toBe(100)
  })

  it('follows a change made in Settings while the Board is open', () => {
    render(<BoardView />)
    const before = pct()
    act(() => prefs.set({ boardScale: 200 }))
    expect(viewportZoom()).toBeCloseTo(0.2)
    expect(pct()).toBe(before)
  })
})
