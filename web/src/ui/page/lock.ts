// The soft lock on a Card's Page, as this browser holds it: claimed while a Block editor is open.
// Moving from one Block to the next closes one editor and opens another a moment later; the short
// grace keeps the claim across that gap, so other Members do not see the lock flicker.
import { page } from '../../lib'

export const RELEASE_GRACE_MS = 300

let held: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function cancelTimer(): boolean {
  if (timer === undefined) return false
  clearTimeout(timer)
  timer = undefined
  return true
}

export const editLock = {
  /** The first editor opened. Safe to repeat: `page.startEditing` is idempotent. */
  claim(cardId: string) {
    const wasLeaving = cancelTimer()
    if (wasLeaving && held === cardId) return // still ours: the release never went out
    held = cardId
    page.startEditing(cardId)
  },
  /** The last editor closed. */
  releaseSoon() {
    if (held === null || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      held = null
      page.stopEditing()
    }, RELEASE_GRACE_MS)
  },
  /** The panel closed, or shows another Card. */
  releaseNow() {
    cancelTimer()
    if (held === null) return
    held = null
    page.stopEditing()
  },
}
