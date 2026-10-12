// Where Conversations are kept: one JSON value per Member in localStorage, on this device only. Nothing here may
// throw — storage can be full, blocked or hold anything — and nothing secret is ever written (an access token is
// not part of a Conversation).
import type { AiConversation, AiMessage, AiScope } from './types'

export const MAX_CONVERSATIONS = 30
export const MAX_MESSAGES = 200
export const CUT_OFF = 'The answer was cut off.'

const VERSION = 1

/** A Conversation as stored: with the Claude Code session to resume it with, when there is one. */
export type StoredConversation = AiConversation & { session?: string }
export type AiMemory = { conversations: StoredConversation[]; current: string | null }

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function storageKey(memberId: string): string {
  return `qoop.ai.${memberId}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readScope(v: unknown): AiScope | undefined {
  if (!isRecord(v) || !isText(v.branch) || !isText(v.branchName)) return undefined
  const scope: AiScope = { branch: v.branch, branchName: v.branchName }
  if (isRecord(v.card) && isText(v.card.id) && isText(v.card.title)) scope.card = { id: v.card.id, title: v.card.title }
  return scope
}

function readMessage(v: unknown): AiMessage | null {
  if (!isRecord(v) || !isText(v.id) || !isText(v.text) || !isTime(v.at)) return null
  if (v.role !== 'user' && v.role !== 'assistant') return null
  if (v.status !== 'done' && v.status !== 'streaming' && v.status !== 'error' && v.status !== 'stopped') return null
  const message: AiMessage = { id: v.id, role: v.role, text: v.text, at: v.at, status: v.status }
  if (isText(v.error)) message.error = v.error
  // An answer that was still arriving when the page went away never ended.
  if (message.status === 'streaming') {
    message.status = 'error'
    message.error = CUT_OFF
  }
  if (Array.isArray(v.tools) && v.tools.length > 0 && v.tools.every(isText)) message.tools = v.tools
  if (isText(v.model)) message.model = v.model
  const scope = readScope(v.scope)
  if (scope) message.scope = scope
  if (Array.isArray(v.pinned)) {
    const pinned: NonNullable<AiMessage['pinned']> = []
    for (const p of v.pinned) {
      if (isRecord(p) && isText(p.card) && isText(p.cardTitle) && isText(p.block)) pinned.push({ card: p.card, cardTitle: p.cardTitle, block: p.block })
    }
    if (pinned.length > 0) message.pinned = pinned
  }
  return message
}

function readConversation(v: unknown): StoredConversation | null {
  if (!isRecord(v) || !isText(v.id) || !isText(v.title) || !isTime(v.createdAt) || !isTime(v.updatedAt)) return null
  if (!Array.isArray(v.messages)) return null
  const messages = v.messages.map(readMessage).filter((m): m is AiMessage => m !== null)
  if (messages.length === 0) return null
  const conversation: StoredConversation = { id: v.id, title: v.title, createdAt: v.createdAt, updatedAt: v.updatedAt, messages }
  if (isText(v.session) && v.session !== '') conversation.session = v.session
  return conversation
}

const newestFirst = (a: AiConversation, b: AiConversation) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The limits: at most 200 messages in a Conversation (the oldest go) and at most 30 Conversations (those not
 * touched for longest go; the ones named in `keep` — the open one, the one being answered — always stay).
 * The same array, and the same Conversations, come back when nothing had to go.
 */
export function withinLimits<T extends AiConversation>(conversations: T[], keep: readonly (string | null)[] = []): T[] {
  let changed = false
  let out = conversations.map((c) => {
    if (c.messages.length <= MAX_MESSAGES) return c
    changed = true
    return { ...c, messages: c.messages.slice(-MAX_MESSAGES) }
  })
  if (out.length > MAX_CONVERSATIONS) {
    const kept = new Set<string>()
    for (const c of out) if (keep.includes(c.id)) kept.add(c.id)
    for (const c of [...out].sort(newestFirst)) {
      if (kept.size >= MAX_CONVERSATIONS) break
      kept.add(c.id)
    }
    out = out.filter((c) => kept.has(c.id))
    changed = true
  }
  return changed ? out : conversations
}

/** What is stored for a Member. Anything unreadable — no value, broken JSON, another version, a blocked storage — reads as nothing. */
export function loadAi(storage: StorageLike | undefined, memberId: string): AiMemory {
  const empty: AiMemory = { conversations: [], current: null }
  if (!storage) return empty
  try {
    const raw = storage.getItem(storageKey(memberId))
    if (raw === null) return empty
    const json: unknown = JSON.parse(raw)
    if (!isRecord(json) || json.v !== VERSION || !Array.isArray(json.conversations)) return empty
    const seen = new Set<string>()
    const conversations: StoredConversation[] = []
    for (const item of json.conversations) {
      const c = readConversation(item)
      if (!c || seen.has(c.id)) continue
      seen.add(c.id)
      conversations.push(c)
    }
    const kept = withinLimits(conversations)
    const current = isText(json.current) && kept.some((c) => c.id === json.current) ? json.current : null
    return { conversations: kept, current }
  } catch {
    return empty
  }
}

/**
 * Writes a Member's Conversations, within the limits. When storage refuses (full), it tries again with the newer
 * half, and again, down to the newest one; false when nothing could be written — the caller goes on in memory.
 */
export function saveAi(storage: StorageLike | undefined, memberId: string, memory: AiMemory): boolean {
  if (!storage) return false
  let list = [...withinLimits(memory.conversations, [memory.current])].sort(newestFirst)
  for (;;) {
    const current = list.some((c) => c.id === memory.current) ? memory.current : null
    try {
      storage.setItem(storageKey(memberId), JSON.stringify({ v: VERSION, current, conversations: list }))
      return true
    } catch {
      if (list.length <= 1) return false
      list = list.slice(0, Math.ceil(list.length / 2))
    }
  }
}
