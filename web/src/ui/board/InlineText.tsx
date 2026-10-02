import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { returnFocus } from './focus'

type Props = {
  initial: string
  /** 'enter' confirms on Enter (titles); 'mod-enter' confirms on ⌘/Ctrl+Enter (summaries). */
  confirm: 'enter' | 'mod-enter'
  label: string
  placeholder?: string
  className?: string
  onCommit: (text: string) => void
  onDone: () => void
}

/**
 * In-place text editor. It keeps its own draft, so remote updates to the same field never
 * overwrite what the person is typing. Blur confirms, Esc cancels; if it unmounts because the
 * entity was deleted elsewhere, nothing is sent.
 */
export function InlineText({ initial, confirm, label, placeholder, className, onCommit, onDone }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      el.focus({ preventScroll: true })
      el.select()
    }
    return () => {
      finished.current = true // unmounting: never commit from a late blur
    }
  }, [])

  const finish = (commit: boolean) => {
    if (finished.current) return
    finished.current = true
    const text = (ref.current?.value ?? '').trim()
    if (commit && text !== initial) onCommit(text)
    onDone()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      returnFocus(ref.current)
      finish(false)
    } else if (e.key === 'Enter' && (confirm === 'enter' ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      returnFocus(ref.current)
      finish(true)
    }
  }

  return (
    <textarea
      ref={ref}
      className={`qb-inline nodrag nopan nowheel ${className ?? ''}`}
      defaultValue={initial}
      aria-label={label}
      placeholder={placeholder}
      rows={confirm === 'enter' ? 2 : 3}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
