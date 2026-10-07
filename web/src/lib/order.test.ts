import { describe, expect, it } from 'vitest'
import { orderBetween } from './order'

const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/

// A small deterministic generator, so a failure can be reproduced.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function check(before: string | undefined, after: string | undefined): string {
  const key = orderBetween(before, after)
  const where = `between ${JSON.stringify(before)} and ${JSON.stringify(after)} gave ${JSON.stringify(key)}`
  expect(KEY.test(key), where).toBe(true)
  if (before !== undefined) expect(before < key, where).toBe(true)
  if (after !== undefined) expect(key < after, where).toBe(true)
  return key
}

describe('orderBetween', () => {
  it('gives a first key, and keys on either side of one', () => {
    const first = check(undefined, undefined)
    expect(first).toHaveLength(1)
    check(first, undefined)
    check(undefined, first)
    expect(orderBetween('', '')).toBe(first)
  })

  it('stays strictly between its arguments, whatever the order of insertions', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = rng(seed)
      const keys: string[] = []
      for (let i = 0; i < 400; i++) {
        const at = Math.floor(random() * (keys.length + 1))
        keys.splice(at, 0, check(keys[at - 1], keys[at]))
      }
      expect([...keys].sort()).toEqual(keys)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('stays strictly between any two keys over the alphabet', () => {
    const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    const random = rng(7)
    // Short keys over few digits, the lowest and highest among them, so that neighbours and prefixes are common.
    const some = '01Uyz'
    const key = (from: string) => {
      let k = ''
      const length = 1 + Math.floor(random() * 4)
      for (let i = 0; i < length; i++) k += from[Math.floor(random() * from.length)]
      return k.replace(/0+$/, '') || '1'
    }
    for (let i = 0; i < 20000; i++) {
      const from = i % 2 === 0 ? some : digits
      const [a, b] = [key(from), key(from)].sort() as [string, string]
      if (a !== b) check(a, b)
      check(a, undefined)
      check(undefined, a)
    }
  })

  it('stays short when appending, prepending, or inserting at one place again and again', () => {
    let last: string | undefined
    for (let i = 0; i < 1000; i++) last = check(last, undefined)
    expect(last!.length).toBeLessThanOrEqual(18)

    let first: string | undefined
    for (let i = 0; i < 1000; i++) first = check(undefined, first)
    expect(first!.length).toBeLessThanOrEqual(18)

    // Typing downwards in the middle of a Page: each new block goes after the previous new one.
    const top = check(undefined, undefined)
    const bottom = check(top, undefined)
    let cursor = top
    for (let i = 0; i < 1000; i++) cursor = check(cursor, bottom)
    expect(cursor.length).toBeLessThanOrEqual(20)

    // The worst case: always right after the same block.
    let next = bottom
    for (let i = 0; i < 100; i++) next = check(top, next)
    expect(next.length).toBeLessThanOrEqual(22)
  })

  it('still answers with a usable key when nothing can lie between', () => {
    for (const [a, b] of [['U', 'U'], ['b', 'a'], ['U', 'U0'], ['x y', 'z'], ['a', 'é']] as const) {
      const key = orderBetween(a, b)
      expect(key > a).toBe(true)
      expect(key.endsWith('0')).toBe(false)
    }
    expect(orderBetween(undefined, '0')).not.toBe('')
  })
})
