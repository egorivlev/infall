// The Branches screen (`/branches`): the Branch Graph (docs/specs/branch-graph.md §1–3). Every Branch drawn from the
// Workspace's first Change, one row per Activity, newest at the top; only the rows in view are in the document, and
// their words are asked for (`graph.need`) only for those rows and a margin. The name field above it is the one way
// to start a Branch: the selected dot is where it starts.
import './branches.css'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { branches, formatWhen, graph, mergeOptions, startLabel, useBoard, useGraph, useMembers, useSession, useWorkspace } from '../../lib'
import type { BranchInfo, GraphLayout } from '../../lib'
import { personOf } from '../history/format'
import { graphPreview } from '../history/fromGraph'
import { usePrefs } from '../settings/prefs'
import { newBranchIntent, useNewBranchIntent } from '../shell/newBranchIntent'
import { MAIN } from '../shell/router'
import { useDelayedFlag } from '../shell/useDelayedFlag'
import { Detail } from './Detail'
import { GraphLines } from './GraphLines'
import {
  MIN_TEXT,
  ROW_H,
  buildDisplay,
  colourOf,
  forkSelectable,
  linesWidth,
  moveSideways,
  moveVertical,
  place,
  rowsIn,
  selectFork,
  selectNow,
  selectRow,
  windowOf,
} from './model'
import type { Display, Selection } from './model'
import { NewBranchField } from './NewBranchField'
import { DotRow, ForkOption, LaneLabel } from './Rows'
import { graphSelection, holdSelection, useGraphSelection } from './state'

const ignore = () => {}
/** jsdom lays nothing out: draw as if the box were this tall. */
const FALLBACK_HEIGHT = 800
/** Rows above and below the view whose words are asked for as well. */
const WORDS_MARGIN = 24
/** Words are asked for once the view has stood still this long (a fast scroll asks for nothing on the way). */
const WORDS_DELAY_MS = 90
const BACK = '/branches'

type Reveal = 'auto' | 'nearest'

function useLatest<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

function itemKey(display: Display, layout: GraphLayout, i: number): string {
  const it = display.items[i]!
  return it.kind === 'row' ? layout.rows[it.row]!.key : `label:${layout.lanes[it.lane]!.branch}`
}

/** `current` is the name of the Branch the Board has open (the shell keeps it while this screen shows). */
export function BranchGraph({ current }: { current: string }) {
  const snap = useGraph()
  const memberList = useMembers()
  const session = useSession()
  const moved = useWorkspace().readOnly === true
  const me = session.status === 'signed_in' ? session.member.id : undefined
  const openId = useBoard().branch?.id
  const textSize = usePrefs((p) => p.textSize)
  const rowH = Math.max(24, Math.round((ROW_H * textSize) / 100))
  const sel = useGraphSelection((s) => s.sel)
  const baseId = useId()

  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => holdSelection(), [])
  useEffect(() => {
    void Promise.resolve(graph.open()).catch(ignore)
    return () => graph.close()
  }, [])

  const { graph: data, layout } = snap
  const display = useMemo(() => (layout ? buildDisplay(layout) : null), [layout])
  const people = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList])
  const laneOfBranch = useMemo(() => new Map((layout?.lanes ?? []).map((l, i) => [l.branch, i])), [layout])
  const colours = useMemo(() => (layout?.lanes ?? []).map((_, i) => colourOf(i)), [layout])
  const currentBranch = layout?.lanes.find((l) => l.name === current)?.branch

  const placed = useMemo(() => (layout && sel ? place(layout, sel) : null), [layout, sel])
  // Where a new Branch starts: the selected dot, or else now on the open Branch.
  const fallback = useMemo(() => (layout && currentBranch ? selectNow(layout, currentBranch) : null), [layout, currentBranch])
  const startSel = placed ? sel : fallback
  const startPlaced = useMemo(() => placed ?? (layout && fallback ? place(layout, fallback) : null), [placed, layout, fallback])

  const nameOf = useCallback((id: string) => people.get(id)?.name.trim().split(/\s+/)[0], [people])
  const from =
    data && startPlaced
      ? startLabel(data, { moment: startPlaced.moment, checkpoint: startPlaced.checkpoint }, { nameOf, me })
      : `from now on ${current}`

  const start = useLatest({ sel: startSel, placed: startPlaced, openId })
  const create = useCallback(
    (name: string): Promise<BranchInfo> => {
      const s = start.current
      // "From now" on the Branch the Board has open: the data layer takes its head at this very moment.
      if (!s.placed || (s.sel?.follow && s.placed.moment.branch === s.openId)) return branches.create({ name })
      return branches.create({ name, from: s.placed.moment })
    },
    [start],
  )

  // ---- the view: which rows are on screen ----
  const [view, setView] = useState({ top: 0, height: 0 })
  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
  }, [])
  const shown = display !== null
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [measure, shown])

  const total = display?.items.length ?? 0
  const [first, last] = windowOf(view.top, view.height || FALLBACK_HEIGHT, rowH, total)

  // The words of the rows in view and a margin, once the view stands still.
  useEffect(() => {
    if (!display) return
    const rows = rowsIn(display, first, last, WORDS_MARGIN)
    const t = setTimeout(() => void graph.need(rows), WORDS_DELAY_MS)
    return () => clearTimeout(t)
  }, [display, first, last])

  // New dots above the view (the open Branch going on) do not move what is being looked at.
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  const latest = useLatest({ display, layout, rowH })
  const remember = useCallback(() => {
    const el = scrollRef.current
    const { display: d, layout: l, rowH: h } = latest.current
    if (!el || !d || !l || d.items.length === 0) return
    if (el.scrollTop <= 0) {
      anchor.current = null
      return
    }
    const i = Math.min(d.items.length - 1, Math.floor(el.scrollTop / h))
    anchor.current = { key: itemKey(d, l, i), offset: el.scrollTop - i * h }
  }, [latest])
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchor.current
    if (!el || !display || !layout || !a) return
    for (let i = 0; i < display.items.length; i++) {
      if (itemKey(display, layout, i) === a.key) {
        const top = i * rowH + a.offset
        if (Math.abs(el.scrollTop - top) >= 1) el.scrollTop = top
        return
      }
    }
  }, [display, layout, rowH])

  const frame = useRef(0)
  const onScroll = () => {
    if (frame.current) return
    const run = () => {
      frame.current = 0
      measure()
      remember()
    }
    if (typeof requestAnimationFrame === 'function') frame.current = requestAnimationFrame(run)
    else run()
  }
  useEffect(
    () => () => {
      if (frame.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
    },
    [],
  )

  // ---- selecting ----
  const reveal = useRef<Reveal | null>('auto') // the first time there is something to show: bring it into view
  const focusAfter = useRef<'actions' | null>(null)
  const choose = useCallback((next: Selection | null, how: Reveal | null = 'nearest') => {
    if (!next) return
    if (how) reveal.current = how
    graphSelection.set(next)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const how = reveal.current
    const target = placed ?? startPlaced
    if (!how || !el || !display || !target) return
    reveal.current = null
    const y = display.at[target.row]! * rowH
    const h = el.clientHeight || FALLBACK_HEIGHT
    const above = y < el.scrollTop
    const below = y + rowH > el.scrollTop + h
    if (!above && !below) return
    if (how === 'auto') el.scrollTop = Math.max(0, y - h / 2 + rowH / 2)
    else el.scrollTop = above ? y : y + rowH - h
    measure()
  })

  useLayoutEffect(() => {
    if (focusAfter.current !== 'actions') return
    const button = actionsRef.current?.querySelector<HTMLElement>('button')
    if (!button) return
    focusAfter.current = null
    button.focus()
  })

  const layoutRef = useLatest(layout)
  const focusGraph = useCallback(() => {
    const active = document.activeElement
    if (active === nameRef.current || (active && listRef.current?.contains(active))) return
    listRef.current?.focus({ preventScroll: true })
  }, [])
  const pickRow = useCallback(
    (row: number, checkpoint?: string) => {
      const l = layoutRef.current
      if (!l) return
      choose(selectRow(l, row, checkpoint), null)
      focusGraph()
    },
    [choose, focusGraph, layoutRef],
  )
  const pickFork = useCallback(
    (lane: number, checkpoint?: string) => {
      const l = layoutRef.current
      if (!l) return
      choose(selectFork(l, lane, checkpoint), null)
      focusGraph()
    },
    [choose, focusGraph, layoutRef],
  )

  // "New Branch…" in the Branch switcher: the newest dot of the open Branch, and the cursor in the name field.
  const wantsName = useNewBranchIntent((s) => s.pending)
  useEffect(() => {
    if (!wantsName) return
    nameRef.current?.focus()
    if (snap.status === 'error') return newBranchIntent.clear()
    if (!layout || !currentBranch) return // once the graph is there
    newBranchIntent.clear()
    choose(selectNow(layout, currentBranch), 'auto')
  }, [wantsName, layout, currentBranch, snap.status, choose])

  const onListMouseDown = (e: MouseEvent) => {
    // Choosing where a Branch starts while naming it: the cursor stays in the name field, so Enter starts it.
    if (document.activeElement === nameRef.current) e.preventDefault()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!layout || !display || e.altKey || e.ctrlKey || e.metaKey) return
    let next: Selection | null = null
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        next = placed ? moveVertical(layout, placed, e.key === 'ArrowUp' ? -1 : 1) : (fallback ?? selectRow(layout, 0))
        break
      case 'ArrowLeft':
      case 'ArrowRight':
        next = placed ? moveSideways(layout, placed, e.key === 'ArrowLeft' ? -1 : 1) : fallback
        break
      case 'Home':
        next = selectRow(layout, 0)
        break
      case 'End':
        next = selectRow(layout, layout.rows.length - 1)
        break
      case 'PageUp':
      case 'PageDown': {
        const step = Math.max(1, Math.floor((view.height || FALLBACK_HEIGHT) / rowH) - 2)
        const at = (placed ?? startPlaced)?.row ?? 0
        const to = Math.min(layout.rows.length - 1, Math.max(0, at + (e.key === 'PageUp' ? -step : step)))
        next = selectRow(layout, to)
        break
      }
      case 'Enter':
        // A dot's actions: beside the graph.
        e.preventDefault()
        if (placed) actionsRef.current?.querySelector<HTMLElement>('button')?.focus()
        else if (fallback) {
          focusAfter.current = 'actions' // once the detail of the dot it selects is there
          choose(fallback)
        }
        return
      case 'n':
      case 'N':
        e.preventDefault()
        nameRef.current?.focus()
        return
      case 'Escape':
        if (!sel) return
        e.preventDefault()
        graphSelection.clear()
        return
      default:
        return
    }
    e.preventDefault()
    choose(next)
  }

  const onPreview = useCallback(() => {
    const l = layoutRef.current
    if (!l || !placed) return
    const lane = l.lanes.find((x) => x.branch === placed.moment.branch)
    if (!lane) return
    graphPreview.start({ branch: lane.name, branchId: lane.branch, seq: placed.moment.seq, back: BACK })
  }, [layoutRef, placed])

  const onCheckpoint = useCallback(
    (name: string | undefined) => {
      if (!sel) return
      const next: Selection = { ...sel }
      if (name === undefined) delete next.checkpoint
      else next.checkpoint = name
      graphSelection.set(next)
    },
    [sel],
  )

  const onShowRow = useCallback(
    (row: number) => {
      const l = layoutRef.current
      if (!l) return
      choose(selectRow(l, row), 'auto')
      listRef.current?.focus({ preventScroll: true })
    },
    [choose, layoutRef],
  )

  // ---- the labels: who started each Branch, and the Merges it can take part in ----
  const labelInfo = useMemo(() => {
    if (!data || !layout) return []
    const all: BranchInfo[] = data.branches.map((b) => ({
      id: b.id,
      name: b.name,
      seq: b.seq,
      checkpoints: b.checkpoints.length,
      ...(b.parent ? { parent: b.parent } : {}),
      ...(b.created_by !== undefined ? { created_by: b.created_by } : {}),
      ...(b.created_at !== undefined ? { created_at: b.created_at } : {}),
    }))
    return layout.lanes.map((lane) => {
      const b = all.find((x) => x.id === lane.branch)
      if (!b) return { meta: '' }
      if (!b.parent) return { meta: b.name === MAIN ? 'default Branch' : '' }
      const parent = all.find((x) => x.id === b.parent!.branch)?.name
      const who = b.created_by ? personOf(people, b.created_by).name : ''
      const when = b.created_at !== undefined ? formatWhen(b.created_at) : ''
      // A moved copy (M18) is read-only: no Merges from it.
      const { intoParent, fromParent } = moved ? {} : mergeOptions(b, all)
      return {
        meta: [parent && `from ${parent}`, who, when].filter(Boolean).join(' · '),
        into: intoParent?.name,
        update: fromParent?.name,
      }
    })
  }, [data, layout, people, moved])

  const loading = useDelayedFlag(snap.status === 'loading' || snap.status === 'idle', 150)
  const linesW = linesWidth(layout?.columns ?? 1)
  const activeId = placed ? (placed.fork !== undefined ? `${baseId}-f${placed.fork}` : `${baseId}-r${placed.row}`) : undefined

  // ---- what is in the document: the rows in view (and the selected one, which the graph names as active) ----
  // Options go in the order they are shown, a fork point right after the row it sits on.
  const rows: { at: number; node: ReactNode }[] = []
  const labels: ReactNode[] = []
  if (display && layout) {
    const wanted = new Set<number>()
    for (let i = first; i <= last; i++) wanted.add(i)
    if (placed) wanted.add(display.at[placed.row]!)
    for (const i of wanted) {
      const it = display.items[i]!
      if (it.kind === 'row') {
        const row = layout.rows[it.row]!
        const li = laneOfBranch.get(row.branch) ?? 0
        const lane = layout.lanes[li]!
        rows.push({
          at: i,
          node: (
          <DotRow
            key={row.key}
            id={`${baseId}-r${it.row}`}
            row={row}
            index={it.row}
            total={layout.rows.length}
            top={i * rowH}
            height={rowH}
            branch={lane.name}
            who={row.activity ? personOf(people, row.activity.author).name : ''}
            colour={colours[li] ?? 0}
            selected={placed !== null && placed.fork === undefined && placed.row === it.row}
            onPick={pickRow}
          />
          ),
        })
      } else {
        const lane = layout.lanes[it.lane]!
        const info = labelInfo[it.lane] ?? { meta: '' }
        labels.push(
          <LaneLabel
            key={lane.branch}
            lane={lane}
            top={i * rowH}
            height={rowH}
            colour={colours[it.lane] ?? 0}
            open={lane.name === current}
            meta={info.meta}
            into={info.into}
            update={info.update}
          />,
        )
      }
    }
    layout.lanes.forEach((lane, li) => {
      if (li === 0 || !forkSelectable(lane)) return
      const i = display.at[lane.forkRow]!
      const selected = placed?.fork === li
      if (!selected && (i < first || i > last)) return
      rows.push({
        at: i + 0.5,
        node: <ForkOption key={lane.branch} id={`${baseId}-f${li}`} lane={lane} laneIndex={li} top={i * rowH} height={rowH} selected={selected} onPick={pickFork} />,
      })
    })
    rows.sort((a, b) => a.at - b.at)
  }

  const style = { '--qg-lines-w': `${linesW}px`, '--qg-row-h': `${rowH}px` } as CSSProperties
  const branchCount = data?.branches.length ?? 0

  return (
    <div className="qg" style={style}>
      <header className="qg-head">
        <div className="qg-title">
          <h1 className="qg-h">Branches</h1>
          {data && (
            <span className="q-mono q-hint">
              {branchCount} {branchCount === 1 ? 'Branch' : 'Branches'}
            </span>
          )}
        </div>
        {!moved && <NewBranchField inputRef={nameRef} from={from} create={create} onLeave={() => listRef.current?.focus({ preventScroll: true })} />}
      </header>
      <div className="qg-body">
        <div className="qg-scroll" ref={scrollRef} onScroll={onScroll}>
          {display && layout ? (
            <div className="qg-canvas" style={{ height: total * rowH, minWidth: linesW + MIN_TEXT }}>
              <div
                ref={listRef}
                role="listbox"
                tabIndex={0}
                aria-label="Branch Graph"
                aria-activedescendant={activeId}
                className="qg-list"
                onKeyDown={onKeyDown}
                onMouseDown={onListMouseDown}
              >
                {rows.map((r) => r.node)}
                <GraphLines
                  layout={layout}
                  display={display}
                  first={first}
                  last={last}
                  rowH={rowH}
                  width={linesW}
                  colours={colours}
                  laneOfBranch={laneOfBranch}
                  selectedRow={placed && placed.fork === undefined ? placed.row : null}
                  selectedFork={placed?.fork ?? null}
                  onCheckpoint={pickRow}
                />
              </div>
              <div className="qg-labels">{labels}</div>
            </div>
          ) : snap.status === 'error' ? (
            <div className="qg-status" role="alert">
              <span title={snap.error}>The Branch Graph could not be loaded.</span>
              <button type="button" className="q-btn q-btn--sm" onClick={() => void Promise.resolve(graph.open()).catch(ignore)}>
                Try again
              </button>
            </div>
          ) : (
            <div className="qg-status">{loading ? 'Loading Branches…' : null}</div>
          )}
        </div>
        {display && layout && data && (
          <Detail
            layout={layout}
            branches={data.branches}
            placed={placed}
            colour={placed ? (colours[laneOfBranch.get(placed.moment.branch) ?? 0] ?? 0) : 0}
            people={people}
            actionsRef={actionsRef}
            onNewBranch={() => nameRef.current?.focus()}
            onPreview={onPreview}
            onCheckpoint={onCheckpoint}
            onShowRow={onShowRow}
            onLeave={() => listRef.current?.focus({ preventScroll: true })}
            readOnly={moved}
          />
        )}
      </div>
    </div>
  )
}
