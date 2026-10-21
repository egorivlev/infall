// Following a control on screen: shared by the Tour and the Tutorial, whose popovers stand beside real controls.
import { useEffect, useState } from 'react'
import { interfacePxPerScreenPx } from '../settings/apply'
import { sameBox, unionBox } from './position'
import type { Box } from './position'

/** How long a step's control may be missing (a panel still opening) before the step is taken for gone. */
export const GONE_AFTER_MS = 400

export type Seen = { target: Box; view: { width: number; height: number } }

/**
 * Where the controls `find` returns are, kept up to date: their size (ResizeObserver), the window's size, any
 * scrolling, and any change of layout around them (the Board panning, a panel opening) all lead to one measurement
 * per frame. Calls `onGone` when they have left the screen and stay away; with `clear`, the answer is also null at
 * once while nothing is found (a ring must not stay where a control was). `find` and `onGone` should be stable
 * (useCallback): a new `find` starts following again.
 */
export function useFollow(find: () => Element[], onGone: () => void, options: { clear?: boolean } = {}): Seen | null {
  const clear = options.clear === true
  const [seen, setSeen] = useState<Seen | null>(null)
  useEffect(() => {
    let frame = 0
    let gone = 0
    let watched: Element[] = []
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure)
    }
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    function measure() {
      frame = 0
      const found = find()
      if (found.length === 0) {
        if (clear) {
          watched = []
          sizes?.disconnect()
          setSeen(null)
        }
        if (gone === 0) {
          gone = window.setTimeout(() => {
            gone = 0
            if (find().length === 0) onGone()
            else measure()
          }, GONE_AFTER_MS)
        }
        return
      }
      window.clearTimeout(gone)
      gone = 0
      if (found.length !== watched.length || found.some((el, i) => el !== watched[i])) {
        sizes?.disconnect()
        for (const el of found) sizes?.observe(el)
        watched = found
      }
      const seenBox = unionBox(found.map((el) => el.getBoundingClientRect()))
      if (seenBox === null) return
      // Rectangles come in screen pixels; the ring and the popover are placed in the interface's own pixels, which
      // Settings → Interface scale zooms. Measured, not taken from the setting (see interfacePxPerScreenPx).
      const k = interfacePxPerScreenPx()
      const target = { left: seenBox.left * k, top: seenBox.top * k, width: seenBox.width * k, height: seenBox.height * k }
      const view = { width: window.innerWidth * k, height: window.innerHeight * k }
      setSeen((was) => (was && sameBox(was.target, target) && was.view.width === view.width && was.view.height === view.height ? was : { target, view }))
    }
    measure()
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    const changes = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null
    changes?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      window.clearTimeout(gone)
      sizes?.disconnect()
      changes?.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
    }
  }, [find, onGone, clear])
  return seen
}
