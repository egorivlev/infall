// The Branch Graph screen's own arithmetic, kept pure so it is tested without a browser: which display rows there
// are (one per Activity, plus one label row above the top end of each Branch's line), where things are drawn, what
// is selected, and where the arrow keys go. The layout itself is the library's (`layoutGraph`).
import type { GraphLane, GraphLayout, GraphRow, Moment } from '../../lib'

/** Width of one column of lines, and the space left and right of them, in interface pixels. */
export const COL_W = 18
export const PAD_X = 10
/** The text column never gets narrower than this; below it the graph scrolls sideways inside its box. */
export const MIN_TEXT = 300
/** Row height at text size 100 %. Rows never change height: words arriving later fill a placeholder. */
export const ROW_H = 28
/** How many lane colours there are besides main's (`--q-lane-1` … `--q-lane-6`). */
export const LANE_COLOURS = 6

/** A display row: a dot (one Activity, or the start), or the label at the top end of a Branch's line. */
export type Item = { kind: 'row'; row: number } | { kind: 'label'; lane: number }

export type Display = {
  items: Item[]
  /** Layout row → its item index. */
  at: Int32Array
  /** Lane index → the item index of its label row. */
  labelAt: Int32Array
}

/**
 * The rows as they are shown: every layout row, and above the newest dot of each Branch (its fork point when it has
 * no Changes) a label row for it. Several labels above one row go left to right by column.
 */
export function buildDisplay(layout: GraphLayout): Display {
  const above = new Map<number, number[]>()
  layout.lanes.forEach((lane, i) => {
    const list = above.get(lane.lastRow)
    if (list) list.push(i)
    else above.set(lane.lastRow, [i])
  })
  const items: Item[] = []
  const at = new Int32Array(layout.rows.length)
  const labelAt = new Int32Array(layout.lanes.length)
  layout.rows.forEach((_, r) => {
    const labels = above.get(r)
    if (labels) {
      labels.sort((a, b) => layout.lanes[a]!.column - layout.lanes[b]!.column || a - b)
      for (const lane of labels) {
        labelAt[lane] = items.length
        items.push({ kind: 'label', lane })
      }
    }
    at[r] = items.length
    items.push({ kind: 'row', row: r })
  })
  return { items, at, labelAt }
}

/** Width of the lines area for `columns` columns. */
export function linesWidth(columns: number): number {
  return PAD_X * 2 + Math.max(columns, 1) * COL_W
}

/** Centre of a column. */
export function xOf(column: number): number {
  return PAD_X + column * COL_W + COL_W / 2
}

/** Which lane colour a Branch gets: 0 for main (the first lane), then 1 … LANE_COLOURS in turn by when it started. */
export function colourOf(laneIndex: number): number {
  return laneIndex <= 0 ? 0 : ((laneIndex - 1) % LANE_COLOURS) + 1
}

/** The item indices to render for a scroll position, with `overscan` items above and below. */
export function windowOf(scrollTop: number, height: number, rowH: number, total: number, overscan = 8): [number, number] {
  if (total === 0) return [0, -1]
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const last = Math.min(total - 1, Math.ceil((scrollTop + height) / rowH) + overscan)
  return [first, Math.max(first, last)]
}

/** The layout rows among the items `first … last`, widened by `margin` items each way (for the words). */
export function rowsIn(display: Display, first: number, last: number, margin = 0): number[] {
  const out: number[] = []
  const from = Math.max(0, first - margin)
  const to = Math.min(display.items.length - 1, last + margin)
  for (let i = from; i <= to; i++) {
    const item = display.items[i]!
    if (item.kind === 'row') out.push(item.row)
  }
  return out
}

// ---- selection ----

/**
 * What is selected, kept by what it is rather than by its index, so it survives the graph being laid out again:
 * `key` is the row's `GraphRow.key` ('start' for the start row) or `fork:<branch id>` for a Branch's fork point.
 * `follow`: the newest dot of its Branch, which stays the newest as Changes arrive ("from now").
 * `checkpoint`: a ◆ was chosen rather than its dot (the same moment; only the words differ).
 */
export type Selection = { key: string; moment: Moment; checkpoint?: string; follow?: boolean }

/** A selection placed on the present layout. `fork` is a lane index when a fork point is selected. */
export type Placed = { row: number; fork?: number; moment: Moment; checkpoint?: string }

const keyIndex = new WeakMap<GraphLayout, Map<string, number>>()
function rowByKey(layout: GraphLayout, key: string): number | undefined {
  let map = keyIndex.get(layout)
  if (!map) {
    map = new Map(layout.rows.map((r, i) => [r.key, i]))
    keyIndex.set(layout, map)
  }
  return map.get(key)
}

/** A fork point can be chosen when its Branch has no Changes (there is nothing else to choose) or a ◆ sits on it. */
export function forkSelectable(lane: GraphLane): boolean {
  return lane.rows.length === 0 || lane.startCheckpoints.length > 0
}

function laneIndexOf(layout: GraphLayout, branch: string): number {
  return layout.lanes.findIndex((l) => l.branch === branch)
}

/** The selection of a row (`follow` when it is the newest dot of its Branch). */
export function selectRow(layout: GraphLayout, row: number, checkpoint?: string): Selection | null {
  const r = layout.rows[row]
  if (!r) return null
  const lane = layout.lanes[laneIndexOf(layout, r.branch)]
  const sel: Selection = { key: r.key, moment: r.moment }
  if (r.kind !== 'start' && lane && lane.lastRow === row && lane.rows.length > 0) sel.follow = true
  if (checkpoint !== undefined && r.checkpoints.some((c) => c.name === checkpoint)) sel.checkpoint = checkpoint
  return sel
}

/** The selection of a Branch's fork point (the start of a Branch, seq 0). */
export function selectFork(layout: GraphLayout, laneIndex: number, checkpoint?: string): Selection | null {
  const lane = layout.lanes[laneIndex]
  if (!lane) return null
  const sel: Selection = { key: `fork:${lane.branch}`, moment: { branch: lane.branch, seq: 0 } }
  if (checkpoint !== undefined && lane.startCheckpoints.some((c) => c.name === checkpoint)) sel.checkpoint = checkpoint
  return sel
}

/** The newest dot of a Branch ("from now on <name>"), or its fork point when it has no Changes. */
export function selectNow(layout: GraphLayout, branch: string): Selection | null {
  const i = laneIndexOf(layout, branch)
  const lane = layout.lanes[i]
  if (!lane) return null
  return lane.rows.length > 0 ? selectRow(layout, lane.lastRow) : selectFork(layout, i)
}

/** Where a selection is on this layout; null when its Branch is gone. */
export function place(layout: GraphLayout, sel: Selection): Placed | null {
  if (sel.key.startsWith('fork:')) {
    const i = laneIndexOf(layout, sel.key.slice(5))
    const lane = layout.lanes[i]
    if (!lane) return null
    // A Branch that has gained Changes since: its fork point is still a moment, now just not a dot of its own.
    const checkpoint = sel.checkpoint !== undefined && lane.startCheckpoints.some((c) => c.name === sel.checkpoint) ? sel.checkpoint : undefined
    return { row: lane.forkRow, fork: i, moment: { branch: lane.branch, seq: 0 }, checkpoint }
  }
  if (sel.follow) {
    const now = selectNow(layout, sel.moment.branch)
    if (!now) return null
    if (now.key.startsWith('fork:')) return place(layout, now)
    const row = rowByKey(layout, now.key)!
    return { row, moment: now.moment, checkpoint: keepCheckpoint(layout.rows[row]!, sel.checkpoint) }
  }
  const exact = rowByKey(layout, sel.key)
  if (exact !== undefined) return { row: exact, moment: sel.moment, checkpoint: keepCheckpoint(layout.rows[exact]!, sel.checkpoint) }
  // The Activity changed (a Checkpoint split it): the dot that now holds the moment.
  if (sel.moment.seq <= 0) {
    const i = laneIndexOf(layout, sel.moment.branch)
    const lane = layout.lanes[i]
    if (!lane) return null
    return { row: lane.forkRow, fork: sel.key === 'start' ? undefined : i, moment: sel.moment }
  }
  const lane = layout.lanes[laneIndexOf(layout, sel.moment.branch)]
  if (!lane) return null
  let row = -1
  for (const r of lane.rows) {
    if (layout.rows[r]!.activity!.from_seq < sel.moment.seq) {
      row = r
      break
    }
  }
  if (row < 0) return null
  return { row, moment: sel.moment, checkpoint: keepCheckpoint(layout.rows[row]!, sel.checkpoint) }
}

function keepCheckpoint(row: GraphRow, name: string | undefined): string | undefined {
  return name !== undefined && row.checkpoints.some((c) => c.name === name && c.seq === row.moment.seq) ? name : undefined
}

// ---- moving with the keyboard ----

/** ↑ (-1) / ↓ (+1): the next row up or down; from a fork point, from the row it sits on. Stays at the ends. */
export function moveVertical(layout: GraphLayout, placed: Placed | null, direction: -1 | 1): Selection | null {
  if (layout.rows.length === 0) return null
  if (!placed) return selectRow(layout, direction < 0 ? layout.rows.length - 1 : 0)
  const to = Math.min(layout.rows.length - 1, Math.max(0, placed.row + direction))
  if (placed.fork === undefined && to === placed.row) return null
  return selectRow(layout, to)
}

/**
 * ← (-1) / → (+1): the nearest dot on the neighbouring line — the closest column on that side that has a dot or a
 * fork point that can be chosen, then the one nearest in rows (the upper one on a tie). null when there is none.
 */
export function moveSideways(layout: GraphLayout, placed: Placed, direction: -1 | 1): Selection | null {
  const column = placed.fork !== undefined ? layout.lanes[placed.fork]!.column : layout.rows[placed.row]!.column
  let best: { column: number; distance: number; row: number; fork?: number } | null = null
  const consider = (c: number, row: number, fork?: number) => {
    if (direction < 0 ? c >= column : c <= column) return
    const distance = Math.abs(row - placed.row)
    if (
      !best ||
      Math.abs(c - column) < Math.abs(best.column - column) ||
      (c === best.column && (distance < best.distance || (distance === best.distance && row < best.row)))
    ) {
      best = { column: c, distance, row, fork }
    }
  }
  layout.lanes.forEach((lane, i) => {
    for (const r of lane.rows) consider(lane.column, r)
    if (forkSelectable(lane) && i > 0) consider(lane.column, lane.forkRow, i)
  })
  const found = best as { row: number; fork?: number } | null
  if (!found) return null
  return found.fork !== undefined ? selectFork(layout, found.fork) : selectRow(layout, found.row)
}

// ---- words ----

/** "Ana Ruiz" → "Ana". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/**
 * A dot's spoken name: its Branch, who, when, the first line of what was done (or "loading"), and its Checkpoints.
 * "main, Ana Ruiz, 13:50, Added Card Axions, Checkpoint before-review".
 */
export function spokenName(parts: { branch: string; who?: string; when?: string; first?: string; checkpoints: readonly string[] }): string {
  const out = [parts.branch]
  if (parts.who) out.push(parts.who)
  if (parts.when) out.push(parts.when)
  out.push(parts.first ?? 'loading')
  for (const c of parts.checkpoints) out.push(`Checkpoint ${c}`)
  return out.join(', ')
}
