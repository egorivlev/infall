import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncEvent } from './board-sync'
import { createBoardSync } from './board-sync'
import { ApiError } from './http'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import type { SuggestionWorld } from './suggestions'
import { createSuggestions, sourceMeta, toSuggestionVMs } from './suggestions'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle } from './testing'
import type { CardVM, Op, SourceVM, Suggestion } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>
let suggestions: ReturnType<typeof createSuggestions>

const items = () => suggestions.internal.store.getState().items
const item = (id: string) => items().find((vm) => vm.suggestion.id === id)!
const states = () => items().map((vm) => `${vm.suggestion.id}:${vm.suggestion.state}`)
const snap = () => sync.store.getState().snapshot
const calls = (method: string) => server.requests.filter((r) => r.method === method && r.path.startsWith('/api/suggestions'))
const card = (id: string, title?: string): Op => ops.createCard({ id, x: 0, y: 0, title })

const WANG = {
  url: 'https://arxiv.org/abs/2007.14384',
  title: 'Topological quantum memory',
  authors: 'Wang, Fowler, Hollenberg',
  year: '2021',
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

async function openLive(name?: string) {
  await sync.open(name)
  const ws = FakeSocket.last()
  ws.open()
  const b = server.find(name)
  ws.receive({ type: 'subscribed', branch: b.info.id, seq: b.log.length })
  await settle()
  return ws
}

async function reconnect(ws: FakeSocket) {
  ws.drop()
  timers.fireNext()
  const next = FakeSocket.last()
  next.open()
  next.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
  await settle()
  return next
}

beforeEach(() => {
  server = new FakeServer()
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [] })
  server.now = 100
  server.commit([card('a', 'Threshold'), card('b', 'Decoder'), card('c')], OTHER.id)
  sync = createBoardSync({
    WebSocketCtor: FakeSocket,
    setTimer: timers.set,
    clearTimer: timers.clear,
    socketUrl: () => 'ws://test/api/ws',
  })
  suggestions = createSuggestions(sync)
})

afterEach(() => {
  sync.close()
  suggestions.internal.dispose()
  vi.unstubAllGlobals()
})

// ---- pure: wording ----

const cardVM = (id: string, title: string): CardVM => ({ id, title, summary: '', status: 'idea', x: 0, y: 0, w: 224, h: 132, blocks: 0, sources: 0 })
const sourceVM = (id: string, fields: Partial<SourceVM>): SourceVM => ({ id, url: '', doi: '', title: '', authors: '', year: '', note: '', cards: [], ...fields })
const world = (over: Partial<SuggestionWorld> = {}): SuggestionWorld => ({
  cards: [cardVM('a', 'Threshold'), cardVM('b', 'Decoder'), cardVM('c', '')],
  sources: [],
  branchName: 'main',
  ...over,
})
let made = 0
const forSource = (cardId: string, source: NonNullable<Suggestion['source']>, over: Partial<Suggestion> = {}): Suggestion => ({
  id: `x${made++}`,
  branch: 'main-id',
  kind: 'source',
  card: cardId,
  source,
  reason: 'Because.',
  created_by: OTHER.id,
  created_at: 1,
  state: 'pending',
  ...over,
})
const forConnection = (connection: NonNullable<Suggestion['connection']>, over: Partial<Suggestion> = {}): Suggestion => ({
  id: `x${made++}`,
  branch: 'main-id',
  kind: 'connection',
  connection,
  reason: 'Because.',
  created_by: OTHER.id,
  created_at: 1,
  state: 'pending',
  ...over,
})
const one = (s: Suggestion, w = world()) => toSuggestionVMs([s], w)[0]!

describe('the meta line of a suggested Source', () => {
  it('reads authors · year · identifier', () => {
    expect(sourceMeta(WANG)).toBe('Wang et al. · 2021 · arXiv:2007.14384')
  })
  it('shortens three or more authors to the first one, and keeps one or two', () => {
    expect(sourceMeta({ authors: 'David S. Wang, Austin G. Fowler , Lloyd Hollenberg, Someone Else' })).toBe('David S. Wang et al.')
    expect(sourceMeta({ authors: ' Kitaev ,Preskill ' })).toBe('Kitaev, Preskill')
    expect(sourceMeta({ authors: 'Shor' })).toBe('Shor')
    expect(sourceMeta({ authors: 'Shor,, ' })).toBe('Shor')
  })
  it('names an arxiv.org address by its arXiv id', () => {
    expect(sourceMeta({ url: 'https://arxiv.org/pdf/2007.14384v2.pdf' })).toBe('arXiv:2007.14384v2')
    expect(sourceMeta({ url: 'http://www.arxiv.org/abs/quant-ph/9512032/' })).toBe('arXiv:quant-ph/9512032')
    expect(sourceMeta({ url: 'https://arxiv.org/abs/2007.14384#section', doi: '10.1103/PhysRevA.52.R2493' })).toBe('arXiv:2007.14384')
    // Not a paper's address: where it lives.
    expect(sourceMeta({ url: 'https://arxiv.org/list/quant-ph/new' })).toBe('arxiv.org')
  })
  it('names a DOI as doi:…, also when it is a doi.org address', () => {
    expect(sourceMeta({ doi: '10.1103/PhysRevA.52.R2493', year: '1995' })).toBe('1995 · doi:10.1103/physreva.52.r2493')
    expect(sourceMeta({ doi: 'doi: 10.1038/nature14270', url: 'https://www.nature.com/articles/nature14270' })).toBe('doi:10.1038/nature14270')
    expect(sourceMeta({ url: 'https://doi.org/10.1038/nature14270' })).toBe('doi:10.1038/nature14270')
  })
  it('falls back to the host of the address', () => {
    expect(sourceMeta({ url: 'https://www.quantamagazine.org/some-story-20210101/', authors: 'A, B' })).toBe('A, B · quantamagazine.org')
    expect(sourceMeta({ url: 'https://errorcorrectionzoo.org/c/surface' })).toBe('errorcorrectionzoo.org')
  })
  it('leaves out what is missing', () => {
    expect(sourceMeta({ authors: 'A, B, C', url: 'https://example.org/x' })).toBe('A et al. · example.org')
    expect(sourceMeta({ year: ' 2020 ' })).toBe('2020')
    expect(sourceMeta({ title: 'Only a title', url: 'not an address', doi: 'not a doi' })).toBe('')
  })
})

describe('a Suggestion ready to show', () => {
  it('a Source: its title, the meta line, and the Card it is for', () => {
    expect(one(forSource('a', WANG))).toMatchObject({
      title: 'Topological quantum memory',
      meta: 'Wang et al. · 2021 · arXiv:2007.14384',
      target: 'for Card: Threshold',
      cards: ['a'],
      stale: false,
    })
    expect(one(forSource('c', { url: 'https://example.org/x', title: '  ' }))).toMatchObject({
      title: 'Untitled Source',
      meta: 'example.org',
      target: 'for Card: Untitled',
    })
  })
  it('a Connection: the two Cards with an arrow only when directed, the label or the kind word, and the Branch', () => {
    expect(one(forConnection({ from: 'a', to: 'b', kind: 'directed', label: 'bounds' }))).toMatchObject({
      title: 'Threshold → Decoder',
      meta: 'bounds',
      target: 'Board: main',
      cards: ['a', 'b'],
      stale: false,
    })
    expect(one(forConnection({ from: 'b', to: 'c', kind: 'related' }))).toMatchObject({ title: 'Decoder — Untitled', meta: 'related' })
    expect(one(forConnection({ from: 'a', to: 'b', kind: 'contradicts', label: ' ' }))).toMatchObject({ title: 'Threshold — Decoder', meta: 'contradicts' })
    expect(one(forConnection({ from: 'a', to: 'b', kind: 'directed' }), world({ branchName: 'try-QEC' }))).toMatchObject({
      meta: 'directed',
      target: 'Board: try-QEC',
    })
  })
  it('is stale when a Card it needs is not live, and lists only the live ones', () => {
    expect(one(forSource('gone', WANG))).toMatchObject({ target: 'for Card: Removed Card', cards: [], stale: true })
    expect(one(forConnection({ from: 'a', to: 'gone', kind: 'directed' }))).toMatchObject({ title: 'Threshold → Removed Card', cards: ['a'], stale: true })
    expect(one(forConnection({ from: 'gone', to: 'gone too', kind: 'related' }))).toMatchObject({ cards: [], stale: true })
  })
  it('points at the Source the Branch already has: same DOI, however it is written', () => {
    const sources = [sourceVM('s1', { doi: '10.1103/PhysRevA.52.R2493', title: 'Scheme for reducing decoherence' })]
    expect(one(forSource('a', { doi: 'https://doi.org/10.1103/physreva.52.r2493' }), world({ sources })).existingSource).toBe('s1')
    expect(one(forSource('a', { url: 'https://dx.doi.org/10.1103/PhysRevA.52.R2493' }), world({ sources })).existingSource).toBe('s1')
    expect(one(forSource('a', { doi: '10.1103/other' }), world({ sources }))).not.toHaveProperty('existingSource')
  })
  it('points at the Source the Branch already has: same address', () => {
    const sources = [sourceVM('s2', { url: 'https://arxiv.org/abs/2007.14384/' })]
    expect(one(forSource('a', { url: 'HTTPS://ArXiv.org/abs/2007.14384#abstract' }), world({ sources })).existingSource).toBe('s2')
    expect(one(forSource('a', { url: 'https://arxiv.org/abs/2007.14385' }), world({ sources }))).not.toHaveProperty('existingSource')
    // Decided: a rejected one would still attach it when reopened; an accepted one has nothing left to attach.
    expect(one(forSource('a', WANG, { state: 'rejected', decided_at: 2 }), world({ sources })).existingSource).toBe('s2')
    expect(one(forSource('a', WANG, { state: 'accepted', decided_at: 2 }), world({ sources }))).not.toHaveProperty('existingSource')
    expect(one(forConnection({ from: 'a', to: 'b', kind: 'related' }), world({ sources }))).not.toHaveProperty('existingSource')
  })
  it('lists pending ones first, newest first, then decided ones, the latest decision first', () => {
    const list = [
      forSource('a', WANG, { id: 'old', created_at: 10 }),
      forSource('a', WANG, { id: 'rejected-early', created_at: 50, state: 'rejected', decided_at: 60 }),
      forSource('a', WANG, { id: 'new', created_at: 30 }),
      forSource('a', WANG, { id: 'accepted-late', created_at: 5, state: 'accepted', decided_at: 90 }),
      forSource('a', WANG, { id: 'mid', created_at: 20 }),
      forSource('a', WANG, { id: 'mid-twin', created_at: 20 }),
    ]
    expect(toSuggestionVMs(list, world()).map((vm) => vm.suggestion.id)).toEqual(['new', 'mid-twin', 'mid', 'old', 'accepted-late', 'rejected-early'])
  })
  it('keeps the items and the array that read the same', () => {
    const list = [forSource('a', WANG, { created_at: 2 }), forConnection({ from: 'b', to: 'c', kind: 'related' })]
    const first = toSuggestionVMs(list, world())
    // The same list sent again (new objects), and Cards that moved.
    const again = toSuggestionVMs(list.map((s) => ({ ...s })), world({ cards: world().cards.map((c) => ({ ...c, x: 9 })) }), first)
    expect(again).toBe(first)
    const retitled = toSuggestionVMs(list, world({ cards: [cardVM('a', 'Threshold ≈ 1%'), cardVM('b', 'Decoder'), cardVM('c', '')] }), first)
    expect(retitled).not.toBe(first)
    expect(retitled[0]!.target).toBe('for Card: Threshold ≈ 1%')
    expect(retitled[1]).toBe(first[1])
  })
})

// ---- the store ----

describe('loading', () => {
  it('is empty until a Member opens the Board, then holds that Branch\'s Suggestions', async () => {
    const s = server.suggest({ card: 'a', source: WANG, reason: 'It gives the threshold.', model: 'claude' }, OTHER.id)
    expect(items()).toEqual([])
    await sync.open()
    await settle()
    expect(calls('GET').map((r) => r.path)).toEqual(['/api/suggestions?branch=main-id'])
    expect(items()).toEqual([
      {
        suggestion: s,
        title: 'Topological quantum memory',
        meta: 'Wang et al. · 2021 · arXiv:2007.14384',
        target: 'for Card: Threshold',
        cards: ['a'],
        stale: false,
      },
    ])
    expect(s).toMatchObject({ branch: 'main-id', kind: 'source', created_by: OTHER.id, model: 'claude', state: 'pending' })
  })
  it('does not fail the Board when the list cannot be loaded; reload then rejects', async () => {
    const inner = server.fetch
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      path.startsWith('/api/suggestions') ? Promise.reject(new Error('down')) : inner(path, init),
    )
    await openLive()
    expect(snap().status).toBe('live')
    expect(items()).toEqual([])
    await expect(suggestions.reload()).rejects.toMatchObject({ status: 0, code: 'network' })
  })
  it('reload needs an open Board', async () => {
    await expect(suggestions.reload()).rejects.toMatchObject({ status: 400, code: 'board_not_open' })
    expect(calls('GET')).toEqual([])
  })
  it('keeps the array when a reload brings nothing new', async () => {
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } })
    await openLive()
    const before = items()
    await suggestions.reload()
    expect(items()).toBe(before)
    server.suggest({ card: 'b', source: { doi: '10.1038/nature14270' } })
    await suggestions.reload()
    expect(items()).toHaveLength(3)
    expect(items()[1]).toBe(before[0])
    expect(items()[2]).toBe(before[1])
  })
  it('is refetched after the socket reconnects, not on the first subscription', async () => {
    const ws = await openLive()
    expect(calls('GET')).toHaveLength(1)
    server.suggest({ card: 'a', source: WANG })
    await reconnect(ws)
    expect(calls('GET')).toHaveLength(2)
    expect(states()).toEqual(['s3:pending'])
  })
  it('is forgotten when the session ends', async () => {
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    expect(items()).toHaveLength(1)
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(items()).toEqual([])
  })
})

describe('following the Board', () => {
  it('keeps the array when an unrelated Card moves, and only re-reads what a new title touches', async () => {
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'b', to: 'c', kind: 'directed' } })
    const ws = await openLive()
    const before = items()
    expect(before.map((vm) => vm.title)).toEqual(['Decoder → Untitled', 'Topological quantum memory'])
    await sync.submit(ops.move('c', 40, 50))
    ws.receive(server.external(ops.move('a', 7, 7)))
    ws.receive(server.external([card('d', 'Unrelated')]))
    expect(snap().cards).toHaveLength(4)
    expect(items()).toBe(before)
    ws.receive(server.external([ops.setText('c', 'title', 'Lattice surgery')]))
    expect(items()).not.toBe(before)
    expect(items()[0]!.title).toBe('Decoder → Lattice surgery')
    expect(items()[1]).toBe(before[1])
  })
  it('shows a title typed here at once', async () => {
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    const gate = deferred()
    server.gate = gate.promise
    const done = sync.submit([ops.setText('a', 'title', 'Threshold ≈ 1%')])
    expect(items()[0]!.target).toBe('for Card: Threshold ≈ 1%')
    gate.release()
    await done
  })
  it('turns stale when a Card it needs is removed, and back when the Card returns', async () => {
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } })
    const ws = await openLive()
    expect(items().map((vm) => vm.stale)).toEqual([false, false])
    ws.receive(server.external([ops.remove('a')]))
    expect(items().map((vm) => [vm.stale, vm.cards])).toEqual([
      [true, ['b']],
      [true, []],
    ])
    expect(items()[0]!.title).toBe('Removed Card — Decoder')
    await expect(suggestions.accept('s3')).rejects.toMatchObject({ status: 400, code: 'stale' })
    expect(calls('POST')).toEqual([])
    ws.receive(server.external([ops.restore('a')]))
    expect(items().map((vm) => vm.stale)).toEqual([false, false])
  })
  it('finds the Source the Branch already has, by DOI and by address, as Sources come and go', async () => {
    server.suggest({ card: 'a', source: { doi: 'https://doi.org/10.1103/PhysRevA.52.R2493', title: 'Shor 95' } })
    server.suggest({ card: 'b', source: WANG })
    const ws = await openLive()
    expect(items().map((vm) => vm.existingSource)).toEqual([undefined, undefined])
    const before = items()
    ws.receive(server.external([ops.createSource({ id: 'src-doi', doi: '10.1103/physreva.52.r2493' })]))
    expect(item('s3').existingSource).toBe('src-doi')
    expect(item('s4')).toBe(before[0])
    // One made here and not yet confirmed counts too.
    const gate = deferred()
    server.gate = gate.promise
    const done = sync.submit([ops.createSource({ id: 'src-url', url: 'https://arxiv.org/abs/2007.14384/' })])
    expect(item('s4').existingSource).toBe('src-url')
    gate.release()
    await done
    ws.receive(server.external([ops.remove('src-doi')]))
    expect(item('s3')).not.toHaveProperty('existingSource')
  })
  it('never puts a suggested Connection on the Board', async () => {
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } })
    await openLive()
    expect(items()).toHaveLength(1)
    expect(snap().connections).toEqual([])
  })
})

describe('the suggestions frame', () => {
  it('replaces the list with what the server says', async () => {
    const ws = await openLive()
    server.suggest({ card: 'a', source: WANG })
    ws.receive(server.suggestionsFrame())
    expect(states()).toEqual(['s3:pending'])
    const before = items()
    ws.receive(server.suggestionsFrame())
    expect(items()).toBe(before)
    server.suggestions = []
    ws.receive(server.suggestionsFrame())
    expect(items()).toEqual([])
  })
  it('is ignored when it speaks about another Branch', async () => {
    const tryIt = server.fork('try', { branch: 'main-id', seq: server.seq })
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } }, OTHER.id, 'try')
    const ws = await openLive()
    expect(states()).toEqual(['s3:pending'])
    const before = items()
    ws.receive(server.suggestionsFrame(tryIt.info.id))
    expect(items()).toBe(before)
    ws.receive({ type: 'suggestions', branch: 'main', suggestions: [] }) // the open Branch, by name
    expect(items()).toEqual([])
  })
})

describe('switching Branch', () => {
  it('clears the list at once and loads the other Branch\'s', async () => {
    server.fork('try', { branch: 'main-id', seq: server.seq })
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'directed' } }, OTHER.id, 'try')
    await openLive()
    expect(states()).toEqual(['s3:pending'])
    const opening = sync.open('try')
    expect(items()).toEqual([])
    await opening
    await settle()
    expect(items().map((vm) => [vm.suggestion.id, vm.target])).toEqual([['s4', 'Board: try']])
    sync.close()
    expect(items()).toEqual([])
  })
  it('drops an answer that arrives after the switch', async () => {
    server.fork('try', { branch: 'main-id', seq: server.seq })
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    const gate = deferred()
    server.suggestionGate = gate.promise
    const done = suggestions.reject('s3')
    await openLive('try')
    gate.release()
    await done
    expect(items()).toEqual([])
    expect(server.suggestions[0]!.state).toBe('rejected')
  })
})

describe('accept', () => {
  it('a new Source: posts the Source and its Attachment, and says which', async () => {
    server.suggest({ card: 'a', source: { ...WANG, doi: ' 10.1103/PhysRevA.86.032324 ' } })
    await openLive()
    const result = await suggestions.accept('s3')
    const posts = calls('POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.path).toBe('/api/suggestions/s3/accept')
    const sent = (posts[0]!.body as { ops: Op[] }).ops
    expect(sent).toEqual([
      {
        Create: {
          entity: result.sourceId,
          kind: 'Source',
          fields: {
            url: { Text: 'https://arxiv.org/abs/2007.14384' },
            doi: { Text: '10.1103/PhysRevA.86.032324' },
            title: { Text: 'Topological quantum memory' },
            authors: { Text: 'Wang, Fowler, Hollenberg' },
            year: { Text: '2021' },
          },
        },
      },
      { Create: { entity: expect.any(String), kind: 'Attachment', fields: { card: { Ref: 'a' }, source: { Ref: result.sourceId } } } },
    ])
    expect(result).toEqual({ sourceId: expect.stringMatching(/^[0-9a-f-]{36}$/), cardId: 'a' })
    // On the Board from the answer alone, without the socket.
    expect(sync.sources().map((s) => [s.id, s.cards])).toEqual([[result.sourceId, ['a']]])
    expect(snap().cards.find((c) => c.id === 'a')!.sources).toBe(1)
    expect(states()).toEqual(['s3:accepted'])
    expect(item('s3')).not.toHaveProperty('existingSource')
  })
  it('an existing Source: posts only the Attachment', async () => {
    server.commit([ops.createSource({ id: 'known', url: 'https://arxiv.org/abs/2007.14384' }), ops.attach({ id: 'att', card: 'b', source: 'known' })], OTHER.id)
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    expect(item('s5').existingSource).toBe('known')
    const result = await suggestions.accept('s5')
    expect((calls('POST')[0]!.body as { ops: Op[] }).ops).toEqual([
      { Create: { entity: expect.any(String), kind: 'Attachment', fields: { card: { Ref: 'a' }, source: { Ref: 'known' } } } },
    ])
    expect(result).toEqual({ sourceId: 'known', cardId: 'a' })
    expect(sync.sources().map((s) => [s.id, s.cards])).toEqual([['known', ['a', 'b']]])
  })
  it('a Connection: posts the Connection as suggested', async () => {
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'directed', label: ' bounds ' } })
    server.suggest({ connection: { from: 'b', to: 'c', kind: 'related' } })
    await openLive()
    const result = await suggestions.accept('s3')
    expect((calls('POST')[0]!.body as { ops: Op[] }).ops).toEqual([
      {
        Create: {
          entity: expect.any(String),
          kind: 'Connection',
          fields: { from: { Ref: 'a' }, to: { Ref: 'b' }, kind: { Text: 'directed' }, label: { Text: 'bounds' } },
        },
      },
    ])
    expect(result).toEqual({ cardId: 'a' })
    expect(snap().connections).toMatchObject([{ from: 'a', to: 'b', kind: 'directed', label: 'bounds' }])
    await suggestions.accept('s4')
    expect((calls('POST')[1]!.body as { ops: Op[] }).ops).toEqual([
      { Create: { entity: expect.any(String), kind: 'Connection', fields: { from: { Ref: 'b' }, to: { Ref: 'c' }, kind: { Text: 'related' } } } },
    ])
    expect(snap().connections).toHaveLength(2)
  })
  it('shows it accepted at once, then as the server recorded it', async () => {
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } })
    await openLive()
    const other = item('s4')
    const gate = deferred()
    server.suggestionGate = gate.promise
    server.now = 900
    const done = suggestions.accept('s3')
    expect(states()).toEqual(['s4:pending', 's3:accepted'])
    expect(item('s3').suggestion).toMatchObject({ decided_by: ME.id })
    expect(typeof item('s3').suggestion.decided_at).toBe('number')
    expect(item('s4')).toBe(other)
    expect(sync.sources()).toEqual([])
    gate.release()
    await done
    expect(item('s3').suggestion).toMatchObject({ state: 'accepted', decided_by: ME.id, decided_at: 900 })
    expect(item('s4')).toBe(other)
    expect(server.suggestions[0]!.state).toBe('accepted')
  })
  it('hands the Changes to the Board once, whether the socket repeats them after the answer…', async () => {
    server.suggest({ card: 'a', source: WANG })
    const ws = await openLive()
    const seen: SyncEvent[] = []
    sync.internal.listen((e) => seen.push(e))
    await suggestions.accept('s3')
    expect(snap().seq).toBe(5)
    ws.receive(server.lastPostFrame!)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'changes', seq: 5 })
    expect((seen[0] as { changes: unknown[] }).changes).toHaveLength(2)
    expect(snap().seq).toBe(5)
    expect(sync.sources()).toHaveLength(1)
    expect(snap().pending).toBe(0)
  })
  it('…or before it', async () => {
    server.suggest({ card: 'a', source: WANG })
    const ws = await openLive()
    const seen: SyncEvent[] = []
    sync.internal.listen((e) => seen.push(e))
    const inner = server.fetch
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const res = await inner(path, init)
      if (path.endsWith('/accept')) {
        ws.receive(server.lastPostFrame!)
        ws.receive(server.suggestionsFrame())
        expect(sync.sources()).toHaveLength(1)
      }
      return res
    })
    await suggestions.accept('s3')
    expect(seen).toHaveLength(1)
    expect(snap().seq).toBe(5)
    expect(sync.sources()).toHaveLength(1)
    expect(states()).toEqual(['s3:accepted'])
  })
  it('takes it back when someone decided first, and fetches what is true now', async () => {
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    // Another Member rejected it; the frame has not reached us.
    server.suggestions[0] = { ...server.suggestions[0]!, state: 'rejected', decided_by: OTHER.id, decided_at: 150 }
    const done = suggestions.accept('s3')
    expect(states()).toEqual(['s3:accepted'])
    const error = await done.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'already_decided' })
    await settle()
    expect(item('s3').suggestion).toMatchObject({ state: 'rejected', decided_by: OTHER.id })
    expect(sync.sources()).toEqual([])
    expect(server.seq).toBe(3)
  })
  it('takes it back on a scripted already_decided and on rejected', async () => {
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    const before = items()
    for (const code of ['already_decided', 'rejected']) {
      server.suggestionFail = { status: 409, code }
      const done = suggestions.accept('s3')
      expect(states()).toEqual(['s3:accepted'])
      await expect(done).rejects.toMatchObject({ status: 409, code })
      await settle()
      expect(items()).toEqual(before)
    }
    expect(sync.sources()).toEqual([])
  })
  it('takes it back when the core refuses the ops: the Source to attach has not reached the server', async () => {
    server.suggest({ card: 'a', source: WANG })
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } })
    await openLive()
    const gate = deferred()
    server.gate = gate.promise
    const typed = sync.submit([ops.createSource({ id: 'mine', url: WANG.url })])
    const before = items()
    expect(item('s3').existingSource).toBe('mine')
    const done = suggestions.accept('s3')
    expect(states()).toEqual(['s4:pending', 's3:accepted'])
    await expect(done).rejects.toMatchObject({ status: 409, code: 'rejected' })
    expect(items()).toEqual(before)
    expect(items()[0]).toBe(before[0])
    expect(server.suggestions[0]!.state).toBe('pending')
    expect(server.seq).toBe(3)
    gate.release()
    await typed
  })
  it('takes it back on a network failure', async () => {
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    const before = items()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    const done = suggestions.accept('s3')
    expect(states()).toEqual(['s3:accepted'])
    await expect(done).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(items()).toEqual(before)
  })
  it('refuses without a request: an unknown id, one already decided, no open Board', async () => {
    server.suggest({ card: 'a', source: WANG })
    await openLive()
    await suggestions.reject('s3')
    await expect(suggestions.accept('s3')).rejects.toMatchObject({ status: 409, code: 'already_decided' })
    await expect(suggestions.accept('ghost')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(calls('POST')).toHaveLength(1)
    sync.close()
    await expect(suggestions.accept('s3')).rejects.toMatchObject({ status: 400, code: 'board_not_open' })
    expect(calls('POST')).toHaveLength(1)
  })
  it('keeps a decision still on its way when a frame arrives from before it', async () => {
    server.suggest({ card: 'a', source: WANG })
    const ws = await openLive()
    const gate = deferred()
    server.suggestionGate = gate.promise
    const done = suggestions.accept('s3')
    ws.receive(server.suggestionsFrame())
    expect(states()).toEqual(['s3:accepted'])
    gate.release()
    await done
    expect(states()).toEqual(['s3:accepted'])
  })
})

describe('reject and reopen', () => {
  beforeEach(async () => {
    server.suggest({ card: 'a', source: WANG })
    server.now = 200
    server.suggest({ connection: { from: 'a', to: 'b', kind: 'related' } })
    await openLive()
  })
  it('rejects at once, moves it below the pending ones, and reopens it', async () => {
    expect(states()).toEqual(['s4:pending', 's3:pending'])
    const gate = deferred()
    server.suggestionGate = gate.promise
    server.now = 900
    const done = suggestions.reject('s4')
    expect(states()).toEqual(['s3:pending', 's4:rejected'])
    gate.release()
    await done
    expect(item('s4').suggestion).toMatchObject({ state: 'rejected', decided_by: ME.id, decided_at: 900 })
    expect(calls('POST')[0]).toEqual({ method: 'POST', path: '/api/suggestions/s4/reject', body: undefined })
    expect(server.seq).toBe(3)

    const gate2 = deferred()
    server.suggestionGate = gate2.promise
    const undone = suggestions.reopen('s4')
    expect(states()).toEqual(['s4:pending', 's3:pending'])
    expect(item('s4').suggestion).not.toHaveProperty('decided_by')
    gate2.release()
    await undone
    expect(calls('POST')[1]).toEqual({ method: 'POST', path: '/api/suggestions/s4/reopen', body: undefined })
    expect(item('s4').suggestion).toEqual(server.suggestions[1])
    expect(server.suggestions[1]).not.toHaveProperty('decided_at')
  })
  it('takes a reject back when the server refuses', async () => {
    const before = items()
    server.suggestionFail = { status: 409, code: 'already_decided' }
    const done = suggestions.reject('s3')
    expect(states()).toEqual(['s4:pending', 's3:rejected'])
    await expect(done).rejects.toMatchObject({ status: 409, code: 'already_decided' })
    await settle()
    expect(items()).toEqual(before)
    expect(items()[0]).toBe(before[0])
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    await expect(suggestions.reject('s3')).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(items()).toEqual(before)
  })
  it('takes a reopen back when the server refuses', async () => {
    await suggestions.reject('s3')
    const before = items()
    server.suggestionFail = { status: 500, code: 'internal' }
    const done = suggestions.reopen('s3')
    expect(states()).toEqual(['s4:pending', 's3:pending'])
    await expect(done).rejects.toMatchObject({ status: 500, code: 'internal' })
    expect(items()).toEqual(before)
    expect(items()[0]).toBe(before[0])
  })
  it('refuses without a request what cannot be: reopening a pending or accepted one, rejecting a decided one', async () => {
    await suggestions.accept('s4')
    await suggestions.reject('s3')
    const sent = calls('POST').length
    const decided = { status: 409, code: 'already_decided' }
    await expect(suggestions.reopen('s4')).rejects.toMatchObject(decided)
    await expect(suggestions.reject('s4')).rejects.toMatchObject(decided)
    await expect(suggestions.reject('s3')).rejects.toMatchObject(decided)
    await expect(suggestions.reject('ghost')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(suggestions.reopen('ghost')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(calls('POST')).toHaveLength(sent)
  })
  it('lets a rejected Suggestion whose Card is gone be reopened, not accepted', async () => {
    await suggestions.reject('s3')
    FakeSocket.last().receive(server.external([ops.remove('a')]))
    expect(item('s3').stale).toBe(true)
    await suggestions.reopen('s3')
    await expect(suggestions.accept('s3')).rejects.toMatchObject({ status: 400, code: 'stale' })
  })
})

describe('a Guest', () => {
  beforeEach(() => {
    server.suggest({ card: 'a', source: WANG })
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
  })
  it('has no Suggestions: nothing is loaded, frames are ignored, every call is refused without a request', async () => {
    const ws = await openLive()
    ws.receive(server.suggestionsFrame())
    expect(items()).toEqual([])
    const refused = { status: 403, code: 'forbidden' }
    await expect(suggestions.reload()).rejects.toMatchObject(refused)
    await expect(suggestions.accept('s3')).rejects.toMatchObject(refused)
    await expect(suggestions.reject('s3')).rejects.toMatchObject(refused)
    await expect(suggestions.reopen('s3')).rejects.toMatchObject(refused)
    await reconnect(ws)
    expect(server.requests.filter((r) => r.path.startsWith('/api/suggestions'))).toEqual([])
    expect(items()).toEqual([])
  })
  it('forgets a Member\'s list when the session becomes a Guest\'s', async () => {
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    server.actor = ME
    await openLive()
    expect(items()).toHaveLength(1)
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(items()).toEqual([])
  })
})

describe('the fake server', () => {
  it('lists pending Suggestions and those decided in the last 7 days, newest first', async () => {
    server.suggest({ card: 'a', source: WANG })
    server.now = 200
    server.suggest({ card: 'b', source: WANG })
    server.suggestions[0] = { ...server.suggestions[0]!, state: 'rejected', decided_by: ME.id, decided_at: 300 }
    expect(server.suggestionsOf().map((s) => s.id)).toEqual(['s4', 's3'])
    server.now = 300 + 7 * 24 * 60 * 60 * 1000
    expect(server.suggestionsOf().map((s) => s.id)).toEqual(['s4'])
  })
  it('refuses an accept without 1 to 20 ops, and an unknown Branch', async () => {
    server.suggest({ card: 'a', source: WANG })
    const post = (ops_: Op[]) => server.fetch('/api/suggestions/s3/accept', { method: 'POST', body: JSON.stringify({ ops: ops_ }) })
    expect((await post([])).status).toBe(400)
    expect((await post(Array.from({ length: 21 }, (_, i) => card(`n${i}`)))).status).toBe(400)
    expect((await server.fetch('/api/suggestions?branch=nowhere')).status).toBe(404)
    expect(server.suggestions[0]!.state).toBe('pending')
  })
})
