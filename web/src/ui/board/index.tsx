import '@xyflow/react/dist/base.css'
import './board.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  useViewportStore,
} from '@xyflow/react'
import type { EdgeChangeset, NodeChangeset, OnConnectEnd, OnNodeDrag } from '@xyflow/react'
import { CARD_H, CARD_W, history, newId, ops, useBoard, useHistory, useSources } from '../../lib'
import type { CardVM, ConnectionVM, FrameVM, Kind, Op } from '../../lib'
import { boardBridge, boardFocus, pagePanel, suggestionsPanel, useBoardRequest, useHistoryPanel, usePagePanel, useSuggestionsPanel } from '../bridge'
import { HistoryPanel } from '../history'
import { prefs, stepBoardScale, usePrefs } from '../settings/prefs'
import { PagePanel } from '../page'
import { ImportBibtex } from '../page/bibtex/ImportBibtex'
import { toBibtex } from '../page/bibtex/write'
import { exportFile } from '../page/export/exportFile'
import { fileName } from '../page/files'
import { SuggestionsPanel } from '../suggestions'
import { EmptyState, ErrorNote, LoadingNote } from './BoardMessage'
import { boardScaleKey, typingIn } from './boardScaleKeys'
import { ConnectionPopover } from './ConnectionPopover'
import { ConnectionEdge } from './edges/ConnectionEdge'
import { ConnectionsOverview } from './edges/ConnectionsOverview'
import { createEdgeBuilder, createNodeBuilder } from './elements'
import {
  FRAME_TITLE_SPACE,
  NEW_FRAME_H,
  NEW_FRAME_W,
  boundsOf,
  centre,
  fitBounds,
  frameMembers,
  isCramped,
  nudge,
  nudgeDelta,
  readingOrder,
  sidePanelsFit,
  viewToShow,
} from './geometry'
import type { Rect } from './geometry'
import { Inspector } from './Inspector'
import { freeSpot } from './place'
import { PreviewBanner } from './PreviewBanner'
import { SuggestedConnection } from './SuggestedConnection'
import { guardBoardSelection } from './textSelection'
import { CardNode } from './nodes/CardNode'
import { FrameNode } from './nodes/FrameNode'
import { Toast } from './Toast'
import { toasts } from './toastStore'
import { Toolbar } from './Toolbar'
import { BoardExportMenu } from './export/ExportMenu'
import type { BoardNode, ConnectionEdgeType } from './types'
import { ui, useBoardUi } from './uiStore'
import type { Transient } from './uiStore'
import { useBoardActions } from './useBoardActions'
import type { Removal } from './useBoardActions'
import { useUndoPlace } from './undoActions'
import { ZoomHud } from './ZoomHud'
import { useZoomLevel } from './useZoomLevel'

const nodeTypes = { card: CardNode, frame: FrameNode }
const edgeTypes = { connection: ConnectionEdge }
const MULTI_KEYS = ['Shift', 'Meta', 'Control']
const ZOOM_KEYS = ['Meta', 'Control']
// The Board's own zoom range, at Board scale 100% (Settings → Board): React Flow's zoom is this times the Board scale.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2
/** How long "Board 120%" stays after a Board scale key. */
const SCALE_NOTE_MS = 1400
// Padding is in screen px (React Flow 13); room for the toolbar above and the HUD below.
const FIT_PADDING = { top: 64, bottom: 56, x: 48 }
const CONNECTION_LINE_STYLE = { stroke: 'var(--q-accent)', strokeWidth: 1.4 }
const ARIA_LABELS = {
  'node.a11yDescription.default': 'Press Enter to edit the title. Arrow keys move the selection.',
  'node.a11yDescription.keyboardDisabled': 'Press Enter to edit the title. Arrow keys move the selection.',
  'edge.a11yDescription.default': 'A Connection between two Cards.',
  'handle.ariaLabel': 'Drag to connect to another Card',
}
const backToNow = () => history.preview(null)
const NO_CARDS: ReadonlySet<string> = new Set()
/**
 * From this many Cards, Frames and Connections on, only what is in view is drawn (docs/specs/scale.md): a Card or
 * Connection off screen has no element until it comes into view. Below it everything is drawn, as before.
 */
export const DRAW_IN_VIEW_FROM = 400
/**
 * From this many Connections on, a Board seen from further away than its 'full' zoom level draws them all as one
 * picture (ConnectionsOverview): no labels (unreadable there anyway) and no picking one by one, but no thousands of
 * separate SVGs either, which is what made panning and zooming slow.
 */
export const OVERVIEW_FROM = 300
const NO_EDGES: ConnectionEdgeType[] = []
/** How many frames a focus waits for a Card that is coming into view to be drawn. */
const FOCUS_FRAMES = 30
const TYPING = 'input, textarea, select, [contenteditable="true"], .qb-inspector, .qb-popover, .qb-status-menu, .qb-toasts'

/**
 * The Board area: fills its positioned parent. The shell opens/closes the Board; this only reads and submits.
 * While the History panel is open the area splits: the Board above, History below.
 * The Suggestions panel sits left of the Board, the Page panel over its right.
 */
export function BoardView() {
  const historyOpen = useHistoryPanel((s) => s.open)
  const isGuest = useBoard().readOnly // Guests have no History
  const areaRef = useRef<HTMLDivElement>(null)
  const focusBoard = useCallback(() => {
    areaRef.current?.querySelector<HTMLElement>('.qb-board')?.focus({ preventScroll: true })
  }, [])

  // The Page of a Card, docked over the right of the Board. Not while History previews an earlier moment.
  const pageCard = usePagePanel((s) => s.cardId)
  const pageFull = usePagePanel((s) => s.full)
  const previewing = useHistory().preview !== null
  useEffect(() => {
    if (previewing && pageCard) pagePanel.close()
  }, [previewing, pageCard])
  const closePage = useCallback((cardId: string) => {
    pagePanel.close()
    // Focus goes back to the Card the Page belongs to, else to the Board.
    const area = areaRef.current
    const nodes = area?.querySelectorAll<HTMLElement>('.react-flow__node-card') ?? []
    const node = [...nodes].find((n) => n.getAttribute('data-id') === cardId) ?? area?.querySelector<HTMLElement>('.qb-board')
    node?.focus({ preventScroll: true })
  }, [])

  // Suggestions, docked left of the Board. Not for Guests, and not while History previews an earlier moment.
  const suggestionsOpen = useSuggestionsPanel((s) => s.open)
  const showSuggestions = suggestionsOpen && !isGuest && !previewing
  useEffect(() => {
    if (suggestionsOpen && (isGuest || previewing)) suggestionsPanel.close()
  }, [suggestionsOpen, isGuest, previewing])
  // Leaving the Board takes the previewed Connection with it (the panel itself may stay open for the way back).
  useEffect(() => () => suggestionsPanel.preview(null), [])

  // Both side panels need room for the Board between them; where there is none, the one opened last stays.
  const sides = useRef({ suggestions: false, page: false })
  useEffect(() => {
    const before = sides.current
    const now = { suggestions: showSuggestions, page: pageCard !== null }
    sides.current = now
    if (!now.suggestions || !now.page) return
    const width = areaRef.current?.clientWidth ?? 0
    if (width === 0 || sidePanelsFit(width)) return // 0: not laid out, nothing to go by
    if (before.suggestions && !before.page) suggestionsPanel.close()
    else pagePanel.close()
  }, [showSuggestions, pageCard])

  // A cramped area (geometry.ts): a side panel takes all of it. Measured in interface pixels, so it follows the scale.
  const [cramped, setCramped] = useState(false)
  useEffect(() => {
    const el = areaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(() => setCramped(isCramped(el.clientWidth)))
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  return (
    <div className={cramped ? 'qb-area is-cramped' : 'qb-area'} ref={areaRef}>
      <div className="qb-area__canvas">
        {showSuggestions && <SuggestionsPanel onClose={focusBoard} />}
        <div className="qb-area__board">
          <ReactFlowProvider>
            <BoardCanvas />
          </ReactFlowProvider>
          {pageCard && !previewing && <PagePanel key={pageCard} cardId={pageCard} full={pageFull} onClose={closePage} />}
        </div>
      </div>
      {historyOpen && !isGuest && <HistoryPanel onClose={focusBoard} />}
    </div>
  )
}

/** What the Board is showing: the live Board, or an earlier moment from History. */
type View = {
  cards: CardVM[]
  frames: FrameVM[]
  connections: ConnectionVM[]
  readOnly: boolean
}

function useLatest<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

function kindOf(s: View, id: string): Kind | null {
  if (s.cards.some((c) => c.id === id)) return 'Card'
  if (s.frames.some((f) => f.id === id)) return 'Frame'
  if (s.connections.some((c) => c.id === id)) return 'Connection'
  return null
}

/** Where a Card is right now: while it is being dragged, where the drag has it. */
function placed(card: CardVM, transient: ReadonlyMap<string, Transient>): Rect {
  const t = transient.get(card.id)
  return { x: t?.x ?? card.x, y: t?.y ?? card.y, w: card.w, h: card.h }
}

function BoardCanvas() {
  const snap = useBoard()
  const rf = useReactFlow<BoardNode, ConnectionEdgeType>()
  const actions = useBoardActions()
  const selected = useBoardUi((s) => s.selected)
  const transient = useBoardUi((s) => s.transient)
  const raised = useBoardUi((s) => s.statusMenu ?? s.editing?.id ?? null)
  const hasSize = useViewportStore((s) => s.width > 0 && s.height > 0)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Settings → Board scale: how large the Board is drawn at its "100%". React Flow's zoom is the person's zoom
  // times this; the zoom control shows the person's part only.
  const base = usePrefs((s) => s.boardScale) / 100
  const [defaultViewport] = useState(() => ({ x: 0, y: 0, zoom: base })) // the first one only
  /** The canvas in its own pixels. Not the Board element's: the interface scale zooms that, and the canvas undoes it. */
  const canvasSize = useCallback(() => {
    const c = wrapRef.current?.querySelector<HTMLElement>('.react-flow')
    return { w: c?.clientWidth ?? 0, h: c?.clientHeight ?? 0 }
  }, [])

  // While History previews an earlier moment, the Board shows that moment instead, fully read-only.
  const preview = useHistory().preview
  const previewing = preview !== null
  const { cards, frames, connections } = preview ?? snap
  const readOnly = snap.readOnly || previewing
  const view = useMemo<View>(() => ({ cards, frames, connections, readOnly }), [cards, frames, connections, readOnly])
  const latest = useLatest(view)

  useLayoutEffect(() => ui.setReadOnly(readOnly), [readOnly])
  // Undo works where the Board of the open Branch is shown and editable (docs/specs/undo.md decision 12).
  useLayoutEffect(() => useUndoPlace.setState({ here: !readOnly }), [readOnly])
  useEffect(() => () => useUndoPlace.setState({ here: false }), [])
  // No browser text selection may start on the Board or survive a press on it (see textSelection.ts).
  useEffect(() => {
    const el = wrapRef.current
    return el ? guardBoardSelection(el) : undefined
  }, [])
  // Entering the preview drops the selection and anything in progress; the viewport stays where it is.
  useLayoutEffect(() => {
    if (previewing) ui.reset()
  }, [previewing])
  useEffect(
    () => () => {
      ui.reset()
      toasts.clear()
    },
    [],
  )

  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const framesById = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames])
  const counts = useMemo(() => frameMembers(frames, cards), [frames, cards])

  // Someone else deleted what this person had selected or was editing: let it go quietly.
  useEffect(() => {
    const conns = new Set(connections.map((c) => c.id))
    ui.prune((id) => cardsById.has(id) || framesById.has(id) || conns.has(id))
  }, [cardsById, framesById, connections])

  // ---- the Connection a Suggestion previews: drawn here, never part of the Board's Connections ----
  const suggestion = useSuggestionsPanel((s) => (s.open ? s.preview : null))
  const live = suggestion !== null && !readOnly && suggestion.from !== suggestion.to
  const suggestedFrom = live ? cardsById.get(suggestion.from) : undefined
  const suggestedTo = live ? cardsById.get(suggestion.to) : undefined
  const suggested = useMemo(
    () => (suggestedFrom && suggestedTo ? new Set([suggestedFrom.id, suggestedTo.id]) : NO_CARDS),
    [suggestedFrom, suggestedTo],
  )

  const [buildNodes] = useState(createNodeBuilder)
  const [buildEdges] = useState(createEdgeBuilder)
  const nodes = useMemo(
    () => buildNodes({ cards, frames, counts, selected, transient, raised, readOnly, suggested }),
    [buildNodes, cards, frames, counts, selected, transient, raised, readOnly, suggested],
  )
  const edges = useMemo(
    () => buildEdges(connections, cardsById, selected),
    [buildEdges, connections, cardsById, selected],
  )
  // Far away on a large Board, Connections are one picture (ConnectionsOverview) rather than thousands of edges.
  const overview = useZoomLevel() !== 'full' && connections.length >= OVERVIEW_FROM

  // ---- viewport ----
  const viewportCentre = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }, [rf])

  const fit = useCallback(
    (animate: boolean) => {
      const s = latest.current
      const b = fitBounds(s.cards, s.frames)
      if (!wrapRef.current) return
      const scale = usePrefs.getState().boardScale / 100
      if (!b) {
        void rf.setViewport({ x: 0, y: 0, zoom: scale }, animate ? { duration: 160 } : undefined)
        return
      }
      const { w, h } = canvasSize()
      const vp = getViewportForBounds(b, w, h, MIN_ZOOM * scale, scale, FIT_PADDING)
      void rf.setViewport(vp, animate ? { duration: 160 } : undefined)
    },
    [rf, latest, canvasSize],
  )

  // Fit once, when the first content and the canvas size are both known.
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !hasSize) return
    if (cards.length || frames.length) {
      fitted.current = true
      fit(false)
    }
  }, [hasSize, cards, frames, fit])

  const reveal = useCallback(
    (r: Rect, minZoom = 0) => {
      if (!wrapRef.current) return
      const { w, h } = canvasSize()
      const { x, y, zoom } = rf.getViewport()
      const left = -x / zoom
      const top = -y / zoom
      const inside = r.x >= left && r.y >= top && r.x + r.w <= left + w / zoom && r.y + r.h <= top + h / zoom
      if (inside && zoom >= minZoom) return
      const c = centre(r)
      void rf.setCenter(c.x, c.y, { zoom: Math.max(zoom, minZoom), duration: 160 })
    },
    [rf, canvasSize],
  )

  // The Board scale changed (Settings, or the keys below): keep the person's zoom and what is in the middle of the view.
  const baseRef = useRef(base)
  useEffect(() => {
    const was = baseRef.current
    baseRef.current = base
    if (was === base) return
    const { w, h } = canvasSize()
    const vp = rf.getViewport()
    const zoom = (vp.zoom / was) * base
    const fx = (w / 2 - vp.x) / vp.zoom
    const fy = (h / 2 - vp.y) / vp.zoom
    void rf.setViewport({ x: w / 2 - fx * zoom, y: h / 2 - fy * zoom, zoom })
  }, [base, rf, canvasSize])

  // Shift + "+" / "−" / 0 change the Board scale while the Board is shown, unless keys are going into a field.
  const [scaleNote, setScaleNote] = useState<{ pct: number; n: number } | null>(null)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || typingIn(e.target)) return
      const dir = boardScaleKey(e)
      if (dir === null) return
      e.preventDefault()
      const pct = stepBoardScale(usePrefs.getState().boardScale, dir)
      prefs.set({ boardScale: pct })
      setScaleNote((n) => ({ pct, n: (n?.n ?? 0) + 1 }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const noteKey = scaleNote?.n
  useEffect(() => {
    if (noteKey === undefined) return
    const t = window.setTimeout(() => setScaleNote(null), SCALE_NOTE_MS)
    return () => window.clearTimeout(t)
  }, [noteKey])

  // A newly previewed Suggestion: if one of its two Cards is out of view, pan just enough to show both
  // (and zoom out only if they do not fit). The part of the Board under the inspector or the Page panel does not count.
  const shownId = suggestedFrom && suggestedTo && suggestion ? suggestion.id : null
  const shownFrom = suggestedFrom?.id
  const shownTo = suggestedTo?.id
  useEffect(() => {
    const el = wrapRef.current
    if (!shownId || !el) return
    const cards = latest.current.cards
    const a = cards.find((c) => c.id === shownFrom)
    const b = cards.find((c) => c.id === shownTo)
    if (!a || !b) return
    // In the canvas's pixels, which are screen pixels: the panels are measured on screen, not in zoomed CSS pixels.
    const covered =
      (el.querySelector<HTMLElement>('.qb-inspector')?.getBoundingClientRect().width ?? 0) +
      (el.parentElement?.querySelector<HTMLElement>('.qp-panel')?.getBoundingClientRect().width ?? 0)
    const { w, h } = canvasSize()
    const next = viewToShow(boundsOf(a, b), rf.getViewport(), w - covered, h)
    if (next) void rf.setViewport(next, { duration: 160 })
  }, [shownId, shownFrom, shownTo, latest, rf, canvasSize])

  // ---- creation ----
  const createCardAt = useCallback(
    (x: number, y: number) => {
      const id = newId()
      // Its title, typed in right after, joins this step: adding and naming it is one Undo.
      void actions.submit([ops.createCard({ id, x, y, status: 'idea' })], { key: `new:${id}` })
      ui.select([id])
      ui.edit(id, 'title')
    },
    [actions],
  )
  /**
   * Where "+ Card" and "+ Frame" put a new box: free space nearest the middle of the view (place.ts). If that is out
   * of sight, the view follows it once it is made.
   */
  const placeNew = useCallback(
    (w: number, h: number, head = 0) => {
      const c = viewportCentre()
      const size = canvasSize()
      const zoom = rf.getZoom()
      const view = { x: c.x - size.w / zoom / 2, y: c.y - size.h / zoom / 2, w: size.w / zoom, h: size.h / zoom }
      const s = latest.current
      const byId = new Map(s.cards.map((card) => [card.id, card]))
      const labels = s.connections.flatMap((conn) => {
        const from = conn.label ? byId.get(conn.from) : undefined
        const to = from ? byId.get(conn.to) : undefined
        return from && to ? [{ from, to, text: conn.label }] : []
      })
      const at = freeSpot({ size: { w, h }, head, view, cards: s.cards, frames: s.frames, labels })
      const show = () => {
        if (view.w > 0 && view.h > 0) reveal({ x: at.x, y: at.y - head, w, h: h + head })
      }
      return { ...at, show }
    },
    [viewportCentre, canvasSize, rf, latest, reveal],
  )
  const addCardAtCentre = useCallback(() => {
    const at = placeNew(CARD_W, CARD_H)
    createCardAt(at.x, at.y)
    at.show()
  }, [placeNew, createCardAt])
  const addFrameAtCentre = useCallback(() => {
    const at = placeNew(NEW_FRAME_W, NEW_FRAME_H, FRAME_TITLE_SPACE)
    const id = newId()
    void actions.submit([ops.createFrame({ id, x: at.x, y: at.y, w: NEW_FRAME_W, h: NEW_FRAME_H })], { key: `new:${id}` })
    ui.select([id])
    ui.edit(id, 'title')
    at.show()
  }, [placeNew, actions])

  // ---- M13: BibTeX in and out for the whole Branch ----
  const allSources = useSources()
  const [importing, setImporting] = useState(false)
  const exportBibtex = useCallback(() => {
    if (allSources.length === 0) {
      toasts.show({ message: 'There are no Sources on this Branch yet, so there is nothing to export.' })
      return
    }
    void exportFile(fileName(`Sources on ${snap.branch?.name ?? 'main'}`, 'bib'), toBibtex(allSources), 'application/x-bibtex')
  }, [allSources, snap.branch?.name])
  // The new Frame goes to the right of everything on the Board, so nothing ends up underneath it.
  const importPlace = useCallback(() => {
    const s = latest.current
    const items = [...s.cards, ...s.frames]
    if (items.length === 0) return viewportCentre()
    return { x: Math.max(...items.map((i) => i.x + i.w)) + 96, y: Math.min(...items.map((i) => i.y)) }
  }, [latest, viewportCentre])
  const importTarget = useMemo(
    () => ({ kind: 'board' as const, place: importPlace, onFrame: (id: string) => boardBridge.focus('frame', id) }),
    [importPlace],
  )

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!(e.target instanceof Element)) return
    // On a Card, outside its title and summary (those edit in place): open its Page.
    const node = e.target.closest('.react-flow__node-card')
    if (node) {
      if (previewing || e.target.closest('.react-flow__handle')) return
      if (!readOnly && e.target.closest('.qb-card--full .qb-card__title, .qb-card--full .qb-card__summary')) return
      const id = node.getAttribute('data-id')
      if (id && cardsById.has(id)) pagePanel.open(id)
      return
    }
    if (readOnly) return
    if (!e.target.classList.contains('react-flow__pane')) return
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    createCardAt(p.x - CARD_W / 2, p.y - CARD_H / 2)
  }

  // ---- shell requests ----
  const request = useBoardRequest((s) => s.request)
  // A create request that predates this Board is stale; a focus request is still honoured.
  const handled = useRef(request && request.type !== 'focus' ? request.nonce : 0)
  useEffect(() => {
    if (!request || request.nonce <= handled.current) return
    if (request.type === 'focus') {
      const target = request.target === 'card' ? cardsById.get(request.id) : framesById.get(request.id)
      if (!target) return // not loaded yet: this effect runs again when the snapshot changes
      handled.current = request.nonce
      ui.select([target.id])
      const el = wrapRef.current
      const scale = usePrefs.getState().boardScale / 100
      if (request.target === 'card') {
        const c = centre(target)
        void rf.setCenter(c.x, c.y, { zoom: Math.max(rf.getZoom(), 0.8 * scale), duration: 200 })
      } else if (el) {
        const b = { x: target.x, y: target.y - FRAME_TITLE_SPACE, width: target.w, height: target.h + FRAME_TITLE_SPACE }
        const { w, h } = canvasSize()
        void rf.setViewport(getViewportForBounds(b, w, h, MIN_ZOOM * scale, 1.2 * scale, FIT_PADDING), { duration: 200 })
      }
      el?.focus({ preventScroll: true })
      return
    }
    handled.current = request.nonce
    if (readOnly) return
    if (request.type === 'create-card') addCardAtCentre()
    else addFrameAtCentre()
  }, [request, cardsById, framesById, rf, readOnly, addCardAtCentre, addFrameAtCentre, canvasSize])

  // ---- React Flow callbacks: selection and in-progress geometry stay local ----
  const onNodesChange = useCallback((changes: NodeChangeset<BoardNode>) => {
    const geo = new Map<string, Transient>()
    let sel: Set<string> | null = null
    for (const c of changes) {
      if (c.type === 'select') {
        sel ??= new Set(useBoardUi.getState().selected)
        if (c.selected) sel.add(c.id)
        else sel.delete(c.id)
      } else if (c.type === 'position' && c.position) {
        geo.set(c.id, { ...geo.get(c.id), x: c.position.x, y: c.position.y })
      } else if (c.type === 'dimensions' && c.resizing && c.dimensions) {
        geo.set(c.id, { ...geo.get(c.id), w: c.dimensions.width, h: c.dimensions.height })
      }
    }
    if (sel) ui.select(sel)
    if (geo.size) ui.setTransient(geo)
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChangeset<ConnectionEdgeType>) => {
    let sel: Set<string> | null = null
    for (const c of changes) {
      if (c.type !== 'select') continue
      sel ??= new Set(useBoardUi.getState().selected)
      if (c.selected) sel.add(c.id)
      else sel.delete(c.id)
    }
    if (sel) ui.select(sel)
  }, [])

  // On drop: one batch for everything that moved.
  const onNodeDragStop = useCallback<OnNodeDrag<BoardNode>>(
    (_e, _node, dragged) => {
      const s = latest.current
      const t = useBoardUi.getState().transient
      const ids = dragged.map((n) => n.id)
      const batch: Op[] = []
      for (const id of ids) {
        const p = t.get(id)
        const vm: CardVM | FrameVM | undefined = s.cards.find((c) => c.id === id) ?? s.frames.find((f) => f.id === id)
        if (!vm || p?.x === undefined || p.y === undefined) continue
        if (Math.round(p.x) !== vm.x || Math.round(p.y) !== vm.y) batch.push(...ops.move(id, p.x, p.y))
      }
      if (batch.length) void actions.submit(batch)
      ui.clearTransient(ids)
    },
    [latest, actions],
  )

  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, state) => {
      if (latest.current.readOnly) return
      const from = state.fromNode?.id
      let to = state.toNode?.id
      if (!to) {
        const pt = 'changedTouches' in event ? event.changedTouches[0] : event
        const el = pt ? document.elementFromPoint(pt.clientX, pt.clientY) : null
        to = el?.closest('.react-flow__node-card')?.getAttribute('data-id') ?? undefined
      }
      const cards = latest.current.cards
      if (!from || !to || from === to || !cards.some((c) => c.id === to) || !cards.some((c) => c.id === from)) return
      const id = newId()
      void actions.submit([ops.createConnection({ id, from, to })])
      ui.select([id])
    },
    [latest, actions],
  )

  const onPaneClick = useCallback(() => {
    ui.clearSelection()
    wrapRef.current?.focus({ preventScroll: true })
  }, [])

  // ---- keyboard ----
  const deleteSelection = useCallback(() => {
    const s = latest.current
    const items: Removal[] = []
    for (const id of useBoardUi.getState().selected) {
      const kind = kindOf(s, id)
      if (kind) items.push({ id, kind })
    }
    if (!items.length) return
    ui.clearSelection()
    actions.removeWithUndo(items)
    wrapRef.current?.focus({ preventScroll: true })
  }, [latest, actions])

  // A Card off screen may not be drawn yet (DRAW_IN_VIEW_FROM): wait a few frames for it while the view moves to it.
  const focusNode = (id: string, frames = FOCUS_FRAMES) => {
    const el = wrapRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    if (el) el.focus({ preventScroll: true })
    else if (frames > 0) requestAnimationFrame(() => focusNode(id, frames - 1))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest(TYPING)) return
    const s = latest.current
    const sel = useBoardUi.getState().selected
    const mod = e.metaKey || e.ctrlKey

    if (e.key === 'Escape') {
      if (useBoardUi.getState().statusMenu) ui.openStatusMenu(null)
      else ui.clearSelection()
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      ui.select(s.cards.map((c) => c.id))
      return
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const order = readingOrder(s.cards, s.frames)
      const focusedId = e.target instanceof Element ? e.target.closest('.react-flow__node-card')?.getAttribute('data-id') : null
      const current = focusedId ?? (sel.size === 1 ? [...sel][0] : undefined)
      const i = current ? order.indexOf(current) : -1
      const nextId = order[i + (e.shiftKey ? -1 : 1)]
      if (i === -1 && e.shiftKey) return
      if (!nextId) return // past the last Card: let focus leave the Board
      e.preventDefault()
      ui.select([nextId])
      focusNode(nextId)
      const card = cardsById.get(nextId)
      if (card) reveal(card)
      return
    }
    if (e.key.toLowerCase() === 'o' && !mod && !e.altKey && !previewing) {
      // O opens the Page of the one selected Card (Guests may read it too).
      const only = sel.size === 1 ? [...sel][0] : undefined
      if (!only || !cardsById.has(only)) return
      e.preventDefault()
      pagePanel.open(only)
      return
    }
    if (readOnly) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      deleteSelection()
      return
    }
    if (e.key === 'Enter' && !mod) {
      const only = sel.size === 1 ? [...sel][0] : undefined
      const card = only ? cardsById.get(only) : undefined
      if (!card) return
      e.preventDefault()
      reveal(card, 0.55) // titles are edited on full Cards
      ui.edit(card.id, 'title')
      return
    }
    const d = nudgeDelta(e.key, e.shiftKey)
    if (d) {
      const items = [...s.cards, ...s.frames].filter((it) => sel.has(it.id))
      if (!items.length) return
      e.preventDefault()
      void actions.submit(nudge(items, d).flatMap((p) => ops.move(p.id, p.x, p.y)))
    }
  }

  // ---- derived overlays ----
  // The Page panel covers the right of the Board: the inspector moves beside it, and is not shown
  // at all for the Card whose Page is open (the Page has everything the inspector has).
  const pageCard = usePagePanel((s) => s.cardId)
  const pageFull = usePagePanel((s) => s.full)
  const pageOpen = pageCard !== null && !previewing
  const only = selected.size === 1 ? [...selected][0] : undefined
  const inspected = only && !previewing && !(pageOpen && only === pageCard) ? cardsById.get(only) : undefined
  const selectedConn = only && !readOnly ? connections.find((c) => c.id === only) : undefined
  // What the AI sidebar follows: the one selected Card, else the Card whose Page is open. Nothing while History previews.
  const focusCard = previewing ? undefined : ((only ? cardsById.get(only) : undefined) ?? (pageCard ? cardsById.get(pageCard) : undefined))
  const focusId = focusCard?.id
  const focusTitle = focusCard?.title
  useEffect(() => {
    boardFocus.set(focusId === undefined ? null : { id: focusId, title: focusTitle ?? '' })
  }, [focusId, focusTitle])
  useEffect(() => () => boardFocus.set(null), [])
  const isEmpty = cards.length === 0 && frames.length === 0
  const loading = isEmpty && !previewing && (snap.status === 'idle' || snap.status === 'loading')
  const failed = isEmpty && !previewing && snap.status === 'error'
  const empty = isEmpty && (previewing || snap.status === 'live' || snap.status === 'reconnecting')

  const selectCard = useCallback(
    (id: string) => {
      ui.select([id])
      const card = latest.current.cards.find((c) => c.id === id)
      if (card) reveal(card)
    },
    [latest, reveal],
  )

  return (
    <div
      ref={wrapRef}
      className={`qb-board${readOnly ? ' is-readonly' : ''}${previewing ? ' is-preview' : ''}${inspected ? ' has-inspector' : ''}${pageOpen && !pageFull ? ' has-page' : ''}`}
      data-testid="board"
      role="region"
      aria-label="Board"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    >
      <ReactFlow<BoardNode, ConnectionEdgeType>
        nodes={nodes}
        edges={overview ? NO_EDGES : edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={CONNECTION_LINE_STYLE}
        defaultViewport={defaultViewport}
        minZoom={MIN_ZOOM * base}
        maxZoom={MAX_ZOOM * base}
        panOnDrag
        panOnScroll
        zoomOnPinch
        zoomOnScroll
        zoomActivationKeyCode={ZOOM_KEYS}
        zoomOnDoubleClick={false}
        selectionOnDrag={false}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={MULTI_KEYS}
        deleteKeyCode={null}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        nodesFocusable
        edgesFocusable={false}
        edgesReconnectable={false}
        elementsSelectable={!previewing}
        disableKeyboardA11y
        autoPanOnNodeFocus={false}
        nodeDragThreshold={2}
        zIndexMode="basic"
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        ariaLabelConfig={ARIA_LABELS}
        onlyRenderVisibleElements={nodes.length + edges.length >= DRAW_IN_VIEW_FROM}
      >
        <Background gap={24} size={1.6} color="var(--q-grid)" />
        {overview && <ConnectionsOverview connections={connections} cards={cardsById} transient={transient} />}
        {suggestion && suggestedFrom && suggestedTo && (
          <SuggestedConnection
            from={placed(suggestedFrom, transient)}
            to={placed(suggestedTo, transient)}
            kind={suggestion.kind}
            label={suggestion.label}
          />
        )}
      </ReactFlow>

      <Toolbar
        readOnly={readOnly}
        onAddCard={addCardAtCentre}
        onAddFrame={addFrameAtCentre}
        onImportBibtex={previewing ? undefined : () => setImporting(true)}
        onExportBibtex={previewing ? undefined : exportBibtex}
        exportMenu={<BoardExportMenu />}
      />
      {importing && !readOnly && <ImportBibtex target={importTarget} onClose={() => setImporting(false)} />}
      <ZoomHud cards={cards.length} frames={frames.length} onFit={() => fit(true)} />
      {scaleNote && (
        <div className="qb-scale-note" key={scaleNote.n} role="status">
          Board {scaleNote.pct}%
        </div>
      )}
      {preview && <PreviewBanner branch={snap.branch?.name ?? 'main'} at={preview.at} onBack={backToNow} />}

      {loading && <LoadingNote />}
      {failed && <ErrorNote detail={snap.error} />}
      {empty && <EmptyState readOnly={readOnly} onAddCard={addCardAtCentre} />}

      {selectedConn && cardsById.get(selectedConn.from) && cardsById.get(selectedConn.to) && (
        <ConnectionPopover
          key={selectedConn.id}
          conn={selectedConn}
          from={cardsById.get(selectedConn.from)!}
          to={cardsById.get(selectedConn.to)!}
        />
      )}

      {inspected && (
        <Inspector
          key={inspected.id}
          card={inspected}
          connections={connections}
          cards={cardsById}
          readOnly={readOnly}
          onSelectCard={selectCard}
          onClose={() => ui.clearSelection()}
          onDelete={() => {
            ui.clearSelection()
            actions.removeWithUndo([{ id: inspected.id, kind: 'Card' }])
          }}
        />
      )}

      {/* While the Page panel is open it shows the toasts itself: it covers the middle of the Board. */}
      {!pageOpen && <Toast />}
    </div>
  )
}
