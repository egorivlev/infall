// Every Board edit goes through here: board.submit with the failure toast, and delete with Undo.
import { ApiError, board, ops } from '../../lib'
import type { Kind, Op } from '../../lib'
import { toasts } from './toastStore'

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

async function submit(batch: Op[]): Promise<boolean> {
  if (batch.length === 0) return true
  try {
    // Large gestures (moving or deleting 100+ items) are split; every part is applied locally at once.
    const parts: Promise<void>[] = []
    for (let i = 0; i < batch.length; i += MAX_BATCH) parts.push(board.submit(batch.slice(i, i + MAX_BATCH)))
    await Promise.all(parts)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.code === 'closed') return false // the Board was closed; nothing to report
    toasts.show({ message: FAILURE_MESSAGE, title: e instanceof Error ? e.message : String(e) })
    return false
  }
}

/** `message` replaces the default wording, e.g. for a Source taken off one Card (its Attachment is what goes). */
function removeWithUndo(items: readonly Removal[], message?: string): void {
  if (items.length === 0) return
  const ids = items.map((i) => i.id)
  // The delete is applied locally at once, so the Undo offer appears at once too.
  const pending = submit(ids.map((id) => ops.remove(id)))
  const toastId = toasts.show(
    {
      message: message ?? describeRemoval(items),
      action: {
        label: 'Undo',
        run: () => {
          toasts.dismiss(toastId)
          void pending.then((ok) => (ok ? submit(ids.map((id) => ops.restore(id))) : undefined))
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
