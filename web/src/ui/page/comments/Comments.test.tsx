// M18: the Comments section of a Page, against the real data layer and the fake server.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board } from '../../../lib'
import { commentsInternal } from '../../../lib/comments'
import { membersStore } from '../../../lib/people'
import { sessionStore } from '../../../lib/session-store'
import { FakeServer, FakeSocket, GUEST, ME, OTHER, settle } from '../../../lib/testing'
import type { Member } from '../../../lib'
import { workspace, workspaceStore } from '../../../lib/workspace'
import { pagePanel } from '../../bridge'
import { Comments } from './Comments'

const ANA: Member = { ...OTHER, name: 'Ana Ruiz' }
const BEN: Member = { id: 'ben', name: 'Ben Okafor', role: 'member', color: '#333' }
let server: FakeServer
let ws: FakeSocket

async function flush() {
  await act(async () => settle())
}

const sent = () => server.requests.filter((r) => r.method !== 'GET' && (r.path.startsWith('/api/cards/') || r.path.startsWith('/api/comments')))

beforeEach(async () => {
  server = new FakeServer()
  server.members = [ME, ANA, BEN, GUEST]
  server.now = Date.now()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStore.setState({ status: 'signed_out' }, true)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME, ANA, BEN, GUEST] })
  commentsInternal.reset()
  await act(async () => board.open())
  ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
  await flush()
})

afterEach(() => {
  cleanup()
  board.close()
  act(() => pagePanel.close())
  act(() => sessionStore.setState({ status: 'signed_out' }, true))
  vi.unstubAllGlobals()
})

const section = () => within(screen.getByTestId('page-comments'))
const options = () => screen.getAllByRole('option').map((o) => o.lastElementChild?.textContent)

describe('the thread', () => {
  it('shows author, time, the text with inline Markdown and the mentions, and "edited"', async () => {
    server.addComment('c1', 'Is **this** tight, @Me? See $x^2$.', [ME.id], ANA.id)
    const edited = server.addComment('c1', 'Second thought', [], BEN.id)
    server.comments[1] = { ...server.comments[1]!, id: edited.id, edited_at: server.now }
    render(<Comments card="c1" />)
    await flush()
    expect(section().getByRole('heading', { name: 'Comments · 2' })).toBeInTheDocument()
    const first = section().getAllByRole('listitem')[0]!
    expect(within(first).getByText('Ana Ruiz')).toBeInTheDocument()
    expect(within(first).getByText('this').tagName).toBe('STRONG')
    expect(within(first).getByText('@Me')).toHaveClass('qc-mention')
    expect(first.querySelector('.katex')).not.toBeNull()
    expect(within(section().getAllByRole('listitem')[1]!).getByText('· edited')).toBeInTheDocument()
  })

  it('follows the live frame', async () => {
    render(<Comments card="c1" />)
    await flush()
    expect(section().getByText(/Start the thread/)).toBeInTheDocument()
    server.addComment('c1', 'From Ana', [], ANA.id)
    act(() => ws.receive(server.commentsFrame('c1')))
    await flush()
    expect(section().getByText('From Ana')).toBeInTheDocument()
  })

  it('a Guest sees none of it', async () => {
    act(() => sessionStore.setState({ status: 'signed_in', member: GUEST }, true))
    const { container } = render(<Comments card="c1" />)
    await flush()
    expect(container).toBeEmptyDOMElement()
    expect(server.requests.some((r) => r.path.startsWith('/api/cards/'))).toBe(false)
  })
})

describe('writing', () => {
  it('completes @ from the Members with the keyboard and sends the mention', async () => {
    const user = userEvent.setup()
    render(<Comments card="c1" />)
    await flush()
    const box = section().getByRole('combobox', { name: 'Start the thread' })
    await user.type(box, 'Ask @')
    // Everyone but the Guest, by name.
    expect(screen.getByRole('listbox', { name: 'Members to mention' })).toBeInTheDocument()
    expect(options()).toEqual(['Ana Ruiz', 'Ben Okafor', 'Me'])
    await user.type(box, 'b')
    expect(options()).toEqual(['Ben Okafor'])
    await user.keyboard('{Enter}')
    expect(box).toHaveValue('Ask @Ben Okafor ')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(box, 'and @a')
    await user.keyboard('{ArrowDown}{Escape}') // Esc closes the list only
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(box, 'lso{Control>}{Enter}{/Control}')
    await flush()
    expect(sent()).toEqual([{ method: 'POST', path: '/api/cards/c1/comments', body: { text: 'Ask @Ben Okafor and @also', mentions: [BEN.id] } }])
    expect(box).toHaveValue('')
    expect(section().getByText('@Ben Okafor')).toHaveClass('qc-mention')
  })

  it('Tab picks too, and ↑ wraps to the last', async () => {
    const user = userEvent.setup()
    render(<Comments card="c1" />)
    await flush()
    const box = section().getByRole('combobox')
    await user.type(box, '@')
    await user.keyboard('{ArrowUp}{Tab}')
    expect(box).toHaveValue('@Me ')
  })

  it('counts near the limit, and refuses past it without sending', async () => {
    render(<Comments card="c1" />)
    await flush()
    const box = section().getByRole('combobox')
    fireEvent.change(box, { target: { value: 'x'.repeat(9_500) } })
    expect(section().getByText('9 500 / 10 000')).toBeInTheDocument()
    fireEvent.change(box, { target: { value: 'x'.repeat(10_003) } })
    expect(section().getByText('10 003 / 10 000 — 3 too many')).toHaveClass('is-over')
    fireEvent.click(section().getByRole('button', { name: 'Add Comment' }))
    await flush()
    expect(sent()).toEqual([])
  })

  it('says what went wrong in the server’s words and keeps the text', async () => {
    server.commentFail = { status: 400, code: 'bad_request', message: 'Each mention must be a Member.' }
    render(<Comments card="c1" />)
    await flush()
    const box = section().getByRole('combobox')
    fireEvent.change(box, { target: { value: 'Hello' } })
    fireEvent.click(section().getByRole('button', { name: 'Add Comment' }))
    await flush()
    expect(section().getByRole('alert')).toHaveTextContent('The Comment could not be added. Each mention must be a Member.')
    expect(box).toHaveValue('Hello')
  })

  it('in a Local Workspace @ offers only yourself', async () => {
    server.workspace = { kind: 'local', preset: null }
    await act(async () => workspace.load())
    const user = userEvent.setup()
    render(<Comments card="c1" />)
    await flush()
    expect(section().getByText('Comments here are for you alone: this Workspace has one Member. They go with it if it moves to a Team server.')).toBeInTheDocument()
    await user.type(section().getByRole('combobox'), '@')
    expect(options()).toEqual(['Me'])
  })

  it('in a moved copy the hint says the Comments went with it', async () => {
    server.workspace = { kind: 'local', preset: null, read_only: true }
    await act(async () => workspace.load())
    render(<Comments card="c1" />)
    await flush()
    expect(section().getByText('Comments here are for you alone: this Workspace has one Member. They went with it to the Team server.')).toBeInTheDocument()
  })
})

describe('editing, deleting, resolving', () => {
  it('edits and deletes your own; another’s has neither', async () => {
    const user = userEvent.setup()
    server.addComment('c1', 'Theirs', [], ANA.id)
    server.addComment('c1', 'Mine', [], ME.id)
    render(<Comments card="c1" />)
    await flush()
    const [theirs, mine] = section().getAllByRole('listitem')
    expect(within(theirs!).queryByRole('button')).toBeNull()
    await user.click(within(mine!).getByRole('button', { name: 'Edit your Comment' }))
    const field = within(mine!).getByRole('combobox', { name: 'Your Comment' })
    expect(field).toHaveFocus()
    await user.clear(field)
    await user.type(field, 'Mine, changed')
    await user.click(within(mine!).getByRole('button', { name: 'Done' }))
    await flush()
    expect(section().getByText('Mine, changed')).toBeInTheDocument()
    expect(within(section().getAllByRole('listitem')[1]!).getByRole('button', { name: 'Edit your Comment' })).toHaveFocus()

    await user.click(within(section().getAllByRole('listitem')[1]!).getByRole('button', { name: 'Delete your Comment' }))
    expect(section().getByText('Delete this Comment? It cannot be brought back.')).toBeInTheDocument()
    await user.click(section().getByRole('button', { name: 'Delete' }))
    await flush()
    expect(section().queryByText('Mine, changed')).toBeNull()
    expect(sent().map((r) => r.method)).toEqual(['PATCH', 'DELETE'])
  })

  it('an Admin may delete anyone’s', async () => {
    const admin = { ...ME, role: 'admin' as const }
    act(() => sessionStore.setState({ status: 'signed_in', member: admin }, true))
    server.actor = admin
    server.addComment('c1', 'Theirs', [], ANA.id)
    render(<Comments card="c1" />)
    await flush()
    expect(section().getByRole('button', { name: 'Delete Ana Ruiz’s Comment' })).toBeInTheDocument()
    expect(section().queryByRole('button', { name: /Edit/ })).toBeNull()
  })

  it('Resolve collapses the thread, still readable; Reopen opens it again', async () => {
    const user = userEvent.setup()
    server.addComment('c1', 'Settled?', [], ANA.id)
    render(<Comments card="c1" />)
    await flush()
    await user.click(section().getByRole('button', { name: 'Resolve' }))
    await flush()
    expect(section().getByRole('heading')).toHaveTextContent('Comments · 1 · resolved')
    expect(section().queryByText('Settled?')).toBeNull()
    expect(section().queryByRole('combobox')).toBeNull()
    await user.click(section().getByRole('button', { name: 'Show the Comment' }))
    expect(section().getByText('Settled?')).toBeInTheDocument()
    await user.click(section().getByRole('button', { name: 'Reopen' }))
    await flush()
    expect(server.resolved.c1).toBe(false)
    expect(section().getByRole('combobox', { name: 'Add a Comment' })).toBeInTheDocument()
  })
})

describe('arriving from For you', () => {
  it('opens a resolved thread, scrolls to the Comment and focuses it', async () => {
    server.addComment('c1', 'Before', [], ANA.id)
    const target = server.addComment('c1', 'This one, @Me', [ME.id], ANA.id)
    server.resolved.c1 = true
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    act(() => pagePanel.open('c1', { comment: target.id }))
    render(<Comments card="c1" removed />)
    await flush()
    expect(section().getByText('On a Card that was removed. The thread is kept.')).toBeInTheDocument()
    const item = document.querySelector(`[data-comment="${target.id}"]`)!
    expect(item).toHaveFocus()
    expect(item).toHaveClass('is-lit')
    expect(scrolled).toHaveBeenCalled()
  })
})

describe('a moved copy', () => {
  it('reads the thread and writes nothing', async () => {
    server.addComment('c1', 'Kept', [], ME.id)
    act(() => workspaceStore.setState({ ...workspaceStore.getState(), readOnly: true }, true))
    render(<Comments card="c1" />)
    await flush()
    expect(section().getByText('Kept')).toBeInTheDocument()
    expect(section().queryByRole('combobox')).toBeNull()
    expect(section().queryByRole('button')).toBeNull()
    act(() => workspaceStore.setState({ ...workspaceStore.getState(), readOnly: false }, true))
  })
})
