import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'

export type DraftResult = {
  /** false when the person pressed Esc. */
  commit: boolean
  text: string
  /** Finished from the keyboard (Enter / Esc) rather than by leaving the field. */
  keyboard: boolean
}

type Props = {
  initial: string
  label: string
  /** 'enter' finishes on Enter (the title); 'mod-enter' on ⌘/Ctrl+Enter (a Block). */
  confirm: 'enter' | 'mod-enter'
  /** Select everything on open (the title) instead of putting the caret at the end. */
  selectAll?: boolean
  className?: string
  placeholder?: string
  describedBy?: string
  onFinish: (result: DraftResult) => void
}

function grow(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/**
 * An in-place editor that owns its draft: the textarea is uncontrolled, so typing re-renders
 * nothing — not this component, not its siblings, not the Board — and remote updates to the same
 * text never overwrite what is being typed. Blur or the confirm key finishes, Esc cancels. If it
 * unmounts because the thing was removed elsewhere, nothing is reported.
 */
export function DraftArea({ initial, label, confirm, selectAll, className, placeholder, describedBy, onFinish }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)

  useLayoutEffect(() => {
    // StrictMode runs this effect twice in development (mount, simulated unmount, mount). The
    // cleanup marks the editor finished so a late blur cannot commit; this line must undo that
    // for the second run, or the editor would never finish again. Same pattern as board/InlineText.
    finished.current = false
    const el = ref.current
    if (el) {
      grow(el)
      el.focus({ preventScroll: true })
      if (selectAll) el.select()
      else el.setSelectionRange(el.value.length, el.value.length)
    }
    return () => {
      finished.current = true
    }
  }, [selectAll])

  const finish = (commit: boolean, keyboard: boolean) => {
    if (finished.current) return
    finished.current = true
    onFinish({ commit, text: ref.current?.value ?? initial, keyboard })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation() // the panel's own Esc must not see keys typed here
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(false, true)
    } else if (e.key === 'Enter' && (confirm === 'enter' ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      finish(true, true)
    }
  }

  return (
    <textarea
      ref={ref}
      className={className}
      defaultValue={initial}
      aria-label={label}
      aria-describedby={describedBy}
      placeholder={placeholder}
      rows={1}
      spellCheck
      onInput={(e) => grow(e.currentTarget)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true, false)}
    />
  )
}
