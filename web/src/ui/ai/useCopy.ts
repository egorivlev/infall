import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/** Copies text with the Clipboard API and says how it went for a moment. */
export function useCopy(): { state: CopyState; copy: (text: string) => Promise<void> } {
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
    timer.current = window.setTimeout(() => setState('idle'), next === 'failed' ? 6000 : 2500)
  }, [])

  return { state, copy }
}
