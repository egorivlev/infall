// The lines, dots, forks, Merges and ◆ of the rows in view, drawn as one SVG that covers only those rows. Everything
// here is decoration for sight (aria-hidden): the rows themselves carry the words and the spoken names.
import { memo } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { GraphLayout } from '../../lib'
import { forkSelectable, xOf } from './model'
import type { Display } from './model'

type Props = {
  layout: GraphLayout
  display: Display
  first: number // item indices in view (with overscan)
  last: number
  rowH: number
  width: number // of the lines area
  colours: readonly number[] // lane index → lane colour
  laneOfBranch: ReadonlyMap<string, number>
  selectedRow: number | null // layout row of the selected dot
  selectedFork: number | null // lane index of a selected fork point
  /** A ◆ on a dot was clicked (the same moment as the dot; the words say "from Checkpoint …"). */
  onCheckpoint: (row: number, name: string) => void
}

const DOT = 4
const DIAMOND = 5.5

function diamond(x: number, y: number, r: number): string {
  return `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`
}

const keep = (e: MouseEvent) => e.preventDefault() // keep focus where it is (the name field, or the graph)

export const GraphLines = memo(function GraphLines(props: Props) {
  const { layout, display, first, last, rowH, width, colours, laneOfBranch, selectedRow, selectedFork, onCheckpoint } = props
  const top = first * rowH
  const height = Math.max(0, (last - first + 1) * rowH)
  const lo = top - rowH
  const hi = top + height + rowH
  const R = rowH / 2
  const yOf = (row: number) => display.at[row]! * rowH + rowH / 2
  const meets = (a: number, b: number) => Math.max(a, b) >= lo && Math.min(a, b) <= hi
  const clip = (y: number) => Math.min(hi, Math.max(lo, y))
  const cls = (lane: number) => `qg-c${colours[lane] ?? 0}`

  const lines: ReactNode[] = []
  const edges: ReactNode[] = []
  const marks: ReactNode[] = []

  // Each Branch's line, in its own column, from where it leaves its parent up to its newest dot.
  layout.lanes.forEach((lane, li) => {
    if (lane.rows.length === 0) return
    const x = xOf(lane.column)
    const elbow = li > 0 && !forkSelectable(lane) // leaves the parent's dot sideways, then turns up
    const bottom = yOf(lane.forkRow) - (elbow ? R : 0)
    const up = yOf(lane.lastRow)
    if (!meets(up, bottom)) return
    lines.push(<line key={`l${li}`} className={cls(li)} x1={x} x2={x} y1={clip(up)} y2={clip(bottom)} />)
  })

  for (const [i, e] of layout.edges.entries()) {
    const ys = yOf(e.from.row)
    const ye = yOf(e.to.row)
    if (!meets(ys, ye)) continue
    const xs = xOf(e.from.column)
    const xe = xOf(e.to.column)
    const r = Math.min(R, Math.abs(xe - xs)) // the radius of a turn
    if (e.kind === 'fork') {
      const li = laneOfBranch.get(e.branch) ?? 0
      const lane = layout.lanes[li]!
      const d =
        forkSelectable(lane) || xs === xe
          ? `M ${xs} ${ys} H ${xe}` // to the fork point, which is drawn as a mark of its own
          : `M ${xs} ${ys} H ${xe - Math.sign(xe - xs) * r} Q ${xe} ${ys} ${xe} ${ys - r} V ${ys - R}`
      edges.push(<path key={`e${i}`} className={cls(li)} d={d} />)
      continue
    }
    // A Merge: from the dot holding the merged moment to the Merge's dot.
    const from = layout.rows[e.from.row]
    const li = from ? (laneOfBranch.get(from.branch) ?? 0) : 0
    const lane = layout.lanes[li]
    let d: string
    if (lane && lane.endsIn === e.to.row && lane.lastRow === e.from.row && xs !== xe) {
      // Its last dot merged into the parent: the line goes on up its own column and ends in the parent's dot.
      d = `M ${xs} ${ys} V ${ye + r} Q ${xs} ${ye} ${xs - Math.sign(xs - xe) * r} ${ye} H ${xe}`
    } else {
      const bend = Math.min((ys - ye) / 2, rowH * 1.5)
      d = `M ${xs} ${ys} C ${xs} ${ys - bend} ${xe} ${ye + bend} ${xe} ${ye}`
    }
    edges.push(<path key={`e${i}`} className={`${cls(li)} qg-merge-line`} d={d} />)
  }

  // Fork points that can be chosen: a Branch without Changes, or one with a ◆ at its own start.
  layout.lanes.forEach((lane, li) => {
    if (li === 0 || !forkSelectable(lane)) return
    const y = yOf(lane.forkRow)
    if (y < lo || y > hi) return
    const x = xOf(lane.column)
    const sel = selectedFork === li
    marks.push(
      <g key={`f${li}`} className={cls(li)}>
        {sel && <circle className="qg-ring" cx={x} cy={y} r={DOT + 4} />}
        {lane.startCheckpoints.length > 0 ? (
          <path className="qg-diamond" d={diamond(x, y, DIAMOND)} />
        ) : (
          <circle className="qg-hollow" cx={x} cy={y} r={DOT} />
        )}
      </g>,
    )
  })

  for (let item = first; item <= last; item++) {
    const it = display.items[item]
    if (!it || it.kind !== 'row') continue
    const row = layout.rows[it.row]!
    const li = laneOfBranch.get(row.branch) ?? 0
    const x = xOf(row.column)
    const y = item * rowH + rowH / 2
    const sel = selectedRow === it.row && selectedFork === null
    const cp = row.checkpoints[0]
    marks.push(
      <g key={`d${row.key}`} className={cls(li)}>
        {sel && <circle className="qg-ring" cx={x} cy={y} r={DOT + 4} />}
        {row.kind === 'merge' && <circle className="qg-merge-ring" cx={x} cy={y} r={DOT + 2.5} />}
        {cp ? (
          <path
            className={row.kind === 'restore' || row.kind === 'start' ? 'qg-diamond qg-diamond--hollow qg-pick' : 'qg-diamond qg-pick'}
            d={diamond(x, y, DIAMOND)}
            onMouseDown={keep}
            onClick={(e) => {
              e.stopPropagation()
              onCheckpoint(it.row, cp.name)
            }}
          />
        ) : row.kind === 'restore' || row.kind === 'start' ? (
          <circle className="qg-hollow" cx={x} cy={y} r={row.kind === 'start' ? DOT - 0.5 : DOT} />
        ) : (
          <circle className="qg-dot" cx={x} cy={y} r={DOT} />
        )}
      </g>,
    )
  }

  return (
    <svg className="qg-svg" width={width} height={height} style={{ top }} viewBox={`0 ${top} ${width} ${height}`} aria-hidden="true" focusable="false">
      <g className="qg-lines">{lines}</g>
      <g className="qg-edges">{edges}</g>
      <g className="qg-marks">{marks}</g>
    </svg>
  )
})
