import type { CardVM, FrameVM } from '../../lib'

/** Frame id -> number of Cards whose centre lies inside the Frame. Membership is geometric. */
export function frameCounts(frames: FrameVM[], cards: CardVM[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of frames) {
    let n = 0
    for (const c of cards) {
      const cx = c.x + c.w / 2
      const cy = c.y + c.h / 2
      if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) n++
    }
    out[f.id] = n
  }
  return out
}
