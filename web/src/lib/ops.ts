// Pure op builders. Output matches the wire format in docs/specs/api.md.
import type { ConnectionKind, Fields, Op, Status, Value } from './types'

export function newId(): string {
  return crypto.randomUUID()
}

function whole(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError('Coordinates and sizes must be finite numbers.')
  const r = Math.round(n)
  return r === 0 ? 0 : r // normalise -0
}

const num = (n: number): Value => ({ Float: whole(n) })
const txt = (s: string): Value => ({ Text: s })
const set = (entity: string, field: string, value: Value): Op => ({ Set: { entity, field, value } })

const SOURCE_FIELDS = ['url', 'doi', 'title', 'authors', 'year', 'note'] as const
type SourceField = (typeof SOURCE_FIELDS)[number]

// What identifies a Source is stored without the spaces a paste brings along; the other fields as typed.
function sourceText(field: SourceField, text: string): string {
  return field === 'url' || field === 'doi' ? text.trim() : text
}

function orderKey(order: string): string {
  if (order === '') throw new RangeError('A block needs an order key.')
  return order
}

export const ops = {
  createCard(input: { id?: string; x: number; y: number; title?: string; status?: Status }): Op {
    const fields: Fields = { x: num(input.x), y: num(input.y) }
    if (input.title) fields.title = txt(input.title)
    if (input.status) fields.status = txt(input.status)
    return { Create: { entity: input.id ?? newId(), kind: 'Card', fields } }
  },
  createFrame(input: { id?: string; x: number; y: number; w: number; h: number; title?: string }): Op {
    const fields: Fields = { x: num(input.x), y: num(input.y), w: num(input.w), h: num(input.h) }
    if (input.title) fields.title = txt(input.title)
    return { Create: { entity: input.id ?? newId(), kind: 'Frame', fields } }
  },
  createConnection(input: {
    id?: string
    from: string
    to: string
    kind?: ConnectionKind
    label?: string
  }): Op {
    const fields: Fields = { from: { Ref: input.from }, to: { Ref: input.to } }
    if (input.kind) fields.kind = txt(input.kind)
    if (input.label) fields.label = txt(input.label)
    return { Create: { entity: input.id ?? newId(), kind: 'Connection', fields } }
  },
  setText(entity: string, field: 'title' | 'summary' | 'label', text: string): Op {
    return set(entity, field, text === '' ? 'Null' : txt(text))
  },
  setStatus(card: string, status: Status): Op {
    return set(card, 'status', txt(status))
  },
  setKind(connection: string, kind: ConnectionKind): Op {
    return set(connection, 'kind', txt(kind))
  },
  move(entity: string, x: number, y: number): Op[] {
    return [set(entity, 'x', num(x)), set(entity, 'y', num(y))]
  },
  resize(entity: string, w: number, h: number): Op[] {
    return [set(entity, 'w', num(w)), set(entity, 'h', num(h))]
  },
  addBlock(input: { id?: string; card: string; text: string; order: string; type?: 'text' | 'visual'; title?: string }): Op {
    const fields: Fields = { card: { Ref: input.card }, type: txt(input.type ?? 'text'), order: txt(orderKey(input.order)) }
    if (input.text !== '') fields.text = txt(input.text)
    if (input.title) fields.title = txt(input.title)
    return { Create: { entity: input.id ?? newId(), kind: 'Block', fields } }
  },
  setBlockText(block: string, text: string): Op {
    return set(block, 'text', text === '' ? 'Null' : txt(text))
  },
  setBlockTitle(block: string, title: string): Op {
    return set(block, 'title', title === '' ? 'Null' : txt(title))
  },
  moveBlock(block: string, order: string): Op {
    return set(block, 'order', txt(orderKey(order)))
  },
  createSource(input: {
    id?: string
    url?: string
    doi?: string
    title?: string
    authors?: string
    year?: string
    note?: string
  }): Op {
    const fields: Fields = {}
    for (const name of SOURCE_FIELDS) {
      const value = sourceText(name, input[name] ?? '')
      if (value !== '') fields[name] = txt(value)
    }
    return { Create: { entity: input.id ?? newId(), kind: 'Source', fields } }
  },
  setSourceField(source: string, field: SourceField, text: string): Op {
    const value = sourceText(field, text)
    return set(source, field, value === '' ? 'Null' : txt(value))
  },
  attach(input: { id?: string; card: string; source: string }): Op {
    const fields: Fields = { card: { Ref: input.card }, source: { Ref: input.source } }
    return { Create: { entity: input.id ?? newId(), kind: 'Attachment', fields } }
  },
  remove(entity: string): Op {
    return { Delete: { entity } }
  },
  restore(entity: string): Op {
    return { Undelete: { entity } }
  },
}
