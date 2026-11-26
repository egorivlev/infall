import { describe, expect, it } from 'vitest'
import { MAX_CONVERSATIONS, MAX_MESSAGES, loadAi, saveAi, storageKey, withinLimits } from './ai-storage'
import type { StoredConversation } from './ai-storage'
import type { AiMessage } from './types'

const message = (id: string, role: AiMessage['role'] = 'user'): AiMessage => ({ id, role, text: id, at: 1, status: 'done' })
const conversation = (id: string, updatedAt: number, count = 1): StoredConversation => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt,
  messages: Array.from({ length: count }, (_, i) => message(`${id}-${i}`)),
})

function memory() {
  const data = new Map<string, string>()
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}

describe('withinLimits', () => {
  it('returns the same array when nothing has to go', () => {
    const list = [conversation('a', 1, MAX_MESSAGES), conversation('b', 2)]
    expect(withinLimits(list)).toBe(list)
  })
  it('drops the oldest messages beyond 200 and leaves other Conversations as they are', () => {
    const list = [conversation('a', 1, MAX_MESSAGES + 3), conversation('b', 2)]
    const out = withinLimits(list)
    expect(out[0]!.messages).toHaveLength(MAX_MESSAGES)
    expect(out[0]!.messages[0]!.id).toBe('a-3')
    expect(out[1]).toBe(list[1])
  })
  it('drops the Conversations untouched for longest beyond 30, never the ones to keep', () => {
    const list = Array.from({ length: MAX_CONVERSATIONS + 2 }, (_, i) => conversation(`c${i}`, i))
    expect(withinLimits(list).map((c) => c.id)).toEqual(list.slice(2).map((c) => c.id))
    const kept = withinLimits(list, ['c0', null]).map((c) => c.id)
    expect(kept).toHaveLength(MAX_CONVERSATIONS)
    expect(kept).toContain('c0')
    expect(kept).not.toContain('c1')
    expect(kept).not.toContain('c2')
  })
})

describe('loadAi / saveAi', () => {
  it('round-trips under a key that names the Member, as { v: 1, … }', () => {
    const storage = memory()
    const list = [conversation('a', 1), { ...conversation('b', 2), session: 'sess' }]
    expect(saveAi(storage, 'me', { conversations: list, current: 'b' })).toBe(true)
    expect([...storage.data.keys()]).toEqual([storageKey('me')])
    expect(storageKey('me')).toBe('infall.ai.me')
    expect(JSON.parse(storage.data.get('infall.ai.me')!)).toMatchObject({ v: 1, current: 'b' })
    const back = loadAi(storage, 'me')
    expect(back.current).toBe('b')
    expect(back.conversations).toEqual([list[1], list[0]])
    expect(loadAi(storage, 'other')).toEqual({ conversations: [], current: null })
  })
  it('applies the limits on write and forgets a current Conversation that is not stored', () => {
    const storage = memory()
    const list = Array.from({ length: MAX_CONVERSATIONS + 5 }, (_, i) => conversation(`c${i}`, i, i === 34 ? MAX_MESSAGES + 10 : 1))
    saveAi(storage, 'me', { conversations: list, current: 'draft' })
    const back = loadAi(storage, 'me')
    expect(back.conversations).toHaveLength(MAX_CONVERSATIONS)
    expect(back.conversations[0]!.id).toBe('c34')
    expect(back.conversations[0]!.messages).toHaveLength(MAX_MESSAGES)
    expect(back.current).toBeNull()
  })
  it('never throws: no storage, a storage that throws', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('blocked')
      },
      setItem: (): void => {
        throw new Error('full')
      },
    }
    expect(loadAi(undefined, 'me')).toEqual({ conversations: [], current: null })
    expect(loadAi(broken, 'me')).toEqual({ conversations: [], current: null })
    expect(saveAi(undefined, 'me', { conversations: [], current: null })).toBe(false)
    expect(saveAi(broken, 'me', { conversations: [conversation('a', 1), conversation('b', 2)], current: null })).toBe(false)
  })
})
