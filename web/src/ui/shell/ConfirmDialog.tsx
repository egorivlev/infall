import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  title: string
  body: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
  /** The control that opened the dialog; focus goes back to it on close (if it still exists). */
  opener?: HTMLElement | null
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** A real modal: focus is trapped, Esc and Cancel close it, focus returns to whatever opened it. */
export function ConfirmDialog({ title, body, confirmLabel, busyLabel, busy, error, onConfirm, onCancel, opener: openerProp }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    const opener = openerProp ?? (document.activeElement as HTMLElement | null)
    cancelRef.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [openerProp])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!busy) onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (!first || !last) return
    const at = document.activeElement
    if (!ref.current?.contains(at)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && at === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="q-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={ref} className="q-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onKeyDown={onKeyDown}>
        <h2 className="q-dialog__title" id={titleId}>
          {title}
        </h2>
        <p className="q-dialog__body" id={bodyId}>
          {body}
        </p>
        {error && (
          <p className="q-error" role="alert">
            {error}
          </p>
        )}
        <div className="q-dialog__actions">
          <button type="button" ref={cancelRef} className="q-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="q-btn q-btn--danger" aria-disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
