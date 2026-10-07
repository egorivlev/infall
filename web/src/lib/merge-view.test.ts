import { describe, expect, it } from 'vitest'
import { replay } from './activities'
import type { Entities } from './board-state'
import type { MergeWorld } from './merge-view'
import {
  buildAuto,
  buildConflicts,
  countLayoutKept,
  defaultCheckpointName,
  mergeOptions,
  toDecision,
  toDecisions,
} from './merge-view'
import { ops } from './ops'
import type { BranchInfo, Change, Conflict, ConflictVM, MergePlan, Op, Value } from './types'

const T = (s: string): Value => ({ Text: s })
const card = (id: string, title?: string): Op => ops.createCard({ id, x: 0, y: 0, title })
const set = (entity: string, field: string, value: Value): Op => ({ Set: { entity, field, value } })

// The Board both Branches started from: three Cards, a Frame, a labelled Connection Alpha → Beta.
const BASE = replay({}, [
  card('a', 'Alpha'),
  card('b', 'Beta'),
  card('c', 'Gamma'),
  ops.createFrame({ id: 'f', x: 0, y: 0, w: 10, h: 10, title: 'Zone' }),
  ops.createConnection({ id: 'k', from: 'a', to: 'b', label: 'uses' }),
])

let n = 0
const log = (author: string, at: number, list: Op[]): Change[] =>
  list.map((op) => ({ id: `c${n++}`, author, at, op, origin: 'Edit' }))

function plan(conflicts: Conflict[], auto: Op[] = [], base = { branch: 'main-id', seq: 0 }): MergePlan {
  return { source: { branch: 'try-id', seq: 9 }, target: { branch: 'main-id', seq: 9 }, base, auto, conflicts }
}

// `try` (source) and `main` (target), each with its own edits on top of BASE.
function world(sourceOps: Op[], targetOps: Op[], extra: Partial<MergeWorld> = {}): MergeWorld {
  return {
    sourceName: 'try',
    targetName: 'main',
    source: replay(BASE, sourceOps),
    target: replay(BASE, targetOps),
    base: BASE,
    sourceChanges: log('sam', 200, sourceOps),
    targetChanges: log('tess', 300, targetOps),
    ...extra,
  }
}

function field(entity: string, name: string, base: Value, source: Value, target: Value): Conflict {
  return { Field: { entity, field: name, base, source, target } }
}

function one(conflict: Conflict, w: MergeWorld, p = plan([conflict])): ConflictVM {
  return buildConflicts(p, w)[0]!.vm
}

describe('buildConflicts: field Conflicts', () => {
  it('shows a title changed on both, with who changed it on each Branch', () => {
    const w = world([ops.setText('a', 'title', 'Alpha S')], [ops.setText('a', 'title', 'Alpha T')])
    expect(one(field('a', 'title', T('Alpha'), T('Alpha S'), T('Alpha T')), w)).toEqual({
      id: 'a:title',
      key: { entity: 'a', field: 'title' },
      type: 'field',
      entityKind: 'Card',
      entityTitle: 'Alpha S',
      field: 'title',
      headline: 'Title changed on both',
      source: { text: 'Alpha S', author: 'sam', at: 200 },
      target: { text: 'Alpha T', author: 'tess', at: 300 },
      canEdit: true,
      choice: null,
    })
  })

  it('shows a summary, an emptied one as (empty)', () => {
    const w = world([ops.setText('a', 'summary', 'From try')], [ops.setText('a', 'summary', 'x'), ops.setText('a', 'summary', '')])
    const vm = one(field('a', 'summary', 'Null', T('From try'), 'Null'), w)
    expect(vm).toMatchObject({ headline: 'Summary changed on both', entityTitle: 'Alpha', canEdit: true })
    expect(vm.source.text).toBe('From try')
    expect(vm.target).toEqual({ text: '(empty)', author: 'tess', at: 300 })
  })

  it('shows a Status by its word and gives the Status for the glyph', () => {
    const w = world([ops.setStatus('b', 'understood')], [ops.setStatus('b', 'open_question')])
    const vm = one(field('b', 'status', 'Null', T('understood'), T('open_question')), w)
    expect(vm).toMatchObject({ headline: 'Status changed on both', canEdit: false, entityTitle: 'Beta' })
    expect(vm.source).toEqual({ text: 'Understood', status: 'understood', author: 'sam', at: 200 })
    expect(vm.target).toEqual({ text: 'Open question', status: 'open_question', author: 'tess', at: 300 })
  })

  it('reads an unset Status as Idea', () => {
    const w = world([], [])
    const vm = one(field('b', 'status', T('reading'), 'Null', T('dead_end')), w)
    expect(vm.source).toEqual({ text: 'Idea', status: 'idea' })
    expect(vm.target).toEqual({ text: 'Dead end', status: 'dead_end' })
  })

  it('shows the ends of a Connection by Card title, each side naming Cards as it has them', () => {
    const w = world(
      [set('k', 'to', { Ref: 'c' }), set('k', 'from', { Ref: 'b' })],
      [set('k', 'to', { Ref: 'a' }), ops.setText('c', 'title', 'Gamma on main'), set('k', 'from', { Ref: 'c' })],
    )
    const end = one(field('k', 'to', { Ref: 'b' }, { Ref: 'c' }, { Ref: 'a' }), w)
    expect(end).toMatchObject({
      headline: 'End changed on both',
      entityKind: 'Connection',
      entityTitle: 'Beta → Gamma',
      canEdit: false,
    })
    expect(end.source.text).toBe('Gamma')
    expect(end.target.text).toBe('Alpha')
    const start = one(field('k', 'from', { Ref: 'a' }, { Ref: 'b' }, { Ref: 'c' }), w)
    expect(start.headline).toBe('Start changed on both')
    expect(start.source.text).toBe('Beta')
    expect(start.target.text).toBe('Gamma on main')
  })

  it('shows a Connection label (editable) and kind (not editable)', () => {
    const w = world(
      [ops.setText('k', 'label', 'needs'), ops.setKind('k', 'contradicts')],
      [ops.setText('k', 'label', ''), ops.setKind('k', 'directed')],
    )
    const label = one(field('k', 'label', T('uses'), T('needs'), 'Null'), w)
    expect(label).toMatchObject({ id: 'k:label', headline: 'Label changed on both', entityTitle: 'Alpha → Beta', canEdit: true })
    expect(label.source.text).toBe('needs')
    expect(label.target.text).toBe('(empty)')
    const kind = one(field('k', 'kind', 'Null', T('contradicts'), T('directed')), w)
    expect(kind).toMatchObject({ headline: 'Kind changed on both', canEdit: false })
    expect(kind.source.text).toBe('Contradicts')
    expect(kind.target.text).toBe('Directed')
    expect(one(field('k', 'kind', T('directed'), 'Null', T('contradicts')), w).source.text).toBe('Related')
  })

  it('names an untitled entity Untitled and words an unknown field by its name', () => {
    const w = world([card('u'), set('u', 'weight', { Float: 2 })], [card('u'), set('u', 'weight', { Float: 3 })])
    const vm = one(field('u', 'weight', 'Null', { Float: 2 }, { Float: 3 }), w)
    expect(vm).toMatchObject({ entityTitle: 'Untitled', headline: 'Weight changed on both', canEdit: false })
    expect(vm.source.text).toBe('2')
    expect(vm.target.text).toBe('3')
  })

  it('leaves author and time out when the Branch has no Change for the field', () => {
    const w = world([ops.setText('a', 'title', 'Alpha S')], [], { targetChanges: [] })
    const vm = one(field('a', 'title', T('Alpha'), T('Alpha S'), T('Alpha T')), w)
    expect(vm.source).toEqual({ text: 'Alpha S', author: 'sam', at: 200 })
    expect(vm.target).toEqual({ text: 'Alpha T' })
  })

  it('takes the last Change for the field, and ignores shared history before the base on the base Branch', () => {
    const shared = log('old', 50, [ops.setText('a', 'title', 'Alpha')]) // on main before the fork
    const own = log('tess', 300, [ops.setText('a', 'title', 'Alpha T0'), ops.setText('b', 'title', 'B'), ops.setText('a', 'title', 'Alpha T')])
    const w = world([], [], { targetChanges: [...shared, ...own], sourceChanges: [] })
    const c = field('a', 'title', T('Alpha'), T('Alpha S'), T('Alpha T'))
    expect(one(c, w, plan([c], [], { branch: 'main-id', seq: 1 })).target).toEqual({ text: 'Alpha T', author: 'tess', at: 300 })
    // Nothing on main since the base: the value came from before.
    expect(one(c, { ...w, targetChanges: shared }, plan([c], [], { branch: 'main-id', seq: 1 })).target).toEqual({ text: 'Alpha T' })
  })

  it('keeps the order of the plan', () => {
    const w = world([], [])
    const list = buildConflicts(
      plan([field('a', 'summary', 'Null', T('1'), T('2')), field('a', 'title', 'Null', T('1'), T('2')), field('b', 'title', 'Null', T('1'), T('2'))]),
      w,
    )
    expect(list.map((c) => c.vm.id)).toEqual(['a:summary', 'a:title', 'b:title'])
  })
})

describe('buildConflicts: edit vs delete', () => {
  const evd = (entity: string, deleted_on: 'Source' | 'Target'): Conflict => ({ EditVsDelete: { entity, deleted_on } })

  it('deleted on the source, edited on the target', () => {
    const w = world([ops.remove('a')], [ops.setText('a', 'title', 'Alpha 2'), ops.setText('a', 'summary', 'More'), ...ops.move('a', 5, 5)])
    expect(one(evd('a', 'Source'), w)).toEqual({
      id: 'a:',
      key: { entity: 'a', field: null },
      type: 'edit_vs_delete',
      entityKind: 'Card',
      entityTitle: 'Alpha',
      field: null,
      headline: 'Deleted on try, edited on main',
      source: { text: 'Delete the Card', author: 'sam', at: 200 },
      target: { text: 'Keep the Card with its edits: summary, title', author: 'tess', at: 300 },
      canEdit: false,
      choice: null,
    })
  })

  it('deleted on the target, edited on the source', () => {
    const w = world([ops.setStatus('b', 'reading')], [ops.remove('b')])
    const vm = one(evd('b', 'Target'), w)
    expect(vm.headline).toBe('Deleted on main, edited on try')
    expect(vm.entityTitle).toBe('Beta')
    expect(vm.source).toEqual({ text: 'Bring back the Card with its edits: status', author: 'sam', at: 200 })
    expect(vm.target).toEqual({ text: 'Leave the Card deleted', author: 'tess', at: 300 })
  })

  it('a Connection: named by its ends, edits worded start / end / label', () => {
    const w = world([ops.remove('k')], [ops.setText('k', 'label', 'needs'), set('k', 'to', { Ref: 'c' })])
    const vm = one(evd('k', 'Source'), w)
    expect(vm).toMatchObject({ entityKind: 'Connection', entityTitle: 'Alpha → Beta', headline: 'Deleted on try, edited on main' })
    expect(vm.source.text).toBe('Delete the Connection')
    expect(vm.target.text).toBe('Keep the Connection with its edits: label, end')
  })

  it('says kept, not edited, when the live side only kept it (a Delete made by hand would be reversed)', () => {
    // main brought the Card back by hand and moved it; try still has it deleted. Content equals the base.
    const base = replay(BASE, [ops.remove('c')])
    const w = world([ops.remove('c')], [ops.remove('c'), ops.restore('c'), ...ops.move('c', 9, 9)], { base })
    const vm = one(evd('c', 'Source'), w)
    expect(vm.headline).toBe('Deleted on try, kept on main')
    expect(vm.target.text).toBe('Keep the Card')
    expect(vm.source.text).toBe('Delete the Card')
  })

  it('says kept when the live side has the content of the base', () => {
    const w = world([...ops.move('a', 3, 3)], [ops.remove('a')])
    const vm = one(evd('a', 'Target'), w)
    expect(vm.headline).toBe('Deleted on main, kept on try')
    expect(vm.source.text).toBe('Bring back the Card')
    expect(vm.source.author).toBeUndefined()
    expect(vm.target).toEqual({ text: 'Leave the Card deleted', author: 'tess', at: 300 })
  })

  it('says kept for an entity the base does not have', () => {
    const w = world([card('n', 'New')], [card('n', 'New'), ops.remove('n')])
    expect(one(evd('n', 'Target'), w).headline).toBe('Deleted on main, kept on try')
  })

  it('without the base Board says edited and lists nothing', () => {
    const w = world([ops.remove('a')], [ops.setText('a', 'title', 'Alpha 2')], { base: null })
    const vm = one(evd('a', 'Source'), w)
    expect(vm.headline).toBe('Deleted on try, edited on main')
    expect(vm.target.text).toBe('Keep the Card')
  })

  it('gives a print that changes with the values a Conflict is about, not with layout', () => {
    const c = evd('a', 'Source')
    const print = (targetOps: Op[]) => buildConflicts(plan([c]), world([ops.remove('a')], targetOps))[0]!.print
    expect(print([ops.setText('a', 'title', 'X'), ...ops.move('a', 1, 1)])).toBe(print([ops.setText('a', 'title', 'X')]))
    expect(print([ops.setText('a', 'title', 'Y')])).not.toBe(print([ops.setText('a', 'title', 'X')]))
    const f = (target: string) => buildConflicts(plan([field('a', 'title', T('Alpha'), T('S'), T(target))]), world([], []))[0]!.print
    expect(f('T')).toBe(f('T'))
    expect(f('T2')).not.toBe(f('T'))
  })
})

describe('buildAuto', () => {
  const auto = (list: Op[], source: Entities, target: Entities = BASE) => buildAuto(plan([], list), source, target)

  it('has nothing to say for an empty plan', () => {
    expect(auto([], BASE)).toEqual({ lines: [], summary: 'Nothing to merge automatically' })
  })

  it('lists what was added, by title; a Connection by its ends and label', () => {
    const added = [
      card('n1', 'Union-find vs MWPM benchmark'),
      card('n2'),
      ops.createFrame({ id: 'g', x: 0, y: 0, w: 5, h: 5, title: 'Decoders' }),
      ops.createConnection({ id: 'k2', from: 'n1', to: 'a', label: 'calibrates' }),
      ops.createConnection({ id: 'k3', from: 'n2', to: 'b' }),
    ]
    expect(auto(added, replay(BASE, added))).toEqual({
      lines: [
        { kind: 'Card added', what: 'Union-find vs MWPM benchmark' },
        { kind: 'Card added', what: 'Untitled' },
        { kind: 'Frame added', what: 'Decoders' },
        { kind: 'Connection added', what: 'Union-find vs MWPM benchmark → Alpha · calibrates' },
        { kind: 'Connection added', what: 'Untitled → Beta' },
      ],
      summary: '5 Changes · 2 Cards added, 1 Frame added, 2 Connections added',
    })
  })

  it('lists one Change per entity with the fields that change, named as the source has it', () => {
    const edits = [
      ops.setText('a', 'title', 'Lattice surgery CNOT'),
      ops.setText('a', 'summary', 'S'),
      ops.setStatus('b', 'understood'),
      ops.setText('k', 'label', 'needs'),
      set('k', 'to', { Ref: 'c' }),
    ]
    expect(auto(edits, replay(BASE, edits))).toEqual({
      lines: [
        { kind: 'Change', what: 'Lattice surgery CNOT · title, summary' },
        { kind: 'Change', what: 'Beta · status' },
        { kind: 'Change', what: 'Lattice surgery CNOT → Gamma · label, end' },
      ],
      summary: '3 Changes',
    })
  })

  it('lists removed and brought-back entities; the Sets of a brought-back one belong to its line', () => {
    const target = replay(BASE, [ops.remove('c')])
    const source = replay(BASE, [ops.remove('a'), ops.setText('c', 'title', 'Gamma 2'), ...ops.move('c', 4, 4)])
    const list = [ops.restore('c'), ops.setText('c', 'title', 'Gamma 2'), ...ops.move('c', 4, 4), ops.remove('a')]
    expect(buildAuto(plan([], list), source, target)).toEqual({
      lines: [
        { kind: 'Brought back', what: 'Gamma 2' },
        { kind: 'Removed', what: 'Alpha' },
      ],
      summary: '2 Changes · 1 removed, 1 brought back',
    })
  })

  it('does not list layout-only Sets; counts their entities as moved or resized', () => {
    const list = [...ops.move('a', 5, 5), ...ops.resize('f', 20, 20), ops.setText('b', 'title', 'Beta 2'), ...ops.move('b', 1, 1)]
    expect(auto(list, replay(BASE, list))).toEqual({
      lines: [{ kind: 'Change', what: 'Beta 2 · title' }],
      summary: '3 Changes · 1 other Change, 2 moved or resized',
    })
    const only = ops.move('a', 5, 5)
    expect(auto(only, replay(BASE, only))).toEqual({ lines: [], summary: '1 moved or resized' })
  })

  it('does not list an entity that arrives already deleted', () => {
    const list = [card('n', 'Gone'), card('m', 'Stays'), ops.remove('n')]
    expect(auto(list, replay(BASE, list))).toEqual({
      lines: [{ kind: 'Card added', what: 'Stays' }],
      summary: '2 Changes · 1 Card added, 1 added and removed',
    })
  })

  it('words a mixed plan like the contract', () => {
    const list = [
      card('n1', 'One'),
      card('n2', 'Two'),
      card('n3', 'Three'),
      ops.createConnection({ id: 'k2', from: 'n1', to: 'n2' }),
      ops.createConnection({ id: 'k3', from: 'n2', to: 'n3' }),
      ops.setText('a', 'title', 'A2'),
      ops.setText('b', 'title', 'B2'),
      ops.setText('c', 'title', 'C2'),
      ops.setText('f', 'title', 'Zone 2'),
    ]
    expect(auto(list, replay(BASE, list)).summary).toBe('9 Changes · 3 Cards added, 2 Connections added, 4 other Changes')
    expect(auto([card('n1', 'One')], replay(BASE, [card('n1', 'One')])).summary).toBe('1 Card added')
  })

  it('names what is only on the target by the target Board', () => {
    // After a by-hand reversal was decided elsewhere, a plan can still touch an entity the source lost track of.
    const target = replay(BASE, [card('t', 'Only on main')])
    expect(buildAuto(plan([], [ops.remove('t')]), BASE, target).lines).toEqual([{ kind: 'Removed', what: 'Only on main' }])
  })
})

describe('countLayoutKept', () => {
  it('counts entities live on both Boards that sit differently and are not laid out by the plan', () => {
    const source = replay(BASE, [...ops.move('a', 5, 5), ...ops.move('b', 6, 6), ...ops.resize('f', 30, 30), ...ops.move('c', 1, 1), ops.remove('c')])
    const target = replay(BASE, [...ops.move('a', 7, 7), ...ops.resize('f', 40, 40), card('t', 'Only on main')])
    // a: moved on both (target wins) → kept. b: the plan moves it → not kept. f: resized on both → kept.
    // c: deleted on the source → not counted. t: only on the target → not counted.
    expect(countLayoutKept(plan([], ops.move('b', 6, 6)), source, target)).toBe(2)
    expect(countLayoutKept(plan([]), BASE, BASE)).toBe(0)
  })
})

describe('defaultCheckpointName', () => {
  it('is "Before merging <source>"', () => {
    expect(defaultCheckpointName('try-QEC', [])).toBe('Before merging try-QEC')
    expect(defaultCheckpointName('try-QEC', ['Before merging other'])).toBe('Before merging try-QEC')
  })
  it('counts up until the name is unused', () => {
    expect(defaultCheckpointName('try', ['Before merging try'])).toBe('Before merging try (2)')
    expect(defaultCheckpointName('try', ['Before merging try', 'Before merging try (2)', 'Before merging try (3)'])).toBe(
      'Before merging try (4)',
    )
    expect(defaultCheckpointName('try', ['Before merging try', 'Before merging try (3)'])).toBe('Before merging try (2)')
  })
})

describe('toDecisions', () => {
  it('turns choices into Decisions; an empty hand-written value is Null', () => {
    expect(toDecision('source')).toBe('TakeSource')
    expect(toDecision('target')).toBe('TakeTarget')
    expect(toDecision({ custom: 'Mine' })).toEqual({ Custom: { Text: 'Mine' } })
    expect(toDecision({ custom: '' })).toEqual({ Custom: 'Null' })
  })
  it('lists the Conflicts still undecided', () => {
    const w = world([], [])
    const vms = buildConflicts(plan([field('a', 'title', 'Null', T('1'), T('2')), { EditVsDelete: { entity: 'b', deleted_on: 'Source' } }]), w).map(
      (c) => c.vm,
    )
    expect(toDecisions(vms)).toEqual({ decisions: [], undecided: [{ entity: 'a', field: 'title' }, { entity: 'b', field: null }] })
    expect(toDecisions([{ ...vms[0]!, choice: { custom: 'x' } }, { ...vms[1]!, choice: 'target' }])).toEqual({
      decisions: [
        [{ entity: 'a', field: 'title' }, { Custom: { Text: 'x' } }],
        [{ entity: 'b', field: null }, 'TakeTarget'],
      ],
      undecided: [],
    })
  })
})

describe('mergeOptions', () => {
  const main: BranchInfo = { id: 'main-id', name: 'main', seq: 4, checkpoints: 0 }
  const child: BranchInfo = { id: 'try-id', name: 'try', seq: 2, parent: { branch: 'main-id', seq: 3 }, checkpoints: 0 }
  const grandchild: BranchInfo = { id: 'deep-id', name: 'deep', seq: 0, parent: { branch: 'try-id', seq: 1 }, checkpoints: 0 }
  const all = [main, child, grandchild]

  it('offers nothing for main', () => {
    expect(mergeOptions(main, all)).toEqual({})
  })
  it('offers a child of main its parent, both ways', () => {
    expect(mergeOptions(child, all)).toEqual({ intoParent: main, fromParent: main })
  })
  it('offers a grandchild its direct parent only', () => {
    expect(mergeOptions(grandchild, all)).toEqual({ intoParent: child, fromParent: child })
  })
  it('offers nothing while the parent is not in the list', () => {
    expect(mergeOptions(child, [child])).toEqual({})
  })
})

describe('Pages and Sources in a Merge', () => {
  const block = (id: string, cardId: string, order: string, text = id): Op => ops.addBlock({ id, card: cardId, text, order })
  // BASE plus a Page on Alpha (two blocks), a Source attached to Alpha, and a loose Source.
  const PAGES = replay(BASE, [
    block('p1', 'a', 'G', 'Intro'),
    block('p2', 'a', 'V', 'Body'),
    ops.createSource({ id: 's1', title: 'Kitaev 2003', url: 'https://example.com/k' }),
    ops.createSource({ id: 's2', title: 'Dennis 2002' }),
    ops.attach({ id: 't1', card: 'a', source: 's1' }),
  ])
  function pages(sourceOps: Op[], targetOps: Op[]): MergeWorld {
    return {
      sourceName: 'try',
      targetName: 'main',
      source: replay(PAGES, sourceOps),
      target: replay(PAGES, targetOps),
      base: PAGES,
      sourceChanges: log('sam', 200, sourceOps),
      targetChanges: log('tess', 300, targetOps),
    }
  }
  const evd = (entity: string, deleted_on: 'Source' | 'Target'): Conflict => ({ EditVsDelete: { entity, deleted_on } })
  const auto = (list: Op[], target: Entities = PAGES) => buildAuto(plan([], list), replay(PAGES, list), target)

  it('shows a paragraph changed on both: named by its Page, editable by hand', () => {
    const w = pages([ops.setText('a', 'title', 'Alpha S'), ops.setBlockText('p1', 'Intro, by Sam')], [ops.setBlockText('p1', 'Intro, by Tess')])
    expect(one(field('p1', 'text', T('Intro'), T('Intro, by Sam'), T('Intro, by Tess')), w)).toEqual({
      id: 'p1:text',
      key: { entity: 'p1', field: 'text' },
      type: 'field',
      entityKind: 'Block',
      entityTitle: 'Page: Alpha S',
      field: 'text',
      headline: 'Paragraph changed on both',
      source: { text: 'Intro, by Sam', author: 'sam', at: 200 },
      target: { text: 'Intro, by Tess', author: 'tess', at: 300 },
      canEdit: true,
      choice: null,
    })
  })
  it('shows an emptied paragraph as (empty), and a hand-written one becomes a Custom text', () => {
    const w = pages([ops.setBlockText('p2', '')], [ops.setBlockText('p2', 'Body, longer')])
    const vm = one(field('p2', 'text', T('Body'), 'Null', T('Body, longer')), w)
    expect(vm).toMatchObject({ entityTitle: 'Page: Alpha', headline: 'Paragraph changed on both', canEdit: true })
    expect(vm.source.text).toBe('(empty)')
    expect(toDecisions([{ ...vm, choice: { custom: 'Body, merged by hand' } }]).decisions).toEqual([
      [{ entity: 'p2', field: 'text' }, { Custom: { Text: 'Body, merged by hand' } }],
    ])
  })
  it('shows a Source field changed on both, by the Source title, editable by hand', () => {
    const w = pages([ops.setSourceField('s1', 'url', 'https://example.com/s')], [ops.setSourceField('s1', 'url', 'https://example.com/t')])
    expect(one(field('s1', 'url', T('https://example.com/k'), T('https://example.com/s'), T('https://example.com/t')), w)).toMatchObject({
      entityKind: 'Source',
      entityTitle: 'Kitaev 2003',
      headline: 'URL changed on both',
      source: { text: 'https://example.com/s', author: 'sam' },
      target: { text: 'https://example.com/t', author: 'tess' },
      canEdit: true,
    })
    const year = one(field('s2', 'year', 'Null', T('2002'), T('2001')), pages([], []))
    expect(year).toMatchObject({ entityTitle: 'Dennis 2002', headline: 'Year changed on both', canEdit: true })
    expect(one(field('s2', 'doi', 'Null', T('10.1/a'), T('10.1/b')), pages([], [])).headline).toBe('DOI changed on both')
  })
  it('words a block deleted on one Branch and edited on the other', () => {
    const w = pages([ops.remove('p1')], [ops.setBlockText('p1', 'Intro, longer')])
    expect(one(evd('p1', 'Source'), w)).toMatchObject({
      type: 'edit_vs_delete',
      entityKind: 'Block',
      entityTitle: 'Page: Alpha',
      headline: 'Deleted on try, edited on main',
      source: { text: 'Delete the block', author: 'sam', at: 200 },
      target: { text: 'Keep the block with its edits: text', author: 'tess', at: 300 },
      canEdit: false,
    })
    const reordered = pages([ops.moveBlock('p1', 'k')], [ops.remove('p1')])
    expect(one(evd('p1', 'Target'), reordered)).toMatchObject({
      headline: 'Deleted on main, kept on try',
      source: { text: 'Bring back the block' },
      target: { text: 'Leave the block deleted' },
    })
  })
  it('words a Source deleted on one Branch and edited on the other, and a detached one', () => {
    const w = pages([ops.setSourceField('s1', 'url', 'https://example.com/new'), ops.setSourceField('s1', 'note', 'key')], [ops.remove('s1')])
    expect(one(evd('s1', 'Target'), w)).toMatchObject({
      entityTitle: 'Kitaev 2003',
      headline: 'Deleted on main, edited on try',
      source: { text: 'Bring back the Source with its edits: note, URL' },
      target: { text: 'Leave the Source deleted' },
    })
    const detached = pages([ops.remove('t1')], [])
    expect(one(evd('t1', 'Source'), detached)).toMatchObject({
      entityKind: 'Attachment',
      entityTitle: 'Kitaev 2003 on Alpha',
      headline: 'Detached on try, kept on main',
      source: { text: 'Detach the Source', author: 'sam' },
      target: { text: 'Keep the Source attached' },
      canEdit: false,
    })
    expect(one(evd('t1', 'Target'), pages([], [ops.remove('t1')]))).toMatchObject({
      headline: 'Detached on main, kept on try',
      source: { text: 'Attach the Source again' },
      target: { text: 'Leave the Source detached' },
    })
  })
  it('lists a Page once, with how many of its blocks change', () => {
    expect(auto([ops.setBlockText('p1', 'Intro!'), block('p3', 'a', 'k', 'More'), ops.remove('p2'), block('q1', 'b', 'V', 'On Beta')])).toEqual({
      lines: [
        { kind: 'Change', what: 'Page of Alpha · 3 blocks' },
        { kind: 'Change', what: 'Page of Beta · 1 block' },
      ],
      summary: '2 Changes',
    })
  })
  it('lists the Page of a Card the plan adds, after the Card', () => {
    expect(auto([card('n', 'New'), block('q1', 'n', 'V'), block('q2', 'n', 'k')])).toEqual({
      lines: [
        { kind: 'Card added', what: 'New' },
        { kind: 'Change', what: 'Page of New · 2 blocks' },
      ],
      summary: '2 Changes · 1 Card added, 1 other Change',
    })
  })
  it('counts a Page that is only reordered as moved, without a line', () => {
    expect(auto([ops.moveBlock('p1', 'k'), ...ops.move('b', 9, 9)])).toEqual({ lines: [], summary: '2 moved or resized' })
    expect(auto([ops.moveBlock('p1', 'k'), ops.setBlockText('p2', 'Body!')])).toEqual({
      lines: [{ kind: 'Change', what: 'Page of Alpha · 1 block' }],
      summary: '1 Change',
    })
  })
  it('lists Sources: added, attached, edited, removed, brought back', () => {
    expect(
      auto([
        ops.createSource({ id: 's3', title: 'Fowler 2012' }),
        ops.attach({ id: 't3', card: 'b', source: 's3' }),
        ops.createSource({ id: 's4', title: 'Loose one' }),
        ops.attach({ id: 't4', card: 'b', source: 's2' }),
        ops.setSourceField('s2', 'year', '2002'),
        ops.setSourceField('s2', 'doi', '10.1063/1.1499754'),
        ops.remove('t1'),
        ops.remove('s1'),
      ]),
    ).toEqual({
      lines: [
        { kind: 'Change', what: 'Source Fowler 2012 · attached to Beta' },
        { kind: 'Change', what: 'Source Loose one' },
        { kind: 'Change', what: 'Source Dennis 2002 · attached to Beta' },
        { kind: 'Change', what: 'Source Dennis 2002 · year, DOI' },
        { kind: 'Removed', what: 'Source Kitaev 2003 from Alpha' },
        { kind: 'Removed', what: 'Source Kitaev 2003' },
      ],
      summary: '6 Changes · 4 other Changes, 2 removed',
    })
    const target = replay(PAGES, [ops.remove('s2'), ops.remove('t1')])
    expect(buildAuto(plan([], [ops.restore('s2'), ops.restore('t1')]), PAGES, target)).toEqual({
      lines: [
        { kind: 'Brought back', what: 'Source Dennis 2002' },
        { kind: 'Change', what: 'Source Kitaev 2003 · attached to Alpha' },
      ],
      summary: '2 Changes · 1 other Change, 1 brought back',
    })
  })
  it('gives no line to blocks, Sources and Attachments that arrive already deleted', () => {
    const list = [block('q1', 'b', 'V'), ops.remove('q1'), ops.createSource({ id: 's3', title: 'Gone' }), ops.remove('s3')]
    expect(auto(list)).toEqual({ lines: [], summary: '2 added and removed' })
  })
  it('does not count a different block order as layout kept', () => {
    const source = replay(PAGES, [ops.moveBlock('p1', 'k'), ...ops.move('a', 5, 5)])
    expect(countLayoutKept(plan([]), source, PAGES)).toBe(1)
  })
})
