// Undo and Redo (docs/specs/undo.md) as the Board, the Page and the shell's keys use them: where they work, the
// keys of this platform, and the short note after each one.
import { create } from 'zustand'
import { undo } from '../../lib'
import type { UndoResult } from '../../lib'
import { toasts, useToasts } from './toastStore'

export type UndoDirection = 'undo' | 'redo'

/** How long the note after an Undo or Redo stays. */
export const NOTE_MS = 5000

/**
 * Whether Undo works here and now (decision 12): the Board of the open Branch is shown and editable — not while
 * History previews an earlier moment, not for Guests, not on other screens. The Board sets it.
 */
export const useUndoPlace = create<{ here: boolean }>(() => ({ here: false }))

export function isMac(): boolean {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined
  const platform = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** The keys as a person reads them: "⌘Z", "⇧⌘Z" on a Mac; "Ctrl+Z", "Ctrl+Y" elsewhere. */
export function undoKeys(direction: UndoDirection): string {
  if (isMac()) return direction === 'undo' ? '⌘Z' : '⇧⌘Z'
  return direction === 'undo' ? 'Ctrl+Z' : 'Ctrl+Y'
}

/** The same for `aria-keyshortcuts`. */
export function ariaKeys(direction: UndoDirection): string {
  if (isMac()) return direction === 'undo' ? 'Meta+Z' : 'Meta+Shift+Z'
  return direction === 'undo' ? 'Control+Z' : 'Control+Shift+Z Control+Y'
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>

// The letter of a key: what the layout produces when that is a Latin letter, else the physical key (a Cyrillic or
// Greek layout still has its Z where QWERTY has it).
function letter(e: KeyLike): string {
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toLowerCase()
  const m = /^Key([A-Z])$/.exec(e.code ?? '')
  return m ? m[1]!.toLowerCase() : ''
}

/**
 * Cmd+Z / Shift+Cmd+Z on a Mac; Ctrl+Z / Shift+Ctrl+Z / Ctrl+Y elsewhere. Never with Alt (Option), never with both
 * Cmd and Ctrl, never while a character is being composed. Other keys — the Board scale's Shift + "+" / "−" / 0,
 * Cmd+, — are not these.
 */
export function undoKey(e: KeyLike): UndoDirection | null {
  if (e.altKey || e.isComposing) return null
  const mac = isMac()
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) return null
  const k = letter(e)
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y' && !mac && !e.shiftKey) return 'redo'
  return null
}

let lastNote = 0

/** The short note after an Undo or Redo, in the toast region (announced politely). One at a time. */
export function showUndoNote(r: UndoResult | null): void {
  if (!r) return
  if (lastNote) toasts.dismiss(lastNote)
  lastNote = toasts.show({ message: r.note }, NOTE_MS)
}

/** Undo or Redo the open Branch's step, and say what was done. */
export async function runUndo(direction: UndoDirection): Promise<void> {
  // A delete's "Undo" offer is the same step: once Undo or Redo runs, it has said what it had to say.
  for (const t of useToasts.getState().items) if (t.action?.label === 'Undo') toasts.dismiss(t.id)
  showUndoNote(await (direction === 'undo' ? undo.undo() : undo.redo()))
}
