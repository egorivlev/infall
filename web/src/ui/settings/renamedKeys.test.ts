import { afterEach, describe, expect, it } from 'vitest'
import { carryOverRenamedKeys } from './renamedKeys'
import { storageKey } from '../../lib/ai-storage'
import { tourKey } from '../tutorial/memory'

afterEach(() => window.localStorage.clear())

describe('carryOverRenamedKeys', () => {
  it('copies each value kept under a name from before the rename to its new key, once', () => {
    const s = window.localStorage
    s.setItem('qoop.ai.m1', '{"v":1,"current":null,"conversations":[]}')
    s.setItem('qoop-tour:m1', 'declined')
    s.setItem('qoop-tour:m2', 'done')
    s.setItem('other', 'x')
    expect(carryOverRenamedKeys(s)).toBe(3)
    // Under the names the app reads now.
    expect(s.getItem(storageKey('m1'))).toBe('{"v":1,"current":null,"conversations":[]}')
    expect(s.getItem(tourKey('m1'))).toBe('declined')
    expect(s.getItem('infall-tour:m2')).toBe('done')
    // The old keys stay; nothing else is touched.
    expect(s.getItem('qoop-tour:m1')).toBe('declined')
    expect(s.getItem('other')).toBe('x')
    expect(s.length).toBe(7)
    // A second start copies nothing again.
    expect(carryOverRenamedKeys(s)).toBe(0)
  })

  it('never writes over a value the new key already has', () => {
    const s = window.localStorage
    s.setItem('qoop-tour:m1', 'declined')
    s.setItem('infall-tour:m1', 'done')
    s.setItem('qoop.ai.', 'no member id')
    expect(carryOverRenamedKeys(s)).toBe(0)
    expect(s.getItem('infall-tour:m1')).toBe('done')
    expect(s.getItem('infall.ai.')).toBeNull()
  })

  it('does nothing and never throws when storage is missing or refuses', () => {
    expect(carryOverRenamedKeys(null)).toBe(0)
    const refusing = {
      length: 1,
      key: () => 'qoop-tour:m1',
      getItem: (k: string) => (k === 'qoop-tour:m1' ? 'declined' : null),
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    expect(carryOverRenamedKeys(refusing)).toBe(0)
    const broken = {
      get length(): number {
        throw new Error('SecurityError')
      },
    } as unknown as Storage
    expect(carryOverRenamedKeys(broken)).toBe(0)
  })
})
