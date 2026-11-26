// What a Member answered when the tour was offered, kept on this device. Storage may be unavailable (private
// windows, a full disk, a policy): then nothing is remembered and the tour is not offered at all.

export type TourAnswer = 'started' | 'declined'

/** One key per Member: a second person on the same device gets their own offer. */
export function tourKey(memberId: string): string {
  return `infall-tour:${memberId}`
}

const PROBE = 'infall-tour-probe'

/**
 * The remembered answer; `null` when this Member was never asked here; `undefined` when storage cannot be read or
 * written (an answer could not be kept, so the question must not be asked).
 */
export function readAnswer(memberId: string): TourAnswer | null | undefined {
  try {
    const store = window.localStorage
    const value = store.getItem(tourKey(memberId))
    if (value === 'started' || value === 'declined') return value
    // Nothing kept yet: make sure an answer could be.
    store.setItem(PROBE, '1')
    store.removeItem(PROBE)
    return null
  } catch {
    return undefined
  }
}

/** Keeps the answer. False when it could not be kept. */
export function writeAnswer(memberId: string, answer: TourAnswer): boolean {
  try {
    window.localStorage.setItem(tourKey(memberId), answer)
    return true
  } catch {
    return false
  }
}
