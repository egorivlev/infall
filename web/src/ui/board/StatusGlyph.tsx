import { memo } from 'react'
import type { Status } from '../../lib'
import { STATUS_LABEL } from './status'

type Props = {
  status: Status
  size?: number
  /** Accessible name. Defaults to the status label; pass null when a visible word sits next to the glyph. */
  label?: string | null
}

/** The one status shape: colour comes from `currentColor`, so the parent sets `color: var(--q-st-…)`. */
export const StatusGlyph = memo(function StatusGlyph({ status, size = 10, label }: Props) {
  const name = label === undefined ? STATUS_LABEL[status] : label
  const a11y = name === null ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name }
  return (
    <svg
      className="q-glyph"
      data-shape={status}
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      focusable="false"
      {...a11y}
    >
      {status === 'idea' && <path d="M5 1.2 L8.8 5 L5 8.8 L1.2 5 Z" />}
      {status === 'reading' && (
        <>
          <circle cx={5} cy={5} r={3.8} />
          <path d="M5 1.2 A3.8 3.8 0 0 1 5 8.8 Z" fill="currentColor" stroke="none" />
        </>
      )}
      {status === 'understood' && <circle cx={5} cy={5} r={3.8} fill="currentColor" />}
      {status === 'open_question' && (
        <>
          <circle cx={5} cy={5} r={3.8} />
          <path d="M3.8 4 C3.8 2.7 6.2 2.7 6.2 4 C6.2 5 5 5 5 6" strokeWidth={1.1} />
          <circle cx={5} cy={7.4} r={0.6} fill="currentColor" stroke="none" />
        </>
      )}
      {status === 'dead_end' && <path d="M1.2 5 H7.4 M8.4 1.8 V8.2" />}
    </svg>
  )
})
