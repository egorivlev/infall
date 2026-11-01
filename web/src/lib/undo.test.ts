import { describe, expect, it } from 'vitest'
import type { Entities } from './board-state'
import { applyOps } from './board-state'
import { ops } from './ops'
import type { Entity, Op, Value } from './types'
import type { Lists, Logged, Part } from './undo'
import {
  NOTHING_TO_UNDO,
  PENDING,
  UNDO_DEPTH,
  endsLists,
  forwardOf,
  imperative,
  inverseOf,
  labelFor,
  mergeParts,
  names,
  noteFor,
  partsOf,
  planStep,
  pushStep,
  remark,
  touches,
} from './undo'

const ME = 'me'
const ANA = 'ana'
const nameOf = (id: string) => ({ me: 'Mei', ana: 'Ana', ben: 'Ben' })[id]

function board(list: Op[]): Entities {
  const r = applyOps({}, list)
  if (!r.ok) throw new Error(r.rejection.message)
  return r.entities
}
function after(e: Entities, list: Op[]): Entities {
  const r = applyOps(e, list)
  if (!r.ok) throw new Error(r.rejection.message)
  return r.entities
}

const card = (id: string, title = '', x = 0, y = 0) => ops.createCard({ id, x, y, title })
const conn = (id: string, from: string, to: string) => ops.createConnection({ id, from, to })
const logged = (seq: number, author: string, op: Op, id = `c${seq}`): Logged => ({ seq, id, author, op, origin: 'Edit' })
const none = () => false

const BASE = board([card('a', 'Axions', 0, 0), card('b', 'Bosons', 300, 0), card('c', 'Chirality', 600, 0), conn('ab', 'a', 'b')])

describe('partsOf', () => {
  it('keeps what a field was before the batch', () => {
    expect(partsOf(BASE, ops.move('a', 40, 8), 5)).toEqual([
      { kind: 'set', entity: 'a', field: 'x', before: { Float: 0 }, after: { Float: 40 }, mark: 5 },
      { kind: 'set', entity: 'a', field: 'y', before: { Float: 0 }, after: { Float: 8 }, mark: 5 },
    ])
  })
  it('reads an unset field as Null and setting it to nothing as Null', () => {
    expect(partsOf(BASE, [ops.setText('a', 'summary', 'Dark matter')])[0]).toMatchObject({ before: 'Null', after: { Text: 'Dark matter' } })
    expect(partsOf(BASE, [ops.setText('a', 'title', '')])[0]).toMatchObject({ before: { Text: 'Axions' }, after: 'Null' })
  })
  it('records the Connections a deleted Card had, only those shown', () => {
    const e = after(BASE, [conn('ac', 'a', 'c'), ops.remove('c')])
    expect(partsOf(e, [ops.remove('a')])).toEqual([{ kind: 'delete', entity: 'a', mark: PENDING, had: ['ab'] }])
    expect(partsOf(BASE, [ops.remove('ab')])).toEqual([{ kind: 'delete', entity: 'ab', mark: PENDING }])
  })
  it('counts a Connection made earlier in the same batch', () => {
    expect(partsOf(BASE, [conn('bc', 'b', 'c'), ops.remove('c')])).toEqual([
      { kind: 'create', entity: 'bc', mark: PENDING },
      { kind: 'delete', entity: 'c', mark: PENDING, had: ['bc'] },
    ])
  })
  it('folds a field set twice into one part and drops one that ends as it began', () => {
    expect(partsOf(BASE, [...ops.move('a', 10, 10), ...ops.move('a', 20, 0)])).toEqual([
      { kind: 'set', entity: 'a', field: 'x', before: { Float: 0 }, after: { Float: 20 }, mark: PENDING },
    ])
  })
  it('sees a Set on a new thing as part of making it', () => {
    expect(partsOf(BASE, [card('n'), ops.setText('n', 'title', 'New')])).toEqual([{ kind: 'create', entity: 'n', mark: PENDING }])
  })
  it('skips an op that does not apply', () => {
    expect(partsOf(BASE, [ops.restore('a')])).toEqual([])
  })
})

describe('mergeParts', () => {
  const create: Part = { kind: 'create', entity: 'n', mark: 3 }
  it('leaves nothing of a thing made and removed in one gesture', () => {
    expect(mergeParts([create, { kind: 'set', entity: 'a', field: 'x', before: { Float: 0 }, after: { Float: 1 }, mark: 3 }], [{ kind: 'delete', entity: 'n', mark: 4 }])).toEqual([
      { kind: 'set', entity: 'a', field: 'x', before: { Float: 0 }, after: { Float: 1 }, mark: 3 },
    ])
  })
  it('takes the later mark for a field set again, the first one for a thing made', () => {
    const set = (v: number, mark: number): Part => ({ kind: 'set', entity: 'a', field: 'x', before: { Float: v - 1 }, after: { Float: v }, mark })
    expect(mergeParts([set(1, 3)], [set(2, 7)])).toEqual([{ kind: 'set', entity: 'a', field: 'x', before: { Float: 0 }, after: { Float: 2 }, mark: 7 }])
    const title: Part = { kind: 'set', entity: 'n', field: 'title', before: 'Null', after: { Text: 'T' }, mark: 9 }
    expect(mergeParts([create], [title], { subsume: true })).toEqual([create])
    expect(mergeParts([create], [title])).toEqual([create, title]) // a later batch: someone may have come in between
  })
  it('cancels a delete and an undelete of the same thing', () => {
    expect(mergeParts([{ kind: 'delete', entity: 'a', mark: 1 }], [{ kind: 'undelete', entity: 'a', mark: 2 }])).toEqual([])
    expect(mergeParts([{ kind: 'undelete', entity: 'a', mark: 1 }], [{ kind: 'delete', entity: 'a', mark: 2 }])).toEqual([])
  })
})

describe('inverse and forward', () => {
  it('takes back and does again each kind of part', () => {
    const set: Part = { kind: 'set', entity: 'a', field: 'x', before: { Float: 0 }, after: { Float: 9 }, mark: 1 }
    expect(inverseOf(set)).toEqual({ Set: { entity: 'a', field: 'x', value: { Float: 0 } } })
    expect(forwardOf(set)).toEqual({ Set: { entity: 'a', field: 'x', value: { Float: 9 } } })
    expect(inverseOf({ kind: 'create', entity: 'n', mark: 1 })).toEqual({ Delete: { entity: 'n' } })
    expect(forwardOf({ kind: 'create', entity: 'n', mark: 1 })).toEqual({ Undelete: { entity: 'n' } })
    expect(inverseOf({ kind: 'delete', entity: 'a', mark: 1 })).toEqual({ Undelete: { entity: 'a' } })
    expect(forwardOf({ kind: 'delete', entity: 'a', mark: 1 })).toEqual({ Delete: { entity: 'a' } })
    expect(inverseOf({ kind: 'undelete', entity: 'a', mark: 1 })).toEqual({ Delete: { entity: 'a' } })
  })
})

describe('touches', () => {
  const set: Part = { kind: 'set', entity: 'a', field: 'title', before: { Text: 'Axions' }, after: { Text: 'Axion' }, mark: 4 }
  const made: Part = { kind: 'create', entity: 'a', mark: 4 }
  const gone: Part = { kind: 'delete', entity: 'a', mark: 4 }
  const block = ops.addBlock({ id: 'blk', card: 'a', text: 'x', order: 'U' })
  const withBlock = after(BASE, [block])
  it('is per field', () => {
    expect(touches(logged(5, ANA, ops.setText('a', 'title', 'A')), set, BASE)).toBe(true)
    expect(touches(logged(5, ANA, ops.setText('a', 'summary', 'A')), set, BASE)).toBe(false)
    expect(touches(logged(5, ANA, ops.setText('b', 'title', 'A')), set, BASE)).toBe(false)
    expect(touches(logged(5, ANA, ops.remove('a')), set, BASE)).toBe(false) // left because it can no longer be set
  })
  it('counts anything belonging to a thing I made: its Page, its Connections, its Sources', () => {
    expect(touches(logged(5, ANA, ops.setStatus('a', 'reading')), made, BASE)).toBe(true)
    expect(touches(logged(5, ANA, block), made, BASE)).toBe(true)
    expect(touches(logged(5, ANA, ops.setBlockText('blk', 'y')), made, withBlock)).toBe(true)
    expect(touches(logged(5, ANA, conn('ca', 'c', 'a')), made, BASE)).toBe(true)
    expect(touches(logged(5, ANA, ops.setText('ab', 'label', 'pairs')), made, BASE)).toBe(true)
    expect(touches(logged(5, ANA, ops.attach({ id: 'at', card: 'a', source: 's' })), made, BASE)).toBe(true)
    expect(touches(logged(5, ANA, ops.setText('c', 'title', 'C')), made, BASE)).toBe(false)
  })
  it('counts bringing back a thing I deleted', () => {
    expect(touches(logged(5, ANA, ops.restore('a')), gone, BASE)).toBe(true)
    expect(touches(logged(5, ANA, block), gone, BASE)).toBe(false)
  })
})

describe('planStep', () => {
  const gesture = [...ops.move('a', 50, 10), ...ops.move('b', 350, 10), ...ops.move('c', 650, 10)]
  const move = (e: Entities) => partsOf(e, gesture, 3)
  const moved = after(BASE, gesture)

  it('takes every part back, newest op first', () => {
    const p = planStep('undo', move(BASE), [], none, moved)
    expect(p.ops).toEqual([...ops.move('c', 600, 0).reverse(), ...ops.move('b', 300, 0).reverse(), ...ops.move('a', 0, 0).reverse()])
    expect(after(moved, p.ops)).toEqual(BASE)
    expect(p.left).toEqual([])
    expect(p.applied).toHaveLength(p.ops.length)
  })
  it('leaves a field someone else changed since, and names them', () => {
    const log = [logged(4, ANA, { Set: { entity: 'b', field: 'x', value: { Float: 999 } } })]
    const world = after(moved, [log[0]!.op])
    const p = planStep('undo', move(BASE), log, none, world)
    expect(p.done).toHaveLength(5)
    expect(p.left).toEqual([expect.objectContaining({ entity: 'b', field: 'x' })])
    expect(p.by).toEqual([ANA])
    expect(p.things).toBe(1)
    const now = after(world, p.ops)
    expect(now.b!.fields.x).toEqual({ Float: 999 })
    expect(now.b!.fields.y).toEqual({ Float: 0 })
    expect(now.a!.fields.x).toEqual({ Float: 0 })
  })
  it('does not count Changes from before the step, or the list’s own', () => {
    const before = [logged(2, ANA, ops.setText('a', 'title', 'A'))]
    expect(planStep('undo', move(BASE), before, none, moved).left).toEqual([])
    const mine = [logged(4, ME, { Set: { entity: 'a', field: 'x', value: { Float: 7 } } }, 'mine')]
    expect(planStep('undo', move(BASE), mine, (id) => id === 'mine', after(moved, [mine[0]!.op])).left).toEqual([])
  })
  it('counts my own Changes from outside the list', () => {
    const elsewhere = [logged(4, ME, { Set: { entity: 'a', field: 'x', value: { Float: 7 } } })]
    const p = planStep('undo', move(BASE), elsewhere, none, after(moved, [elsewhere[0]!.op]))
    expect(p.by).toEqual([ME])
  })
  it('does not remove a Card I added that someone else wrote on the Page of', () => {
    const add = partsOf(BASE, [card('n', 'New')], 3)
    const page = logged(4, ANA, ops.addBlock({ id: 'p1', card: 'n', text: 'Notes', order: 'U' }))
    const world = after(BASE, [card('n', 'New'), page.op])
    const p = planStep('undo', add, [page], none, world)
    expect(p.ops).toEqual([])
    expect(p.by).toEqual([ANA])
  })
  it('brings a deleted Card back and counts its Connections whose other end is gone', () => {
    const e = after(BASE, [conn('ac', 'a', 'c')])
    const del = partsOf(e, [ops.remove('a')], 3)
    const log = [logged(4, ANA, ops.remove('c'))]
    const world = after(e, [ops.remove('a'), ops.remove('c')])
    const p = planStep('undo', del, log, none, world)
    expect(p.ops).toEqual([ops.restore('a')])
    expect(p.cut).toBe(1)
  })
  it('leaves a part that can no longer apply, without a name', () => {
    const set = partsOf(BASE, [ops.setText('a', 'title', 'Axion')], 3)
    const world = after(BASE, [ops.setText('a', 'title', 'Axion'), ops.remove('a')])
    const p = planStep('undo', set, [logged(4, ANA, ops.remove('a'))], none, world)
    expect(p.ops).toEqual([])
    expect(p.by).toEqual([])
    expect(p.left).toHaveLength(1)
  })
  describe('a Card added, then its title typed (two batches of one step)', () => {
    const added = after(BASE, [card('n')])
    const step = mergeParts(partsOf(BASE, [card('n')], 3), partsOf(added, [ops.setText('n', 'title', 'Neutrinos')], 5))
    const world = after(added, [ops.setText('n', 'title', 'Neutrinos')])
    it('takes both back with one Delete', () => {
      const p = planStep('undo', step, [], none, world)
      expect(p.ops).toEqual([ops.remove('n')])
      expect(p.done).toHaveLength(2)
      const r = planStep('redo', remark(p.done, 7), [], none, after(world, p.ops))
      expect(r.ops).toEqual([ops.restore('n')])
    })
    it('keeps both when someone else edited the Card since', () => {
      const log = [logged(6, ANA, ops.setStatus('n', 'reading'))]
      const p = planStep('undo', step, log, none, after(world, [log[0]!.op]))
      expect(p.ops).toEqual([])
      expect(p.by).toEqual([ANA])
      expect(p.things).toBe(1)
    })
    it('gives back a title someone else wrote before mine came', () => {
      const log = [logged(4, ANA, ops.setText('n', 'title', 'Theirs'))]
      const s = mergeParts(partsOf(BASE, [card('n')], 3), partsOf(after(added, [log[0]!.op]), [ops.setText('n', 'title', 'Neutrinos')], 5))
      const p = planStep('undo', s, log, none, world)
      expect(p.ops).toEqual([ops.setText('n', 'title', 'Theirs')])
      expect(p.left).toEqual([expect.objectContaining({ kind: 'create' })])
    })
  })
  it('redoes under the same rule', () => {
    const set = remark(partsOf(BASE, [ops.setText('a', 'title', 'Axion')], 3), 5) // undone at 5
    expect(planStep('redo', set, [], none, BASE).ops).toEqual([ops.setText('a', 'title', 'Axion')])
    const p = planStep('redo', set, [logged(6, ANA, ops.setText('a', 'title', 'Ax'))], none, BASE)
    expect(p.ops).toEqual([])
    expect(p.by).toEqual([ANA])
  })
})

describe('the list', () => {
  it('keeps the last 100 steps, newest first, and a new step clears Redo', () => {
    let l: Lists<number> = { undo: [], redo: [] }
    for (let i = 1; i <= UNDO_DEPTH + 1; i++) l = pushStep(l, i)
    expect(l.undo).toHaveLength(UNDO_DEPTH)
    expect(l.undo[0]).toBe(101)
    expect(l.undo.at(-1)).toBe(2)
    expect(pushStep({ undo: [1], redo: [2, 3] }, 4)).toEqual({ undo: [4, 1], redo: [] })
  })
  it('ends with a Merge or a Restore', () => {
    expect(endsLists('Edit')).toBe(false)
    expect(endsLists({ Restore: { batch: 'x', to_seq: 3 } })).toBe(true)
    expect(endsLists({ Merge: { batch: 'x', source: { branch: 'b', seq: 2 } } })).toBe(true)
  })
})

describe('words', () => {
  const label = (before: Entities, list: Op[]) => labelFor(before, after(before, list), list)
  it('uses History’s words in the present tense', () => {
    expect(label(BASE, [...ops.move('a', 1, 1), ...ops.move('b', 1, 1), ...ops.move('c', 1, 1)])).toBe('Move 3 Cards')
    expect(label(BASE, [ops.remove('a')])).toBe('Delete Card Axions')
    expect(label(BASE, [ops.remove('a'), ops.remove('b'), ops.remove('ab')])).toBe('Delete 2 Cards and 1 Connection')
    expect(label(BASE, [card('n', 'Neutrinos')])).toBe('Add Card Neutrinos')
    expect(label(BASE, [card('n')])).toBe('Add Card Untitled')
    expect(label(BASE, [ops.setText('a', 'title', 'Axion')])).toBe('Rename Card Axions → Axion')
    expect(label(BASE, [ops.setStatus('a', 'understood')])).toBe('Status: Axions → Understood')
    expect(label(BASE, [conn('bc', 'b', 'c')])).toBe('Connect Bosons → Chirality')
    expect(label(BASE, [ops.remove('ab')])).toBe('Disconnect Axions → Bosons')
    expect(label(BASE, [ops.setKind('ab', 'contradicts')])).toBe('Mark Axions → Bosons as contradicts')
    expect(label(BASE, [ops.setText('ab', 'label', 'couples')])).toBe('Label Axions → Bosons: couples')
    expect(label(BASE, ops.resize('a', 300, 200))).toBe('Resize 1 Card')
    expect(label(BASE, [ops.setText('a', 'summary', 'x')])).toBe('Edit the summary of Axions')
    expect(label(BASE, [ops.addBlock({ id: 'k', card: 'a', text: 'x', order: 'U' })])).toBe('Add a block to the Page of Axions')
    const withSource = after(BASE, [ops.createSource({ id: 's', title: 'Peccei–Quinn' })])
    expect(label(withSource, [ops.attach({ id: 't', card: 'a', source: 's' })])).toBe('Add Source Peccei–Quinn to Axions')
    expect(label(BASE, [ops.setText('a', 'title', 'A'), ops.setText('b', 'title', 'B')])).toBe('Rename Card Axions → A and 1 more')
  })
  it('turns History lines around', () => {
    expect(imperative('Removed a block from the Page of X')).toBe('Remove a block from the Page of X')
    expect(imperative('Moved and resized 1 Frame')).toBe('Move and resize 1 Frame')
    expect(imperative('Removed Frame Reading')).toBe('Delete Frame Reading')
    expect(imperative('Reordered the Page of X')).toBe('Reorder the Page of X')
    expect(imperative('Pinned an AI answer to the Page of X')).toBe('Pin an AI answer to the Page of X')
  })
  it('names people', () => {
    expect(names([ANA], nameOf, ME)).toBe('Ana')
    expect(names([ME, ANA], nameOf, ME)).toBe('Ana and you')
    expect(names([ANA, 'ben', 'zed'], nameOf, ME)).toBe('Ana, Ben and Someone')
  })
  it('says what was done', () => {
    const p = (patch: Partial<ReturnType<typeof planStep>>) => ({ ops: [], applied: [], done: [], left: [], by: [], things: 0, cut: 0, ...patch })
    const part: Part = { kind: 'create', entity: 'n', mark: 1 }
    expect(noteFor('undo', 'Move 3 Cards', p({ done: [part] }), nameOf, ME)).toBe('Undid Move 3 Cards.')
    expect(noteFor('undo', 'Move 3 Cards', p({ done: [part], left: [part], by: [ANA], things: 1 }), nameOf, ME)).toBe(
      'Undid Move 3 Cards. 1 left as it is — Ana changed it since.',
    )
    expect(noteFor('undo', 'Move 3 Cards', p({ done: [part], left: [part, part], by: [ANA, 'ben'], things: 2 }), nameOf, ME)).toBe(
      'Undid Move 3 Cards. 2 left as they are — Ana and Ben changed them since.',
    )
    expect(noteFor('undo', 'Rename Card A → B', p({ left: [part], by: [ANA], things: 1 }), nameOf, ME)).toBe('Not undone — Ana changed this since.')
    expect(noteFor('redo', 'Rename Card A → B', p({ left: [part], by: [ME], things: 1 }), nameOf, ME)).toBe('Not redone — you changed this since.')
    expect(noteFor('undo', 'X', p({ left: [part], things: 1 }), nameOf, ME)).toBe('Not undone — it was removed since.')
    expect(noteFor('undo', 'Delete Card Axions', p({ done: [part], cut: 1 }), nameOf, ME)).toBe(
      'Undid Delete Card Axions. 1 Connection left out — the Card at its other end is gone.',
    )
    expect(noteFor('redo', 'Delete Card Axions', p({ done: [part] }), nameOf, ME)).toBe('Redid Delete Card Axions.')
    expect(NOTHING_TO_UNDO).toBe('Nothing to undo. To go further back, use History.')
  })
})

// ---- the randomised test (docs/specs/undo.md, "Pure core") ----

/** A small seeded random source, so that a failure names the seed that makes it again. */
function random(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick<T>(list: readonly T[]): T | undefined {
      return list.length === 0 ? undefined : list[Math.floor(next() * list.length)]
    },
    chance: (p: number) => next() < p,
  }
}

type SimStep = { parts: Part[] }

/** How much the runs exercised, so that the test cannot pass by doing nothing. */
const STATS = { done: 0, left: 0, dropped: 0 }

class Sim {
  world: Entities
  log: Logged[] = []
  seq = 0
  ours = new Set<string>()
  lists: Lists<SimStep> = { undo: [], redo: [] }
  private n = 0
  readonly initial: Entities
  /** The value a field had right before my first Set of it (of things I did not make myself). */
  readonly firstBefore = new Map<string, Value>()
  /** Things I made. Kept when someone else touched them, with the fields I gave them (decision 5). */
  readonly made = new Set<string>()
  /** The value the others last set a field to. */
  readonly otherLast = new Map<string, Value>()
  /** Whether the others' last word on a thing left it live. */
  readonly otherExists = new Map<string, boolean>()
  /** Things the others touched, or touched something belonging to. */
  readonly otherTouched = new Set<string>()

  constructor(world: Entities) {
    this.world = world
    this.initial = world
  }

  commit(list: readonly Op[], author: string, ours: boolean): number {
    const r = applyOps(this.world, list)
    if (!r.ok) throw new Error(`does not apply: ${r.rejection.message} ${JSON.stringify(list)}`)
    for (const op of list) {
      this.seq++
      const id = `c${this.n++}`
      this.log.push({ seq: this.seq, id, author, op, origin: 'Edit' })
      if (ours) this.ours.add(id)
    }
    this.world = r.entities
    return this.seq
  }

  /** A gesture of mine: one or more batches (`between` runs between them: someone else may act). */
  gesture(batches: Op[][], between: () => void = () => {}) {
    let parts: Part[] = []
    batches.forEach((batch, i) => {
      if (i > 0) between()
      if (!applyOps(this.world, batch).ok) return
      for (const op of batch) {
        if ('Create' in op) this.made.add(op.Create.entity)
        if (!('Set' in op) || this.made.has(op.Set.entity)) continue
        const k = `${op.Set.entity}\u0000${op.Set.field}`
        if (!this.firstBefore.has(k)) this.firstBefore.set(k, this.world[op.Set.entity]?.fields[op.Set.field] ?? 'Null')
      }
      const before = this.world
      const mark = this.commit(batch, ME, true)
      parts = mergeParts(parts, partsOf(before, batch, mark))
    })
    if (parts.length > 0) this.lists = pushStep(this.lists, { parts })
  }

  /** A Change by someone else (`ME` from another window counts as someone else: not in the list). */
  other(op: Op, author: string) {
    if (!applyOps(this.world, [op]).ok) return
    const id = 'Create' in op ? op.Create.entity : 'Set' in op ? op.Set.entity : 'Delete' in op ? op.Delete.entity : op.Undelete.entity
    this.otherTouched.add(id)
    const fields = 'Create' in op ? op.Create.fields : this.world[id]?.fields
    for (const name of ['card', 'from', 'to', 'source']) {
      const v = fields?.[name]
      if (typeof v === 'object' && 'Ref' in v) this.otherTouched.add(v.Ref)
    }
    if ('Set' in op) this.otherLast.set(`${id}\u0000${op.Set.field}`, op.Set.value)
    if ('Create' in op || 'Undelete' in op) this.otherExists.set(id, true)
    if ('Delete' in op) this.otherExists.set(id, false)
    this.commit([op], author, false)
  }

  /** One press of Undo or Redo; false when there was nothing. */
  press(direction: 'undo' | 'redo'): boolean {
    const from = direction === 'undo' ? this.lists.undo : this.lists.redo
    const step = from[0]
    if (!step) return false
    const plan = planStep(direction, step.parts, this.log, (id) => this.ours.has(id), this.world)
    STATS.done += plan.done.length
    STATS.left += plan.left.length
    if (plan.done.length === 0) STATS.dropped++
    const rest = from.slice(1)
    if (plan.done.length === 0) {
      this.lists = direction === 'undo' ? { undo: rest, redo: this.lists.redo } : { undo: this.lists.undo, redo: rest }
      return true
    }
    const mark = this.commit(plan.ops, ME, true)
    const moved = { parts: remark(plan.done, mark) }
    this.lists = direction === 'undo' ? { undo: rest, redo: [moved, ...this.lists.redo] } : { undo: [moved, ...this.lists.undo], redo: rest }
    return true
  }
}

const live = (e: Entities, kind: Entity['kind']) => Object.keys(e).filter((id) => e[id]!.kind === kind && !e[id]!.deleted)
const gone = (e: Entities) => Object.keys(e).filter((id) => e[id]!.deleted)

function setup(): Entities {
  const list: Op[] = []
  for (let i = 0; i < 6; i++) list.push(card(`k${i}`, `Card ${i}`, i * 300, 0))
  list.push(conn('q01', 'k0', 'k1'), conn('q12', 'k1', 'k2'), conn('q34', 'k3', 'k4'))
  list.push(ops.addBlock({ id: 'b0', card: 'k0', text: 'zero', order: 'U' }), ops.addBlock({ id: 'b1', card: 'k1', text: 'one', order: 'U' }))
  return board(list)
}

/** Someone else's random Change, valid on the Board as it is. */
function otherOp(r: ReturnType<typeof random>, e: Entities, fresh: () => string): Op | null {
  const cards = live(e, 'Card')
  switch (r.int(9)) {
    case 0:
      return cards.length ? ops.setText(r.pick(cards)!, 'title', `T${r.int(1000)}`) : null
    case 1:
      return cards.length ? ops.move(r.pick(cards)!, r.int(900), r.int(900))[0]! : null
    case 2:
      return cards.length ? ops.setStatus(r.pick(cards)!, r.pick(['reading', 'understood', 'dead_end'] as const)!) : null
    case 3: {
      const all = [...cards, ...live(e, 'Connection'), ...live(e, 'Block')]
      return all.length ? ops.remove(r.pick(all)!) : null
    }
    case 4: {
      const g = gone(e)
      return g.length ? ops.restore(r.pick(g)!) : null
    }
    case 5:
      return ops.createCard({ id: fresh(), x: r.int(900), y: r.int(900), title: 'Theirs' })
    case 6:
      return cards.length ? ops.addBlock({ id: fresh(), card: r.pick(cards)!, text: 'their notes', order: 'V' }) : null
    case 7:
      return cards.length >= 2 ? conn(fresh(), r.pick(cards)!, r.pick(cards)!) : null
    default: {
      const blocks = live(e, 'Block')
      return blocks.length ? ops.setBlockText(r.pick(blocks)!, `text ${r.int(100)}`) : null
    }
  }
}

/** A random gesture of mine, as batches. */
function myGesture(r: ReturnType<typeof random>, e: Entities, fresh: () => string): Op[][] {
  const cards = live(e, 'Card')
  const some = () => [...new Set([r.pick(cards), r.pick(cards), r.pick(cards)].slice(0, 1 + r.int(3)))].filter((x): x is string => !!x)
  switch (r.int(9)) {
    case 0:
      return [some().flatMap((id) => ops.move(id, r.int(900), r.int(900)))]
    case 1:
      return cards.length ? [[ops.setText(r.pick(cards)!, 'title', `Mine ${r.int(1000)}`)]] : []
    case 2: {
      // Adding a Card, then its title typed into it: one step (a join).
      const id = fresh()
      return [[ops.createCard({ id, x: r.int(900), y: r.int(900) })], [ops.setText(id, 'title', 'New')]]
    }
    case 3:
      return cards.length >= 2 ? [[conn(fresh(), r.pick(cards)!, r.pick(cards)!)]] : []
    case 4:
      return [some().map((id) => ops.remove(id))]
    case 5: {
      const c = live(e, 'Connection')
      return c.length ? [[ops.remove(r.pick(c)!)]] : []
    }
    case 6:
      return cards.length ? [[ops.addBlock({ id: fresh(), card: r.pick(cards)!, text: 'mine', order: 'W' })]] : []
    case 7: {
      const b = live(e, 'Block')
      return b.length ? [[ops.setBlockText(r.pick(b)!, `edited ${r.int(100)}`)]] : []
    }
    default:
      return cards.length ? [[ops.setStatus(r.pick(cards)!, 'open_question')]] : []
  }
}

const valueOf = (e: Entity, field: string): string => JSON.stringify(e.fields[field] ?? 'Null')

/**
 * Undone as far as it goes, every field I set is as it was before my gesture or as the others last set it; none of
 * their Changes is lost; and everything the others never touched is exactly as it was before I began.
 */
function check(sim: Sim, seed: number) {
  const w = sim.world
  const where = `seed ${seed}`
  for (const [k, v0] of sim.firstBefore) {
    const [id, field] = k.split('\u0000') as [string, string]
    const e = w[id]
    if (!e || e.deleted) continue
    const now = valueOf(e, field)
    const allowed = [JSON.stringify(v0)]
    if (sim.otherLast.has(k)) allowed.push(JSON.stringify(sim.otherLast.get(k)))
    expect(allowed, `${where}: ${id}.${field}`).toContain(now)
  }
  for (const [k, v] of sim.otherLast) {
    const [id, field] = k.split('\u0000') as [string, string]
    const e = w[id]
    if (!e || e.deleted) continue
    expect(valueOf(e, field), `${where}: their ${id}.${field}`).toBe(JSON.stringify(v))
  }
  for (const [id, exists] of sim.otherExists) expect(!w[id]!.deleted, `${where}: their ${id}`).toBe(exists)
  for (const id of Object.keys(w)) {
    if (sim.otherTouched.has(id)) continue
    const was = sim.initial[id]
    if (!was) expect(w[id]!.deleted, `${where}: my new ${id} is gone`).toBe(true)
    else expect(w[id], `${where}: ${id} as it was`).toEqual(was)
  }
}

describe('randomised: my gestures among another Member’s Changes', () => {
  function run(seed: number, options: { pressDuring: boolean }) {
    const r = random(seed)
    const sim = new Sim(setup())
    let n = 0
    const fresh = () => `n${seed}_${n++}`
    const others = () => {
      const op = otherOp(r, sim.world, fresh)
      if (op) sim.other(op, r.chance(0.2) ? ME : ANA) // now and then: me, in another window
    }
    for (let i = 0; i < 40; i++) {
      const roll = r.next()
      if (roll < 0.45) sim.gesture(myGesture(r, sim.world, fresh), () => r.chance(0.5) && others())
      else if (roll < 0.8 || !options.pressDuring) others()
      else sim.press(r.chance(0.6) ? 'undo' : 'redo')
    }
    // Undo as far as it goes. Every plan must apply as it is (commit throws otherwise).
    let presses = 0
    while (sim.press('undo')) presses++
    expect(presses).toBeLessThanOrEqual(UNDO_DEPTH + 40)
    check(sim, seed)
  }
  it('gestures and Changes interleaved, then undone as far as it goes', () => {
    for (let seed = 1; seed <= 300; seed++) run(seed, { pressDuring: false })
    expect(STATS.done).toBeGreaterThan(1000)
    expect(STATS.left).toBeGreaterThan(100)
    expect(STATS.dropped).toBeGreaterThan(10)
  })
  it('with Undo and Redo pressed along the way too', () => {
    for (let seed = 1001; seed <= 1300; seed++) run(seed, { pressDuring: true })
  })
})
