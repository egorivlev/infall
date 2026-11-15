// Pure op builders. Output matches the wire format in docs/specs/api.md.
import { isEnvName, isLangId, PYTHON } from './run-lang'
import { encodeRunResult } from './run-result'
import type { ConnectionKind, Fields, Op, RunResult, Status, Value } from './types'

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
  addBlock(input: { id?: string; card: string; text: string; order: string; type?: 'text' | 'visual' | 'run'; title?: string }): Op {
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
  /**
   * Records the captured output of a Run's execution (api.md §15), or clears it with null. Throws `RangeError`
   * when `result` is not a §15 result or its JSON is over 600 000 characters.
   */
  setRunResult(block: string, result: RunResult | null): Op {
    return set(block, 'result', result === null ? 'Null' : txt(encodeRunResult(result)))
  },
  /**
   * The language of a Run (api.md §15 "Languages"): an id, `^[a-z][a-z0-9_-]{0,23}$`. Python, and null, unset it —
   * a Run without `lang` is Python, so a Run made Python again is stored as every Run before M19b. Throws `RangeError`
   * for anything else.
   */
  setRunLang(block: string, lang: string | null): Op {
    if (lang !== null && !isLangId(lang)) throw new RangeError('A language id is a lowercase letter, then up to 23 lowercase letters, digits, - or _.')
    return set(block, 'lang', lang === null || lang === PYTHON ? 'Null' : txt(lang))
  },
  /**
   * The environment a Run asks for (Python and Q#; desktop.md M19): one line of 1–60 characters, no space at either
   * end, nothing invisible. '' and null unset it (the default environment). Throws `RangeError` for anything else.
   */
  setRunEnv(block: string, env: string | null): Op {
    if (env !== null && env !== '' && !isEnvName(env)) throw new RangeError('An environment name is one line of 1–60 characters.')
    return set(block, 'env', env === null || env === '' ? 'Null' : txt(env))
  },
  /** A text Block pinned from an AI Conversation: it carries what produced it, who pinned it, and when (unix ms). */
  pinBlock(input: { id?: string; card: string; text: string; order: string; model: string; pinnedBy: string; pinnedAt: number }): Op {
    if (input.pinnedBy === '') throw new RangeError('A pinned block needs the Member who pinned it.')
    const fields: Fields = { card: { Ref: input.card }, type: txt('text'), order: txt(orderKey(input.order)) }
    if (input.text !== '') fields.text = txt(input.text)
    if (input.model !== '') fields.ai_model = txt(input.model)
    fields.ai_pinned_by = txt(input.pinnedBy)
    fields.ai_pinned_at = num(input.pinnedAt)
    return { Create: { entity: input.id ?? newId(), kind: 'Block', fields } }
  },
  /** Marks a pinned Block as reviewed by a Member; '' takes the mark back. */
  markReviewed(block: string, memberId: string): Op {
    return set(block, 'ai_reviewed_by', memberId === '' ? 'Null' : txt(memberId))
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
