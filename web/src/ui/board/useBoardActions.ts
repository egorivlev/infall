// Every Board edit goes through here: board.submit with the failure toast, and delete with Undo.
// Each call is one gesture, so one step of Undo (docs/specs/undo.md decision 3).
import { ApiError, board, ops, undo } from '../../lib'
import type { GestureOptions, Kind, Op } from '../../lib'
import { toasts } from './toastStore'
import { showUndoNote } from './undoActions'

export const FAILURE_MESSAGE = 'That Change could not be applied — the Board was updated meanwhile.'
export const UNDO_MS = 6000

export type Removal = { id: string; kind: Kind }

function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** "Deleted 2 Cards and 1 Connection." */
export function describeRemoval(items: readonly Removal[]): string {
  const n = (k: Kind) => items.filter((i) => i.kind === k).length
  const parts = [
    n('Card') && plural(n('Card'), 'Card'),
    n('Frame') && plural(n('Frame'), 'Frame'),
    n('Connection') && plural(n('Connection'), 'Connection'),
    n('Block') && plural(n('Block'), 'block'),
    n('Source') && plural(n('Source'), 'Source'),
  ].filter((p): p is string => Boolean(p))
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
  return `Deleted ${list}.`
}

const MAX_BATCH = 200 // the sync layer's limit per submit

/**
 * Sends one gesture. `step` says how it stands in Undo: a `key` for a thing just added (`new:<id>`) lets the text
 * typed into it right after `join` that step, so adding a Card and naming it is one step.
 */
async function submit(batch: Op[], step?: GestureOptions): Promise<boolean> {
  if (batch.length === 0) return true
  try {
    // Large gestures (moving or deleting 100+ items) are split; every part is applied locally at once, and all of
    // them are one step.
    const parts = undo.gesture(() => {
      const sent: Promise<void>[] = []
      for (let i = 0; i < batch.length; i += MAX_BATCH) sent.push(board.submit(batch.slice(i, i + MAX_BATCH)))
      return sent
    }, step)
    await Promise.all(parts)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.code === 'closed') return false // the Board was closed; nothing to report
    toasts.show({ message: FAILURE_MESSAGE, title: e instanceof Error ? e.message : String(e) })
    return false
  }
}

let removals = 0

/**
 * `message` replaces the default wording, e.g. for a Source taken off one Card (its Attachment is what goes).
 * The toast's Undo is ⌘Z for this step while it is the newest one. When another step came after it, the things are
 * brought back as a step of their own, so the list stays in order.
 */
function removeWithUndo(items: readonly Removal[], message?: string, step?: GestureOptions): void {
  if (items.length === 0) return
  const key = step?.key ?? `remove:${++removals}`
  // The delete is applied locally at once, so the Undo offer appears at once too.
  const pending = submit(
    items.map((i) => ops.remove(i.id)),
    { ...step, key },
  )
  const bringBack = async () => {
    const r = await undo.undo(key)
    if (r) showUndoNote(r)
    else await submit(items.map((i) => ops.restore(i.id)))
  }
  const toastId = toasts.show(
    {
      message: message ?? describeRemoval(items),
      action: {
        label: 'Undo',
        run: () => {
          toasts.dismiss(toastId)
          void pending.then((ok) => (ok ? bringBack() : undefined))
        },
      },
    },
    UNDO_MS,
  )
  void pending.then((ok) => {
    if (!ok) toasts.dismiss(toastId)
  })
}

const actions = { submit, removeWithUndo }
export type BoardActions = typeof actions

/** Stable across renders; safe to call from event handlers. */
export function useBoardActions(): BoardActions {
  return actions
}
