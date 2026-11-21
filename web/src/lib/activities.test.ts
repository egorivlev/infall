import { describe, expect, it } from 'vitest'
import { describeChanges, groupActivities, groupShapes, replay } from './activities'
import type { Entities } from './board-state'
import { pdfOps } from './files'
import { ops } from './ops'
import { fakeRunResult, loadActivityFixture } from './testing'
import type { Change, Checkpoint, Op, Origin } from './types'

const MIN = 60_000
let n = 0

function ch(op: Op, at = 0, author = 'me', origin: Origin = 'Edit'): Change {
  return { id: `c${n++}`, author, at, op, origin }
}
const many = (list: Op[], at = 0, author = 'me', origin: Origin = 'Edit') => list.map((op) => ch(op, at, author, origin))
const cp = (name: string, seq: number): Checkpoint => ({ name, moment: { branch: 'b', seq }, author: 'me', at: 0 })
const card = (id: string, title?: string) => ops.createCard({ id, x: 0, y: 0, title })
const lines = (changes: Change[], base: Entities = {}) => groupActivities(changes, [], base).map((a) => a.lines)
const boardOf = (list: Op[]) => replay({}, list)

describe('replay', () => {
  it('applies ops in order and skips one that cannot apply', () => {
    const out = replay({}, [card('a', 'A'), ops.remove('ghost'), ops.setText('a', 'title', 'B')])
    expect(out.a?.fields.title).toEqual({ Text: 'B' })
  })
  it('returns the same map for no ops', () => {
    const base = boardOf([card('a')])
    expect(replay(base, [])).toBe(base)
  })
})

describe('groupActivities: grouping', () => {
  it('returns nothing for no Changes', () => {
    expect(groupActivities([], [cp('start', 0)], {})).toEqual([])
  })
  it('joins consecutive Edits of one author into one Activity', () => {
    const changes = [ch(card('a'), 1000), ch(card('b'), 2000), ch(card('c'), 3000)]
    const [a, ...rest] = groupActivities(changes, [], {})
    expect(rest).toEqual([])
    expect(a).toMatchObject({
      id: changes[0]!.id,
      author: 'me',
      kind: 'edit',
      fromSeq: 0,
      toSeq: 3,
      startedAt: 1000,
      endedAt: 3000,
      count: 3,
    })
  })
  it('splits when the author changes, even back and forth', () => {
    const changes = [ch(card('a'), 0, 'me'), ch(card('b'), 0, 'other'), ch(card('c'), 0, 'me')]
    const out = groupActivities(changes, [], {})
    expect(out.map((a) => [a.author, a.fromSeq, a.toSeq])).toEqual([
      ['me', 0, 1],
      ['other', 1, 2],
      ['me', 2, 3],
    ])
  })
  it('splits on a pause of more than 10 minutes between neighbours, not from the start', () => {
    const changes = [
      ch(card('a'), 0),
      ch(card('b'), 9 * MIN),
      ch(card('c'), 18 * MIN), // 18 min after the first, 9 after its neighbour: same Activity
      ch(card('d'), 28 * MIN), // exactly 10 minutes: still the same
      ch(card('e'), 38 * MIN + 1), // over 10 minutes: a new one
    ]
    const out = groupActivities(changes, [], {})
    expect(out.map((a) => a.count)).toEqual([4, 1])
    expect(out[1]).toMatchObject({ fromSeq: 4, toSeq: 5, startedAt: 38 * MIN + 1 })
  })
  it('honours a custom gap', () => {
    const changes = [ch(card('a'), 0), ch(card('b'), 2000)]
    expect(groupActivities(changes, [], {}, { gapMs: 1000 })).toHaveLength(2)
  })
  it('makes a Restore batch its own Activity, whoever its neighbours are', () => {
    const restore: Origin = { Restore: { batch: 'r1', to_seq: 1 } }
    const changes = [
      ch(card('a', 'A'), 0),
      ch(card('b', 'B'), 0),
      ...many([ops.remove('b')], 0, 'me', restore),
      ch(card('c'), 0),
    ]
    const out = groupActivities(changes, [], {})
    expect(out.map((a) => [a.kind, a.fromSeq, a.toSeq])).toEqual([
      ['edit', 0, 2],
      ['restore', 2, 3],
      ['edit', 3, 4],
    ])
    expect(out[1]!.lines).toEqual(['Restored to an earlier moment'])
  })
  it('keeps two Restore batches apart and a batch together across a long pause', () => {
    const r1: Origin = { Restore: { batch: 'r1', to_seq: 0 } }
    const r2: Origin = { Restore: { batch: 'r2', to_seq: 2 } }
    const changes = [
      ch(card('a'), 0),
      ch(card('b'), 0),
      ch(ops.remove('a'), 0, 'me', r1),
      ch(ops.remove('b'), 60 * MIN, 'me', r1),
      ch(ops.restore('a'), 60 * MIN, 'me', r2),
      ch(ops.restore('b'), 60 * MIN, 'me', r2),
    ]
    expect(groupActivities(changes, [], {}).map((a) => [a.kind, a.count])).toEqual([
      ['edit', 2],
      ['restore', 2],
      ['restore', 2],
    ])
  })
  it('makes a Merge batch its own Activity', () => {
    const merge: Origin = { Merge: { batch: 'm1', source: { branch: 'x', seq: 4 } } }
    const out = groupActivities([ch(card('a')), ...many([card('b'), card('c')], 0, 'me', merge)], [], {})
    expect(out.map((a) => a.kind)).toEqual(['edit', 'merge'])
    expect(out[1]!.lines).toEqual(['Merged from another Branch'])
  })
  it('ends an Activity at every Checkpoint inside it and attaches each Checkpoint to the Activity it ends', () => {
    const changes = [ch(card('a', 'A'), 0, 'me'), ch(card('b', 'B'), 0, 'me'), ch(card('c', 'C'), 0, 'other')]
    const all = [cp('zero', 0), cp('two', 2), cp('one', 1), cp('three', 3), cp('also two', 2)]
    const out = groupActivities(changes, all, {})
    expect(out.map((a) => [a.author, a.fromSeq, a.toSeq, a.lines])).toEqual([
      ['me', 0, 1, ['Added Card A']],
      ['me', 1, 2, ['Added Card B']],
      ['other', 2, 3, ['Added Card C']],
    ])
    expect(out.map((a) => a.checkpoints.map((c) => c.name))).toEqual([['one'], ['also two', 'two'], ['three']])
  })
  it('splits a Merge or Restore batch at a Checkpoint too, each part keeping its kind', () => {
    const merge: Origin = { Merge: { batch: 'm1', source: { branch: 'x', seq: 4 } } }
    const out = groupActivities(many([card('a'), card('b'), card('c')], 0, 'me', merge), [cp('mid', 1)], {})
    expect(out.map((a) => [a.kind, a.fromSeq, a.toSeq, a.count])).toEqual([
      ['merge', 0, 1, 1],
      ['merge', 1, 3, 2],
    ])
  })
  it('starts a new Activity after a Checkpoint at the head of a tail', () => {
    const base = boardOf([card('a', 'A')])
    const out = groupActivities([ch(ops.setText('a', 'title', 'B')), ch(ops.setText('a', 'title', 'C'))], [cp('x', 6)], base, {
      startSeq: 5,
    })
    expect(out.map((a) => [a.fromSeq, a.toSeq, a.lines])).toEqual([
      [5, 6, ['Renamed Card A → B']],
      [6, 7, ['Renamed Card B → C']],
    ])
  })
  it('numbers moments from startSeq when given the tail of a log', () => {
    const base = boardOf([card('a', 'A')])
    const out = groupActivities([ch(ops.setText('a', 'title', 'B'))], [cp('x', 6)], base, { startSeq: 5 })
    expect(out[0]).toMatchObject({ fromSeq: 5, toSeq: 6, lines: ['Renamed Card A → B'] })
    expect(out[0]!.checkpoints).toHaveLength(1)
  })
  it('gives the same Activities for a whole log as for a head plus a regrouped tail', () => {
    const changes = [
      ch(card('a', 'A'), 0, 'me'),
      ch(card('b', 'B'), 0, 'other'),
      ch(ops.setText('a', 'title', 'A2'), 0, 'other'),
      ch(ops.setStatus('a', 'reading'), 0, 'other'),
    ]
    const whole = groupActivities(changes, [], {})
    const mid = replay({}, [changes[0]!.op])
    const tail = groupActivities(changes.slice(1), [], mid, { startSeq: 1 })
    expect(tail).toEqual(whole.slice(1))
  })
})

describe('groupActivities: lines', () => {
  it('names an added Card by the title it has by the end of the Activity', () => {
    expect(lines([ch(card('a')), ch(ops.setText('a', 'title', 'Surface code basics'))])).toEqual([
      ['Added Card Surface code basics'],
    ])
  })
  it('reads an untitled entity as Untitled', () => {
    expect(lines([ch(card('a')), ch(ops.createFrame({ id: 'f', x: 0, y: 0, w: 10, h: 10 }))])).toEqual([
      ['Added Card Untitled', 'Added Frame Untitled'],
    ])
  })
  it('says Added Frame with its title', () => {
    expect(lines([ch(ops.createFrame({ id: 'f', x: 0, y: 0, w: 10, h: 10, title: 'Decoders' }))])).toEqual([
      ['Added Frame Decoders'],
    ])
  })
  it('names a removed Card by the title it had when removed', () => {
    const changes = [
      ch(card('a', 'Old'), 0, 'other'),
      ch(ops.setText('a', 'title', 'New'), 0, 'me'),
      ch(ops.remove('a'), 0, 'other'),
      ch(ops.restore('a'), 0, 'me'),
    ]
    expect(lines(changes)).toEqual([
      ['Added Card Old'],
      ['Renamed Card Old → New'],
      ['Removed Card New'],
      ['Brought back Card New'],
    ])
  })
  it('uses the titles of that moment, not the latest ones', () => {
    const changes = [
      ch(card('a', 'First'), 0, 'me'),
      ch(ops.setStatus('a', 'understood'), 0, 'other'),
      ch(ops.setText('a', 'title', 'Second'), 0, 'me'),
    ]
    expect(lines(changes)[1]).toEqual(['Status: First → Understood'])
  })
  it('words every Status', () => {
    const base = boardOf([card('a', 'T')])
    const word = (s: Parameters<typeof ops.setStatus>[1]) => lines([ch(ops.setStatus('a', s))], base)[0]![0]
    expect(word('reading')).toBe('Status: T → Reading')
    expect(word('understood')).toBe('Status: T → Understood')
    expect(word('open_question')).toBe('Status: T → Open question')
    expect(word('dead_end')).toBe('Status: T → Dead end')
    const read = boardOf([card('a', 'T'), ops.setStatus('a', 'reading')])
    expect(lines([ch(ops.setStatus('a', 'idea'))], read)[0]).toEqual(['Status: T → Idea'])
  })
  it('treats an unset Status as Idea, so setting Idea on a new Card is no change', () => {
    const base = boardOf([card('a', 'T')])
    expect(lines([ch(ops.setStatus('a', 'idea'))], base)).toEqual([['No lasting changes']])
  })
  it('reports only the net rename and the last Status', () => {
    const base = boardOf([card('a', 'A')])
    const changes = [
      ch(ops.setText('a', 'title', 'B')),
      ch(ops.setText('a', 'title', 'C')),
      ch(ops.setStatus('a', 'reading')),
      ch(ops.setStatus('a', 'dead_end')),
    ]
    expect(lines(changes, base)).toEqual([['Renamed Card A → C', 'Status: C → Dead end']])
  })
  it('reads clearing a title as a rename to Untitled, and renames Frames too', () => {
    const base = boardOf([card('a', 'A'), ops.createFrame({ id: 'f', x: 0, y: 0, w: 1, h: 1 })])
    expect(lines([ch(ops.setText('a', 'title', '')), ch(ops.setText('f', 'title', 'Zone'))], base)).toEqual([
      ['Renamed Card A → Untitled', 'Renamed Frame Untitled → Zone'],
    ])
  })
  it('collapses layout-only edits into one Moved line', () => {
    const base = boardOf([card('a'), card('b'), card('c')])
    const changes = many([...ops.move('a', 1, 1), ...ops.move('b', 2, 2), ...ops.move('c', 3, 3), ...ops.move('a', 9, 9)])
    expect(lines(changes, base)).toEqual([['Moved 3 Cards']])
  })
  it('says Resized, or Moved and resized, and counts kinds apart', () => {
    const base = boardOf([card('a'), ops.createFrame({ id: 'f', x: 0, y: 0, w: 10, h: 10 })])
    expect(lines(many(ops.resize('f', 20, 20)), base)).toEqual([['Resized 1 Frame']])
    expect(lines(many([...ops.resize('f', 20, 20), ...ops.move('a', 5, 5)]), base)).toEqual([
      ['Moved and resized 1 Card and 1 Frame'],
    ])
  })
  it('does not count a move of something that already has its own line, or a move back to where it was', () => {
    const base = boardOf([card('a', 'A'), card('b', 'B')])
    const changes = many([
      ops.setText('a', 'title', 'A2'),
      ...ops.move('a', 5, 5),
      ...ops.move('b', 7, 7),
      ...ops.move('b', 0, 0),
    ])
    expect(lines(changes, base)).toEqual([['Renamed Card A → A2']])
    expect(lines(many([card('n', 'N'), ...ops.move('n', 4, 4)]), base)).toEqual([['Added Card N']])
  })
  it('says Connected A → B by the Cards titles, and Disconnected / Reconnected', () => {
    const base = boardOf([card('a', 'A'), card('b', 'B')])
    const link = ops.createConnection({ id: 'k', from: 'a', to: 'b' })
    expect(lines([ch(link)], base)).toEqual([['Connected A → B']])
    const linked = replay(base, [link])
    expect(lines([ch(ops.remove('k'))], linked)).toEqual([['Disconnected A → B']])
    expect(lines([ch(ops.restore('k'))], replay(linked, [ops.remove('k')]))).toEqual([['Reconnected A → B']])
  })
  it('words Connection labels and kinds', () => {
    const base = boardOf([card('a', 'A'), card('b', 'B'), ops.createConnection({ id: 'k', from: 'a', to: 'b' })])
    expect(lines([ch(ops.setText('k', 'label', 'refutes')), ch(ops.setKind('k', 'contradicts'))], base)).toEqual([
      ['Labelled A → B: refutes', 'Marked A → B as contradicts'],
    ])
    const labelled = replay(base, [ops.setText('k', 'label', 'x')])
    expect(lines([ch(ops.setText('k', 'label', ''))], labelled)).toEqual([['Removed the label of A → B']])
  })
  it('mentions a summary edit', () => {
    const base = boardOf([card('a', 'A')])
    expect(lines([ch(ops.setText('a', 'summary', 'text'))], base)).toEqual([['Edited the summary of A']])
  })
  it('says Added and removed for something that did not survive the Activity', () => {
    expect(lines([ch(card('a', 'A')), ch(ops.remove('a'))])).toEqual([['Added and removed Card A']])
  })
  it('says nothing lasting when a removal is undone within the Activity', () => {
    const base = boardOf([card('a', 'A')])
    expect(lines([ch(ops.remove('a')), ch(ops.restore('a'))], base)).toEqual([['No lasting changes']])
  })
  it('keeps at most 6 lines; the last becomes "and N more"', () => {
    const six = 'abcdef'.split('').map((id) => ch(card(id, id.toUpperCase())))
    expect(lines(six)[0]).toHaveLength(6)
    expect(lines(six)[0]![5]).toBe('Added Card F')
    const eight = 'abcdefgh'.split('').map((id) => ch(card(id, id.toUpperCase())))
    const out = lines(eight)[0]!
    expect(out).toHaveLength(6)
    expect(out.slice(0, 5)).toEqual(['A', 'B', 'C', 'D', 'E'].map((t) => `Added Card ${t}`))
    expect(out[5]).toBe('and 3 more')
  })
  it('lists lines in the order things were first touched, the layout line last', () => {
    const base = boardOf([card('a', 'A'), card('b', 'B')])
    const changes = many([...ops.move('b', 1, 1), card('c', 'C'), ops.setStatus('a', 'reading')])
    expect(lines(changes, base)).toEqual([['Added Card C', 'Status: A → Reading', 'Moved 1 Card']])
  })
})

describe('describeChanges', () => {
  it('ignores Changes about entities that do not exist afterwards', () => {
    expect(describeChanges({}, {}, [ch(ops.remove('ghost'))])).toEqual(['No lasting changes'])
  })
})

describe('describeChanges: Pages and Sources', () => {
  const block = (id: string, cardId: string, order: string, text = id) => ops.addBlock({ id, card: cardId, text, order })
  // Card "Threshold" with two blocks and a Source; Card "Decoder" with nothing.
  const base = boardOf([
    card('a', 'Threshold'),
    card('b', 'Decoder'),
    block('k1', 'a', 'G'),
    block('k2', 'a', 'V'),
    ops.createSource({ id: 's1', title: 'Kitaev 2003' }),
    ops.attach({ id: 'at1', card: 'a', source: 's1' }),
  ])
  const said = (list: Op[]) => lines(many(list), base)

  it('reads typing in a Page as one line, however many keystrokes', () => {
    expect(said([ops.setBlockText('k1', 'a'), ops.setBlockText('k1', 'ab'), ops.setBlockText('k2', 'c')])).toEqual([
      ['Edited the Page of Threshold'],
    ])
  })
  it('says when blocks were only added, only removed, or only reordered', () => {
    expect(said([block('k3', 'a', 'k')])).toEqual([['Added a block to the Page of Threshold']])
    expect(said([block('k3', 'a', 'k'), block('k4', 'a', 'm')])).toEqual([['Added 2 blocks to the Page of Threshold']])
    expect(said([ops.remove('k1')])).toEqual([['Removed a block from the Page of Threshold']])
    expect(said([ops.remove('k1'), ops.remove('k2')])).toEqual([['Removed 2 blocks from the Page of Threshold']])
    expect(said([ops.moveBlock('k1', 'k')])).toEqual([['Reordered the Page of Threshold']])
  })
  it('reads a mix of adding, removing and rewriting as editing the Page', () => {
    expect(said([block('k3', 'a', 'k'), ops.remove('k1')])).toEqual([['Edited the Page of Threshold']])
    expect(said([block('k3', 'a', 'k'), ops.setBlockText('k2', 'new')])).toEqual([['Edited the Page of Threshold']])
    expect(said([ops.moveBlock('k1', 'k'), ops.setBlockText('k2', 'new')])).toEqual([['Edited the Page of Threshold']])
  })
  it('reads a block that came back as added, and says nothing of what cancels out', () => {
    const removed = replay(base, [ops.remove('k1')])
    expect(lines(many([ops.restore('k1')]), removed)).toEqual([['Added a block to the Page of Threshold']])
    expect(said([block('k3', 'a', 'k'), ops.remove('k3')])).toEqual([['No lasting changes']])
    expect(said([ops.setBlockText('k1', 'x'), ops.setBlockText('k1', 'k1')])).toEqual([['No lasting changes']])
    expect(said([block('k3', 'a', 'k'), ops.remove('k3'), ops.setText('b', 'title', 'Decoders')])).toEqual([
      ['Renamed Card Decoder → Decoders'],
    ])
  })
  it('gives each Page its own line, where it was first touched, by the title the Card ends with', () => {
    expect(
      said([
        ops.setBlockText('k1', 'x'),
        block('kb', 'b', 'V'),
        ops.setText('a', 'title', 'Threshold ≈ 1%'),
        ops.setBlockText('k2', 'y'),
        card('c', 'New'),
        block('kc', 'c', 'V'),
      ]),
    ).toEqual([
      [
        'Edited the Page of Threshold ≈ 1%',
        'Added a block to the Page of Decoder',
        'Renamed Card Threshold → Threshold ≈ 1%',
        'Added Card New',
        'Added a block to the Page of New',
      ],
    ])
  })
  it('does not count a Page edit as moving a Card', () => {
    expect(said([ops.moveBlock('k1', 'k'), ...ops.move('b', 5, 5)])).toEqual([
      ['Reordered the Page of Threshold', 'Moved 1 Card'],
    ])
  })
  it('says which Source was added to or removed from which Card', () => {
    expect(said([ops.attach({ id: 'at2', card: 'b', source: 's1' })])).toEqual([['Added Source Kitaev 2003 to Decoder']])
    expect(said([ops.remove('at1')])).toEqual([['Removed Source Kitaev 2003 from Threshold']])
    const detached = replay(base, [ops.remove('at1')])
    expect(lines(many([ops.restore('at1')]), detached)).toEqual([['Added Source Kitaev 2003 to Threshold']])
    expect(said([ops.attach({ id: 'at2', card: 'b', source: 's1' }), ops.remove('at2')])).toEqual([['No lasting changes']])
  })
  it('reads a new Source attached at once as one line, and a loose one on its own', () => {
    expect(
      said([ops.createSource({ id: 's2', title: 'Dennis 2002', doi: '10.1063/1.1499754' }), ops.attach({ id: 'at2', card: 'b', source: 's2' })]),
    ).toEqual([['Added Source Dennis 2002 to Decoder']])
    expect(said([ops.createSource({ id: 's2', title: 'Dennis 2002' })])).toEqual([['Added Source Dennis 2002']])
    expect(said([ops.createSource({ id: 's2', title: 'Dennis 2002' }), ops.remove('s2')])).toEqual([
      ['Added and removed Source Dennis 2002'],
    ])
  })
  it('says when a Source was edited, removed or brought back', () => {
    expect(said([ops.setSourceField('s1', 'year', '2003'), ops.setSourceField('s1', 'authors', 'A. Kitaev')])).toEqual([
      ['Edited Source Kitaev 2003'],
    ])
    expect(said([ops.setSourceField('s1', 'title', 'Fault-tolerant quantum computation by anyons')])).toEqual([
      ['Edited Source Fault-tolerant quantum computation by anyons'],
    ])
    expect(said([ops.remove('s1')])).toEqual([['Removed Source Kitaev 2003']])
    const removed = replay(base, [ops.remove('s1')])
    expect(lines(many([ops.restore('s1')]), removed)).toEqual([['Brought back Source Kitaev 2003']])
    expect(said([ops.setSourceField('s1', 'note', 'x'), ops.setSourceField('s1', 'note', '')])).toEqual([['No lasting changes']])
  })
  it('says when a PDF was attached to a Source, replaced or removed (M19)', () => {
    const a = { hash: 'a'.repeat(64), name: 'kitaev.pdf', size: 1000, pages: 3 }
    const b = { hash: 'b'.repeat(64), name: 'other.pdf', size: 2000, pages: 5 }
    expect(said(pdfOps.attach('s1', a))).toEqual([['Attached a PDF to Kitaev 2003']])
    const withA = replay(base, pdfOps.attach('s1', a))
    expect(lines(many(pdfOps.attach('s1', b)), withA)).toEqual([['Replaced the PDF of Kitaev 2003']])
    expect(lines(many(pdfOps.remove('s1')), withA)).toEqual([['Removed the PDF from Kitaev 2003']])
    // Only the page count found later: nothing to say about which PDF it is.
    expect(lines(many([{ Set: { entity: 's1', field: 'pdf_pages', value: { Float: 4 } } }]), withA)).toEqual([['No lasting changes']])
    // A new Source that comes with its PDF (Fetch the PDF from arXiv, or attached in the same Activity).
    expect(said([ops.createSource({ id: 's2', title: 'Dennis 2002' }), ops.attach({ id: 'at2', card: 'b', source: 's2' }), ...pdfOps.attach('s2', b)])).toEqual([
      ['Added Source Dennis 2002 to Decoder', 'Attached a PDF to Dennis 2002'],
    ])
    expect(said([...pdfOps.attach('s1', a), ops.setSourceField('s1', 'year', '2003')])).toEqual([
      ['Edited Source Kitaev 2003', 'Attached a PDF to Kitaev 2003'],
    ])
  })
  it('names an untitled Source by its DOI, else its address', () => {
    expect(said([ops.createSource({ id: 's2', doi: '10.1000/x', url: 'https://example.com' })])).toEqual([['Added Source 10.1000/x']])
    expect(said([ops.createSource({ id: 's2', url: 'https://example.com' })])).toEqual([['Added Source https://example.com']])
    expect(said([ops.createSource({ id: 's2', note: 'no name' })])).toEqual([['Added Source Untitled']])
  })
  it('still cuts long Activities to six lines', () => {
    const list = ['c', 'd', 'e', 'f', 'g', 'h', 'i'].flatMap((id) => [card(id, id.toUpperCase()), block(`k${id}`, id, 'V')])
    const [out] = said(list)
    expect(out).toHaveLength(6)
    expect(out![5]).toBe('and 9 more')
  })
})

describe('describeChanges: Visuals (M6)', () => {
  const block = (id: string, cardId: string, order: string, text = id) => ops.addBlock({ id, card: cardId, text, order })
  const visual = (id: string, cardId: string, order: string, title?: string) =>
    ops.addBlock({ id, card: cardId, type: 'visual', text: '<p>one</p>', title, order })
  // Card "Threshold" with a paragraph and the Visual "Decoder demo".
  const base = boardOf([card('a', 'Threshold'), block('k1', 'a', 'G'), visual('v1', 'a', 'V', 'Decoder demo')])
  const said = (list: Op[]) => lines(many(list), base)

  it('names an added Visual by its title', () => {
    expect(said([visual('v2', 'a', 'k', 'Error rates')])).toEqual([['Added Visual Error rates to the Page of Threshold']])
    expect(said([visual('v2', 'a', 'k')])).toEqual([['Added Untitled Visual to the Page of Threshold']])
    expect(said([visual('v2', 'a', 'k'), ops.setBlockTitle('v2', 'Named later')])).toEqual([
      ['Added Visual Named later to the Page of Threshold'],
    ])
  })
  it('says a Visual was edited when its source changed, however many keystrokes', () => {
    expect(said([ops.setBlockText('v1', '<p>t</p>'), ops.setBlockText('v1', '<p>two</p>')])).toEqual([
      ['Edited Visual Decoder demo in the Page of Threshold'],
    ])
  })
  it('says a Visual was edited when its title changed, by the new title', () => {
    expect(said([ops.setBlockTitle('v1', 'Decoder, live')])).toEqual([['Edited Visual Decoder, live in the Page of Threshold']])
    expect(said([ops.setBlockTitle('v1', '')])).toEqual([['Edited Untitled Visual in the Page of Threshold']])
  })
  it('names a removed Visual, and one that came back reads as added', () => {
    expect(said([ops.remove('v1')])).toEqual([['Removed Visual Decoder demo from the Page of Threshold']])
    const removed = replay(base, [ops.remove('v1')])
    expect(lines(many([ops.restore('v1')]), removed)).toEqual([['Added Visual Decoder demo to the Page of Threshold']])
  })
  it('says nothing about a Visual that was added and removed, or edited back', () => {
    expect(said([visual('v2', 'a', 'k'), ops.remove('v2')])).toEqual([['No lasting changes']])
    expect(said([ops.setBlockText('v1', 'x'), ops.setBlockText('v1', '<p>one</p>')])).toEqual([['No lasting changes']])
  })
  it('gives each Visual its own line beside the line of the Page', () => {
    expect(said([ops.setBlockText('k1', 'typed'), ops.setBlockText('v1', 'x'), visual('v2', 'a', 'k', 'Second')])).toEqual([
      ['Edited the Page of Threshold', 'Edited Visual Decoder demo in the Page of Threshold', 'Added Visual Second to the Page of Threshold'],
    ])
    // a Visual does not count as "a block" of the Page line
    expect(said([visual('v2', 'a', 'k', 'Second'), block('k2', 'a', 'm')])).toEqual([
      ['Added Visual Second to the Page of Threshold', 'Added a block to the Page of Threshold'],
    ])
  })
  it('reads moving a Visual within the Page as reordering the Page', () => {
    expect(said([ops.moveBlock('v1', 'A')])).toEqual([['Reordered the Page of Threshold']])
    expect(said([ops.moveBlock('v1', 'A'), ops.setBlockTitle('v1', 'New')])).toEqual([['Edited Visual New in the Page of Threshold']])
  })
})

describe('describeChanges: Pin (M7)', () => {
  const block = (id: string, cardId: string, order: string, text = id) => ops.addBlock({ id, card: cardId, text, order })
  const pin = (id: string, cardId: string, order: string) =>
    ops.pinBlock({ id, card: cardId, text: 'answer', order, model: 'claude-sonnet-4-5', pinnedBy: 'me', pinnedAt: 1 })
  // Card "Threshold" with a paragraph and a pinned answer that nobody reviewed; Card "Decoder" with nothing.
  const base = boardOf([card('a', 'Threshold'), card('b', 'Decoder'), block('k1', 'a', 'G'), pin('p1', 'a', 'V')])
  const said = (list: Op[]) => lines(many(list), base)

  it('says when an AI answer was pinned to a Page', () => {
    expect(said([pin('p2', 'b', 'V')])).toEqual([['Pinned an AI answer to the Page of Decoder']])
    expect(said([pin('p2', 'a', 'k'), pin('p3', 'a', 'm')])).toEqual([['Pinned 2 AI answers to the Page of Threshold']])
  })
  it('says when an AI answer was marked as reviewed', () => {
    expect(said([ops.markReviewed('p1', 'other')])).toEqual([['Marked an AI answer as reviewed in the Page of Threshold']])
    expect(said([pin('p2', 'a', 'k')]).length).toBe(1)
    const two = replay(base, [pin('p2', 'a', 'k')])
    expect(lines(many([ops.markReviewed('p1', 'me'), ops.markReviewed('p2', 'me')]), two)).toEqual([
      ['Marked 2 AI answers as reviewed in the Page of Threshold'],
    ])
  })
  it('keeps the Page line beside them for what else happened to the Page', () => {
    expect(said([pin('p2', 'a', 'k'), block('k2', 'a', 'm')])).toEqual([
      ['Pinned an AI answer to the Page of Threshold', 'Added a block to the Page of Threshold'],
    ])
    expect(said([ops.markReviewed('p1', 'other'), ops.setBlockText('p1', 'answer, corrected')])).toEqual([
      ['Marked an AI answer as reviewed in the Page of Threshold', 'Edited the Page of Threshold'],
    ])
    expect(said([ops.setBlockText('k1', 'x'), pin('p2', 'b', 'V'), ops.markReviewed('p1', 'other')])).toEqual([
      ['Marked an AI answer as reviewed in the Page of Threshold', 'Edited the Page of Threshold', 'Pinned an AI answer to the Page of Decoder'],
    ])
  })
  it('reads the rest as for any block', () => {
    expect(said([ops.remove('p1')])).toEqual([['Removed a block from the Page of Threshold']])
    expect(said([ops.setBlockText('p1', 'edited')])).toEqual([['Edited the Page of Threshold']])
    expect(said([pin('p2', 'a', 'k'), ops.remove('p2')])).toEqual([['No lasting changes']])
    expect(lines(many([ops.restore('p1')]), replay(base, [ops.remove('p1')]))).toEqual([['Added a block to the Page of Threshold']])
    // pinned and reviewed in one go: the pin says it; taking a review back, or reviewing twice, says nothing
    expect(said([pin('p2', 'a', 'k'), ops.markReviewed('p2', 'me')])).toEqual([['Pinned an AI answer to the Page of Threshold']])
    const reviewed = replay(base, [ops.markReviewed('p1', 'other')])
    expect(lines(many([ops.markReviewed('p1', '')]), reviewed)).toEqual([['No lasting changes']])
    expect(lines(many([ops.markReviewed('p1', 'me')]), reviewed)).toEqual([['No lasting changes']])
    // a review mark on a block that is not a pinned answer is not one
    expect(said([ops.markReviewed('k1', 'me')])).toEqual([['No lasting changes']])
  })
})

describe('describeChanges: Runs (M8)', () => {
  const block = (id: string, cardId: string, order: string, text = id) => ops.addBlock({ id, card: cardId, text, order })
  const runBlock = (id: string, cardId: string, order: string, title?: string) =>
    ops.addBlock({ id, card: cardId, type: 'run', text: 'print(1)', title, order })
  const result = (at = 1) => fakeRunResult('print(1)', { at, output: 'x'.repeat(5000) })
  // Card "Threshold" with a paragraph, the Run "Sweep" (never executed) and the Run "Fit" (executed once).
  const base = boardOf([card('a', 'Threshold'), block('k1', 'a', 'G'), runBlock('r1', 'a', 'V', 'Sweep'), runBlock('r2', 'a', 'k', 'Fit'), ops.setRunResult('r2', result())])
  const said = (list: Op[]) => lines(many(list), base)

  it('names an added Run by its name', () => {
    expect(said([runBlock('r3', 'a', 'z', 'Noise model')])).toEqual([['Added Run Noise model to the Page of Threshold']])
    expect(said([runBlock('r3', 'a', 'z')])).toEqual([['Added Untitled Run to the Page of Threshold']])
    expect(said([runBlock('r3', 'a', 'z'), ops.setBlockTitle('r3', 'Named later')])).toEqual([['Added Run Named later to the Page of Threshold']])
  })
  it('says a Run was edited when its code or its name changed', () => {
    expect(said([ops.setBlockText('r1', 'p'), ops.setBlockText('r1', 'pr'), ops.setBlockText('r1', 'print(2)')])).toEqual([['Edited Run Sweep in the Page of Threshold']])
    expect(said([ops.setBlockTitle('r1', 'Sweep, wide')])).toEqual([['Edited Run Sweep, wide in the Page of Threshold']])
    expect(said([ops.setBlockTitle('r1', '')])).toEqual([['Edited Untitled Run in the Page of Threshold']])
  })
  it('says a Run was executed when a result was recorded, first or again', () => {
    expect(said([ops.setRunResult('r1', result())])).toEqual([['Executed Run Sweep in the Page of Threshold']])
    expect(said([ops.setRunResult('r2', result(2))])).toEqual([['Executed Run Fit in the Page of Threshold']])
    expect(said([ops.setRunResult('r2', result(2)), ops.setRunResult('r2', result(3))])).toEqual([['Executed Run Fit in the Page of Threshold']])
  })
  it('says the output was cleared when the result was set to nothing', () => {
    expect(said([ops.setRunResult('r2', null)])).toEqual([['Cleared the output of Run Fit in the Page of Threshold']])
  })
  it('never prints the stored result', () => {
    const all = said([ops.setRunResult('r1', result()), ops.setRunResult('r2', null)]).flat().join(' ')
    expect(all).not.toContain('code_sha256')
    expect(all).not.toContain('xxxx')
  })
  it('says both when a Run was edited and executed, or added and executed, in one Activity', () => {
    expect(said([ops.setBlockText('r1', 'print(2)'), ops.setRunResult('r1', result())])).toEqual([
      ['Edited Run Sweep in the Page of Threshold', 'Executed Run Sweep in the Page of Threshold'],
    ])
    expect(said([runBlock('r3', 'a', 'z', 'New'), ops.setRunResult('r3', result())])).toEqual([
      ['Added Run New to the Page of Threshold', 'Executed Run New in the Page of Threshold'],
    ])
  })
  it('says nothing for a result recorded and cleared again, or put back as it was', () => {
    expect(said([ops.setRunResult('r1', result()), ops.setRunResult('r1', null)])).toEqual([['No lasting changes']])
    expect(said([ops.setRunResult('r2', null), ops.setRunResult('r2', result())])).toEqual([['No lasting changes']])
  })
  it('names a removed Run; one that came back reads as added, without saying it was executed', () => {
    expect(said([ops.remove('r2')])).toEqual([['Removed Run Fit from the Page of Threshold']])
    expect(said([ops.setRunResult('r1', result()), ops.remove('r1')])).toEqual([['Removed Run Sweep from the Page of Threshold']])
    const gone = replay(base, [ops.remove('r2')])
    expect(lines(many([ops.restore('r2')]), gone)).toEqual([['Added Run Fit to the Page of Threshold']])
    expect(said([runBlock('r3', 'a', 'z', 'Brief'), ops.remove('r3')])).toEqual([['No lasting changes']])
  })
  it('keeps Runs out of the count of blocks and gives the Page its own line beside them', () => {
    expect(said([block('k2', 'a', 'W'), runBlock('r3', 'a', 'z', 'New'), ops.setRunResult('r2', result(2))])).toEqual([
      ['Added a block to the Page of Threshold', 'Added Run New to the Page of Threshold', 'Executed Run Fit in the Page of Threshold'],
    ])
  })
  it('reads moving a Run within the Page as reordering, unless the Run has a line of its own', () => {
    expect(said([ops.moveBlock('r1', 'A')])).toEqual([['Reordered the Page of Threshold']])
    expect(said([ops.moveBlock('r1', 'A'), ops.setRunResult('r1', result())])).toEqual([['Executed Run Sweep in the Page of Threshold']])
  })
  it('leaves Visuals as they were', () => {
    const visual = ops.addBlock({ id: 'v1', card: 'a', type: 'visual', text: '<p>', title: 'Demo', order: 'zz' })
    expect(said([visual])).toEqual([['Added Visual Demo to the Page of Threshold']])
  })
})

describe('the shared fixture (docs/specs/branch-graph-activities.json)', () => {
  it('groups every case exactly as the server does', async () => {
    const fixture = await loadActivityFixture()
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10)
    for (const c of fixture.cases) {
      const shapes = groupShapes(c.changes, c.checkpoints, { gapMs: c.gap_ms })
      const asWire = shapes.map((s) => ({
        kind: s.kind,
        author: s.author,
        from_seq: s.fromSeq,
        to_seq: s.toSeq,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        ...(s.source ? { source: s.source } : {}),
        ...(s.to !== undefined ? { to: s.to } : {}),
      }))
      expect(asWire, c.name).toEqual(c.expected)
    }
  })
  it('gives History the same Activities, with words', async () => {
    const fixture = await loadActivityFixture()
    for (const c of fixture.cases) {
      const cps = c.checkpoints.map((seq, i) => cp(`cp${i}`, seq))
      const out = groupActivities(c.changes, cps, {}, { gapMs: c.gap_ms })
      expect(
        out.map((a) => [a.kind, a.author, a.fromSeq, a.toSeq, a.startedAt, a.endedAt]),
        c.name,
      ).toEqual(c.expected.map((e) => [e.kind, e.author, e.from_seq, e.to_seq, e.started_at, e.ended_at]))
      expect(out.every((a) => a.lines.length > 0 && a.count === a.toSeq - a.fromSeq)).toBe(true)
      // Every Checkpoint inside the log sits at the end of an Activity.
      for (const a of out) for (const k of a.checkpoints) expect(k.moment.seq).toBe(a.toSeq)
    }
  })
})
