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
import { CARD_H, CARD_W, history, newId, ops, useBoard, useHistory } from '../../lib'
import type { CardVM, ConnectionVM, FrameVM, Kind, Op } from '../../lib'
import { pagePanel, suggestionsPanel, useBoardRequest, useHistoryPanel, usePagePanel, useSuggestionsPanel } from '../bridge'
import { HistoryPanel } from '../history'
import { PagePanel } from '../page'
import { SuggestionsPanel } from '../suggestions'
import { EmptyState, ErrorNote, LoadingNote } from './BoardMessage'
import { ConnectionPopover } from './ConnectionPopover'
import { ConnectionEdge } from './edges/ConnectionEdge'
import { createEdgeBuilder, createNodeBuilder } from './elements'
import {
  FRAME_TITLE_SPACE,
  NEW_FRAME_H,
  NEW_FRAME_W,
  boundsOf,
  centre,
  fitBounds,
  frameMembers,
  nudge,
  nudgeDelta,
  readingOrder,
  sidePanelsFit,
  viewToShow,
} from './geometry'
import type { Rect } from './geometry'
import { Inspector } from './Inspector'
import { PreviewBanner } from './PreviewBanner'
import { SuggestedConnection } from './SuggestedConnection'
import { CardNode } from './nodes/CardNode'
import { FrameNode } from './nodes/FrameNode'
import { Toast } from './Toast'
import { toasts } from './toastStore'
import { Toolbar } from './Toolbar'
import type { BoardNode, ConnectionEdgeType } from './types'
import { ui, useBoardUi } from './uiStore'
import type { Transient } from './uiStore'
import { useBoardActions } from './useBoardActions'
import type { Removal } from './useBoardActions'
import { ZoomHud } from './ZoomHud'

const nodeTypes = { card: CardNode, frame: FrameNode }
const edgeTypes = { connection: ConnectionEdge }
const MULTI_KEYS = ['Shift', 'Meta', 'Control']
const ZOOM_KEYS = ['Meta', 'Control']
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 }
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

  return (
    <div className="qb-area" ref={areaRef}>
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

  // While History previews an earlier moment, the Board shows that moment instead, fully read-only.
  const preview = useHistory().preview
  const previewing = preview !== null
  const { cards, frames, connections } = preview ?? snap
  const readOnly = snap.readOnly || previewing
  const view = useMemo<View>(() => ({ cards, frames, connections, readOnly }), [cards, frames, connections, readOnly])
  const latest = useLatest(view)

  useLayoutEffect(() => ui.setReadOnly(readOnly), [readOnly])
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
      const el = wrapRef.current
      if (!el) return
      if (!b) {
        void rf.setViewport(DEFAULT_VIEWPORT, animate ? { duration: 160 } : undefined)
        return
      }
      const vp = getViewportForBounds(b, el.clientWidth, el.clientHeight, 0.1, 1, FIT_PADDING)
      void rf.setViewport(vp, animate ? { duration: 160 } : undefined)
    },
    [rf, latest],
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
      const el = wrapRef.current
      if (!el) return
      const { x, y, zoom } = rf.getViewport()
      const left = -x / zoom
      const top = -y / zoom
      const inside =
        r.x >= left && r.y >= top && r.x + r.w <= left + el.clientWidth / zoom && r.y + r.h <= top + el.clientHeight / zoom
      if (inside && zoom >= minZoom) return
      const c = centre(r)
      void rf.setCenter(c.x, c.y, { zoom: Math.max(zoom, minZoom), duration: 160 })
    },
    [rf],
  )

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
    const covered =
      (el.querySelector<HTMLElement>('.qb-inspector')?.offsetWidth ?? 0) +
      (el.parentElement?.querySelector<HTMLElement>('.qp-panel')?.offsetWidth ?? 0)
    const next = viewToShow(boundsOf(a, b), rf.getViewport(), el.clientWidth - covered, el.clientHeight)
    if (next) void rf.setViewport(next, { duration: 160 })
  }, [shownId, shownFrom, shownTo, latest, rf])

  // ---- creation ----
  const createCardAt = useCallback(
    (x: number, y: number) => {
      const id = newId()
      void actions.submit([ops.createCard({ id, x, y, status: 'idea' })])
      ui.select([id])
      ui.edit(id, 'title')
    },
    [actions],
  )
  const addCardAtCentre = useCallback(() => {
    const c = viewportCentre()
    createCardAt(c.x - CARD_W / 2, c.y - CARD_H / 2)
  }, [viewportCentre, createCardAt])
  const addFrameAtCentre = useCallback(() => {
    const c = viewportCentre()
    const id = newId()
    void actions.submit([ops.createFrame({ id, x: c.x - NEW_FRAME_W / 2, y: c.y - NEW_FRAME_H / 2, w: NEW_FRAME_W, h: NEW_FRAME_H })])
    ui.select([id])
    ui.edit(id, 'title')
  }, [viewportCentre, actions])

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
      if (request.target === 'card') {
        const c = centre(target)
        void rf.setCenter(c.x, c.y, { zoom: Math.max(rf.getZoom(), 0.8), duration: 200 })
      } else if (el) {
        const b = { x: target.x, y: target.y - FRAME_TITLE_SPACE, width: target.w, height: target.h + FRAME_TITLE_SPACE }
        void rf.setViewport(getViewportForBounds(b, el.clientWidth, el.clientHeight, 0.1, 1.2, FIT_PADDING), { duration: 200 })
      }
      el?.focus({ preventScroll: true })
      return
    }
    handled.current = request.nonce
    if (readOnly) return
    if (request.type === 'create-card') addCardAtCentre()
    else addFrameAtCentre()
  }, [request, cardsById, framesById, rf, readOnly, addCardAtCentre, addFrameAtCentre])

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

  const focusNode = (id: string) => {
    const el = wrapRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    el?.focus({ preventScroll: true })
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
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={CONNECTION_LINE_STYLE}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={2}
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
      >
        <Background gap={24} size={1.6} color="var(--q-grid)" />
        {suggestion && suggestedFrom && suggestedTo && (
          <SuggestedConnection
            from={placed(suggestedFrom, transient)}
            to={placed(suggestedTo, transient)}
            kind={suggestion.kind}
            label={suggestion.label}
          />
        )}
      </ReactFlow>

      <Toolbar readOnly={readOnly} onAddCard={addCardAtCentre} onAddFrame={addFrameAtCentre} />
      <ZoomHud cards={cards.length} frames={frames.length} onFit={() => fit(true)} />
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
