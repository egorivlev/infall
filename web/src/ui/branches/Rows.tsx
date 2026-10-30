// The rows of the Branch Graph that are in view: a dot's row (an option of the graph's listbox, with its words filled
// in lazily), a fork point that can be chosen, and the label at the top end of each Branch's line with its actions.
import { memo } from 'react'
import type { MouseEvent } from 'react'
import { formatWhen, useGraphLines } from '../../lib'
import type { GraphLane, GraphRow } from '../../lib'
import { Link } from '../shell/Link'
import { branchPath, mergePath } from '../shell/router'
import { FORMER_MEMBER } from '../history/format'
import { firstName, spokenName, xOf } from './model'

const FORMER = FORMER_MEMBER.name

type RowProps = {
  id: string
  row: GraphRow
  index: number // layout row
  total: number // layout rows
  top: number
  height: number
  branch: string // its Branch's name
  who: string // full name
  colour: number
  selected: boolean
  onPick: (row: number, checkpoint?: string) => void
}

const keep = (e: MouseEvent) => e.preventDefault()

/** One Activity (or the start): who, when, the first line of what was done and "+N", and its ◆. */
export const DotRow = memo(function DotRow({ id, row, index, total, top, height, branch, who, colour, selected, onPick }: RowProps) {
  const lines = useGraphLines(row.key)
  const a = row.activity
  const start = a === null
  const when = a ? formatWhen(a.ended_at) : undefined
  const first = start ? 'before the first Change' : lines?.[0]
  const label = spokenName({ branch, who: start ? undefined : who, when, first, checkpoints: row.checkpoints.map((c) => c.name) })
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={label}
      aria-posinset={index + 1}
      aria-setsize={total}
      className={`qg-row qg-row--${row.kind}${selected ? ' is-selected' : ''}`}
      style={{ top, height }}
      data-row={index}
      onClick={() => onPick(index)}
    >
      {start ? (
        <span className="qg-row__line qg-row__line--start">Before the first Change</span>
      ) : (
        <>
          <span className="qg-row__who" title={who}>
            {who === FORMER ? who : firstName(who)}
          </span>
          <span className="qg-row__when">{when}</span>
          {lines ? (
            <span className="qg-row__line">
              {row.kind === 'restore' && (
                <span className="qg-row__glyph" aria-hidden="true">
                  ↺{' '}
                </span>
              )}
              {lines[0]}
            </span>
          ) : (
            <span className="qg-row__wait" aria-hidden="true" />
          )}
          {lines && lines.length > 1 && <span className="qg-row__more">+{lines.length - 1}</span>}
        </>
      )}
      {row.checkpoints.map((c) => (
        <span
          key={c.name}
          className="qg-row__cp"
          title={`Checkpoint ${c.name}`}
          onMouseDown={keep}
          onClick={(e) => {
            e.stopPropagation()
            onPick(index, c.name)
          }}
        >
          <span className={`qg-c${colour}`} aria-hidden="true">
            ◆
          </span>{' '}
          {c.name}
        </span>
      ))}
    </div>
  )
})

type ForkProps = {
  id: string
  lane: GraphLane
  laneIndex: number
  top: number
  height: number
  selected: boolean
  onPick: (lane: number, checkpoint?: string) => void
}

/** A Branch's fork point, as a target of its own (a Branch without Changes, or one with a ◆ at its start). */
export const ForkOption = memo(function ForkOption({ id, lane, laneIndex, top, height, selected, onPick }: ForkProps) {
  const empty = lane.rows.length === 0
  const label = [lane.name, empty ? 'the start, no Changes yet' : 'the start of the Branch', ...lane.startCheckpoints.map((c) => `Checkpoint ${c.name}`)].join(', ')
  const size = Math.min(height, 20)
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={label}
      className={`qg-fork${selected ? ' is-selected' : ''}`}
      style={{ top: top + (height - size) / 2, left: xOf(lane.column) - size / 2, width: size, height: size }}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onPick(laneIndex, lane.startCheckpoints[0]?.name)
      }}
    />
  )
})

type LabelProps = {
  lane: GraphLane
  top: number
  height: number
  colour: number
  open: boolean // the Branch the Board has open
  meta: string // "default Branch", or "from main · Ana Ruiz · 14 Nov, 10:02"
  into?: string // "Merge into <into>…", when that Merge is possible (`mergeOptions`)
  update?: string // "Update from <update>…", likewise
}

/** The label at the top end of a Branch's line: its name, who started it and when, Open and the two Merges. */
export const LaneLabel = memo(function LaneLabel({ lane, top, height, colour, open, meta, into, update }: LabelProps) {
  const name = lane.name
  return (
    <div className="qg-label" style={{ top, height }} data-lane={lane.branch}>
      <span className={`qg-label__swatch qg-c${colour}`} aria-hidden="true" />
      <span className="qg-label__name">{name}</span>
      {open && <span className="q-tag qg-label__open">open</span>}
      <span className="qg-label__meta">{meta}</span>
      <span className="qg-label__acts">
        {into !== undefined && (
          <Link
            href={mergePath(name, into)}
            className="q-btn q-btn--sm qg-label__merge"
            aria-label={`Merge ${name} into ${into}…`}
            data-tour={`merge-into:${name}`}
          >
            Merge into <span className="qg-label__target">{into}</span>…
          </Link>
        )}
        {update !== undefined && (
          <Link
            href={mergePath(update, name)}
            className="q-btn q-btn--sm qg-label__merge"
            aria-label={`Update ${name} from ${update}…`}
            title={`Brings the newer work on ${update} into ${name}`}
          >
            Update from <span className="qg-label__target">{update}</span>…
          </Link>
        )}
        <Link href={branchPath(name)} className="q-btn q-btn--sm" aria-label={`Open ${name}`}>
          Open
        </Link>
      </span>
    </div>
  )
})
