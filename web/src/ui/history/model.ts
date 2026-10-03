// Pure derivations for the timeline. The x axis is Activity order, evenly spaced:
// boundary k (0 … N) is the moment after Activity k, and N is now.
import type { Activity } from '../../lib'
import { dayKey, formatDay } from './format'

export type LaneItem = { activity: Activity; index: number }
export type Lane = { author: string; items: LaneItem[] }

/** One lane per author, in order of first appearance. */
export function buildLanes(activities: readonly Activity[]): Lane[] {
  const byAuthor = new Map<string, Lane>()
  activities.forEach((activity, index) => {
    let lane = byAuthor.get(activity.author)
    if (!lane) {
      lane = { author: activity.author, items: [] }
      byAuthor.set(activity.author, lane)
    }
    lane.items.push({ activity, index })
  })
  return [...byAuthor.values()]
}

/** Index of the first Activity whose toSeq is at or after seq; N when there is none. */
function firstReaching(activities: readonly Activity[], seq: number): number {
  let lo = 0
  let hi = activities.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (activities[mid]!.toSeq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Where a moment sits on the axis, 0 … N; fractional when it falls inside an Activity. */
export function positionOf(activities: readonly Activity[], seq: number): number {
  const i = firstReaching(activities, seq)
  const a = activities[i]
  if (!a) return activities.length
  if (seq <= a.fromSeq) return i
  return i + (seq - a.fromSeq) / (a.toSeq - a.fromSeq)
}

/** The Activity a moment belongs to (fromSeq < seq ≤ toSeq), or -1 at the start and beyond the end. */
export function activityAt(activities: readonly Activity[], seq: number): number {
  const i = firstReaching(activities, seq)
  const a = activities[i]
  return a && seq > a.fromSeq ? i : -1
}

/** The moment a scrubber step previews: null at N (now), 0 at the start, else the end of Activity k. */
export function seqForStep(activities: readonly Activity[], k: number): number | null {
  if (k >= activities.length) return null
  if (k <= 0) return 0
  return activities[k - 1]!.toSeq
}

export type DayTick = { index: number; label: string }

/** The first Activity of each day. */
export function dayTicks(activities: readonly Activity[], now: Date = new Date()): DayTick[] {
  const out: DayTick[] = []
  let last = ''
  activities.forEach((a, index) => {
    const key = dayKey(a.startedAt)
    if (key !== last) out.push({ index, label: formatDay(a.startedAt, now) })
    last = key
  })
  return out
}

/** Block width in px: 6 + 3 × min(count, 12). */
export function blockWidth(changes: number): number {
  return 6 + 3 * Math.min(Math.max(changes, 0), 12)
}
