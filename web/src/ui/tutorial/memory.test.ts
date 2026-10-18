import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnswer, tourKey, writeAnswer } from './memory'

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('the tour memory', () => {
  it('knows nothing about a Member who was never asked', () => {
    expect(readAnswer('m1')).toBeNull()
    expect(window.localStorage.length).toBe(0) // the probe leaves nothing behind
  })

  it('keeps each answer, per Member', () => {
    expect(writeAnswer('m1', 'declined')).toBe(true)
    expect(writeAnswer('m2', 'started')).toBe(true)
    expect(readAnswer('m1')).toBe('declined')
    expect(readAnswer('m2')).toBe('started')
    expect(readAnswer('m3')).toBeNull()
    expect(tourKey('m1')).not.toBe(tourKey('m2'))
  })

  it('reads anything unknown as never asked', () => {
    window.localStorage.setItem(tourKey('m1'), 'whatever')
    expect(readAnswer('m1')).toBeNull()
  })

  it('says so when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readAnswer('m1')).toBeUndefined()
  })

  it('says so when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(readAnswer('m1')).toBeUndefined()
    expect(writeAnswer('m1', 'declined')).toBe(false)
  })
})
