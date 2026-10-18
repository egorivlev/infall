import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeHash, forgetHashes, knownHash, sha256Hex, useRunStale } from './code-hash'
import { fakeRunResult, settle } from './testing'
import type { BlockVM } from './types'

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const block = (text: string, hashOf: string | null, id = 'r1'): BlockVM => ({
  id,
  card: 'a',
  type: 'run',
  text,
  title: 'T',
  order: 'U',
  run: { result: hashOf === null ? null : fakeRunResult(hashOf), broken: false },
})

/**
 * Waits until these codes are hashed and the hooks waiting for them have rendered again. It waits for the hashes
 * themselves, not for a moment to pass: WebCrypto answers from another thread, whenever it gets to it.
 */
async function hashed(...codes: string[]) {
  await act(async () => {
    await Promise.all(codes.map((code) => codeHash(code)))
    await settle()
  })
}

beforeEach(() => forgetHashes())
afterEach(() => vi.unstubAllGlobals())

describe('sha256Hex', () => {
  it('gives the known digests', () => {
    expect(sha256Hex('')).toBe(EMPTY)
    expect(sha256Hex('abc')).toBe(ABC)
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })
  it('agrees with WebCrypto on UTF-8 text of every block length', async () => {
    for (const text of ['é', 'print("ψ = 😀")\n', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'лямбда '.repeat(500)]) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      const want = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
      expect(sha256Hex(text)).toBe(want)
    }
  })
})

describe('codeHash', () => {
  it('is the lowercase hex SHA-256 of the UTF-8 bytes', async () => {
    expect(await codeHash('abc')).toBe(ABC)
    expect(await codeHash('')).toBe(EMPTY)
    expect(await codeHash('ψ')).toBe(sha256Hex('ψ'))
  })
  it('hashes a text once and remembers it', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest')
    expect(knownHash('once')).toBeUndefined()
    const [a, b] = await Promise.all([codeHash('once'), codeHash('once')])
    expect(a).toBe(b)
    await codeHash('once')
    expect(digest).toHaveBeenCalledTimes(1)
    expect(knownHash('once')).toBe(a)
    digest.mockRestore()
  })
  it('works without WebCrypto, as on a page served over plain http', async () => {
    vi.stubGlobal('crypto', {})
    expect(await codeHash('abc')).toBe(ABC)
  })
  it('falls back when WebCrypto fails', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('no'))
    expect(await codeHash('abc')).toBe(ABC)
    digest.mockRestore()
  })
})

describe('useRunStale', () => {
  it('is null without a result, for a broken one, and for a block that is not a Run', () => {
    expect(renderHook(() => useRunStale(block('x', null))).result.current).toBeNull()
    expect(renderHook(() => useRunStale({ ...block('x', null), run: { result: null, broken: true } })).result.current).toBeNull()
    expect(renderHook(() => useRunStale({ id: 't', card: 'a', type: 'text', text: 'x', title: '', order: 'U' })).result.current).toBeNull()
  })
  it('is unknown for a moment, then says whether the code is the one that was executed', async () => {
    const same = renderHook(() => useRunStale(block('print(1)', 'print(1)')))
    expect(same.result.current).toBeNull()
    await hashed('print(1)')
    expect(same.result.current).toBe(false)
    const changed = renderHook(() => useRunStale(block('print(2)', 'print(1)', 'r2')))
    await hashed('print(2)')
    expect(changed.result.current).toBe(true)
  })
  it('answers at once for a code it has hashed before', async () => {
    await codeHash('print(1)')
    expect(renderHook(() => useRunStale(block('print(1)', 'print(1)'))).result.current).toBe(false)
    expect(renderHook(() => useRunStale(block('print(1)', 'something else', 'r2'))).result.current).toBe(true)
  })
  it('keeps the last answer while the code is typed, instead of going back to unknown', async () => {
    const seen: (boolean | null)[] = []
    const hook = renderHook(({ b }) => {
      const stale = useRunStale(b)
      seen.push(stale)
      return stale
    }, { initialProps: { b: block('print(1)', 'print(1)') } })
    await hashed('print(1)')
    expect(hook.result.current).toBe(false)
    seen.length = 0
    hook.rerender({ b: block('print(12)', 'print(1)') })
    expect(hook.result.current).toBe(false) // not yet hashed: the answer before stands
    await hashed('print(12)')
    expect(hook.result.current).toBe(true)
    hook.rerender({ b: block('print(123)', 'print(1)') })
    await hashed('print(123)')
    hook.rerender({ b: block('print(1)', 'print(1)') })
    expect(hook.result.current).toBe(false) // typed back: known at once
    expect(seen).not.toContain(null)
  })
  it('does not carry an answer over to another result of the same Block', async () => {
    const hook = renderHook(({ b }) => useRunStale(b), { initialProps: { b: block('print(1)', 'print(0)') } })
    await hashed('print(1)')
    expect(hook.result.current).toBe(true)
    // Executed again with new code, both arriving together: the old "changed" says nothing about the new result.
    hook.rerender({ b: block('print(2)', 'print(2)') })
    expect(hook.result.current).toBeNull()
    await hashed('print(2)')
    expect(hook.result.current).toBe(false)
  })
  it('follows a result that is cleared and recorded again', async () => {
    const hook = renderHook(({ b }) => useRunStale(b), { initialProps: { b: block('print(1)', 'print(1)') } })
    await hashed('print(1)')
    hook.rerender({ b: block('print(1)', null) })
    expect(hook.result.current).toBeNull()
    hook.rerender({ b: block('print(1)', 'print(1)') })
    expect(hook.result.current).toBe(false)
  })
})
