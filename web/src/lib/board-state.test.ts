import { describe, expect, it } from 'vitest'
import { applyOp, applyOps, toSnapshotParts } from './board-state'
import type { Entities } from './board-state'
import { ops } from './ops'
import { CARD_H, CARD_W } from './types'
import type { Op } from './types'

const run = (e: Entities, o: Op) => {
  const r = applyOp(e, o)
  if (!r.ok) throw new Error(r.rejection.message)
  return r.entities
}
const code = (e: Entities, o: Op) => {
  const r = applyOp(e, o)
  return r.ok ? 'ok' : r.rejection.code
}

const card = (id: string, extra = {}): Op => ops.createCard({ id, x: 1, y: 2, ...extra })

describe('applyOp', () => {
  it('creates and does not mutate the input', () => {
    const before: Entities = {}
    const after = run(before, card('a'))
    expect(before).toEqual({})
    expect(after.a).toEqual({ kind: 'Card', deleted: false, fields: { x: { Float: 1 }, y: { Float: 2 } } })
  })
  it('rejects Create when the id exists, even if deleted', () => {
    let e = run({}, card('a'))
    expect(code(e, card('a'))).toBe('exists')
    e = run(e, ops.remove('a'))
    expect(code(e, card('a'))).toBe('exists')
  })
  it('Create drops Null fields', () => {
    const e = run({}, { Create: { entity: 'a', kind: 'Card', fields: { title: 'Null', x: { Float: 1 } } } })
    expect(e.a?.fields).toEqual({ x: { Float: 1 } })
  })
  it('rejects non-finite floats', () => {
    expect(code({}, { Create: { entity: 'a', kind: 'Card', fields: { x: { Float: NaN } } } })).toBe('invalid')
    const e = run({}, card('a'))
    expect(code(e, { Set: { entity: 'a', field: 'x', value: { Float: Infinity } } })).toBe('invalid')
  })
  it('Connection needs two existing Cards (live or deleted)', () => {
    let e = run({}, card('a'))
    const c = ops.createConnection({ id: 'c', from: 'a', to: 'b' })
    expect(code(e, c)).toBe('invalid')
    e = run(run(e, card('b')), ops.remove('b'))
    expect(code(e, c)).toBe('ok')
    const f = run(e, ops.createFrame({ id: 'f', x: 0, y: 0, w: 1, h: 1 }))
    expect(code(f, ops.createConnection({ id: 'c2', from: 'a', to: 'f' }))).toBe('invalid')
  })
  it('Set updates a field; Null removes it', () => {
    let e = run({}, card('a'))
    e = run(e, ops.setText('a', 'title', 'Hi'))
    expect(e.a?.fields.title).toEqual({ Text: 'Hi' })
    e = run(e, ops.setText('a', 'title', ''))
    expect('title' in (e.a?.fields ?? {})).toBe(false)
  })
  it('Set and Delete are rejected on a missing entity', () => {
    expect(code({}, ops.setStatus('zz', 'idea'))).toBe('missing')
    expect(code({}, ops.remove('zz'))).toBe('missing')
    expect(code({}, ops.restore('zz'))).toBe('missing')
  })
  it('Set and Delete are rejected on a deleted entity', () => {
    const e = run(run({}, card('a')), ops.remove('a'))
    expect(code(e, ops.setStatus('a', 'idea'))).toBe('deleted')
    expect(code(e, ops.remove('a'))).toBe('deleted')
  })
  it('Undelete only works on a deleted entity', () => {
    const live = run({}, card('a'))
    expect(code(live, ops.restore('a'))).toBe('not_deleted')
    const gone = run(live, ops.remove('a'))
    expect(run(gone, ops.restore('a')).a?.deleted).toBe(false)
  })
  it('applyOps is all-or-nothing and sees earlier ops of the batch', () => {
    const r = applyOps({}, [card('a'), ops.setStatus('a', 'reading')])
    expect(r.ok).toBe(true)
    const bad = applyOps({}, [card('a'), ops.remove('nope')])
    expect(bad.ok).toBe(false)
  })
})

describe('toSnapshotParts', () => {
  it('applies defaults', () => {
    const e = run(run({}, card('a')), ops.createFrame({ id: 'f', x: 5, y: 6, w: 7, h: 8 }))
    const p = toSnapshotParts(e)
    expect(p.cards).toEqual([
      { id: 'a', title: '', summary: '', status: 'idea', x: 1, y: 2, w: CARD_W, h: CARD_H },
    ])
    expect(p.frames).toEqual([{ id: 'f', title: '', x: 5, y: 6, w: 7, h: 8 }])
  })
  it('connection kind defaults to related and unknown status falls back to idea', () => {
    let e = run(run({}, card('a')), card('b'))
    e = run(e, ops.createConnection({ id: 'c', from: 'a', to: 'b' }))
    e = run(e, { Set: { entity: 'a', field: 'status', value: { Text: 'bogus' } } })
    const p = toSnapshotParts(e)
    expect(p.connections[0]?.kind).toBe('related')
    expect(p.cards[0]?.status).toBe('idea')
  })
  it('orders by id and hides deleted entities', () => {
    let e: Entities = {}
    for (const id of ['c', 'a', 'b']) e = run(e, card(id))
    e = run(e, ops.remove('b'))
    expect(toSnapshotParts(e).cards.map((c) => c.id)).toEqual(['a', 'c'])
  })
  it('hides a Connection while an endpoint Card is deleted, and shows it again after Undelete', () => {
    let e = run(run({}, card('a')), card('b'))
    e = run(e, ops.createConnection({ id: 'c', from: 'a', to: 'b', kind: 'directed' }))
    expect(toSnapshotParts(e).connections).toHaveLength(1)
    e = run(e, ops.remove('b'))
    expect(toSnapshotParts(e).connections).toHaveLength(0)
    e = run(e, ops.restore('b'))
    expect(toSnapshotParts(e).connections[0]?.kind).toBe('directed')
    e = run(e, ops.remove('c'))
    expect(toSnapshotParts(e).connections).toHaveLength(0)
  })
  it('keeps identity of arrays and items when nothing changed', () => {
    let e = run(run({}, card('a')), card('b'))
    const p1 = toSnapshotParts(e)
    const p2 = toSnapshotParts({ ...e }, p1)
    expect(p2.cards).toBe(p1.cards)
    e = run(e, ops.setText('a', 'title', 'x'))
    const p3 = toSnapshotParts(e, p2)
    expect(p3.cards).not.toBe(p2.cards)
    expect(p3.cards[1]).toBe(p2.cards[1])
    expect(p3.frames).toBe(p2.frames)
  })
})
