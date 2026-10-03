import { describe, expect, it } from 'vitest'
import { activityLabel, checkpointLabel, count, formatSpan, initials, momentLabel, personOf } from './format'
import { activityAt, blockWidth, buildLanes, dayTicks, positionOf, seqForStep } from './model'
import { ACTIVITIES, ANA, CHECKPOINTS, at } from './testkit'

describe('timeline model', () => {
  it('makes one lane per author, in order of first appearance', () => {
    const lanes = buildLanes(ACTIVITIES)
    expect(lanes.map((l) => l.author)).toEqual(['ana', 'mei', 'gone'])
    expect(lanes[0]!.items.map((i) => [i.activity.id, i.index])).toEqual([
      ['a1', 0],
      ['a4', 3],
    ])
  })

  it('maps scrubber steps to moments: 0 at the start, an Activity end in between, null at now', () => {
    expect(seqForStep(ACTIVITIES, 0)).toBe(0)
    expect(seqForStep(ACTIVITIES, 1)).toBe(3)
    expect(seqForStep(ACTIVITIES, 3)).toBe(6)
    expect(seqForStep(ACTIVITIES, 4)).toBeNull()
    expect(seqForStep([], 0)).toBeNull()
  })

  it('places a moment on the evenly spaced axis, fractional inside an Activity', () => {
    expect(positionOf(ACTIVITIES, 0)).toBe(0)
    expect(positionOf(ACTIVITIES, 3)).toBe(1)
    expect(positionOf(ACTIVITIES, 4)).toBe(1.5)
    expect(positionOf(ACTIVITIES, 9)).toBe(4)
    expect(positionOf(ACTIVITIES, 99)).toBe(4)
    expect(positionOf([], 0)).toBe(0)
  })

  it('finds the Activity a moment belongs to', () => {
    expect(activityAt(ACTIVITIES, 0)).toBe(-1)
    expect(activityAt(ACTIVITIES, 3)).toBe(0)
    expect(activityAt(ACTIVITIES, 4)).toBe(1)
    expect(activityAt(ACTIVITIES, 9)).toBe(3)
    expect(activityAt(ACTIVITIES, 10)).toBe(-1)
  })

  it('labels the first Activity of each day', () => {
    expect(dayTicks(ACTIVITIES)).toEqual([
      { index: 0, label: '14 Nov' },
      { index: 2, label: '15 Nov' },
    ])
  })

  it('sizes blocks 6 + 3 × min(count, 12)', () => {
    expect(blockWidth(1)).toBe(9)
    expect(blockWidth(12)).toBe(42)
    expect(blockWidth(80)).toBe(42)
  })
})

describe('words', () => {
  it('counts in the singular and plural', () => {
    expect(count(1, 'Change')).toBe('1 Change')
    expect(count(0, 'Change')).toBe('0 Changes')
    expect(count(2, 'Activity', 'Activities')).toBe('2 Activities')
  })

  it('formats a span: one time, a time range, or two dates', () => {
    expect(formatSpan(at(14, 9, 0), at(14, 9, 0))).toBe('14 Nov, 09:00')
    expect(formatSpan(at(14, 9, 0), at(14, 9, 12))).toBe('14 Nov, 09:00–09:12')
    expect(formatSpan(at(14, 23, 50), at(15, 0, 10))).toBe('14 Nov, 23:50 – 15 Nov, 00:10')
    expect(formatSpan(new Date(2001, 0, 2, 3, 4).getTime(), new Date(2001, 0, 2, 3, 4).getTime())).toBe('2 Jan 2001, 03:04')
  })

  it('names a moment', () => {
    expect(momentLabel(null)).toBe('the start')
    expect(momentLabel(at(14, 9, 12))).toBe('14 Nov, 09:12')
  })

  it('resolves people, and calls a missing author a Former Member', () => {
    const byId = new Map([[ANA.id, ANA]])
    expect(personOf(byId, 'ana')).toEqual({ name: 'Ana Ruiz', initials: 'AR', color: ANA.color })
    expect(personOf(byId, 'gone')).toEqual({ name: 'Former Member', initials: '–', color: null })
    expect(initials('Cher')).toBe('CH')
  })

  it('writes full labels for blocks and markers', () => {
    expect(activityLabel(ACTIVITIES[0]!, 'Ana Ruiz')).toBe('Ana Ruiz · 14 Nov, 09:00–09:12 · 3 Changes')
    expect(activityLabel(ACTIVITIES[2]!, 'Former Member')).toBe('Former Member · 15 Nov, 11:00 · 1 Change')
    expect(activityLabel(ACTIVITIES[3]!, 'Ana Ruiz')).toBe('Ana Ruiz · 15 Nov, 12:00 · Restore · 3 Changes')
    expect(checkpointLabel(CHECKPOINTS[1]!, 'Mei Tanaka')).toBe('Checkpoint Kick-off · named by Mei Tanaka, 14 Nov, 10:30')
  })
})
