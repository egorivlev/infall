// Small pure helpers for the Runner monitor: how memory, processor use and the time left are written out.

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

const sane = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * An amount of memory: "512 MB", "1.2 GB", "24 GB". Units of 1024, as a computer's memory is sold; one decimal
 * from a gigabyte up while the number is under 100 (a ".0" is not written), whole numbers otherwise. '' when it
 * is not an amount.
 */
export function formatBytes(n: number): string {
  if (!sane(n)) return ''
  if (n < 1024) return `${Math.round(n)} B`
  let value = n / 1024
  let unit = 0
  // 1023.6 MB would round to 1024: it is said in the next unit
  while (unit < UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024
    unit++
  }
  const decimals = unit >= 2 && value < 99.95 ? 1 : 0
  const text = value.toFixed(decimals).replace(/\.0$/, '')
  return `${text} ${UNITS[unit]}`
}

/** A share as a whole percentage: "76 %". '' when it is not a number. */
export function formatPercent(n: number): string {
  return sane(n) ? `${Math.round(n)} %` : ''
}

/** Processor use where 100 is one core fully busy: "182 % · 1.8 of 10 cores"; without a core count, "182 %". */
export function formatProcessor(percent: number, cores: number): string {
  if (!sane(percent)) return ''
  if (!sane(cores) || cores < 1) return formatPercent(percent)
  const n = Math.round(cores)
  return `${formatPercent(percent)} · ${(percent / 100).toFixed(1)} of ${n} ${n === 1 ? 'core' : 'cores'}`
}

/** `part` of `whole` as a fraction between 0 and 1, for a meter; 0 when either is not an amount or nothing is whole. */
export function fraction(part: number, whole: number): number {
  if (!sane(part) || !sane(whole) || whole === 0) return 0
  return Math.min(1, part / whole)
}

/** A count as the code gave it: whole numbers as they are ("45"), others with at most two decimals ("0.45"). */
export function formatCount(n: number): string {
  if (!sane(n)) return ''
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/**
 * An estimate of the time left, said no more exactly than it is known: "about 5 s", "about 40 s" (to the nearest
 * five from twenty seconds up), "about 3 min", "about 2 h 05 min". Less than a second is "about 1 s". '' when it
 * is not a duration.
 */
export function formatEstimate(ms: number): string {
  if (!sane(ms)) return ''
  let s = Math.max(1, Math.round(ms / 1000))
  if (s >= 20 && s < 60) s = Math.round(s / 5) * 5
  if (s < 60) return `about ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `about ${m} min`
  return `about ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** The same, as a sentence end: "about 3 min left". */
export function formatLeft(ms: number): string {
  const estimate = formatEstimate(ms)
  return estimate === '' ? '' : `${estimate} left`
}
