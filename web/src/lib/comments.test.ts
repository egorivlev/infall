// M18: Comments and For you against the fake server, through the real Board layer's socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sync } from './board-sync'
import { comments, commentsInternal, forYou, MAX_COMMENT } from './comments'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, GUEST, ME, OTHER, settle } from './testing'
import { workspaceStore } from './workspace'

let server: FakeServer
const state = () => commentsInternal.store.getState()
const thread = (card: string) => state().threads[card]
const asked = (path: string) => server.requests.filter((r) => r.method === 'GET' && r.path === path).length

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
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStore.setState({ status: 'signed_out' }, true)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME, OTHER] })
  commentsInternal.reset()
  server.now = 1000
})

afterEach(() => {
  sync.close()
  sessionStore.setState({ status: 'signed_out' }, true)
  vi.unstubAllGlobals()
})

describe('the counts for badges', () => {
  it('are one request when the Board opens, and one more per comments frame — never one per Card', async () => {
    server.addComment('c1', 'First', [], OTHER.id)
    server.addComment('c1', 'Second', [], OTHER.id)
    server.addComment('c2', 'Elsewhere', [], OTHER.id)
    const ws = await openLive()
    expect(asked('/api/comments/counts')).toBe(1)
    expect(state().counts).toEqual({ c1: { open: 2, resolved: false }, c2: { open: 1, resolved: false } })
    const c2 = state().counts.c2
    server.addComment('c1', 'Third', [], OTHER.id)
    ws.receive(server.commentsFrame('c1'))
    await settle()
    expect(asked('/api/comments/counts')).toBe(2)
    expect(state().counts.c1).toEqual({ open: 3, resolved: false })
    expect(state().counts.c2).toBe(c2) // unchanged badges keep their object: those Cards do not re-render
    expect(server.requests.some((r) => r.path.startsWith('/api/cards/'))).toBe(false)
  })

  it('a Guest never asks', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
    await openLive()
    expect(asked('/api/comments/counts')).toBe(0)
    expect(asked('/api/for-you')).toBe(0)
  })
})

describe('a thread', () => {
  it('loads when watched, and follows its frame while watched', async () => {
    const ws = await openLive()
    server.addComment('c1', 'Is the bound tight?', [], OTHER.id)
    const stop = comments.watch('c1')
    expect(thread('c1')?.status).toBe('loading')
    await settle()
    expect(thread('c1')).toMatchObject({ status: 'ready', resolved: false })
    expect(thread('c1')!.comments.map((c) => c.text)).toEqual(['Is the bound tight?'])
    const first = thread('c1')!.comments[0]
    server.addComment('c1', 'It is.', [], OTHER.id)
    ws.receive(server.commentsFrame('c1'))
    await settle()
    expect(thread('c1')!.comments.map((c) => c.text)).toEqual(['Is the bound tight?', 'It is.'])
    expect(thread('c1')!.comments[0]).toBe(first)
    stop()
    const before = server.requests.length
    ws.receive(server.commentsFrame('c1'))
    await settle()
    expect(server.requests.slice(before).filter((r) => r.path.startsWith('/api/cards/'))).toEqual([])
  })

  it('posts with the mentions, edits, resolves, reopens and deletes', async () => {
    await openLive()
    comments.watch('c1')
    await settle()
    const posted = await comments.post('c1', '  @Other look at this  ', [OTHER.id, OTHER.id])
    expect(server.requests.find((r) => r.method === 'POST' && r.path === '/api/cards/c1/comments')?.body).toEqual({ text: '@Other look at this', mentions: [OTHER.id] })
    expect(thread('c1')!.comments).toEqual([posted])
    server.now = 2000
    await comments.edit(posted.id, 'Look again', [])
    expect(thread('c1')!.comments[0]).toMatchObject({ text: 'Look again', edited_at: 2000 })
    await comments.setResolved('c1', true)
    expect(thread('c1')!.resolved).toBe(true)
    expect(server.resolved.c1).toBe(true)
    await comments.setResolved('c1', false)
    expect(thread('c1')!.resolved).toBe(false)
    await comments.remove(posted.id)
    expect(thread('c1')!.comments).toEqual([])
    await settle()
    expect(state().counts.c1).toBeUndefined()
  })

  it('a thread outlives its Card: any Card id is asked for as it is', async () => {
    await openLive()
    server.addComment('gone-card', 'Kept', [], OTHER.id)
    comments.watch('gone-card')
    await settle()
    expect(thread('gone-card')!.comments.map((c) => c.text)).toEqual(['Kept'])
  })

  it('refuses locally: empty, too long, Guests', async () => {
    await openLive()
    await expect(comments.post('c1', '   ')).rejects.toMatchObject({ status: 400 })
    await expect(comments.post('c1', 'x'.repeat(MAX_COMMENT + 1))).rejects.toMatchObject({ status: 400 })
    await expect(comments.post('c1', 'x'.repeat(MAX_COMMENT))).resolves.toBeTruthy()
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await expect(comments.post('c1', 'hi')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('passes on the server’s refusal (someone else’s Comment)', async () => {
    await openLive()
    const theirs = server.addComment('c1', 'Mine', [], OTHER.id)
    comments.watch('c1')
    await settle()
    await expect(comments.edit(theirs.id, 'Changed')).rejects.toMatchObject({ status: 403 })
    expect(thread('c1')!.comments[0]!.text).toBe('Mine')
  })

  it('in a moved Workspace every write is refused without asking', async () => {
    await openLive()
    workspaceStore.setState({ ...workspaceStore.getState(), readOnly: true }, true)
    const before = server.requests.length
    await expect(comments.post('c1', 'hi')).rejects.toMatchObject({ status: 403, code: 'moved' })
    await expect(comments.setResolved('c1', true)).rejects.toMatchObject({ code: 'moved' })
    expect(server.requests.length).toBe(before)
    workspaceStore.setState({ ...workspaceStore.getState(), readOnly: false }, true)
  })
})

describe('For you', () => {
  it('loads with the Board; a for_you frame with more brings the new mention once, for the notice', async () => {
    server.addComment('c1', 'Old @Me', [ME.id], OTHER.id)
    const ws = await openLive()
    expect(state().forYou).toMatchObject({ status: 'ready', unseen: 1 })
    const told: string[] = []
    const off = forYou.onMention((i) => told.push(i.comment))
    server.now = 5000
    const fresh = server.addComment('c2', 'New @Me', [ME.id], OTHER.id)
    ws.receive(server.forYouFrame())
    await settle()
    expect(state().forYou.items.map((i) => i.comment)).toEqual([fresh.id, state().forYou.items[1]!.comment])
    expect(state().forYou.unseen).toBe(2)
    expect(told).toEqual([fresh.id])
    off()
  })

  it('seen marks that one and every older one, at once', async () => {
    server.now = 1
    const a = server.addComment('c1', 'a', [ME.id], OTHER.id)
    server.now = 2
    const b = server.addComment('c1', 'b', [ME.id], OTHER.id)
    server.now = 3
    const c = server.addComment('c2', 'c', [ME.id], OTHER.id)
    await openLive()
    expect(state().forYou.items.map((i) => i.comment)).toEqual([c.id, b.id, a.id])
    const seeing = forYou.seen(b.id)
    expect(state().forYou.items.map((i) => i.seen)).toEqual([false, true, true])
    expect(state().forYou.unseen).toBe(1)
    await seeing
    expect(server.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/for-you/seen', body: { up_to: b.id } })
    expect(server.forYouOf().map((i) => i.seen)).toEqual([false, true, true])
  })

  it('a failed seen takes the marks back', async () => {
    server.addComment('c1', 'a', [ME.id], OTHER.id)
    await openLive()
    const id = state().forYou.items[0]!.comment
    server.commentFail = { status: 500, code: 'internal' }
    await expect(forYou.seen(id)).rejects.toMatchObject({ status: 500 })
    expect(state().forYou.unseen).toBe(1)
  })

  it('is forgotten when the session changes hands', async () => {
    server.addComment('c1', 'a', [ME.id], OTHER.id)
    await openLive()
    expect(state().forYou.unseen).toBe(1)
    sessionStore.setState({ status: 'signed_in', member: OTHER }, true)
    expect(state().forYou).toEqual({ status: 'idle', items: [], unseen: 0 })
    expect(state().counts).toEqual({})
  })
})
