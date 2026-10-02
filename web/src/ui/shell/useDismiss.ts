import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Closes a popup on Esc and on a press outside it. Esc returns focus to the trigger;
 * an outside press does so only if focus was inside the popup (so it never steals focus from what was clicked).
 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  containerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
      triggerRef.current?.focus()
    }
    const onPress = (e: PointerEvent | MouseEvent) => {
      const box = containerRef.current
      if (!box || box.contains(e.target as Node)) return
      const hadFocus = box.contains(document.activeElement)
      onClose()
      if (hadFocus) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress)
    }
  }, [open, onClose, containerRef, triggerRef])
}
