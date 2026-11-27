// q-scale (styles/components.css): a stepper for a percentage among fixed steps — − value + in one block.
// The value is the one tab stop (a spinbutton): Left / Down and Right / Up step it, Home and End go to the ends. The −
// and + buttons are for the pointer; they stay out of the tab order, as a spinbutton's own buttons do.
import type { KeyboardEvent } from 'react'
import { formatPercent } from './format'

export function ScaleSelect(props: {
  id: string
  /** The element that names it (the settings row's label). */
  labelId: string
  descriptionId?: string
  /** The setting's name, for the − and + buttons' own names ("Smaller: Interface scale"). */
  name: string
  value: number
  steps: readonly number[]
  onChange: (value: number) => void
}) {
  const { id, labelId, descriptionId, name, value, steps, onChange } = props
  const first = steps[0]
  const last = steps[steps.length - 1]
  // A value that is not one of the steps (it cannot be, after prefs.ts reads it) steps to its neighbour.
  const lower = [...steps].reverse().find((s) => s < value)
  const higher = steps.find((s) => s > value)
  const go = (to: number | undefined) => {
    if (to !== undefined && to !== value) onChange(to)
  }

  const onKey = (e: KeyboardEvent) => {
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp'
        ? higher
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown'
          ? lower
          : e.key === 'Home'
            ? first
            : e.key === 'End'
              ? last
              : null
    if (to === null) return
    e.preventDefault()
    go(to)
  }

  return (
    <span className="q-scale">
      <button type="button" className="q-scale__step" tabIndex={-1} aria-label={`Smaller: ${name}`} aria-controls={id} disabled={lower === undefined} onClick={() => go(lower)}>
        −
      </button>
      <span
        id={id}
        className="q-scale__value"
        role="spinbutton"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-valuenow={value}
        aria-valuemin={first}
        aria-valuemax={last}
        aria-valuetext={formatPercent(value)}
        onKeyDown={onKey}
      >
        {formatPercent(value)}
      </span>
      <button type="button" className="q-scale__step" tabIndex={-1} aria-label={`Larger: ${name}`} aria-controls={id} disabled={higher === undefined} onClick={() => go(higher)}>
        +
      </button>
    </span>
  )
}
