// What the name field of the Branch Graph says about where a new Branch will start (branch-graph.md §2).
import type { GraphResponse, Moment } from './types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')

/** "13:50" today, "12 Nov, 13:50" another day this year, "12 Nov 2025, 13:50" another year. This device's time. */
export function formatWhen(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
    return time
  }
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === today.getFullYear() ? `${day}, ${time}` : `${day} ${d.getFullYear()}, ${time}`
}

export type StartFrom = {
  moment: Moment // where the Branch will start: a dot's `moment`, a Checkpoint's, or a fork point (seq 0)
  checkpoint?: string // set when the Member chose a ◆ rather than its dot
}

export type StartLabelOptions = {
  nameOf?: (memberId: string) => string | undefined // a Member's name; unknown ones read "Someone"
  me?: string // the signed-in Member's id: their own work reads "your work"
  now?: number // for "today"; default Date.now()
}

/**
 * The words under the name field:
 * - "from now on main" — the newest moment of a Branch (its head);
 * - "from Checkpoint before-review on main" — a ◆ was chosen;
 * - "from Ana's work at 13:50 on exp-A" — a dot (an edit Activity) that is not the newest;
 *   a Merge or Restore dot reads "from Ana's Merge at …" / "from Ana's Restore at …"; your own reads "your work";
 * - "from the start of exp-A" — a Branch's fork point when it has Changes since;
 * - "from Change 12 of main" — any other moment (inside an Activity), which the graph does not offer.
 * The time is when the Activity ended (`formatWhen`). An unknown Branch reads "from a Branch that is not there".
 */
export function startLabel(graph: GraphResponse, from: StartFrom, options: StartLabelOptions = {}): string {
  const b = graph.branches.find((x) => x.id === from.moment.branch)
  if (!b) return 'from a Branch that is not there'
  const seq = from.moment.seq
  if (from.checkpoint !== undefined) {
    const cp = b.checkpoints.find((c) => c.name === from.checkpoint && c.seq === seq)
    if (cp) return `from Checkpoint ${cp.name} on ${b.name}`
  }
  if (seq >= b.seq) return `from now on ${b.name}`
  if (seq <= 0) return `from the start of ${b.name}`
  const a = b.activities.find((x) => x.to_seq === seq)
  if (!a) return `from Change ${seq} of ${b.name}`
  const whose =
    options.me !== undefined && a.author === options.me
      ? 'your'
      : `${options.nameOf?.(a.author) ?? 'Someone'}'s`
  const what = a.kind === 'merge' ? 'Merge' : a.kind === 'restore' ? 'Restore' : 'work'
  return `from ${whose} ${what} at ${formatWhen(a.ended_at, options.now)} on ${b.name}`
}
