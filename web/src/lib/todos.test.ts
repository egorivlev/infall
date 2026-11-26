import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { ApiError } from './http'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle } from './testing'
import { isNameOnly, todos, todosInternal } from './todos'
import { workspaceStore } from './workspace'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>

const list = () => todosInternal.store.getState().todos
const texts = () => list().map((t) => t.text)
const calls = (method: string) => server.requests.filter((r) => r.method === method && r.path.startsWith('/api/todos'))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

async function openLive() {
  await sync.open()
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
  await settle()
  return ws
}

beforeEach(() => {
  server = new FakeServer()
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [] })
  todosInternal.reset()
  server.now = 100
  sync = createBoardSync({
    WebSocketCtor: FakeSocket,
    setTimer: timers.set,
    clearTimer: timers.clear,
    socketUrl: () => 'ws://test/api/ws',
  })
})

afterEach(() => {
  sync.close()
  vi.unstubAllGlobals()
})

describe('loading', () => {
  it('is empty until loaded; reload fetches the list', async () => {
    server.addTodo({ owner: ME.id, text: 'Read the paper' })
    server.addTodo({ owner: OTHER.id, text: 'Check the bound' }, OTHER.id)
    expect(list()).toEqual([])
    await todos.reload()
    expect(list()).toEqual([
      { id: 't0', owner: ME.id, text: 'Read the paper', done: false, created_by: ME.id, created_at: 100 },
      { id: 't1', owner: OTHER.id, text: 'Check the bound', done: false, created_by: OTHER.id, created_at: 100 },
    ])
  })
  it('keeps the list and its To-dos when a reload brings nothing new', async () => {
    server.addTodo({ owner: ME.id, text: 'One' })
    server.addTodo({ owner: ME.id, text: 'Two' })
    await todos.reload()
    const before = list()
    await todos.reload()
    expect(list()).toBe(before)
    server.todos[1] = { ...server.todos[1]!, text: 'Two, edited' }
    await todos.reload()
    expect(list()).not.toBe(before)
    expect(list()[0]).toBe(before[0])
    expect(list()[1]!.text).toBe('Two, edited')
  })
  it('orders by creation time, then id', async () => {
    todosInternal.reset()
    server.now = 300
    server.addTodo({ owner: ME.id, text: 'later' })
    server.now = 200
    server.addTodo({ owner: ME.id, text: 'earlier' })
    server.addTodo({ owner: ME.id, text: 'earlier too' })
    await todos.reload()
    expect(texts()).toEqual(['earlier', 'earlier too', 'later'])
  })
  it('is loaded when a Member opens the Board', async () => {
    server.addTodo({ owner: ME.id, text: 'From before' })
    await sync.open()
    await settle()
    expect(texts()).toEqual(['From before'])
    expect(calls('GET')).toHaveLength(1)
  })
  it('does not fail the Board when the list cannot be loaded', async () => {
    const inner = server.fetch
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      path === '/api/todos' ? Promise.reject(new Error('down')) : inner(path, init),
    )
    await openLive()
    expect(sync.store.getState().snapshot.status).toBe('live')
    expect(list()).toEqual([])
    await expect(todos.reload()).rejects.toMatchObject({ status: 0, code: 'network' })
  })
  it('is refetched after the socket reconnects, not on the first subscription', async () => {
    const ws = await openLive()
    expect(calls('GET')).toHaveLength(1)
    server.addTodo({ owner: ME.id, text: 'Added while away' }, OTHER.id)
    ws.drop()
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
    await settle()
    expect(calls('GET')).toHaveLength(2)
    expect(texts()).toEqual(['Added while away'])
  })
  it('is forgotten when the session ends', async () => {
    server.addTodo({ owner: ME.id, text: 'Mine' })
    await todos.reload()
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(list()).toEqual([])
  })
})

describe('the todos frame', () => {
  it('replaces the list with what the server says', async () => {
    const ws = await openLive()
    server.addTodo({ owner: ME.id, text: 'Assigned to me' }, OTHER.id)
    ws.receive(server.todosFrame())
    expect(texts()).toEqual(['Assigned to me'])
    const before = list()
    ws.receive(server.todosFrame())
    expect(list()).toBe(before)
    server.todos = []
    ws.receive(server.todosFrame())
    expect(list()).toEqual([])
  })
})

describe('add', () => {
  it('shows the To-do at once and then the one the server made', async () => {
    const gate = deferred()
    server.todoGate = gate.promise
    const done = todos.add({ owner: OTHER.id, text: '  Check the threshold  ', card: { id: 'a', title: 'Threshold', branch: 'main-id' } })
    expect(list()).toHaveLength(1)
    expect(list()[0]).toMatchObject({
      owner: OTHER.id,
      text: 'Check the threshold',
      done: false,
      created_by: ME.id,
      card: { id: 'a', title: 'Threshold', branch: 'main-id' },
    })
    expect(list()[0]!.id).toMatch(/^pending:/)
    gate.release()
    const made = await done
    expect(made).toEqual({
      id: 't0',
      owner: OTHER.id,
      text: 'Check the threshold',
      done: false,
      created_by: ME.id,
      created_at: 100,
      card: { id: 'a', title: 'Threshold', branch: 'main-id' },
    })
    expect(list()).toEqual([made])
    expect(calls('POST')[0]!.body).toEqual({
      owner: OTHER.id,
      text: 'Check the threshold',
      card: { id: 'a', title: 'Threshold', branch: 'main-id' },
    })
  })
  it('does not show it twice when the frame arrives before the answer', async () => {
    const ws = await openLive()
    const gate = deferred()
    server.todoGate = gate.promise
    const done = todos.add({ owner: ME.id, text: 'Once' })
    await settle()
    // The server has made it and tells everyone; our own answer is still on its way.
    const made = { id: 't0', owner: ME.id, text: 'Once', done: false, created_by: ME.id, created_at: 100 }
    ws.receive({ type: 'todos', todos: [made] })
    expect(list()).toEqual([made])
    gate.release()
    await done
    expect(list()).toEqual([made])
  })
  it('takes it back and rejects when the server refuses', async () => {
    server.addTodo({ owner: ME.id, text: 'Already there' })
    await todos.reload()
    const before = list()
    server.todoFail = { status: 400, code: 'bad_request' }
    const done = todos.add({ owner: 'nobody', text: 'For a stranger' })
    expect(texts()).toEqual(['Already there', 'For a stranger'])
    const error = await done.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'bad_request' })
    expect(list()).toEqual(before)
  })
  it('takes it back on a network failure', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    await expect(todos.add({ owner: ME.id, text: 'Offline' })).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(list()).toEqual([])
  })
  it('refuses an empty or overlong text without a request', async () => {
    await expect(todos.add({ owner: ME.id, text: '   ' })).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(todos.add({ owner: ME.id, text: 'x'.repeat(501) })).rejects.toMatchObject({ status: 400 })
    expect(calls('POST')).toEqual([])
    expect(list()).toEqual([])
  })
})

describe('setDone', () => {
  beforeEach(async () => {
    server.addTodo({ owner: ME.id, text: 'Mine' })
    server.addTodo({ owner: OTHER.id, text: 'Theirs, added by me' })
    await todos.reload()
  })
  it('ticks at once and keeps the server answer', async () => {
    const gate = deferred()
    server.todoGate = gate.promise
    server.now = 900
    const done = todos.setDone('t0', true)
    expect(list()[0]).toMatchObject({ id: 't0', done: true })
    expect(typeof list()[0]!.done_at).toBe('number')
    const other = list()[1]
    gate.release()
    await done
    expect(list()[0]).toMatchObject({ id: 't0', done: true, done_at: 900 })
    expect(list()[1]).toBe(other)
    expect(calls('PATCH')[0]).toMatchObject({ path: '/api/todos/t0', body: { done: true } })
    await todos.setDone('t0', false)
    expect(list()[0]).toEqual({ id: 't0', owner: ME.id, text: 'Mine', done: false, created_by: ME.id, created_at: 100 })
  })
  it('refuses to tick someone else\'s without a request, even one we added', async () => {
    await expect(todos.setDone('t1', true)).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(todos.setDone('ghost', true)).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(calls('PATCH')).toEqual([])
    expect(list()[1]!.done).toBe(false)
  })
  it('ticks a name only’s To-do in a Local Workspace, and only there; it stays theirs', async () => {
    const name = { ...OTHER, claimed: false }
    membersStore.setState({ members: [ME, name] })
    server.members = [ME, name]
    // On a Team server the name waits for whoever claims it.
    expect(isNameOnly(OTHER.id)).toBe(false)
    await expect(todos.setDone('t1', true)).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    const was = workspaceStore.getState()
    workspaceStore.setState({ ...was, kind: 'local' }, true)
    server.workspace = { kind: 'local', preset: 'blank' }
    try {
      expect(isNameOnly(OTHER.id)).toBe(true)
      expect(isNameOnly(ME.id)).toBe(false)
      await todos.setDone('t1', true)
      expect(list()[1]).toMatchObject({ id: 't1', owner: OTHER.id, done: true })
      expect(calls('PATCH')).toHaveLength(1)
    } finally {
      workspaceStore.setState(was, true)
    }
  })
  it('unticks again and rejects when the server refuses', async () => {
    const before = list()
    server.todoFail = { status: 500, code: 'internal' }
    const done = todos.setDone('t0', true)
    expect(list()[0]!.done).toBe(true)
    await expect(done).rejects.toMatchObject({ status: 500, code: 'internal' })
    expect(list()).toEqual(before)
  })
  it('keeps a tick still on its way when a frame arrives from before it', async () => {
    const ws = await openLive()
    const gate = deferred()
    server.todoGate = gate.promise
    const done = todos.setDone('t0', true)
    ws.receive(server.todosFrame())
    expect(list()[0]!.done).toBe(true)
    gate.release()
    await done
    expect(list()[0]!.done).toBe(true)
  })
})

describe('edit and remove', () => {
  beforeEach(async () => {
    server.addTodo({ owner: ME.id, text: 'Mine', card: { id: 'a', title: 'A', branch: 'main-id' } })
    server.addTodo({ owner: OTHER.id, text: 'Theirs' }, OTHER.id)
    await todos.reload()
  })
  it('edits the text and the Card pointer at once', async () => {
    const gate = deferred()
    server.todoGate = gate.promise
    const done = todos.edit('t0', { text: ' Mine, reworded ', card: { id: 'b', title: 'B', branch: 'try-id' } })
    expect(list()[0]).toMatchObject({ text: 'Mine, reworded', card: { id: 'b', title: 'B', branch: 'try-id' } })
    gate.release()
    await done
    expect(calls('PATCH')[0]!.body).toEqual({ text: 'Mine, reworded', card: { id: 'b', title: 'B', branch: 'try-id' } })
    expect(server.todos[0]).toMatchObject({ text: 'Mine, reworded', card: { id: 'b' } })
  })
  it('clears the Card pointer with null and leaves it alone when not given', async () => {
    await todos.edit('t0', { text: 'Reworded' })
    expect(list()[0]!.card).toEqual({ id: 'a', title: 'A', branch: 'main-id' })
    await todos.edit('t0', { card: null })
    expect(list()[0]).toEqual({ id: 't0', owner: ME.id, text: 'Reworded', done: false, created_by: ME.id, created_at: 100 })
    expect(calls('PATCH')[1]!.body).toEqual({ card: null })
    await todos.edit('t0', {})
    expect(calls('PATCH')).toHaveLength(2)
  })
  it('takes an edit back when the server refuses (someone else\'s To-do)', async () => {
    const before = list()
    const done = todos.edit('t1', { text: 'Hijacked' })
    expect(list()[1]!.text).toBe('Hijacked')
    await expect(done).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(list()).toEqual(before)
    await expect(todos.edit('t0', { text: '' })).rejects.toMatchObject({ status: 400 })
    await expect(todos.edit('ghost', { text: 'x' })).rejects.toMatchObject({ status: 404 })
  })
  it('removes at once, and puts it back when the server refuses', async () => {
    const gate = deferred()
    server.todoGate = gate.promise
    const done = todos.remove('t0')
    expect(texts()).toEqual(['Theirs'])
    gate.release()
    await done
    expect(texts()).toEqual(['Theirs'])
    expect(server.todos.map((t) => t.id)).toEqual(['t1'])
    const before = list()
    const refused = todos.remove('t1')
    expect(list()).toEqual([])
    await expect(refused).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(list()).toEqual(before)
    await expect(todos.remove('ghost')).rejects.toMatchObject({ status: 404 })
  })
})

describe('a Guest', () => {
  beforeEach(() => {
    server.addTodo({ owner: ME.id, text: 'Not for Guests' })
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
  })
  it('has no To-dos: nothing is loaded, frames are ignored, every call is refused without a request', async () => {
    const ws = await openLive()
    await todos.reload()
    ws.receive(server.todosFrame())
    expect(list()).toEqual([])
    const refused = { status: 403, code: 'forbidden' }
    await expect(todos.add({ owner: ME.id, text: 'x' })).rejects.toMatchObject(refused)
    await expect(todos.setDone('t0', true)).rejects.toMatchObject(refused)
    await expect(todos.edit('t0', { text: 'x' })).rejects.toMatchObject(refused)
    await expect(todos.remove('t0')).rejects.toMatchObject(refused)
    expect(server.requests.filter((r) => r.path.startsWith('/api/todos'))).toEqual([])
    // Not refetched after a reconnect either.
    ws.drop()
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
    await settle()
    expect(server.requests.filter((r) => r.path.startsWith('/api/todos'))).toEqual([])
  })
  it('forgets a Member\'s list when the session becomes a Guest\'s', async () => {
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    server.actor = ME
    await todos.reload()
    expect(list()).toHaveLength(1)
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(list()).toEqual([])
  })
})
