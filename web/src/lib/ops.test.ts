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

  it('addBlock creates a text block of a Card at an order key', () => {
    expect(ops.addBlock({ id: 'k', card: 'a', text: 'Hello $x$', order: 'V' })).toEqual({
      Create: {
        entity: 'k',
        kind: 'Block',
        fields: { card: { Ref: 'a' }, type: { Text: 'text' }, order: { Text: 'V' }, text: { Text: 'Hello $x$' } },
      },
    })
  })
  it('addBlock leaves an empty text unset, generates an id and refuses an empty order', () => {
    const op = ops.addBlock({ card: 'a', text: '', order: 'V' })
    if (!('Create' in op)) throw new Error('not create')
    expect(op.Create.entity).toHaveLength(36)
    expect(op.Create.fields).toEqual({ card: { Ref: 'a' }, type: { Text: 'text' }, order: { Text: 'V' } })
    expect(() => ops.addBlock({ card: 'a', text: 'x', order: '' })).toThrow(RangeError)
  })
  it('addBlock creates a Visual with its source and title', () => {
    expect(ops.addBlock({ id: 'v', card: 'a', type: 'visual', text: '<canvas></canvas>', title: 'Demo', order: 'V' })).toEqual({
      Create: {
        entity: 'v',
        kind: 'Block',
        fields: {
          card: { Ref: 'a' },
          type: { Text: 'visual' },
          order: { Text: 'V' },
          text: { Text: '<canvas></canvas>' },
          title: { Text: 'Demo' },
        },
      },
    })
  })
  it('addBlock leaves an empty or missing title unset, and an explicit text type is the default', () => {
    const fields = { card: { Ref: 'a' }, type: { Text: 'visual' }, order: { Text: 'V' } }
    expect(ops.addBlock({ id: 'v', card: 'a', type: 'visual', text: '', order: 'V' })).toEqual({ Create: { entity: 'v', kind: 'Block', fields } })
    expect(ops.addBlock({ id: 'v', card: 'a', type: 'visual', text: '', title: '', order: 'V' })).toEqual({ Create: { entity: 'v', kind: 'Block', fields } })
    expect(ops.addBlock({ id: 'k', card: 'a', type: 'text', text: 'x', order: 'V' })).toEqual(ops.addBlock({ id: 'k', card: 'a', text: 'x', order: 'V' }))
    expect(JSON.stringify(ops.addBlock({ id: 'k', card: 'a', text: 'x', order: 'V' }))).toBe(
      '{"Create":{"entity":"k","kind":"Block","fields":{"card":{"Ref":"a"},"type":{"Text":"text"},"order":{"Text":"V"},"text":{"Text":"x"}}}}',
    )
  })
  it('setBlockTitle; an empty title sets Null', () => {
    expect(ops.setBlockTitle('v', ' Demo ')).toEqual({ Set: { entity: 'v', field: 'title', value: { Text: ' Demo ' } } })
    expect(ops.setBlockTitle('v', '')).toEqual({ Set: { entity: 'v', field: 'title', value: 'Null' } })
  })
  it('setBlockText; an empty text sets Null and the block stays', () => {
    expect(ops.setBlockText('k', '  kept as typed ')).toEqual({
      Set: { entity: 'k', field: 'text', value: { Text: '  kept as typed ' } },
    })
    expect(ops.setBlockText('k', '')).toEqual({ Set: { entity: 'k', field: 'text', value: 'Null' } })
  })
  it('moveBlock sets the order key', () => {
    expect(ops.moveBlock('k', 'Vz')).toEqual({ Set: { entity: 'k', field: 'order', value: { Text: 'Vz' } } })
    expect(() => ops.moveBlock('k', '')).toThrow(RangeError)
  })
  it('createSource keeps the fields given, trims what identifies it, omits the rest', () => {
    expect(
      ops.createSource({
        id: 's',
        url: ' https://example.com/p ',
        doi: ' 10.1000/Xyz\n',
        title: 'A paper',
        authors: 'A. Author, B. Author',
        year: '1997',
        note: ' as typed ',
      }),
    ).toEqual({
      Create: {
        entity: 's',
        kind: 'Source',
        fields: {
          url: { Text: 'https://example.com/p' },
          doi: { Text: '10.1000/Xyz' },
          title: { Text: 'A paper' },
          authors: { Text: 'A. Author, B. Author' },
          year: { Text: '1997' },
          note: { Text: ' as typed ' },
        },
      },
    })
    const bare = ops.createSource({ url: 'https://example.com', title: '', doi: '   ' })
    if (!('Create' in bare)) throw new Error('not create')
    expect(bare.Create.entity).toHaveLength(36)
    expect(bare.Create.kind).toBe('Source')
    expect(bare.Create.fields).toEqual({ url: { Text: 'https://example.com' } })
  })
  it('setSourceField; an empty text sets Null', () => {
    expect(ops.setSourceField('s', 'year', '2001')).toEqual({ Set: { entity: 's', field: 'year', value: { Text: '2001' } } })
    expect(ops.setSourceField('s', 'doi', ' 10.1000/x ')).toEqual({ Set: { entity: 's', field: 'doi', value: { Text: '10.1000/x' } } })
    expect(ops.setSourceField('s', 'note', '')).toEqual({ Set: { entity: 's', field: 'note', value: 'Null' } })
    expect(ops.setSourceField('s', 'url', '  ')).toEqual({ Set: { entity: 's', field: 'url', value: 'Null' } })
  })
  it('attach joins a Card and a Source; remove and restore work on the new kinds', () => {
    expect(ops.attach({ id: 't', card: 'a', source: 's' })).toEqual({
      Create: { entity: 't', kind: 'Attachment', fields: { card: { Ref: 'a' }, source: { Ref: 's' } } },
    })
    const op = ops.attach({ card: 'a', source: 's' })
    if (!('Create' in op)) throw new Error('not create')
    expect(op.Create.entity).toHaveLength(36)
    expect(ops.remove('t')).toEqual({ Delete: { entity: 't' } })
    expect(ops.restore('t')).toEqual({ Undelete: { entity: 't' } })
  })
})
