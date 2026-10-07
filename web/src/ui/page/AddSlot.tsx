import { memo, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, Ref } from 'react'
import type { AddBlock } from './BlockTools'
import { TEMPLATES } from './visuals/templates'

type Props = {
  /** The new Block goes before the Block at this index (or at the end). */
  index: number
  label: string
  /** 'between': a thin line that shows on hover; 'end': plain text; 'first': the empty Page's button. */
  variant?: 'between' | 'end' | 'first'
  onAdd: AddBlock
  ref?: Ref<HTMLButtonElement>
}

type Stage = 'closed' | 'kind' | 'starter'

const BUTTON_CLASS = { between: 'qp-add', end: 'qp-add qp-add--end', first: 'q-btn q-btn--primary' } as const

/**
 * "+ Add block": a small menu of the two kinds, Text and Visual; Visual goes on to the starters.
 * Arrow keys move, Esc closes and gives focus back to the button.
 */
export const AddSlot = memo(function AddSlot({ index, label, variant = 'between', onAdd, ref }: Props) {
  const [stage, setStage] = useState<Stage>('closed')
  const wrapRef = useRef<HTMLDivElement>(null)
  const open = stage !== 'closed'

  useEffect(() => {
    if (stage === 'closed') return
    wrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [stage])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setStage('closed')
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const shut = () => {
    setStage('closed')
    wrapRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step) {
      e.preventDefault()
      items[(i + step + items.length) % items.length]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // closes the menu, not the panel
      shut()
    }
  }

  return (
    <div
      className={`qp-add-slot${open ? ' is-open' : ''}`}
      ref={wrapRef}
      onBlur={(e) => {
        // Focus went somewhere else on the Page (Tab): the menu does not stay behind.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setStage('closed')
      }}
    >
      <button
        ref={ref}
        type="button"
        className={BUTTON_CLASS[variant]}
        aria-label={variant === 'first' ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setStage(open ? 'closed' : 'kind')}
      >
        {variant === 'first' ? '+ Add block' : <span aria-hidden="true">+ Add block</span>}
      </button>
      {stage === 'kind' && (
        <div className="qp-menu" role="menu" aria-label="Add block" onKeyDown={onKeyDown}>
          <button
            type="button"
            role="menuitem"
            className="qp-menu__item"
            onClick={() => {
              setStage('closed')
              onAdd(index)
            }}
          >
            Text
          </button>
          <button type="button" role="menuitem" className="qp-menu__item" aria-haspopup="menu" onClick={() => setStage('starter')}>
            Visual
          </button>
        </div>
      )}
      {stage === 'starter' && (
        <div className="qp-menu" role="menu" aria-label="Start the Visual from" onKeyDown={onKeyDown}>
          <span className="q-caps qp-menu__label" aria-hidden="true">
            Start the Visual from
          </span>
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              role="menuitem"
              className="qp-menu__item"
              onClick={() => {
                setStage('closed')
                onAdd(index, template)
              }}
            >
              {template.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
