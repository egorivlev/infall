// Undo end to end in the UI (docs/specs/undo.md): a gesture through the Board's actions, the buttons naming it, the
// keys handled once by the shell, the note, and the desktop Edit menu's bridge — against the real data layer and
// the fake server.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board, ops, undo } from '../../lib'
import { membersStore } from '../../lib/people'
import { sessionStore } from '../../lib/session-store'
import { FakeServer, FakeSocket, ME, OTHER, settle } from '../../lib/testing'
import { UndoKeys } from '../shell/UndoKeys'
import { Toast } from './Toast'
import { toasts } from './toastStore'
import { UndoButtons } from './UndoButtons'
import { undoKey, useUndoPlace } from './undoActions'
import { useBoardActions } from './useBoardActions'

const ANA = { ...OTHER, name: 'Ana Ruiz' }
let server: FakeServer
let ws: FakeSocket

const field = (id: string, name: string) => server.entities[id]?.fields[name]
const actions = () => {
  let a!: ReturnType<typeof useBoardActions>
  function Grab() {
    a = useBoardActions()
    return null
  }
  render(<Grab />)
  return a
}

async function flush() {
  await act(async () => settle())
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value: platform })
}

beforeEach(async () => {
  setPlatform('Linux x86_64')
  server = new FakeServer()
  server.members = [ME, ANA]
  server.commit([ops.createCard({ id: 'a', x: 0, y: 0, title: 'Axions' }), ops.createCard({ id: 'b', x: 300, y: 0, title: 'Bosons' })], ANA.id)
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME, ANA] })
  await act(async () => board.open())
  ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
  useUndoPlace.setState({ here: true })
  render(
    <>
      <Toast />
      <UndoKeys />
      <div role="toolbar">
        <UndoButtons buttonClass="b" />
      </div>
      <textarea aria-label="A field being edited" />
    </>,
  )
})

afterEach(() => {
  cleanup()
  act(() => toasts.clear())
  board.close()
  useUndoPlace.setState({ here: false })
  act(() => sessionStore.setState({ status: 'signed_out' }, true)) // a list is the Member's: this ends it
  vi.unstubAllGlobals()
})

const note = () => screen.getAllByTestId('toast').map((t) => t.querySelector('.qb-toast__msg')?.textContent)

describe('buttons', () => {
  it('name the step and the keys, and are unavailable when there is nothing', async () => {
    expect(screen.getByTestId('undo-button')).toHaveAttribute('aria-label', 'Nothing to undo')
    expect(screen.getByTestId('undo-button')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('redo-button')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Z Control+Y')
    const a = actions()
    await act(async () => void (await a.submit([...ops.move('a', 40, 40), ...ops.move('b', 340, 40)])))
    await flush()
    const button = screen.getByTestId('undo-button')
    expect(button).toHaveAttribute('aria-label', 'Undo Move 2 Cards')
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button.parentElement).toHaveTextContent('Undo Move 2 CardsCtrl+Z')
    fireEvent.click(button)
    await flush()
    expect(note()).toEqual(['Undid Move 2 Cards.'])
    expect(field('a', 'x')).toEqual({ Float: 0 })
    expect(screen.getByTestId('redo-button')).toHaveAttribute('aria-label', 'Redo Move 2 Cards')
    expect(screen.getByTestId('redo-button').parentElement).toHaveTextContent('Redo Move 2 CardsCtrl+Y')
  })
})

describe('keys, handled once', () => {
  it('Ctrl+Z undoes and Ctrl+Y / Shift+Ctrl+Z redo, each press taken (preventDefault) — "nothing to undo" too', async () => {
    const a = actions()
    await act(async () => void (await a.submit([ops.setStatus('a', 'reading')])))
    await flush()
    expect(press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(note()).toEqual(['Undid Status: Axions → Reading.'])
    expect(field('a', 'status')).toBeUndefined()
    expect(press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(note()).toEqual(['Nothing to undo. To go further back, use History.'])
    expect(press(document.body, { key: 'y', code: 'KeyY', ctrlKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(note()).toEqual(['Redid Status: Axions → Reading.'])
    expect(press(document.body, { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(note()).toEqual(['Nothing to redo.'])
  })
  it('leaves the key alone in a field being edited: its own text undo', async () => {
    const a = actions()
    await act(async () => void (await a.submit([ops.setStatus('a', 'reading')])))
    await flush()
    const area = screen.getByRole('textbox', { name: 'A field being edited' })
    area.focus()
    expect(press(area, { key: 'z', code: 'KeyZ', ctrlKey: true }).defaultPrevented).toBe(false)
    await flush()
    expect(screen.queryByTestId('toast')).toBeNull()
    expect(field('a', 'status')).toEqual({ Text: 'reading' })
  })
  it('does nothing where Undo does not work (History previewed, a Guest, another screen)', async () => {
    useUndoPlace.setState({ here: false })
    expect(press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true }).defaultPrevented).toBe(false)
    await flush()
    expect(screen.queryByTestId('toast')).toBeNull()
  })
  it('never with Alt, never Cmd on Linux, and not the Board scale keys', () => {
    expect(undoKey({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, isComposing: false })).toBeNull()
    expect(undoKey({ key: 'z', code: 'KeyZ', ctrlKey: false, altKey: false, metaKey: true, shiftKey: false, isComposing: false })).toBeNull()
    expect(undoKey({ key: '+', code: 'Equal', ctrlKey: false, altKey: false, metaKey: false, shiftKey: true, isComposing: false })).toBeNull()
    expect(undoKey({ key: ',', code: 'Comma', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, isComposing: false })).toBeNull()
    // A Cyrillic layout still has its Z where QWERTY has it.
    expect(undoKey({ key: 'я', code: 'KeyZ', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, isComposing: false })).toBe('undo')
  })
  it('on a Mac: Cmd+Z and Shift+Cmd+Z; not Ctrl+Z, not Cmd+Y', async () => {
    setPlatform('MacIntel')
    const key = (k: string, m: Partial<KeyboardEventInit>) => undoKey({ key: k, code: `Key${k.toUpperCase()}`, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...m })
    expect(key('z', { metaKey: true })).toBe('undo')
    expect(key('Z', { metaKey: true, shiftKey: true })).toBe('redo')
    expect(key('z', { ctrlKey: true })).toBeNull()
    expect(key('y', { metaKey: true })).toBeNull()
    expect(key('z', { metaKey: true, altKey: true })).toBeNull()
    expect(press(document.body, { key: 'z', code: 'KeyZ', metaKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(note()).toEqual(['Nothing to undo. To go further back, use History.'])
    render(<UndoButtons buttonClass="mac" />)
    expect(document.querySelector('.mac')?.parentElement).toHaveTextContent('Nothing to undo⌘Z')
  })
})

describe('the Edit menu’s bridge', () => {
  it('names the steps, leaves a field’s own undo to it, and tells of every change', async () => {
    const bridge = window.__infallUndo!
    expect(bridge.state()).toEqual({ undo: null, redo: null })
    const heard = vi.fn()
    const stop = bridge.subscribe(heard)
    const a = actions()
    await act(async () => void (await a.submit([ops.setText('a', 'title', 'Axion')])))
    await flush()
    expect(heard).toHaveBeenCalled()
    expect(bridge.state()).toEqual({ undo: 'Undo Rename Card Axions → Axion', redo: null })
    const area = screen.getByRole('textbox', { name: 'A field being edited' })
    heard.mockClear()
    act(() => area.focus())
    expect(heard).toHaveBeenCalled()
    expect(bridge.state()).toEqual({ undo: null, redo: null })
    act(() => area.blur())
    act(() => bridge.undo())
    await flush()
    expect(field('a', 'title')).toEqual({ Text: 'Axions' })
    expect(bridge.state()).toEqual({ undo: null, redo: 'Redo Rename Card Axions → Axion' })
    stop()
    heard.mockClear()
    act(() => bridge.redo())
    await flush()
    expect(heard).not.toHaveBeenCalled()
    expect(field('a', 'title')).toEqual({ Text: 'Axion' })
  })
  it('is there only while the app is', () => {
    expect(window.__infallUndo).toBeDefined()
    cleanup()
    expect(window.__infallUndo).toBeUndefined()
  })
})

describe('with another Member', () => {
  it('says who changed it since and leaves it', async () => {
    const a = actions()
    await act(async () => void (await a.submit([ops.setText('a', 'title', 'Axion')])))
    await flush()
    act(() => ws.receive(server.external([ops.setText('a', 'title', 'Axion field')], ANA.id)))
    expect(press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(note()).toEqual(['Not undone — Ana changed this since.'])
    expect(field('a', 'title')).toEqual({ Text: 'Axion field' })
    expect(undo.current()).toEqual({ undo: null, redo: null })
  })
})
