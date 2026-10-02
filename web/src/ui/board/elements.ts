// Derive React Flow nodes/edges from the snapshot plus local UI state.
// Each item keeps its identity while its inputs are unchanged, so memoised node/edge components skip work.
import type { CardVM, ConnectionVM, FrameVM } from '../../lib'
import { STATUS_LABEL } from './status'
import type { BoardNode, CardNodeType, ConnectionEdgeType, FrameNodeType } from './types'
import type { Transient } from './uiStore'

type CardEntry = { vm: CardVM; selected: boolean; t: Transient | undefined; raised: boolean; readOnly: boolean; node: CardNodeType }
type FrameEntry = { vm: FrameVM; selected: boolean; t: Transient | undefined; count: number; readOnly: boolean; node: FrameNodeType }
type EdgeEntry = { vm: ConnectionVM; selected: boolean; from: string; to: string; edge: ConnectionEdgeType }

// Cards are focused by the Board's own Tab handling (reading order), not by the browser's tab sequence.
const CARD_DOM = { 'aria-roledescription': 'Card', tabIndex: -1 }
const FRAME_DOM = { 'aria-roledescription': 'Frame' }
const EDGE_DOM = { 'aria-roledescription': 'Connection' }

export type NodeInputs = {
  cards: readonly CardVM[]
  frames: readonly FrameVM[]
  counts: ReadonlyMap<string, string[]>
  selected: ReadonlySet<string>
  transient: ReadonlyMap<string, Transient>
  raised: string | null // a Card with an open menu or editor sits above its neighbours
  readOnly: boolean
}

export function createNodeBuilder() {
  let cardCache = new Map<string, CardEntry>()
  let frameCache = new Map<string, FrameEntry>()
  let last: BoardNode[] = []

  return function build(i: NodeInputs): BoardNode[] {
    const nextCards = new Map<string, CardEntry>()
    const nextFrames = new Map<string, FrameEntry>()
    const out: BoardNode[] = []
    for (const vm of i.frames) {
      const selected = i.selected.has(vm.id)
      const t = i.transient.get(vm.id)
      const count = i.counts.get(vm.id)?.length ?? 0
      let e = frameCache.get(vm.id)
      if (!e || e.vm !== vm || e.selected !== selected || e.t !== t || e.count !== count || e.readOnly !== i.readOnly) {
        const node: FrameNodeType = {
          id: vm.id,
          type: 'frame',
          position: { x: t?.x ?? vm.x, y: t?.y ?? vm.y },
          width: t?.w ?? vm.w,
          height: t?.h ?? vm.h,
          data: { frame: vm, count },
          selected,
          draggable: !i.readOnly,
          dragHandle: '.qb-frame__label',
          connectable: false,
          deletable: false,
          focusable: false,
          zIndex: -1,
          ariaLabel: `Frame: ${vm.title || 'Untitled'}, ${count} ${count === 1 ? 'Card' : 'Cards'}`,
          domAttributes: FRAME_DOM,
        }
        e = { vm, selected, t, count, readOnly: i.readOnly, node }
      }
      nextFrames.set(vm.id, e)
      out.push(e.node)
    }
    for (const vm of i.cards) {
      const selected = i.selected.has(vm.id)
      const t = i.transient.get(vm.id)
      const raised = i.raised === vm.id
      let e = cardCache.get(vm.id)
      if (!e || e.vm !== vm || e.selected !== selected || e.t !== t || e.raised !== raised || e.readOnly !== i.readOnly) {
        const node: CardNodeType = {
          id: vm.id,
          type: 'card',
          position: { x: t?.x ?? vm.x, y: t?.y ?? vm.y },
          width: vm.w,
          height: vm.h,
          data: { card: vm },
          selected,
          draggable: !i.readOnly,
          connectable: !i.readOnly,
          deletable: false,
          zIndex: raised ? 10 : 0,
          ariaLabel: `${vm.title || 'Untitled'} — ${STATUS_LABEL[vm.status]}`,
          domAttributes: CARD_DOM,
        }
        e = { vm, selected, t, raised, readOnly: i.readOnly, node }
      }
      nextCards.set(vm.id, e)
      out.push(e.node)
    }
    cardCache = nextCards
    frameCache = nextFrames
    if (out.length === last.length && out.every((n, k) => n === last[k])) return last
    last = out
    return out
  }
}

export function createEdgeBuilder() {
  let cache = new Map<string, EdgeEntry>()
  let last: ConnectionEdgeType[] = []
  return function build(
    connections: readonly ConnectionVM[],
    cards: ReadonlyMap<string, CardVM>,
    selected: ReadonlySet<string>,
  ): ConnectionEdgeType[] {
    const next = new Map<string, EdgeEntry>()
    const out: ConnectionEdgeType[] = []
    for (const vm of connections) {
      const isSel = selected.has(vm.id)
      const from = cards.get(vm.from)?.title || 'Untitled'
      const to = cards.get(vm.to)?.title || 'Untitled'
      let e = cache.get(vm.id)
      if (!e || e.vm !== vm || e.selected !== isSel || e.from !== from || e.to !== to) {
        const arrow = vm.kind === 'directed' ? '→' : vm.kind === 'contradicts' ? 'contradicts' : '—'
        const edge: ConnectionEdgeType = {
          id: vm.id,
          type: 'connection',
          source: vm.from,
          target: vm.to,
          data: { conn: vm },
          selected: isSel,
          deletable: false,
          focusable: false,
          ariaLabel: `Connection: ${from} ${arrow} ${to}${vm.label ? ` (${vm.label})` : ''}`,
          domAttributes: EDGE_DOM,
        }
        e = { vm, selected: isSel, from, to, edge }
      }
      next.set(vm.id, e)
      out.push(e.edge)
    }
    cache = next
    if (out.length === last.length && out.every((n, k) => n === last[k])) return last
    last = out
    return out
  }
}
