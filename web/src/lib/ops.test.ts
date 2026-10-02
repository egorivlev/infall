import { describe, expect, it } from 'vitest'
import { newId, ops } from './ops'

describe('op builders', () => {
  it('newId is a uuid', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('createCard rounds coordinates and omits unset fields', () => {
    expect(ops.createCard({ id: 'a', x: 10.6, y: -0.4 })).toEqual({
      Create: { entity: 'a', kind: 'Card', fields: { x: { Float: 11 }, y: { Float: 0 } } },
    })
    expect(Object.is((ops.createCard({ id: 'a', x: -0.4, y: 0 }) as any).Create.fields.x.Float, -0)).toBe(false)
  })
  it('createCard with title and status; generates an id', () => {
    const op = ops.createCard({ x: 1, y: 2, title: 'T', status: 'reading' })
    if (!('Create' in op)) throw new Error('not create')
    expect(op.Create.entity).toHaveLength(36)
    expect(op.Create.fields).toEqual({
      x: { Float: 1 },
      y: { Float: 2 },
      title: { Text: 'T' },
      status: { Text: 'reading' },
    })
  })
  it('createFrame', () => {
    expect(ops.createFrame({ id: 'f', x: 1.2, y: 2.5, w: 100.4, h: 50, title: 'F' })).toEqual({
      Create: {
        entity: 'f',
        kind: 'Frame',
        fields: { x: { Float: 1 }, y: { Float: 3 }, w: { Float: 100 }, h: { Float: 50 }, title: { Text: 'F' } },
      },
    })
  })
  it('createConnection', () => {
    expect(ops.createConnection({ id: 'c', from: 'a', to: 'b', kind: 'contradicts', label: 'but' })).toEqual({
      Create: {
        entity: 'c',
        kind: 'Connection',
        fields: { from: { Ref: 'a' }, to: { Ref: 'b' }, kind: { Text: 'contradicts' }, label: { Text: 'but' } },
      },
    })
    expect(ops.createConnection({ id: 'c', from: 'a', to: 'b' })).toEqual({
      Create: { entity: 'c', kind: 'Connection', fields: { from: { Ref: 'a' }, to: { Ref: 'b' } } },
    })
  })
  it('set builders', () => {
    expect(ops.setText('a', 'title', 'x')).toEqual({ Set: { entity: 'a', field: 'title', value: { Text: 'x' } } })
    expect(ops.setText('a', 'summary', '')).toEqual({ Set: { entity: 'a', field: 'summary', value: 'Null' } })
    expect(ops.setStatus('a', 'dead_end')).toEqual({
      Set: { entity: 'a', field: 'status', value: { Text: 'dead_end' } },
    })
    expect(ops.setKind('c', 'directed')).toEqual({
      Set: { entity: 'c', field: 'kind', value: { Text: 'directed' } },
    })
  })
  it('move and resize are two Sets with whole numbers', () => {
    expect(ops.move('a', 40.4, 80.6)).toEqual([
      { Set: { entity: 'a', field: 'x', value: { Float: 40 } } },
      { Set: { entity: 'a', field: 'y', value: { Float: 81 } } },
    ])
    expect(ops.resize('a', 300.2, 200.9)).toEqual([
      { Set: { entity: 'a', field: 'w', value: { Float: 300 } } },
      { Set: { entity: 'a', field: 'h', value: { Float: 201 } } },
    ])
  })
  it('remove and restore', () => {
    expect(ops.remove('a')).toEqual({ Delete: { entity: 'a' } })
    expect(ops.restore('a')).toEqual({ Undelete: { entity: 'a' } })
  })
  it('rejects non-finite coordinates', () => {
    expect(() => ops.move('a', NaN, 0)).toThrow(RangeError)
  })
})
