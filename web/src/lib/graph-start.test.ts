import { describe, expect, it } from 'vitest'
import { formatWhen, startLabel } from './graph-start'
import type { GraphResponse } from './types'

const at = (month: number, day: number, hour: number, minute: number, year = 2026) => new Date(year, month, day, hour, minute).getTime()
const NOW = at(10, 24, 18, 0)
const names: Record<string, string> = { ana: 'Ana', egor: 'Egor' }
const opts = { nameOf: (id: string) => names[id], me: 'egor', now: NOW }

const graph: GraphResponse = {
  branches: [
    {
      id: 'main-id',
      name: 'main',
      seq: 6,
      checkpoints: [
        { name: 'before-review', seq: 2, author: 'ana', at: 0 },
        { name: 'at-head', seq: 6, author: 'ana', at: 0 },
      ],
      activities: [
        { kind: 'edit', author: 'ana', from_seq: 0, to_seq: 2, started_at: 0, ended_at: at(10, 24, 9, 15) },
        { kind: 'merge', author: 'ana', from_seq: 2, to_seq: 4, started_at: 0, ended_at: at(10, 23, 11, 2), source: { branch: 'exp-id', seq: 3 } },
        { kind: 'restore', author: 'mei', from_seq: 4, to_seq: 5, started_at: 0, ended_at: at(0, 3, 7, 5, 2025), to: 2 },
        { kind: 'edit', author: 'egor', from_seq: 5, to_seq: 6, started_at: 0, ended_at: at(10, 24, 17, 0) },
      ],
    },
    {
      id: 'exp-id',
      name: 'exp-A',
      seq: 4,
      parent: { branch: 'main-id', seq: 2 },
      checkpoints: [],
      activities: [
        { kind: 'edit', author: 'ana', from_seq: 0, to_seq: 3, started_at: 0, ended_at: at(10, 24, 13, 50) },
        { kind: 'edit', author: 'egor', from_seq: 3, to_seq: 4, started_at: 0, ended_at: at(10, 24, 14, 7) },
      ],
    },
    { id: 'empty-id', name: 'empty', seq: 0, parent: { branch: 'exp-id', seq: 3 }, checkpoints: [], activities: [] },
  ],
}

describe('formatWhen', () => {
  it('gives the time today, the day this year, the year otherwise', () => {
    expect(formatWhen(at(10, 24, 9, 5), NOW)).toBe('09:05')
    expect(formatWhen(at(10, 12, 13, 50), NOW)).toBe('12 Nov, 13:50')
    expect(formatWhen(at(0, 3, 7, 5, 2025), NOW)).toBe('3 Jan 2025, 07:05')
  })
})

describe('startLabel', () => {
  const label = (branch: string, seq: number, checkpoint?: string) =>
    startLabel(graph, checkpoint === undefined ? { moment: { branch, seq } } : { moment: { branch, seq }, checkpoint }, opts)

  it('says "from now" at the head of a Branch, also of one without Changes', () => {
    expect(label('main-id', 6)).toBe('from now on main')
    expect(label('exp-id', 4)).toBe('from now on exp-A')
    expect(label('empty-id', 0)).toBe('from now on empty')
  })
  it('names a chosen Checkpoint, also at the head', () => {
    expect(label('main-id', 2, 'before-review')).toBe('from Checkpoint before-review on main')
    expect(label('main-id', 6, 'at-head')).toBe('from Checkpoint at-head on main')
    expect(label('main-id', 2, 'not there')).toBe("from Ana's work at 09:15 on main") // no such ◆: its dot
  })
  it("says whose work, Merge or Restore it was and when it ended; one's own is \"your\"", () => {
    expect(label('exp-id', 3)).toBe("from Ana's work at 13:50 on exp-A")
    expect(label('main-id', 4)).toBe("from Ana's Merge at 23 Nov, 11:02 on main")
    expect(label('main-id', 5)).toBe("from Someone's Restore at 3 Jan 2025, 07:05 on main")
    expect(startLabel(graph, { moment: { branch: 'exp-id', seq: 3 } }, { ...opts, me: 'ana' })).toBe('from your work at 13:50 on exp-A')
  })
  it('names the start of a Branch, any other moment, and a Branch that is gone', () => {
    expect(label('exp-id', 0)).toBe('from the start of exp-A')
    expect(label('main-id', 0)).toBe('from the start of main')
    expect(label('exp-id', 1)).toBe('from Change 1 of exp-A')
    expect(label('gone', 1)).toBe('from a Branch that is not there')
  })
  it('reads "Someone" without names', () => {
    expect(startLabel(graph, { moment: { branch: 'exp-id', seq: 3 } }, { now: NOW })).toBe("from Someone's work at 13:50 on exp-A")
  })
})
