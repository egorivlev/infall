// The hash a Run's result is tied to (api.md §15): SHA-256 of the UTF-8 bytes of the code, as lowercase hex.
// `useRunStale` compares it with the present code of the Block.
import { useEffect, useState } from 'react'
import type { BlockVM } from './types'

// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * SHA-256 of the UTF-8 bytes of `text`, computed here. Used where WebCrypto is not there (a page served over plain
 * http has no `crypto.subtle`) and where the answer is needed at once (the fake Runner of the tests).
 */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text)
  const length = data.length
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000))
  view.setUint32(padded.length - 4, (length << 3) >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!
      const b = w[i - 2]!
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (hh! + s1 + ch + K[i]! + w[i]!) | 0
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (s0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d! + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0]! + a!) | 0
    h[1] = (h[1]! + b!) | 0
    h[2] = (h[2]! + c!) | 0
    h[3] = (h[3]! + d!) | 0
    h[4] = (h[4]! + e!) | 0
    h[5] = (h[5]! + f!) | 0
    h[6] = (h[6]! + g!) | 0
    h[7] = (h[7]! + hh!) | 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!)
  return hex(out)
}

// Hashes by text, the most recently used last. Small: every keystroke in a Run's code is a new text.
const MAX_KNOWN = 64
const known = new Map<string, string>()
const working = new Map<string, Promise<string>>()

function remember(code: string, hash: string): void {
  known.delete(code)
  known.set(code, hash)
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!)
}

/** The hash of `code` when it was computed before; nothing is computed. */
export function knownHash(code: string): string | undefined {
  return known.get(code)
}

/** For tests: forget every hash, as a fresh page would. */
export function forgetHashes(): void {
  known.clear()
  working.clear()
  answers.clear()
}

async function digest(code: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle && typeof subtle.digest === 'function') {
    try {
      return hex(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(code))))
    } catch {
      // computed here instead
    }
  }
  return sha256Hex(code)
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `code`. Never rejects; the same text is hashed once. */
export function codeHash(code: string): Promise<string> {
  const have = known.get(code)
  if (have !== undefined) return Promise.resolve(have)
  const busy = working.get(code)
  if (busy) return busy
  const job = digest(code).then((hash) => {
    if (working.get(code) === job) {
      working.delete(code)
      remember(code, hash)
    }
    return hash
  })
  working.set(code, job)
  return job
}

// The last answer given for a Block, with the result hash it was about: shown again while the code is being
// hashed anew (typing), so the mark does not blink. Bounded; an entry costs a few bytes.
const MAX_ANSWERS = 500
const answers = new Map<string, { expected: string; stale: boolean }>()

/**
 * Whether the code of a Run changed since its recorded result: `true` changed, `false` the same, `null` when there
 * is no result (or the Block is not a Run), and for the moment it takes to hash a code never seen before.
 */
export function useRunStale(block: BlockVM): boolean | null {
  const expected = block.run?.result?.code_sha256
  const code = block.text
  const [, again] = useState(0)
  useEffect(() => {
    if (expected === undefined || knownHash(code) !== undefined) return
    let on = true
    void codeHash(code).then(() => {
      if (on) again((n) => n + 1)
    })
    return () => {
      on = false
    }
  }, [code, expected])
  if (expected === undefined) return null
  const hash = knownHash(code)
  const before = answers.get(block.id)
  if (hash === undefined) return before && before.expected === expected ? before.stale : null
  const stale = hash !== expected
  if (!before || before.expected !== expected || before.stale !== stale) {
    answers.delete(block.id)
    answers.set(block.id, { expected, stale })
    if (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value!)
  }
  return stale
}
