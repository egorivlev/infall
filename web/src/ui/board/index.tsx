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
import { CARD_H, CARD_W, newId, ops, useBoard } from '../../lib'
import type { BoardSnapshot, CardVM, FrameVM, Kind, Op } from '../../lib'
import { useBoardRequest } from '../bridge'
import { EmptyState, ErrorNote, LoadingNote } from './BoardMessage'
import { ConnectionPopover } from './ConnectionPopover'
import { ConnectionEdge } from './edges/ConnectionEdge'
import { createEdgeBuilder, createNodeBuilder } from './elements'
import {
  FRAME_TITLE_SPACE,
  NEW_FRAME_H,
  NEW_FRAME_W,
  centre,
  fitBounds,
  frameMembers,
  nudge,
  nudgeDelta,
  readingOrder,
} from './geometry'
import type { Rect } from './geometry'
import { Inspector } from './Inspector'
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
const PRO_OPTIONS = { hideAttribution: true } // MIT licence; no paid plan required
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
const TYPING = 'input, textarea, select, [contenteditable="true"], .qb-inspector, .qb-popover, .qb-status-menu, .qb-toasts'

/** The Board: fills its positioned parent. The shell opens/closes the Board; this only reads and submits. */
export function BoardView() {
  return (
    <ReactFlowProvider>
      <BoardCanvas />
    </ReactFlowProvider>
  )
}

function useLatest<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

function kindOf(s: BoardSnapshot, id: string): Kind | null {
  if (s.cards.some((c) => c.id === id)) return 'Card'
  if (s.frames.some((f) => f.id === id)) return 'Frame'
  if (s.connections.some((c) => c.id === id)) return 'Connection'
  return null
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
  const latest = useLatest(snap)
  const { readOnly } = snap

  useLayoutEffect(() => ui.setReadOnly(readOnly), [readOnly])
  useEffect(
    () => () => {
      ui.reset()
      toasts.clear()
    },
    [],
  )

  const cardsById = useMemo(() => new Map(snap.cards.map((c) => [c.id, c])), [snap.cards])
  const framesById = useMemo(() => new Map(snap.frames.map((f) => [f.id, f])), [snap.frames])
  const counts = useMemo(() => frameMembers(snap.frames, snap.cards), [snap.frames, snap.cards])

  // Someone else deleted what this person had selected or was editing: let it go quietly.
  useEffect(() => {
    const conns = new Set(snap.connections.map((c) => c.id))
    ui.prune((id) => cardsById.has(id) || framesById.has(id) || conns.has(id))
  }, [cardsById, framesById, snap.connections])

  const [buildNodes] = useState(createNodeBuilder)
  const [buildEdges] = useState(createEdgeBuilder)
  const nodes = useMemo(
    () => buildNodes({ cards: snap.cards, frames: snap.frames, counts, selected, transient, raised, readOnly }),
    [buildNodes, snap.cards, snap.frames, counts, selected, transient, raised, readOnly],
  )
  const edges = useMemo(
    () => buildEdges(snap.connections, cardsById, selected),
    [buildEdges, snap.connections, cardsById, selected],
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
    if (snap.cards.length || snap.frames.length) {
      fitted.current = true
      fit(false)
    }
  }, [hasSize, snap.cards, snap.frames, fit])

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
    if (readOnly) return
    if (!(e.target instanceof Element) || !e.target.classList.contains('react-flow__pane')) return
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
  const only = selected.size === 1 ? [...selected][0] : undefined
  const inspected = only ? cardsById.get(only) : undefined
  const selectedConn = only && !readOnly ? snap.connections.find((c) => c.id === only) : undefined
  const isEmpty = snap.cards.length === 0 && snap.frames.length === 0
  const loading = isEmpty && (snap.status === 'idle' || snap.status === 'loading')
  const failed = isEmpty && snap.status === 'error'
  const empty = isEmpty && (snap.status === 'live' || snap.status === 'reconnecting')

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
      className={`qb-board${readOnly ? ' is-readonly' : ''}${inspected ? ' has-inspector' : ''}`}
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
        elementsSelectable
        disableKeyboardA11y
        autoPanOnNodeFocus={false}
        nodeDragThreshold={2}
        zIndexMode="basic"
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        proOptions={PRO_OPTIONS}
        ariaLabelConfig={ARIA_LABELS}
      >
        <Background gap={24} size={1.6} color="var(--q-grid)" />
      </ReactFlow>

      <Toolbar readOnly={readOnly} onAddCard={addCardAtCentre} onAddFrame={addFrameAtCentre} />
      <ZoomHud cards={snap.cards.length} frames={snap.frames.length} onFit={() => fit(true)} />

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
          connections={snap.connections}
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

      <Toast />
    </div>
  )
}
