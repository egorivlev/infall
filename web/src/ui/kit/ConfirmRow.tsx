// q-confirm-row (styles/components.css): the row itself becomes the question, in place, so it is clear what is being
// removed. Focus lands on the safe choice; the destructive one is red text on the right; Esc keeps it.
import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'

type Props = {
  /** The question, naming the thing: "Remove Ben Okafor?". */
  question: string
  /** What is lost, in a sentence. */
  detail?: string
  keepLabel?: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  error?: string
  onConfirm: () => void
  onKeep: () => void
  /** The question and its sentence on one line (a table row), or the question in bold over the sentence. */
  inline?: boolean
}

export function ConfirmRow({ question, detail, keepLabel = 'Keep', confirmLabel, busyLabel, busy, error, onConfirm, onKeep, inline = false }: Props) {
  const keepRef = useRef<HTMLButtonElement>(null)
  const textId = useId()
  useEffect(() => {
    keepRef.current?.focus()
  }, [])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (!busy) onKeep()
  }
  return (
    <div className="q-confirm-row" role="group" aria-labelledby={textId} onKeyDown={onKeyDown}>
      <p className="q-confirm-row__text" id={textId}>
        {inline ? (
          <>
            {question}
            {detail ? ` ${detail}` : ''}
          </>
        ) : (
          <>
            <span className="q-confirm-row__q">{question}</span>
            {detail && (
              <>
                <br />
                {detail}
              </>
            )}
          </>
        )}
      </p>
      <div className="q-confirm-row__actions">
        <button type="button" ref={keepRef} className="q-btn q-btn--sm q-btn--soft" onClick={onKeep}>
          {keepLabel}
        </button>
        <button type="button" className="q-btn q-btn--sm q-btn--ghost q-btn--danger" aria-disabled={busy} onClick={() => !busy && onConfirm()}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
      {error && (
        <p className="q-error q-confirm-row__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
