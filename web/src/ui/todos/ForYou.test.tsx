// M18: For you — the rail badge, the screen beside To-dos, opening a mention, and the notice — the whole shell
// against the real data layer and the fake server.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ops } from '../../lib'
import type { Member } from '../../lib'
import { commentsInternal } from '../../lib/comments'
import { membersStore } from '../../lib/people'
import { sessionStore } from '../../lib/session-store'
import { FakeServer, FakeSocket, GUEST, ME, OTHER, settle } from '../../lib/testing'
import { historyPanel, pagePanel, usePagePanel } from '../bridge'
import { App } from '../shell/App'
import { navigate, rememberBranch } from '../shell/router'

const ANA: Member = { ...OTHER, name: 'Ana Ruiz' }
let server: FakeServer
let ws: FakeSocket

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => settle())
}

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  rememberBranch('main')
  server = new FakeServer()
  server.members = [ME, ANA]
  server.commit([ops.createCard({ id: 'a', x: 0, y: 0, title: 'Axions' })], ANA.id)
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStore.setState({ status: 'signed_out' }, true)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME, ANA] })
  commentsInternal.reset()
})

afterEach(() => {
  cleanup()
  act(() => {
    pagePanel.close()
    historyPanel.close()
    sessionStore.setState({ status: 'signed_out' }, true)
  })
})

async function open() {
  render(<App />)
  await flush()
  ws = FakeSocket.last()
  act(() => {
    ws.open()
    ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
  })
  await flush()
}

const rail = () => within(screen.getByRole('navigation', { name: 'Main' }))

describe('For you', () => {
  it('has a rail item beside To-dos with the unseen count', async () => {
    server.now = 1
    server.addComment('a', 'One @Me', [ME.id], ANA.id)
    server.now = 2
    server.addComment('a', 'Two @Me', [ME.id], ANA.id)
    await open()
    const item = rail().getByRole('link', { name: 'For you, 2 unseen' })
    expect(item).toHaveAttribute('href', '/for-you')
    expect(item.querySelector('.q-count')).toHaveClass('q-count--att')
    expect(item.querySelector('.q-count')).toHaveTextContent('2')
  })

  it('lists mentions newest first, the unseen marked in words, and opens one at its Comment, marking it seen', async () => {
    server.now = 1
    const old = server.addComment('gone', 'Old @Me', [ME.id], ANA.id)
    server.now = 2
    const recent = server.addComment('a', 'New @Me', [ME.id], ANA.id)
    server.seenBy[ME.id] = [old.id]
    await open()
    act(() => navigate('/for-you'))
    await flush()
    expect(screen.getByRole('heading', { level: 1, name: 'For you' })).toBeInTheDocument()
    const tabs = within(screen.getByRole('navigation', { name: 'To-dos and mentions' }))
    expect(tabs.getByRole('link', { name: 'For you, 1 unseen' })).toHaveAttribute('aria-current', 'page')
    expect(tabs.getByRole('link', { name: 'To-dos' })).toHaveAttribute('href', '/todos')
    const items = within(screen.getByRole('list', { name: 'Mentions, newest first' })).getAllByRole('button')
    expect(items.map((b) => b.querySelector('.qf-item__line')?.textContent)).toEqual(['Ana mentioned you on the Card “Axions”', 'Ana mentioned you on a Card that was removed'])
    expect(items[0]).toHaveTextContent('New')
    expect(items[1]).not.toHaveTextContent('New')
    fireEvent.click(items[0]!)
    await act(async () => new Promise((r) => setTimeout(r, 80)))
    await flush()
    expect(window.location.pathname).toBe('/')
    expect(usePagePanel.getState()).toMatchObject({ cardId: 'a', comment: { id: recent.id } })
    expect(server.requests.find((r) => r.path === '/api/for-you/seen')?.body).toEqual({ up_to: recent.id })
    expect(rail().getByRole('link', { name: 'For you, 0 unseen' })).toBeInTheDocument()
  })

  it('a mention arriving while here shows a short notice; Open goes to the Comment', async () => {
    await open()
    server.now = 10
    const fresh = server.addComment('a', 'Look @Me', [ME.id], ANA.id)
    act(() => ws.receive(server.forYouFrame()))
    await flush()
    const notice = screen.getByText(/mentioned you on/).closest('.q-notice') as HTMLElement
    expect(notice).toHaveTextContent('Ana mentioned you on the Card “Axions”.')
    expect(notice.querySelector('.q-notice__snippet')?.textContent).toBe('“Look @Me”')
    expect(notice.closest('[role="status"]')).not.toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Open' }))
    await flush()
    expect(usePagePanel.getState()).toMatchObject({ cardId: 'a', comment: { id: fresh.id } })
    expect(screen.queryByText(/mentioned you on the Card/)).toBeNull()
  })

  it('each row shows the first line of the Comment as plain text, and says when it was deleted', async () => {
    server.now = 1
    const kept = server.addComment('a', '\n  First line @Me  \nsecond line', [ME.id], ANA.id)
    server.now = 2
    const gone = server.addComment('a', 'Soon gone @Me', [ME.id], ANA.id)
    const real = server.forYouOf.bind(server)
    // The server gives null for a Comment that is no longer there.
    server.forYouOf = (member) => real(member).map((i) => (i.comment === gone.id ? { ...i, snippet: null } : i))
    await open()
    act(() => navigate('/for-you'))
    await flush()
    const items = within(screen.getByRole('list', { name: 'Mentions, newest first' })).getAllByRole('button')
    expect(items[0]!.querySelector('.qf-item__snippet')).toHaveTextContent('That Comment was deleted.')
    expect(items[1]!.querySelector('.qf-item__snippet')?.textContent).toBe('“First line @Me”')
    expect(items[1]).not.toHaveTextContent('second line')
    expect(kept.id).not.toBe(gone.id)
  })

  it('a row from a server that gives no snippet shows none', async () => {
    server.now = 1
    server.addComment('a', 'Old server @Me', [ME.id], ANA.id)
    const real = server.forYouOf.bind(server)
    server.forYouOf = (member) => real(member).map(({ snippet: _s, ...i }) => i)
    await open()
    act(() => navigate('/for-you'))
    await flush()
    const items = within(screen.getByRole('list', { name: 'Mentions, newest first' })).getAllByRole('button')
    expect(items[0]!.querySelector('.qf-item__snippet')).toBeNull()
    expect(items[0]).toHaveTextContent('Ana mentioned you on the Card “Axions”')
  })

  it('an empty list says what will arrive', async () => {
    await open()
    act(() => navigate('/for-you'))
    await flush()
    expect(screen.getByText('No mentions yet')).toBeInTheDocument()
    expect(screen.getByText('When a Member writes @Me in a Comment, it shows here, newest first.')).toBeInTheDocument()
  })

  it('a Guest has none of it: no rail item, and /for-you goes to the Board', async () => {
    act(() => sessionStore.setState({ status: 'signed_in', member: GUEST }, true))
    server.actor = GUEST
    window.history.replaceState(null, '', '/for-you')
    render(<App />)
    await flush()
    expect(window.location.pathname).toBe('/')
    expect(rail().queryByRole('link', { name: /For you/ })).toBeNull()
    expect(server.requests.some((r) => r.path.startsWith('/api/for-you') || r.path.startsWith('/api/comments'))).toBe(false)
  })
})
