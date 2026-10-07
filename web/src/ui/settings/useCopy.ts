import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies text with the Clipboard API and says how it went for a moment.
 * Nothing is kept: the text goes to the clipboard and nowhere else.
 */
export function useCopy(): { state: CopyState; copy: (text: string) => Promise<void>; reset: () => void } {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(async (text: string) => {
    let next: CopyState = 'copied'
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      next = 'failed' // no permission, no secure context, or no Clipboard API at all
    }
    setState(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 2500)
  }, [])

  const reset = useCallback(() => {
    window.clearTimeout(timer.current)
    setState('idle')
  }, [])

  return { state, copy, reset }
}
