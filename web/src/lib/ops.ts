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
  remove(entity: string): Op {
    return { Delete: { entity } }
  },
  restore(entity: string): Op {
    return { Undelete: { entity } }
  },
}
