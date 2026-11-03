// Undo and Redo from the keyboard and from the desktop app's Edit menu (docs/specs/undo.md): handled once, here.
import { useEffect } from 'react'
import { undo } from '../../lib'
import { typingIn } from '../board/boardScaleKeys'
import { runUndo, undoKey, useUndoPlace } from '../board/undoActions'

/**
 * What the desktop app's Edit menu calls (web/src/lib/CONTRACT.md, "M15 — Undo"). Labels are ready to show:
 * "Undo Move 3 Cards". Both are null where Undo does not work, and while a text field has focus — the menu then
 * gives the key to the field, as the system's own items do.
 */
export type UndoBridge = {
  state(): { undo: string | null; redo: string | null }
  undo(): void
  redo(): void
  subscribe(fn: () => void): () => void
}

declare global {
  interface Window {
    __infallUndo?: UndoBridge
  }
}

// Inside a dialog that holds focus (Import BibTeX…, a confirmation): its keys are its own.
function inDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[aria-modal="true"]') !== null
}

/** Whether Undo and Redo go to the open Branch's list now, rather than to a field or nowhere. */
function listHas(target: EventTarget | null): boolean {
  return useUndoPlace.getState().here && !typingIn(target) && !inDialog(target)
}

function state(): { undo: string | null; redo: string | null } {
  if (!listHas(document.activeElement)) return { undo: null, redo: null }
  const s = undo.current()
  return { undo: s.undo === null ? null : `Undo ${s.undo}`, redo: s.redo === null ? null : `Redo ${s.redo}` }
}

/** Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl+Y, and `window.__infallUndo`. Renders nothing. */
export function UndoKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const direction = undoKey(e)
      if (direction === null || !listHas(e.target)) return // a field's own text undo, or not here
      e.preventDefault()
      void runUndo(direction)
    }
    window.addEventListener('keydown', onKey)

    const bridge: UndoBridge = {
      state,
      undo: () => {
        if (listHas(document.activeElement)) void runUndo('undo')
      },
      redo: () => {
        if (listHas(document.activeElement)) void runUndo('redo')
      },
      subscribe(fn) {
        const call = () => fn()
        const stop = [undo.subscribe(call), useUndoPlace.subscribe(call)]
        // Focus moving into or out of a text field changes what the menu's items do.
        document.addEventListener('focusin', call)
        document.addEventListener('focusout', call)
        return () => {
          stop.forEach((off) => off())
          document.removeEventListener('focusin', call)
          document.removeEventListener('focusout', call)
        }
      },
    }
    window.__infallUndo = bridge
    return () => {
      window.removeEventListener('keydown', onKey)
      if (window.__infallUndo === bridge) delete window.__infallUndo
    }
  }, [])
  return null
}
