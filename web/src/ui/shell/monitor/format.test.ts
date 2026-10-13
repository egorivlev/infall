import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount, formatEstimate, formatLeft, formatPercent, formatProcessor, fraction } from './format'

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [KB, '1 KB'],
    [1536, '2 KB'],
    [512 * MB, '512 MB'],
    [1023.4 * MB, '1023 MB'],
    [1023.6 * MB, '1 GB'],
    [1.2 * GB, '1.2 GB'],
    [1.44 * GB, '1.4 GB'],
    [16 * GB, '16 GB'],
    [24 * GB, '24 GB'],
    [99.94 * GB, '99.9 GB'],
    [99.96 * GB, '100 GB'],
    [128 * GB, '128 GB'],
    [1536 * GB, '1.5 TB'],
    [5000 * 1024 * GB, '5000 TB'],
  ])('%d → %s', (n, text) => {
    expect(formatBytes(n)).toBe(text)
  })
  it('says nothing for what is not an amount', () => {
    for (const n of [-1, NaN, Infinity, undefined as unknown as number, '5' as unknown as number]) expect(formatBytes(n)).toBe('')
  })
})

describe('formatPercent and formatProcessor', () => {
  it('writes whole percentages', () => {
    expect(formatPercent(76)).toBe('76 %')
    expect(formatPercent(75.6)).toBe('76 %')
    expect(formatPercent(0)).toBe('0 %')
    expect(formatPercent(NaN)).toBe('')
    expect(formatPercent(-3)).toBe('')
  })
  it('says how many cores that is', () => {
    expect(formatProcessor(182, 10)).toBe('182 % · 1.8 of 10 cores')
    expect(formatProcessor(96.4, 8)).toBe('96 % · 1.0 of 8 cores')
    expect(formatProcessor(100, 1)).toBe('100 % · 1.0 of 1 core')
    expect(formatProcessor(0, 10)).toBe('0 % · 0.0 of 10 cores')
  })
  it('leaves the cores out when their number is not known', () => {
    expect(formatProcessor(182, 0)).toBe('182 %')
    expect(formatProcessor(182, NaN)).toBe('182 %')
    expect(formatProcessor(NaN, 10)).toBe('')
  })
})

describe('fraction', () => {
  it('is the share between 0 and 1', () => {
    expect(fraction(45, 100)).toBe(0.45)
    expect(fraction(182, 1000)).toBe(0.182)
    expect(fraction(0, 5)).toBe(0)
    expect(fraction(7, 5)).toBe(1)
  })
  it('is 0 when there is nothing to take a share of', () => {
    expect(fraction(5, 0)).toBe(0)
    expect(fraction(NaN, 5)).toBe(0)
    expect(fraction(5, Infinity)).toBe(0)
    expect(fraction(-1, 5)).toBe(0)
  })
})

describe('formatCount', () => {
  it('keeps whole numbers and shortens the others', () => {
    expect(formatCount(45)).toBe('45')
    expect(formatCount(100000)).toBe('100000')
    expect(formatCount(0.456)).toBe('0.46')
    expect(formatCount(2.5)).toBe('2.5')
    expect(formatCount(NaN)).toBe('')
  })
})

describe('formatEstimate', () => {
  it.each([
    [0, 'about 1 s'],
    [400, 'about 1 s'],
    [4600, 'about 5 s'],
    [19_400, 'about 19 s'],
    [22_000, 'about 20 s'],
    [43_000, 'about 45 s'],
    [57_000, 'about 55 s'],
    [58_000, 'about 1 min'],
    [89_000, 'about 1 min'],
    [91_000, 'about 2 min'],
    [176_000, 'about 3 min'],
    [59 * 60_000, 'about 59 min'],
    [59.6 * 60_000, 'about 1 h 00 min'],
    [65 * 60_000, 'about 1 h 05 min'],
    [(2 * 60 + 40) * 60_000, 'about 2 h 40 min'],
    [30 * 3_600_000, 'about 30 h 00 min'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatEstimate(ms)).toBe(text)
  })
  it('says nothing for what is not a duration', () => {
    for (const ms of [-1, NaN, Infinity]) {
      expect(formatEstimate(ms)).toBe('')
      expect(formatLeft(ms)).toBe('')
    }
  })
  it('reads as the end of a sentence with "left"', () => {
    expect(formatLeft(176_000)).toBe('about 3 min left')
    expect(formatLeft(4600)).toBe('about 5 s left')
  })
})
