import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { STATUSES } from '../../lib'
import type { Status } from '../../lib'
import { StatusGlyph } from './StatusGlyph'
import { STATUS_LABEL } from './status'

type Props = {
  value: Status
  onPick: (status: Status) => void
  /** 'menu': a popup that takes focus and closes on Esc. 'inline': a radio group (the inspector). */
  variant?: 'menu' | 'inline'
  onClose?: () => void
  label?: string
}

export function StatusMenu({ value, onPick, variant = 'menu', onClose, label = 'Status' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const menu = variant === 'menu'

  useEffect(() => {
    if (!menu) return
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [menu])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (step) {
      e.preventDefault()
      e.stopPropagation()
      items[(i + step + items.length) % items.length]?.focus()
    } else if (e.key === 'Escape' && menu) {
      e.preventDefault()
      e.stopPropagation()
      onClose?.()
    }
  }

  return (
    <div
      ref={ref}
      className={menu ? 'qb-status-menu nodrag nopan nowheel' : 'qb-status-picker'}
      role={menu ? 'menu' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          role={menu ? 'menuitemradio' : 'radio'}
          aria-checked={s === value}
          tabIndex={menu || s === value ? 0 : -1}
          className="qb-status-opt"
          data-status={s}
          onClick={(e) => {
            e.stopPropagation()
            onPick(s)
          }}
        >
          <span className="qb-status-opt__glyph">
            <StatusGlyph status={s} size={10} label={null} />
          </span>
          <span>{STATUS_LABEL[s]}</span>
        </button>
      ))}
    </div>
  )
}
