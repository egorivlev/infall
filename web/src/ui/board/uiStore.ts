// Transient, local-only Board UI state: what this person has selected, is editing, or is dragging.
// Nothing here is ever sent; the Board data itself comes from useBoard().
import { create } from 'zustand'

export type EditField = 'title' | 'summary'
export type Editing = { id: string; field: EditField } | null
/** In-progress drag/resize geometry that overrides the snapshot until the gesture ends. */
export type Transient = { x?: number; y?: number; w?: number; h?: number }

type UiState = {
  selected: ReadonlySet<string>
  editing: Editing
  statusMenu: string | null
  readOnly: boolean
  transient: ReadonlyMap<string, Transient>
}

const NONE: ReadonlySet<string> = new Set()
const NO_TRANSIENT: ReadonlyMap<string, Transient> = new Map()

export const useBoardUi = create<UiState>(() => ({
  selected: NONE,
  editing: null,
  statusMenu: null,
  readOnly: false,
  transient: NO_TRANSIENT,
}))

const set = useBoardUi.setState
const get = useBoardUi.getState

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

export const ui = {
  select(ids: Iterable<string>) {
    const next = new Set(ids)
    const s = get()
    if (!sameSet(s.selected, next)) set({ selected: next.size ? next : NONE, statusMenu: null })
  },
  toggle(id: string, on: boolean) {
    const s = get().selected
    if (s.has(id) === on) return
    const next = new Set(s)
    if (on) next.add(id)
    else next.delete(id)
    set({ selected: next, statusMenu: null })
  },
  clearSelection() {
    if (get().selected.size || get().statusMenu) set({ selected: NONE, statusMenu: null })
  },
  /** Drops ids that no longer exist (deleted by someone else). */
  prune(exists: (id: string) => boolean) {
    const s = get()
    let changed = false
    const next = new Set<string>()
    for (const id of s.selected) {
      if (exists(id)) next.add(id)
      else changed = true
    }
    const patch: Partial<UiState> = {}
    if (changed) patch.selected = next
    if (s.editing && !exists(s.editing.id)) patch.editing = null
    if (s.statusMenu && !exists(s.statusMenu)) patch.statusMenu = null
    if (Object.keys(patch).length) set(patch)
  },
  edit(id: string, field: EditField) {
    set({ editing: { id, field }, statusMenu: null })
  },
  stopEditing(id: string) {
    if (get().editing?.id === id) set({ editing: null })
  },
  openStatusMenu(id: string | null) {
    set({ statusMenu: id })
  },
  setReadOnly(readOnly: boolean) {
    if (get().readOnly !== readOnly) set({ readOnly, editing: readOnly ? null : get().editing })
  },
  setTransient(updates: Map<string, Transient>) {
    const next = new Map(get().transient)
    for (const [id, t] of updates) next.set(id, { ...next.get(id), ...t })
    set({ transient: next })
  },
  clearTransient(ids: Iterable<string>) {
    const cur = get().transient
    let next: Map<string, Transient> | null = null
    for (const id of ids) {
      if (!cur.has(id)) continue
      next ??= new Map(cur)
      next.delete(id)
    }
    if (next) set({ transient: next.size ? next : NO_TRANSIENT })
  },
  reset() {
    set({ selected: NONE, editing: null, statusMenu: null, transient: NO_TRANSIENT })
  },
}
