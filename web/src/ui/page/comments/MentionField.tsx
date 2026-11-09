// A textarea that completes "@Name" from the Members (M18). The field is a combobox: while a mention is being
// typed, a list of matching Members opens under it; ↑ ↓ move, Enter or Tab puts the name in, Esc closes the list
// (and only the list: the Page stays open). The text stays the field's own; nothing is sent from here.
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { insertMention, mentionAt, mentionCandidates } from '../../../lib'
import type { Member } from '../../../lib'
import { initials } from '../../shell/initials'

type Props = {
  value: string
  onChange: (text: string) => void
  members: readonly Member[]
  label: string
  /** Shown above the field (visually); the field is always labelled. */
  showLabel?: boolean
  placeholder?: string
  describedBy?: string
  disabled?: boolean
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void
  /** Esc with no list open. */
  onCancel?: () => void
  fieldRef?: RefObject<HTMLTextAreaElement | null>
  autoFocus?: boolean
  rows?: number
}

export function MentionField({ value, onChange, members, label, showLabel = true, placeholder, describedBy, disabled, onSubmit, onCancel, fieldRef, autoFocus, rows = 3 }: Props) {
  const id = useId()
  const listId = `${id}-list`
  const own = useRef<HTMLTextAreaElement>(null)
  const ref = fieldRef ?? own
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [closedAt, setClosedAt] = useState<number | null>(null) // Esc closed the list for the mention starting here
  const pendingCaret = useRef<number | null>(null)

  const typing = mentionAt(value, caret)
  const candidates = typing && closedAt !== typing.start ? mentionCandidates(typing.query, members) : []
  const open = candidates.length > 0 && !disabled
  const current = Math.min(active, Math.max(0, candidates.length - 1))

  // Put the caret after an inserted name once React has written the new text.
  useLayoutEffect(() => {
    const at = pendingCaret.current
    const el = ref.current
    if (at === null || !el) return
    pendingCaret.current = null
    el.setSelectionRange(at, at)
    setCaret(at)
  }, [value, ref])

  // Grow with the text (no inner scroll bar until it is long).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 360)}px`
  }, [value, ref])

  const pick = (m: Member) => {
    if (!typing) return
    const next = insertMention(value, typing.start, caret, m.name)
    pendingCaret.current = next.caret
    setActive(0)
    onChange(next.text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = candidates.length
        setActive((current + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        return
      }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(candidates[current]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setClosedAt(typing!.start)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSubmit?.()
      return
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  const track = () => setCaret(ref.current?.selectionStart ?? 0)

  return (
    <div className="qc-field">
      <label className={showLabel ? 'q-label qc-field__label' : 'q-sr'} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        className="q-input qc-field__input"
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        // Asked for by "Edit", which is gone once the field shows: focus goes where the person is working.
        autoFocus={autoFocus}
        spellCheck
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${current}` : undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length)
          setClosedAt(null)
          setActive(0)
          onChange(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onKeyUp={track}
        onClick={track}
        onSelect={track}
        onBlur={() => setClosedAt(typing?.start ?? null)}
        onFocus={() => setClosedAt(null)}
      />
      {open && (
        <ul className="qc-mentions" id={listId} role="listbox" aria-label="Members to mention">
          {candidates.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className={i === current ? 'qc-mentions__opt is-active' : 'qc-mentions__opt'}
              // Keep focus in the field: a press on the list must not blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(m)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="q-avatar qc-mentions__avatar" style={{ background: m.color }} aria-hidden="true">
                {initials(m.name)}
              </span>
              <span>{m.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
