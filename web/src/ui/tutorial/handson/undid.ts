// How the Undo step (watch.tsx) tells, from the lib's list of steps alone, that an Undo took something back.
import type { UndoSnapshot } from '../../../lib'

/**
 * Whether going from `was` to `now` (the open Branch's next Undo and Redo, by name) was an Undo that took something
 * back: the newest step moved to the top of Redo. A new gesture empties Redo; a step that was wholly left ("Not
 * undone — …") is dropped without reaching Redo; a Branch switch passes through "nothing" (the Board closes first).
 * Names alone cannot tell this from a Redo whose next step bears the same name as the newest Undo; that one counts
 * too, as a Redo needs an Undo before it.
 */
export function undid(was: UndoSnapshot, now: UndoSnapshot): boolean {
  return was.undo !== null && now.redo === was.undo && (now.redo !== was.redo || now.undo !== was.undo)
}
