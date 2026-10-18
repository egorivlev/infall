// Where the popover and the ring go, from where the control is. Plain arithmetic, so it can be tested without a layout.

export type Box = { left: number; top: number; width: number; height: number }
export type Size = { width: number; height: number }

/** The smallest box around all of them. */
export function unionBox(boxes: Box[]): Box | null {
  const first = boxes[0]
  if (!first) return null
  let left = first.left
  let top = first.top
  let right = first.left + first.width
  let bottom = first.top + first.height
  for (const b of boxes.slice(1)) {
    left = Math.min(left, b.left)
    top = Math.min(top, b.top)
    right = Math.max(right, b.left + b.width)
    bottom = Math.max(bottom, b.top + b.height)
  }
  return { left, top, width: right - left, height: bottom - top }
}

export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

const GAP = 10 // between the control and the popover
const MARGIN = 8 // between the popover and the window's edge
const INSET = 24 // from the corner of a control too large to stand beside

/**
 * The popover's top-left corner: under the control if it fits, else above, to its right, to its left; a control that
 * leaves no room on any side (the Board) gets the popover inside its bottom-left corner. Always inside the window.
 */
export function placePopover(target: Box, pop: Size, view: Size): { left: number; top: number } {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, view.width - pop.width - MARGIN))
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, view.height - pop.height - MARGIN))
  const right = target.left + target.width
  const bottom = target.top + target.height
  if (bottom + GAP + pop.height <= view.height - MARGIN) return { left: clampX(target.left), top: bottom + GAP }
  if (target.top - GAP - pop.height >= MARGIN) return { left: clampX(target.left), top: target.top - GAP - pop.height }
  if (right + GAP + pop.width <= view.width - MARGIN) return { left: right + GAP, top: clampY(target.top) }
  if (target.left - GAP - pop.width >= MARGIN) return { left: target.left - GAP - pop.width, top: clampY(target.top) }
  return { left: clampX(target.left + INSET), top: clampY(bottom - pop.height - INSET) }
}

const RING_PAD = 4
const RING_EDGE = 2

/** The ring: a little outside the control, and never outside the window (a control that fills it is ringed inside). */
export function ringBox(target: Box, view: Size): Box {
  const left = Math.max(RING_EDGE, target.left - RING_PAD)
  const top = Math.max(RING_EDGE, target.top - RING_PAD)
  const right = Math.min(view.width - RING_EDGE, target.left + target.width + RING_PAD)
  const bottom = Math.min(view.height - RING_EDGE, target.top + target.height + RING_PAD)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
