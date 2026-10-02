import { useEffect, useState } from 'react'

/** True only after `active` has stayed true for `ms`; avoids flashing loaders. */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active) return
    const t = window.setTimeout(() => setOn(true), ms)
    return () => {
      window.clearTimeout(t)
      setOn(false)
    }
  }, [active, ms])
  return active && on
}
