import type { Edge, Node } from '@xyflow/react'
import type { CardVM, ConnectionVM, FrameVM } from '../../lib'

export type CardNodeType = Node<{ card: CardVM }, 'card'>
export type FrameNodeType = Node<{ frame: FrameVM; count: number }, 'frame'>
export type BoardNode = CardNodeType | FrameNodeType
export type ConnectionEdgeType = Edge<{ conn: ConnectionVM }, 'connection'>
