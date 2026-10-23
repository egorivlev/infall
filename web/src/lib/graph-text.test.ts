import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupActivities } from './activities'
import { activityKey } from './graph-layout'
import { createGraphText } from './graph-text'
import { ops } from './ops'
import { sessionStore } from './session-store'
import { FakeServer, ME, OTHER } from './testing'
import type { Op } from './types'

const MIN = 60_000
let server: FakeServer
const card = (id: string, title: string): Op => ops.createCard({ id, x: 0, y: 0, title })
const gets = () => server.requests.filter((r) => r.method === 'GET').map((r) => r.path)

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
})
afterEach(() => vi.unstubAllGlobals())

/** main: 4 Activities by turns; `idea` forked at 2 with 2 of its own; main then merges idea. */
function seed() {
  server.now = 0
  server.commit([card('a', 'A'), card('b', 'B')], ME.id)
  server.now = 1 * MIN
  server.commit([ops.setText('a', 'title', 'A2')], OTHER.id)
  server.fork('idea', { branch: 'main-id', seq: 3 })
  server.now = 20 * MIN
  server.commit([card('c', 'C')], ME.id)
  server.now = 40 * MIN
  server.commit([ops.setStatus('b', 'reading')], OTHER.id)
  server.commit([card('i', 'Idea card')], ME.id, 'idea')
  server.now = 60 * MIN
  server.commit([ops.setText('i', 'title', 'Idea card 2')], OTHER.id, 'idea')
  server.commit([card('i', 'Idea card 2')], ME.id, 'main-id', { Merge: { batch: 'm1', source: { branch: 'idea-id', seq: 2 } } })
}

describe('the lazy text loader', () => {
  it('reads one Board and one range of Changes per Branch, and says what History says', async () => {
    seed()
    const graph = server.graph()
    const main = graph.branches[0]!
    const text = createGraphText()
    await text.need(graph, [
      { branch: 'main-id', index: 1 },
      { branch: 'main-id', index: 3 },
      { branch: 'idea-id', index: 0 },
    ])
    expect(gets()).toEqual([
      '/api/branches/main-id/board?at=2',
      '/api/branches/main-id/changes?after=2&before=5',
      '/api/branches/idea-id/board?at=0',
      '/api/branches/idea-id/changes?after=0&before=1',
    ])
    const history = groupActivities(server.log, [], {})
    for (const i of [1, 2, 3]) {
      expect(text.lines(activityKey('main-id', main.activities[i]!))).toEqual(history[i]!.lines)
    }
    expect(text.lines(activityKey('main-id', main.activities[0]!))).toBeUndefined()
    expect(text.lines(activityKey('idea-id', graph.branches[1]!.activities[0]!))).toEqual(['Added Card Idea card'])
  })
  it('keeps what it worked out, and goes on from there without another Board', async () => {
    seed()
    const graph = server.graph()
    const text = createGraphText()
    await text.need(graph, [{ branch: 'main-id', index: 1 }])
    const sent = server.requests.length
    await text.need(graph, [{ branch: 'main-id', index: 1 }])
    expect(server.requests.length).toBe(sent)
    await text.need(graph, [{ branch: 'main-id', index: 3 }])
    expect(gets().slice(-1)).toEqual(['/api/branches/main-id/changes?after=3&before=5'])
    // Further back than what is known: a Board again, at that moment.
    await text.need(graph, [{ branch: 'main-id', index: 0 }])
    expect(gets().slice(-2)).toEqual(['/api/branches/main-id/board?at=0', '/api/branches/main-id/changes?after=0&before=2'])
    expect(text.lines(activityKey('main-id', graph.branches[0]!.activities[0]!))).toEqual(['Added Card A', 'Added Card B'])
  })
  it('names both Branches of a Merge, then what it brought', async () => {
    seed()
    const graph = server.graph()
    const main = graph.branches[0]!
    const merge = main.activities.findIndex((a) => a.kind === 'merge')
    const text = createGraphText()
    await text.need(graph, [{ branch: 'main-id', index: merge }])
    expect(text.lines(activityKey('main-id', main.activities[merge]!))).toEqual(['Merged idea into main', 'Added Card Idea card 2'])
  })
  it('notifies once per batch, and leaves rows without words when loading fails, to try again later', async () => {
    seed()
    const graph = server.graph()
    const text = createGraphText()
    const seen = vi.fn()
    text.store.subscribe(seen)
    server.failChanges = true
    await expect(text.need(graph, [{ branch: 'main-id', index: 0 }])).resolves.toBeUndefined()
    expect(text.lines(activityKey('main-id', graph.branches[0]!.activities[0]!))).toBeUndefined()
    expect(seen).not.toHaveBeenCalled()
    server.failChanges = false
    await text.need(graph, [
      { branch: 'main-id', index: 0 },
      { branch: 'main-id', index: 1 },
    ])
    expect(seen).toHaveBeenCalledTimes(1)
    expect(text.lines(activityKey('main-id', graph.branches[0]!.activities[1]!))).toEqual(['Renamed Card A → A2'])
  })
  it('asks once for rows already on their way, and forgets everything on clear()', async () => {
    seed()
    const graph = server.graph()
    const text = createGraphText()
    await Promise.all([text.need(graph, [{ branch: 'main-id', index: 2 }]), text.need(graph, [{ branch: 'main-id', index: 2 }])])
    expect(gets()).toHaveLength(2)
    text.clear()
    expect(text.lines(activityKey('main-id', graph.branches[0]!.activities[2]!))).toBeUndefined()
  })
  it('drops an answer that arrives after clear()', async () => {
    seed()
    const graph = server.graph()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const text = createGraphText({
      request: async <T,>(method: string, path: string) => {
        await gate
        return (await (await server.fetch(path, { method })).json()) as T
      },
    })
    const p = text.need(graph, [{ branch: 'main-id', index: 0 }])
    text.clear()
    release()
    await p
    expect(text.store.getState().lines.size).toBe(0)
  })
  it('lists every Change of an Activity in plain words', async () => {
    seed()
    const graph = server.graph()
    const text = createGraphText()
    const lines = await text.changesOf(graph.branches[0]!, graph.branches[0]!.activities[0]!)
    expect(lines.map((l) => [l.author, l.at, l.line])).toEqual([
      [ME.id, 0, 'Added Card A'],
      [ME.id, 0, 'Added Card B'],
    ])
    expect(lines[0]!.id).toBe(server.log[0]!.id)
  })
  it('stays quick on a long log: rows in view of a 20 000-Change Branch', async () => {
    const list: Op[] = [card('x', 'X')]
    for (let i = 0; i < 19_999; i++) list.push(ops.setText('x', 'title', `T${i}`))
    for (let i = 0; i < list.length; i += 200) {
      server.now = (i / 200) * 11 * MIN // a new Activity every 200 Changes
      server.commit(list.slice(i, i + 200), i % 400 === 0 ? ME.id : OTHER.id)
    }
    const graph = server.graph()
    const main = graph.branches[0]!
    expect(main.activities).toHaveLength(100)
    const text = createGraphText()
    const t0 = performance.now()
    await text.need(
      graph,
      Array.from({ length: 30 }, (_, k) => ({ branch: 'main-id', index: 60 + k })),
    )
    const ms = performance.now() - t0
    process.stderr.write(`graph text: 30 rows (6 000 Changes) of a 20 000-Change Branch: ${ms.toFixed(1)} ms\n`)
    expect(text.lines(activityKey('main-id', main.activities[75]!))).toEqual(['Renamed Card T14998 → T15198'])
    expect(ms).toBeLessThan(2000)
  })
})
