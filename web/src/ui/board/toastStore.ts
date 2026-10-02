// A tiny local toast store for the Board: failure notices and the Undo offer after a delete.
import { create } from 'zustand'

export type ToastAction = { label: string; run: () => void }
export type ToastItem = { id: number; message: string; title?: string; action?: ToastAction }

type ToastState = { items: ToastItem[] }

const MAX = 3
let next = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const useToasts = create<ToastState>(() => ({ items: [] }))

export const toasts = {
  show(t: Omit<ToastItem, 'id'>, ms = 6000): number {
    const id = ++next
    const items = [...useToasts.getState().items, { ...t, id }]
    for (const dropped of items.slice(0, Math.max(0, items.length - MAX))) clearTimer(dropped.id)
    useToasts.setState({ items: items.slice(-MAX) })
    timers.set(
      id,
      setTimeout(() => toasts.dismiss(id), ms),
    )
    return id
  },
  dismiss(id: number) {
    clearTimer(id)
    const items = useToasts.getState().items
    if (items.some((t) => t.id === id)) useToasts.setState({ items: items.filter((t) => t.id !== id) })
  },
  clear() {
    for (const id of timers.keys()) clearTimer(id)
    useToasts.setState({ items: [] })
  },
}

function clearTimer(id: number) {
  const h = timers.get(id)
  if (h !== undefined) clearTimeout(h)
  timers.delete(id)
}
