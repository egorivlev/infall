// M7: the Board publishes what the Member is looking at (`boardFocus`), for the AI sidebar to follow.
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('../page/testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))
vi.mock('./useZoomLevel', () => ({ useZoomLevel: () => 'full' }))

const { BoardView } = await import('./index')
const { toasts } = await import('./toastStore')
const { ui } = await import('./uiStore')
const { boardFocus, historyPanel, pagePanel, useBoardFocus } = await import('../bridge')
const { editLock } = await import('../page/lock')
const { card } = await import('../page/testkit')

const { history, boardStore } = fake

const A = card('a', 'Surface code basics')
const B = card('b', 'MWPM decoder', { x: 300 })
const focus = () => useBoardFocus.getState().card

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
  boardStore.setState({
    cards: [A, B],
    frames: [{ id: 'f1', title: 'Decoders', x: 0, y: 300, w: 520, h: 360 }],
    connections: [{ id: 'k1', from: 'a', to: 'b', kind: 'directed', label: 'decoded by' }],
  })
  fake.boardAt.fn = () => ({ cards: [A], frames: [], connections: [] })
})
afterEach(() => {
  cleanup()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
    ui.reset()
    historyPanel.close()
    pagePanel.close()
    boardFocus.set(null)
  })
})

describe('what the Board publishes as its focus', () => {
  it('nothing while nothing is selected', () => {
    render(<BoardView />)
    expect(focus()).toBeNull()
  })

  it('the one selected Card, by id and title', () => {
    render(<BoardView />)
    act(() => ui.select(['a']))
    expect(focus()).toEqual({ id: 'a', title: 'Surface code basics' })
    act(() => ui.select(['b']))
    expect(focus()).toEqual({ id: 'b', title: 'MWPM decoder' })
  })

  it('follows a new title of that Card', () => {
    render(<BoardView />)
    act(() => ui.select(['a']))
    act(() => boardStore.setState({ cards: [{ ...A, title: 'Surface codes' }, B] }))
    expect(focus()).toEqual({ id: 'a', title: 'Surface codes' })
  })

  it('nothing for several Cards, a Frame or a Connection', () => {
    render(<BoardView />)
    act(() => ui.select(['a', 'b']))
    expect(focus()).toBeNull()
    act(() => ui.select(['f1']))
    expect(focus()).toBeNull()
    act(() => ui.select(['k1']))
    expect(focus()).toBeNull()
    act(() => ui.select([]))
    expect(focus()).toBeNull()
  })

  it('the Card whose Page is open, when no single Card is selected', () => {
    render(<BoardView />)
    act(() => pagePanel.open('b'))
    expect(focus()).toEqual({ id: 'b', title: 'MWPM decoder' })
    act(() => pagePanel.close())
    expect(focus()).toBeNull()
  })

  it('the selected Card wins over the open Page', () => {
    render(<BoardView />)
    act(() => pagePanel.open('b'))
    act(() => ui.select(['a']))
    expect(focus()).toEqual({ id: 'a', title: 'Surface code basics' })
    act(() => ui.select([]))
    expect(focus()).toEqual({ id: 'b', title: 'MWPM decoder' })
  })

  it('nothing while History previews an earlier moment', () => {
    render(<BoardView />)
    act(() => ui.select(['a']))
    act(() => history.preview(4))
    expect(focus()).toBeNull()
  })

  it('is cleared when the Board goes away', () => {
    const view = render(<BoardView />)
    act(() => ui.select(['a']))
    expect(focus()).not.toBeNull()
    view.unmount()
    expect(focus()).toBeNull()
  })

  it('is published under StrictMode too (effects run twice)', () => {
    render(
      <StrictMode>
        <BoardView />
      </StrictMode>,
    )
    act(() => ui.select(['a']))
    expect(focus()).toEqual({ id: 'a', title: 'Surface code basics' })
  })
})
