// Order keys for the blocks of a Page: short strings that sort by plain string comparison, with room between any two.
// A key reads as a fraction written in base 62 ("U" is about a half); a key never ends in the lowest digit, so there
// is always room below it.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const TOP = DIGITS.length - 1
const MIDDLE = DIGITS[TOP >> 1]! // 'U'
const KEY = /^[0-9A-Za-z]+$/

const digit = (c: string | undefined): number => (c === undefined ? 0 : DIGITS.indexOf(c))

// The next key after `a` with nothing above it: one step up, so that appending again and again stays short.
function above(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const d = digit(a[i])
    if (d < TOP) return a.slice(0, i) + DIGITS[d + 1]!
  }
  return a + DIGITS[1]!
}

// A key under `b` with nothing below it: one step down. Null when `b` is all lowest digits (nothing fits under it).
function below(b: string): string | null {
  for (let i = 0; i < b.length; i++) {
    const d = digit(b[i])
    if (d === 0) continue
    if (d > 1) return b.slice(0, i) + DIGITS[d - 1]!
    return i < b.length - 1 ? b.slice(0, i + 1) : b.slice(0, i) + DIGITS[0]! + DIGITS[TOP]!
  }
  return null
}

// A key between `a` and `b` (`a < b`). Null when nothing fits (`b` is `a` followed only by lowest digits).
function within(a: string, b: string): string | null {
  let n = 0
  while (n < b.length && (a[n] ?? DIGITS[0]) === b[n]) n++
  if (n === b.length) return null
  const lo = digit(a[n])
  const hi = digit(b[n])
  if (hi - lo > 1) return b.slice(0, n) + DIGITS[(lo + hi) >> 1]!
  if (b.length > n + 1) return b.slice(0, n + 1)
  // Neighbouring digits and `b` ends here: stay under `b` by keeping `a`'s digit, and go above the rest of `a`.
  const rest = a.slice(n + 1)
  return b.slice(0, n) + DIGITS[lo]! + (rest === '' ? MIDDLE : above(rest))
}

/**
 * An order key strictly between `before` and `after` under plain string comparison; either may be absent (or '').
 * The result never ends in '0'. Appending or prepending again and again grows a key by one character per 61 keys;
 * inserting again and again into one gap, by one character per 5 keys at worst (about 60 when typing downwards).
 *
 * The promise holds for keys made here (any mix of digits and ASCII letters works too). When nothing can lie between
 * the two — they are equal, out of order, hold other characters, or `after` is `before` plus zeros — the result is
 * the closest thing that is still a usable key: one right after `before`.
 */
export function orderBetween(before?: string, after?: string): string {
  const a = before ?? ''
  const b = after ?? ''
  const usable = (a === '' || KEY.test(a)) && (b === '' || KEY.test(b)) && (a === '' || b === '' || a < b)
  let key: string | null = null
  if (usable) {
    if (a === '' && b === '') key = MIDDLE
    else if (b === '') key = above(a)
    else if (a === '') key = below(b)
    else key = within(a, b)
  }
  return key ?? `${a}${MIDDLE}`
}
