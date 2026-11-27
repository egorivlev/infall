// q-seg (styles/components.css): two to four exclusive choices that apply at once — one tab stop, a radio group.
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'

export type SegOption<T extends string> = { value: T; label: string }

/** Arrow keys move and choose (focus follows the choice), Home and End go to the ends, Tab leaves. */
export function Segmented<T extends string>(props: {
  id: string
  labelId: string
  descriptionId?: string
  value: T
  options: SegOption<T>[]
  onChange: (value: T) => void
  /** Stretch the options across the row (a form's choice). */
  fill?: boolean
}) {
  const { id, labelId, descriptionId, value, options, onChange, fill = false } = props
  const group = useRef<HTMLDivElement>(null)
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null
    if (step === 0 && to === null) return
    e.preventDefault()
    const at = options.findIndex((o) => o.value === value)
    const next = options[to ?? (at + step + options.length) % options.length]
    if (!next) return
    onChange(next.value)
    // Focus follows the choice once it has rendered.
    window.setTimeout(() => group.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus(), 0)
  }
  return (
    <div className={fill ? 'q-seg q-seg--fill' : 'q-seg'} role="radiogroup" aria-labelledby={labelId} aria-describedby={descriptionId} ref={group} onKeyDown={onKey}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            id={on ? `${id}-on` : undefined}
            data-value={o.value}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="q-seg__opt"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
