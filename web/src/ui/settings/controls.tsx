// The parts every Settings section is built from: a row with a visible label, a one-line description where the
// effect is not obvious, the control, and "Reset to default". Every change applies at once: there is no Save.
import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'

type RowProps = {
  label: string
  description?: string
  /** Whether the value differs from its default: "Reset to default" is only offered then. */
  changed: boolean
  onReset: () => void
  /** A group of choices names itself with aria-labelledby: a <label for> would rename its chosen button "Theme". */
  group?: boolean
  children: (ids: { labelId: string; descriptionId?: string; controlId: string }) => ReactNode
}

export function SettingRow({ label, description, changed, onReset, group = false, children }: RowProps) {
  const id = useId()
  const labelId = `${id}-label`
  const descriptionId = description ? `${id}-desc` : undefined
  const controlId = `${id}-control`
  return (
    <div className="q-set-row">
      <div className="q-set-row__text">
        {group ? (
          <span className="q-set-row__label" id={labelId}>
            {label}
          </span>
        ) : (
          <label className="q-set-row__label" id={labelId} htmlFor={controlId}>
            {label}
          </label>
        )}
        {description && (
          <p className="q-set-row__desc" id={descriptionId}>
            {description}
          </p>
        )}
      </div>
      <div className="q-set-row__control">
        {children({ labelId, descriptionId, controlId })}
        <button
          type="button"
          className="q-btn q-btn--sm q-btn--quiet q-set-row__reset"
          disabled={!changed}
          aria-label={`Reset ${label} to default`}
          title={changed ? undefined : 'Already the default'}
          onClick={onReset}
        >
          Reset to default
        </button>
      </div>
    </div>
  )
}

type Option<T extends string> = { value: T; label: string }

/**
 * A row of buttons of which exactly one is chosen (a radio group): arrow keys move and choose, Tab leaves.
 */
export function Segmented<T extends string>(props: {
  id: string
  labelId: string
  descriptionId?: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
}) {
  const { id, labelId, descriptionId, value, options, onChange } = props
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
    <div className="q-seg" role="radiogroup" aria-labelledby={labelId} aria-describedby={descriptionId} ref={group} onKeyDown={onKey}>
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

/** A choice among percentages, as a native list box (keyboard and screen readers know it). */
export function PercentSelect(props: {
  id: string
  descriptionId?: string
  value: number
  steps: readonly number[]
  defaultValue: number
  onChange: (value: number) => void
}) {
  const { id, descriptionId, value, steps, defaultValue, onChange } = props
  return (
    <select
      id={id}
      className="q-input q-set-select"
      aria-describedby={descriptionId}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {steps.map((s) => (
        <option key={s} value={s}>
          {s}%{s === defaultValue ? ' (default)' : ''}
        </option>
      ))}
    </select>
  )
}

/** A section of Settings: its title (the page's heading), what it is about, and its rows. */
export function SectionHead({ title, intro, headingRef, onResetAll, canResetAll }: {
  title: string
  intro?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
  onResetAll?: () => void
  canResetAll?: boolean
}) {
  return (
    <header className="q-settings__head q-set-head">
      <div className="q-set-head__row">
        <h1 className="q-settings__title" ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        {onResetAll && (
          <button type="button" className="q-btn q-btn--sm" disabled={!canResetAll} onClick={onResetAll}>
            Reset {title} to defaults
          </button>
        )}
      </div>
      {intro && <p className="q-settings__text">{intro}</p>}
    </header>
  )
}
