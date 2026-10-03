// The timeline: Checkpoint markers, one lane per author, the scrubber and the day ticks.
// Everything is positioned in percentages of the track, so scrubbing never re-measures anything;
// only the blocks whose state flips re-render.
import { memo, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { Activity, Checkpoint } from '../../lib'
import { activityLabel, checkpointLabel } from './format'
import type { Person } from './format'
import { blockWidth, positionOf } from './model'
import type { DayTick, Lane, LaneItem } from './model'

const pct = (x: number, n: number) => `${n > 0 ? (x / n) * 100 : 0}%`

type BlockProps = {
  activity: Activity
  left: string
  maxWidth: string
  person: Person
  past: boolean // at or before the scrub position
  selected: boolean
  onPick: (seq: number) => void
}

const Block = memo(function Block({ activity, left, maxWidth, person, past, selected, onPick }: BlockProps) {
  const label = activityLabel(activity, person.name)
  const restore = activity.kind === 'restore'
  const tint = past ? (person.color ?? 'var(--q-ink-3)') : undefined
  return (
    <button
      type="button"
      className={`qh-block${past ? ' is-past' : ''}${selected ? ' is-selected' : ''}${restore ? ' qh-block--restore' : ''}`}
      style={{ left, width: blockWidth(activity.count), maxWidth, ['--qh-tint' as string]: tint }}
      data-testid={`activity-${activity.id}`}
      title={label}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onPick(activity.toSeq)}
    >
      <span className="qh-block__bar" aria-hidden="true">
        {restore ? '↺' : null}
      </span>
    </button>
  )
})

type LaneRowProps = {
  items: readonly LaneItem[]
  n: number
  person: Person
  seq: number | null // null = now
  selected: number
  onPick: (seq: number) => void
}

const LaneRow = memo(function LaneRow({ items, n, person, seq, selected, onPick }: LaneRowProps) {
  const maxWidth = `calc(${100 / n}% - 2px)`
  return (
    <div className="qh-row qh-row--lane qh-lane" role="group" aria-label={`Activities by ${person.name}`}>
      {items.map(({ activity, index }) => (
        <Block
          key={activity.id}
          activity={activity}
          left={pct(index + 0.5, n)}
          maxWidth={maxWidth}
          person={person}
          past={seq === null || activity.fromSeq < seq}
          selected={index === selected}
          onPick={onPick}
        />
      ))}
    </div>
  )
})

type MarkerProps = {
  checkpoint: Checkpoint
  left: string
  right: boolean // near the right edge: the name hangs to the left of the mark
  who: string
  current: boolean
  onPick: (seq: number) => void
}

const Marker = memo(function Marker({ checkpoint, left, right, who, current, onPick }: MarkerProps) {
  return (
    <button
      type="button"
      className={`qh-checkpoint${current ? ' is-current' : ''}${right ? ' is-right' : ''}`}
      style={{ left }}
      data-testid={`checkpoint-${checkpoint.name}`}
      title={checkpoint.name}
      aria-label={checkpointLabel(checkpoint, who)}
      aria-current={current ? 'true' : undefined}
      onClick={() => onPick(checkpoint.moment.seq)}
    >
      <span className="qh-checkpoint__name">{checkpoint.name}</span>
      <svg className="qh-checkpoint__mark" width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M7 1 L13 7 L7 13 L1 7 Z" />
      </svg>
    </button>
  )
})

export function Avatar({ person, size }: { person: Person; size?: number }) {
  const style: CSSProperties = { background: person.color ?? undefined }
  if (size) {
    style.width = size
    style.height = size
  }
  return (
    <span className={`q-avatar qh-avatar${person.color ? '' : ' is-former'}`} style={style} title={person.name} aria-hidden="true">
      {person.initials}
    </span>
  )
}

type Props = {
  activities: readonly Activity[]
  checkpoints: readonly Checkpoint[]
  lanes: readonly Lane[]
  ticks: readonly DayTick[]
  people: ReadonlyMap<string, Person>
  former: Person
  seq: number | null // the previewed moment; null = now
  pos: number // where that moment sits, 0 … N
  step: number // the scrubber's value
  selected: number // index of the selected Activity, or -1
  valueText: string
  onStep: (k: number) => void
  onPick: (seq: number) => void
}

export function Timeline(p: Props) {
  const n = p.activities.length
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const marks = useMemo(
    () =>
      p.checkpoints.map((c) => {
        const at = positionOf(p.activities, c.moment.seq)
        return { c, left: pct(at, n), right: n > 0 && at / n > 0.6 }
      }),
    [p.checkpoints, p.activities, n],
  )

  // When the timeline is wider than the panel, keep the scrub position in view.
  useEffect(() => {
    const sc = scrollRef.current
    const track = trackRef.current
    if (!sc || !track || n === 0 || sc.scrollWidth <= sc.clientWidth) return
    const x = track.offsetLeft + (p.pos / n) * track.offsetWidth
    const margin = 48
    if (x < sc.scrollLeft + margin) sc.scrollLeft = Math.max(0, x - margin)
    else if (x > sc.scrollLeft + sc.clientWidth - margin) sc.scrollLeft = x - sc.clientWidth + margin
  }, [p.pos, n])

  const head = pct(p.pos, n)

  return (
    <div className="qh-timeline" data-testid="history-timeline">
      <div className="qh-gutter" aria-hidden="true">
        <span className="qh-row qh-row--checkpoints" />
        {p.lanes.map((lane) => (
          <span key={lane.author} className="qh-row qh-row--lane" data-testid={`lane-${lane.author}`}>
            <Avatar person={p.people.get(lane.author) ?? p.former} />
          </span>
        ))}
      </div>
      <div className="qh-scroll" ref={scrollRef}>
        <div className="qh-track" ref={trackRef} style={{ ['--qh-n' as string]: n }}>
          <div className="qh-row qh-row--checkpoints">
            {marks.map(({ c, left, right }) => (
              <Marker
                key={`${c.moment.seq}:${c.name}`}
                checkpoint={c}
                left={left}
                right={right}
                who={(p.people.get(c.author) ?? p.former).name}
                current={p.seq === c.moment.seq}
                onPick={p.onPick}
              />
            ))}
          </div>
          {p.lanes.map((lane) => (
            <LaneRow
              key={lane.author}
              items={lane.items}
              n={n}
              person={p.people.get(lane.author) ?? p.former}
              seq={p.seq}
              selected={p.selected}
              onPick={p.onPick}
            />
          ))}
          <div className="qh-row qh-row--scrub">
            <input
              type="range"
              className="qh-range"
              min={0}
              max={n}
              step={1}
              value={p.step}
              aria-label="Moment in History"
              aria-valuetext={p.valueText}
              onChange={(e) => p.onStep(Number(e.target.value))}
            />
            <span className="qh-knob" style={{ left: head }} aria-hidden="true" />
          </div>
          <div className="qh-row qh-row--ticks" aria-hidden="true">
            {p.ticks.map((t) => (
              <span
                key={t.index}
                className={`qh-tick${t.index / n > 0.8 ? ' is-right' : ''}`}
                style={{ left: pct(t.index / n > 0.8 ? t.index + 1 : t.index, n) }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <span className="qh-playhead" style={{ left: head }} aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}
