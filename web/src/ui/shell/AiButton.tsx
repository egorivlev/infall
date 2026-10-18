import { useEffect, useRef } from 'react'
import { aiPanel, useAiPanel } from '../bridge'
import { Icon } from './Icon'

/** Shows or hides the AI sidebar, on whatever screen is showing. Not rendered for Guests. */
export function AiButton() {
  const open = useAiPanel((s) => s.open)
  const button = useRef<HTMLButtonElement>(null)

  // When the sidebar closes from inside (its collapse button), focus has nowhere to be: bring it back here.
  const wasOpen = useRef(open)
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    if (!closed) return
    const active = document.activeElement
    if (active === null || active === document.body || !active.isConnected) button.current?.focus({ preventScroll: true })
  }, [open])

  return (
    <button ref={button} type="button" className="q-btn q-topbtn" data-tour="ai" title="AI sidebar" aria-pressed={open} onClick={() => aiPanel.toggle()}>
      <Icon name="ai" size={13} />
      AI
    </button>
  )
}
