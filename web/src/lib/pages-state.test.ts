import { describe, expect, it } from 'vitest'
import { replay } from './activities'
import type { Editors, Entities } from './board-state'
import { applyOps, EMPTY_PAGE, toPage, toPageIndex, toSnapshotParts } from './board-state'
import { previewAt } from './history'
import { ops } from './ops'
import { resultParses } from './run-result'
import { fakeRunResult, TINY_PNG } from './testing'
import type { Change, Op, Value } from './types'

const card = (id: string, title = id.toUpperCase()): Op => ops.createCard({ id, x: 0, y: 0, title })
const block = (id: string, cardId: string, order: string, text = id): Op => ops.addBlock({ id, card: cardId, text, order })
const NOBODY: Editors = new Map()

// Two Cards; `a` has three blocks and two Sources, one of them shared with `b`.
const BOARD: Op[] = [
  card('a'),
  card('b'),
  block('k2', 'a', 'V', 'second'),
  block('k1', 'a', 'G', 'first'),
  block('k3', 'a', 'k', 'third'),
  block('kb', 'b', 'V', 'on b'),
  ops.createSource({ id: 's1', title: 'Zeta paper', year: '1996', doi: '10.1000/zeta' }),
  ops.createSource({ id: 's2', title: 'alpha paper', year: '2019', url: 'https://example.com/alpha' }),
  ops.createSource({ id: 's3', title: 'Loose' }),
  ops.attach({ id: 'at1', card: 'a', source: 's1' }),
  ops.attach({ id: 'at2', card: 'a', source: 's2' }),
  ops.attach({ id: 'at3', card: 'b', source: 's1' }),
]
const board = (...more: Op[]): Entities => replay({}, [...BOARD, ...more])
const page = (e: Entities, id: string) => toPage(id, toSnapshotParts(e), toPageIndex(e), NOBODY)

describe('applying ops of the new kinds', () => {
  it('a block needs an existing Card, an Attachment an existing Card and Source', () => {
    const e = board()
    const bad = (op: Op) => {
      const r = applyOps(e, [op])
      return r.ok ? 'ok' : r.rejection.code
    }
    expect(bad(block('x', 'ghost', 'V'))).toBe('invalid')
    expect(bad(block('x', 's1', 'V'))).toBe('invalid')
    expect(bad(ops.attach({ id: 'x', card: 'a', source: 'b' }))).toBe('invalid')
    expect(bad(ops.attach({ id: 'x', card: 's1', source: 's1' }))).toBe('invalid')
    expect(bad(ops.attach({ id: 'x', card: 'b', source: 's2' }))).toBe('ok')
  })
  it('accepts them when what they refer to is deleted, as the core does', () => {
    const e = board(ops.remove('a'), ops.remove('s1'))
    expect(applyOps(e, [block('x', 'a', 'V'), ops.attach({ id: 'y', card: 'a', source: 's1' })]).ok).toBe(true)
  })
})

describe('toSnapshotParts with Pages and Sources', () => {
  it('counts the visible blocks and Sources of each Card and leaves the rest of the Board alone', () => {
    const p = toSnapshotParts(board())
    expect(p.cards.map((c) => [c.id, c.blocks, c.sources])).toEqual([
      ['a', 3, 2],
      ['b', 1, 1],
    ])
    expect(p.frames).toEqual([])
    expect(p.connections).toEqual([])
  })
  it('does not count deleted blocks, deleted Attachments, or Attachments of a deleted Source', () => {
    const p = toSnapshotParts(board(ops.remove('k1'), ops.remove('at2'), ops.remove('s1')))
    expect(p.cards.map((c) => [c.id, c.blocks, c.sources])).toEqual([
      ['a', 2, 0],
      ['b', 1, 0],
    ])
  })
  it('counts a Source attached twice to one Card once', () => {
    const p = toSnapshotParts(board(ops.attach({ id: 'at9', card: 'a', source: 's1' })))
    expect(p.cards[0]).toMatchObject({ id: 'a', sources: 2 })
  })
  it('keeps a Card object when a block text changes but its count does not', () => {
    const before = toSnapshotParts(board())
    const after = toSnapshotParts(board(ops.setBlockText('k1', 'rewritten')), before)
    expect(after.cards).toBe(before.cards)
    const more = toSnapshotParts(board(block('k4', 'a', 'z')), before)
    expect(more.cards[0]).not.toBe(before.cards[0])
    expect(more.cards[1]).toBe(before.cards[1])
  })
})

describe('toPageIndex', () => {
  it('orders blocks by `order`, ties by id', () => {
    const index = toPageIndex(board(block('k0', 'a', 'V', 'tie'), block('k9', 'a', 'V', 'tie')))
    expect(index.blocks.get('a')!.map((b) => b.id)).toEqual(['k1', 'k0', 'k2', 'k9', 'k3'])
    expect(index.blocks.get('a')![0]).toEqual({ id: 'k1', card: 'a', type: 'text', text: 'first', title: '', order: 'G' })
  })
  it('compares `order` as plain strings', () => {
    const index = toPageIndex(replay({}, [card('a'), block('x', 'a', 'a'), block('y', 'a', 'Z'), block('z', 'a', '9z')]))
    expect(index.blocks.get('a')!.map((b) => b.id)).toEqual(['z', 'y', 'x'])
  })
  it('reads an emptied block as an empty text', () => {
    const index = toPageIndex(board(ops.setBlockText('k1', '')))
    expect(index.blocks.get('a')![0]).toMatchObject({ id: 'k1', text: '' })
  })
  it('hides a deleted block, and every block of a deleted Card', () => {
    expect(toPageIndex(board(ops.remove('k2'))).blocks.get('a')!.map((b) => b.id)).toEqual(['k1', 'k3'])
    const gone = toPageIndex(board(ops.remove('a')))
    expect(gone.blocks.has('a')).toBe(false)
    expect(gone.blocks.get('b')).toHaveLength(1)
    const back = toPageIndex(board(ops.remove('a'), ops.restore('a')))
    expect(back.blocks.get('a')).toHaveLength(3)
  })
  it('lists every live Source by title, with the live Cards it is attached to', () => {
    const index = toPageIndex(board())
    expect(index.sources.map((s) => [s.title, s.cards])).toEqual([
      ['alpha paper', ['a']],
      ['Loose', []],
      ['Zeta paper', ['a', 'b']],
    ])
    expect(index.sources[2]).toEqual({
      id: 's1',
      url: '',
      doi: '10.1000/zeta',
      title: 'Zeta paper',
      authors: '',
      year: '1996',
      note: '',
      cards: ['a', 'b'],
    })
  })
  it('hides an Attachment when it, its Card or its Source is deleted', () => {
    const cards = (e: Entities) => toPageIndex(e).sources.find((s) => s.id === 's1')?.cards
    expect(cards(board(ops.remove('at1')))).toEqual(['b'])
    expect(cards(board(ops.remove('a')))).toEqual(['b'])
    const noSource = toPageIndex(board(ops.remove('s1')))
    expect(noSource.sources.map((s) => s.id)).toEqual(['s2', 's3'])
    expect(noSource.attached.get('a')!.map((s) => s.id)).toEqual(['s2'])
    expect(noSource.attached.has('b')).toBe(false)
    expect(cards(board(ops.remove('s1'), ops.restore('s1')))).toEqual(['a', 'b'])
  })
  it('gives each Card its Sources newest first, then by title, with the Attachment to remove', () => {
    const index = toPageIndex(
      board(
        ops.createSource({ id: 's4', title: 'Beta', year: '2019' }),
        ops.createSource({ id: 's5', title: 'Undated' }),
        ops.attach({ id: 'at4', card: 'a', source: 's4' }),
        ops.attach({ id: 'at5', card: 'a', source: 's5' }),
      ),
    )
    expect(index.attached.get('a')!.map((s) => [s.id, s.attachment])).toEqual([
      ['s2', 'at2'],
      ['s4', 'at4'],
      ['s1', 'at1'],
      ['s5', 'at5'],
    ])
  })
  it('shows a Source attached twice once, by its first Attachment', () => {
    const index = toPageIndex(board(ops.attach({ id: 'at0', card: 'a', source: 's1' })))
    expect(index.attached.get('a')!.filter((s) => s.id === 's1').map((s) => s.attachment)).toEqual(['at0'])
    expect(index.sources.find((s) => s.id === 's1')!.cards).toEqual(['a', 'b'])
  })
  it('keeps every list that did not change', () => {
    const before = toPageIndex(board())
    expect(toPageIndex(board(ops.move('a', 5, 5)[0]!), before)).toBe(before)
    const edited = toPageIndex(board(ops.setBlockText('k1', 'rewritten')), before)
    expect(edited.blocks.get('b')).toBe(before.blocks.get('b'))
    expect(edited.blocks.get('a')).not.toBe(before.blocks.get('a'))
    expect(edited.blocks.get('a')![1]).toBe(before.blocks.get('a')![1])
    expect(edited.sources).toBe(before.sources)
    expect(edited.attached).toBe(before.attached)
    const renamed = toPageIndex(board(ops.setSourceField('s2', 'title', 'Alpha, revised')), before)
    expect(renamed.blocks).toBe(before.blocks)
    expect(renamed.sources[2]).toBe(before.sources[2])
    expect(renamed.attached.get('b')).toBe(before.attached.get('b'))
    expect(renamed.attached.get('a')![0]).toMatchObject({ id: 's2', title: 'Alpha, revised' })
  })
})

describe('toPage', () => {
  it('is empty for a Card that is not live', () => {
    expect(page(board(), 'ghost')).toBe(EMPTY_PAGE)
    expect(page(board(ops.remove('a')), 'a')).toBe(EMPTY_PAGE)
    expect(EMPTY_PAGE).toEqual({ card: null, blocks: [], sources: [], connections: [], editor: null })
  })
  it('holds the Card, its blocks, its Sources and nobody editing', () => {
    const p = page(board(), 'a')
    expect(p.card).toMatchObject({ id: 'a', blocks: 3, sources: 2 })
    expect(p.blocks.map((b) => b.text)).toEqual(['first', 'second', 'third'])
    expect(p.sources.map((s) => s.title)).toEqual(['alpha paper', 'Zeta paper'])
    expect(p.connections).toEqual([])
    expect(p.editor).toBeNull()
  })
  it('lists the visible Connections of the Card with the Card at the other end', () => {
    const e = board(
      card('c'),
      ops.createConnection({ id: 'c1', from: 'a', to: 'b', kind: 'directed', label: 'leads to' }),
      ops.createConnection({ id: 'c2', from: 'c', to: 'a', kind: 'directed' }),
      ops.createConnection({ id: 'c3', from: 'b', to: 'a' }),
      ops.createConnection({ id: 'c4', from: 'a', to: 'c', kind: 'contradicts' }),
      ops.createConnection({ id: 'c5', from: 'b', to: 'c' }),
    )
    expect(page(e, 'a').connections.map((c) => [c.id, c.other.id, c.direction, c.kind, c.label])).toEqual([
      ['c1', 'b', 'out', 'directed', 'leads to'],
      ['c2', 'c', 'in', 'directed', ''],
      ['c3', 'b', 'none', 'related', ''],
      ['c4', 'c', 'none', 'contradicts', ''],
    ])
    expect(page(replay(e, [ops.remove('b')]), 'a').connections.map((c) => c.id)).toEqual(['c2', 'c4'])
  })
  it('shows who else holds the Page', () => {
    const e = board()
    const editors: Editors = new Map([['a', { member: null, memberId: 'other', since: 5 }]])
    const p = toPage('a', toSnapshotParts(e), toPageIndex(e), editors)
    expect(p.editor).toEqual({ member: null, memberId: 'other', since: 5 })
    expect(toPage('b', toSnapshotParts(e), toPageIndex(e), editors).editor).toBeNull()
  })
  it('comes back as the same object until something in it changes', () => {
    const e0 = board(card('c'), ops.createConnection({ id: 'c1', from: 'a', to: 'b' }))
    const parts0 = toSnapshotParts(e0)
    const index0 = toPageIndex(e0)
    const p0 = toPage('a', parts0, index0, NOBODY)
    const step = (e: Entities, prev = p0) => toPage('a', toSnapshotParts(e, parts0), toPageIndex(e, index0), NOBODY, prev)
    // An unrelated Card moves, another Page is edited, a loose Source is renamed: not this Page's business.
    expect(step(replay(e0, ops.move('c', 50, 50)))).toBe(p0)
    expect(step(replay(e0, [ops.setBlockText('kb', 'other page')]))).toBe(p0)
    expect(step(replay(e0, [ops.setSourceField('s3', 'title', 'Still loose')]))).toBe(p0)
    // Its own block changes: a new Page, with everything else in it kept.
    const edited = step(replay(e0, [ops.setBlockText('k2', 'rewritten')]))
    expect(edited).not.toBe(p0)
    expect(edited.card).toBe(p0.card)
    expect(edited.sources).toBe(p0.sources)
    expect(edited.connections).toBe(p0.connections)
    expect(edited.blocks[0]).toBe(p0.blocks[0])
    // A connected Card moves: the Connection entry changes, the blocks do not.
    const moved = step(replay(e0, ops.move('b', 9, 9)))
    expect(moved).not.toBe(p0)
    expect(moved.blocks).toBe(p0.blocks)
    expect(moved.connections[0]!.other).toMatchObject({ id: 'b', x: 9 })
  })
})

describe('History preview on a Board with Pages and Sources', () => {
  it('replays the new kinds and shows the Board as before, with the counts of that moment', () => {
    const changes: Change[] = [...BOARD, ops.remove('k1'), ops.remove('s2')].map((op, i) => ({
      id: `c${i}`,
      author: 'me',
      at: i,
      op,
      origin: 'Edit',
    }))
    const full = previewAt({}, changes, BOARD.length)
    expect(Object.keys(full).sort()).toEqual(['at', 'cards', 'connections', 'frames', 'seq'])
    expect(full.cards.map((c) => [c.id, c.blocks, c.sources])).toEqual([
      ['a', 3, 2],
      ['b', 1, 1],
    ])
    expect(previewAt({}, changes, 3).cards.map((c) => [c.id, c.blocks, c.sources])).toEqual([
      ['a', 1, 0],
      ['b', 0, 0],
    ])
    const end = previewAt({}, changes, changes.length, full)
    expect(end.cards.map((c) => [c.id, c.blocks, c.sources])).toEqual([
      ['a', 2, 1],
      ['b', 1, 1],
    ])
    expect(end.cards[1]).toBe(full.cards[1])
  })
})

describe('Visuals (M6)', () => {
  const visual = (id: string, cardId: string, order: string, title?: string): Op =>
    ops.addBlock({ id, card: cardId, type: 'visual', text: `<p>${id}</p>`, title, order })
  // A block of Card `b` as another build might write it: with any `type`, or none.
  const typed = (id: string, type?: Value): Op => ({
    Create: { entity: id, kind: 'Block', fields: { card: { Ref: 'b' }, order: { Text: 'W' }, text: { Text: id }, ...(type ? { type } : {}) } },
  })

  it('reads a Visual with its source and title, a text block with an empty title', () => {
    const e = board(visual('v1', 'a', 'H', 'Decoder demo'), ops.setBlockTitle('k2', 'stray'))
    const list = toPageIndex(e).blocks.get('a')!
    expect(list.map((b) => [b.id, b.type])).toEqual([
      ['k1', 'text'],
      ['v1', 'visual'],
      ['k2', 'text'],
      ['k3', 'text'],
    ])
    expect(list[1]).toEqual({ id: 'v1', card: 'a', type: 'visual', text: '<p>v1</p>', title: 'Decoder demo', order: 'H' })
    expect(list[2]).toMatchObject({ id: 'k2', title: '' }) // a caption belongs to a Visual only
  })
  it('reads a Visual without a title as an empty title, and follows a title edit', () => {
    const e = board(visual('v1', 'a', 'H'))
    const before = toPageIndex(e)
    expect(before.blocks.get('a')![1]).toMatchObject({ type: 'visual', title: '' })
    const after = toPageIndex(replay(e, [ops.setBlockTitle('v1', 'Named')]), before)
    expect(after.blocks.get('a')![1]).toMatchObject({ type: 'visual', title: 'Named' })
    expect(after.blocks.get('a')![0]).toBe(before.blocks.get('a')![0])
    expect(after.blocks.get('b')).toBe(before.blocks.get('b'))
  })
  it('reads an unset type, and a type that is not a text, as a text block', () => {
    const e = board(typed('u1'), typed('u2', { Float: 1 }), typed('u3', { Text: 'text' }))
    expect(toPageIndex(e).blocks.get('b')!.map((b) => [b.id, b.type, b.title])).toEqual([
      ['kb', 'text', ''],
      ['u1', 'text', ''],
      ['u2', 'text', ''],
      ['u3', 'text', ''],
    ])
  })
  it('counts text blocks and Visuals alike', () => {
    const e = board(visual('v1', 'a', 'H'), visual('v2', 'b', 'H'), ops.remove('v2'))
    expect(toSnapshotParts(e).cards.map((c) => [c.id, c.blocks])).toEqual([
      ['a', 4],
      ['b', 1],
    ])
    expect(page(e, 'a').blocks).toHaveLength(4)
  })
  it('keeps a block of a kind it does not know in the store, but neither shows nor counts it', () => {
    const e = board(typed('r1', { Text: 'sheet' }))
    expect(e.r1).toEqual({ kind: 'Block', deleted: false, fields: { card: { Ref: 'b' }, order: { Text: 'W' }, text: { Text: 'r1' }, type: { Text: 'sheet' } } })
    expect(toPageIndex(e).blocks.get('b')!.map((b) => b.id)).toEqual(['kb'])
    expect(toSnapshotParts(e).cards.find((c) => c.id === 'b')!.blocks).toBe(1)
    // …and it can still be edited and removed like any entity
    expect(applyOps(e, [ops.setBlockText('r1', 'x'), ops.remove('r1')]).ok).toBe(true)
  })
})

describe('Blocks pinned from an AI Conversation (M7)', () => {
  const pin = (id: string, order: string): Op => ops.pinBlock({ id, card: 'a', text: 'answer', order, model: 'claude-sonnet-4-5', pinnedBy: 'me', pinnedAt: 1234 })
  const blockOf = (e: Entities, id: string) => page(e, 'a').blocks.find((b) => b.id === id)!
  const setField = (entity: string, field: string, value: Value): Op => ({ Set: { entity, field, value } })

  it('reads the AI fields into BlockVM.ai; an ordinary block has none', () => {
    const e = board(pin('p1', 'z'))
    expect(blockOf(e, 'p1')).toEqual({
      id: 'p1',
      card: 'a',
      type: 'text',
      text: 'answer',
      title: '',
      order: 'z',
      ai: { model: 'claude-sonnet-4-5', pinnedBy: 'me', pinnedAt: 1234 },
    })
    expect('ai' in blockOf(e, 'k1')).toBe(false)
    expect(toSnapshotParts(e).cards.find((c) => c.id === 'a')!.blocks).toBe(4)
  })
  it('is reviewed once a Member put their id on it, and not after the mark is taken back', () => {
    const reviewed = board(pin('p1', 'z'), ops.markReviewed('p1', 'other'))
    expect(blockOf(reviewed, 'p1').ai).toEqual({ model: 'claude-sonnet-4-5', pinnedBy: 'me', pinnedAt: 1234, reviewedBy: 'other' })
    const back = board(pin('p1', 'z'), ops.markReviewed('p1', 'other'), ops.markReviewed('p1', ''))
    expect(blockOf(back, 'p1').ai).toEqual({ model: 'claude-sonnet-4-5', pinnedBy: 'me', pinnedAt: 1234 })
  })
  it('is AI-generated only for as long as ai_pinned_by is set; missing pieces read as empty', () => {
    const cleared = board(pin('p1', 'z'), ops.markReviewed('p1', 'other'), setField('p1', 'ai_pinned_by', 'Null'))
    expect('ai' in blockOf(cleared, 'p1')).toBe(false)
    const bare = board(block('p2', 'a', 'z'), setField('p2', 'ai_pinned_by', { Text: 'me' }))
    expect(blockOf(bare, 'p2').ai).toEqual({ model: '', pinnedBy: 'me', pinnedAt: 0 })
    const odd = board(block('p3', 'a', 'z'), setField('p3', 'ai_pinned_by', { Float: 3 }), setField('p3', 'ai_reviewed_by', { Text: 'other' }))
    expect('ai' in blockOf(odd, 'p3')).toBe(false)
  })
  it('keeps the block and the list when nothing about it changed, and replaces only it when it is reviewed', () => {
    const e = board(pin('p1', 'z'))
    const first = toPageIndex(e)
    const moved = replay(e, ops.move('b', 9, 9))
    const second = toPageIndex(moved, first)
    expect(second).toBe(first)
    const third = toPageIndex(replay(moved, [ops.markReviewed('p1', 'other')]), second)
    expect(third.blocks.get('a')).not.toBe(second.blocks.get('a'))
    expect(third.blocks.get('a')![0]).toBe(second.blocks.get('a')![0])
    expect(third.blocks.get('a')!.at(-1)).not.toBe(second.blocks.get('a')!.at(-1))
    expect(third.blocks.get('b')).toBe(second.blocks.get('b'))
    expect(third.sources).toBe(second.sources)
  })
})

describe('Runs (M8)', () => {
  const runBlock = (id: string, cardId: string, order: string, title?: string, text = 'print(1)'): Op =>
    ops.addBlock({ id, card: cardId, type: 'run', text, title, order })
  const result = fakeRunResult('print(1)', { output: '1\n', figures: [{ png: TINY_PNG }] })
  const blocksOf = (e: Entities, id = 'a') => toPageIndex(e).blocks.get(id) ?? []
  const only = (e: Entities, id: string) => blocksOf(e).find((b) => b.id === id)!

  it('reads a Run: its code, its name, and no result yet', () => {
    expect(only(board(runBlock('r1', 'a', 'z', 'Threshold sweep')), 'r1')).toEqual({
      id: 'r1',
      card: 'a',
      type: 'run',
      text: 'print(1)',
      title: 'Threshold sweep',
      order: 'z',
      run: { result: null, broken: false },
    })
    expect(only(board(runBlock('r1', 'a', 'z')), 'r1').title).toBe('')
  })
  it('gives `run` to Runs only, and keeps a title for Visuals and Runs but not for text', () => {
    const e = board(runBlock('r1', 'a', 'z', 'R'), ops.addBlock({ id: 'v1', card: 'a', type: 'visual', text: 'x', title: 'V', order: 'zz' }), ops.setBlockTitle('k1', 'stray'))
    expect(only(e, 'r1').run).toBeDefined()
    expect(only(e, 'v1')).toMatchObject({ type: 'visual', title: 'V' })
    expect('run' in only(e, 'v1')).toBe(false)
    expect(only(e, 'k1')).toMatchObject({ type: 'text', title: '' })
    expect('run' in only(e, 'k1')).toBe(false)
  })
  it('reads a recorded result, and a cleared one as none', () => {
    const e = board(runBlock('r1', 'a', 'z'), ops.setRunResult('r1', result))
    expect(only(e, 'r1').run).toEqual({ result, broken: false })
    expect(only(replay(e, [ops.setRunResult('r1', null)]), 'r1').run).toEqual({ result: null, broken: false })
  })
  it.each([
    ['text that is not JSON', { Text: 'Traceback (most recent call last)' }],
    ['another version', { Text: JSON.stringify({ ...result, v: 2 }) }],
    ['a result with an unknown key', { Text: JSON.stringify({ ...result, html: '<b>' }) }],
    ['a figure that is not a PNG', { Text: JSON.stringify({ ...result, figures: [{ png: 'PHN2Zz4=' }] }) }],
    ['a number', { Float: 1 }],
  ] as [string, Value][])('shows %s as broken, never throwing', (_what, value) => {
    const e = board(runBlock('r1', 'a', 'z'), { Set: { entity: 'r1', field: 'result', value } })
    expect(only(e, 'r1').run).toEqual({ result: null, broken: true })
  })
  it('counts Runs among the blocks of a Card, on the Board and at an earlier moment', () => {
    const e = board(runBlock('r1', 'a', 'z'), runBlock('r2', 'a', 'zz'))
    expect(toSnapshotParts(e).cards.find((c) => c.id === 'a')!.blocks).toBe(5)
    expect(toSnapshotParts(replay(e, [ops.remove('r2')])).cards.find((c) => c.id === 'a')!.blocks).toBe(4)
  })
  it('orders a Run among the other blocks by its order key', () => {
    expect(blocksOf(board(runBlock('r1', 'a', 'H'))).map((b) => b.id)).toEqual(['k1', 'r1', 'k2', 'k3'])
  })
  it('keeps a Run, its `run` and its result the same objects while something else changes', () => {
    const e1 = board(runBlock('r1', 'a', 'z'), ops.setRunResult('r1', { ...result, output: 'identity '.repeat(2000) }))
    const i1 = toPageIndex(e1)
    const before = i1.blocks.get('a')!.find((b) => b.id === 'r1')!
    const parses = resultParses()
    // Another Card moves, another block of the same Page is typed in, a Source is renamed: three passes.
    const e2 = replay(e1, ops.move('b', 9, 9))
    const i2 = toPageIndex(e2, i1)
    const e3 = replay(e2, [ops.setBlockText('k1', 'typing')])
    const i3 = toPageIndex(e3, i2)
    const i4 = toPageIndex(replay(e3, [ops.setSourceField('s1', 'title', 'Renamed')]), i3)
    expect(i2.blocks).toBe(i1.blocks)
    const after = i4.blocks.get('a')!.find((b) => b.id === 'r1')!
    expect(after).toBe(before)
    expect(after.run!.result).toBe(before.run!.result)
    expect(resultParses()).toBe(parses) // the stored JSON was not read again
  })
  it('does not parse again when the same result arrives in new objects, as a refetched Board brings it', () => {
    const e1 = board(runBlock('r1', 'a', 'z'), ops.setRunResult('r1', { ...result, output: 'refetch '.repeat(2000) }))
    const i1 = toPageIndex(e1)
    const parses = resultParses()
    const copy = JSON.parse(JSON.stringify(e1)) as Entities
    const i2 = toPageIndex(copy, i1)
    expect(resultParses()).toBe(parses)
    expect(i2).toBe(i1)
  })
  it('gives a new Run object when its result, its code or its name changes', () => {
    const e1 = board(runBlock('r1', 'a', 'z', 'R'), ops.setRunResult('r1', result))
    const i1 = toPageIndex(e1)
    const first = i1.blocks.get('a')!.find((b) => b.id === 'r1')!
    const next = (op: Op) => toPageIndex(replay(e1, [op]), i1).blocks.get('a')!.find((b) => b.id === 'r1')!
    expect(next(ops.setRunResult('r1', { ...result, at: 5 }))).not.toBe(first)
    expect(next(ops.setRunResult('r1', null)).run).toEqual({ result: null, broken: false })
    expect(next(ops.setBlockText('r1', 'print(2)'))).toMatchObject({ text: 'print(2)', run: { result } })
    expect(next(ops.setBlockTitle('r1', 'Renamed')).title).toBe('Renamed')
    expect(next(ops.setBlockText('k1', 'x'))).toBe(first)
  })
  it('shows a Run in the Page of its Card and in a preview of History', () => {
    const e = board(runBlock('r1', 'a', 'z', 'R'))
    expect(page(e, 'a').blocks.at(-1)).toMatchObject({ id: 'r1', type: 'run' })
    expect(page(e, 'a').card!.blocks).toBe(4)
  })
})
