import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

export type MenuItem = { label: string; onPick: () => void }

type Props = {
  /** What the button and the menu are called for a screen reader, e.g. "More for experiment.py". */
  label: string
  items: readonly MenuItem[]
  /** The button's tooltip. */
  title?: string
  /** What the button shows; "⋯" by default. */
  glyph?: ReactNode
  /** Class names, so each place can size it like its neighbours. The Run's are the default. */
  wrapClass?: string
  buttonClass?: string
  menuClass?: string
}

/** A small "⋯" menu. Arrow keys move, Home/End jump, Esc closes and gives focus back to the button. */
export function MoreMenu({
  label,
  items,
  title = 'More',
  glyph = '⋯',
  wrapClass = 'qp-run__more-wrap',
  buttonClass = 'q-btn q-btn--sm q-btn--quiet qp-run__more-btn',
  menuClass = 'qp-run__menu',
}: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    wrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const shut = () => {
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step) {
      e.preventDefault()
      list[(i + step + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // closes the menu, not the panel
      shut()
    }
  }

  return (
    <span
      className={wrapClass}
      ref={wrapRef}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass}
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{glyph}</span>
      </button>
      {open && (
        <div className={`qp-menu ${menuClass}`} role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="qp-menu__item"
              onClick={() => {
                shut() // focus is back on the button before anything opens, so a dialog returns it there
                item.onPick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
