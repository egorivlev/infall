import { memo } from 'react'
import { NodeResizeControl } from '@xyflow/react'
import type { NodeProps, ResizeDragEvent, ResizeParams } from '@xyflow/react'
import { ops } from '../../../lib'
import { InlineText } from '../InlineText'
import type { FrameNodeType } from '../types'
import { ui, useBoardUi } from '../uiStore'
import { useBoardActions } from '../useBoardActions'
import { useZoomLevel } from '../useZoomLevel'

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
const MIN_W = 160
const MIN_H = 120

function FrameNodeImpl({ id, data, selected }: NodeProps<FrameNodeType>) {
  const { frame, count } = data
  const level = useZoomLevel()
  const readOnly = useBoardUi((s) => s.readOnly)
  const editing = useBoardUi((s) => s.editing?.id === id && s.editing.field === 'title')
  const actions = useBoardActions()

  const onResizeEnd = (_e: ResizeDragEvent, p: ResizeParams) => {
    void actions.submit([...ops.move(id, p.x, p.y), ...ops.resize(id, p.width, p.height)])
    ui.clearTransient([id])
  }

  return (
    <div
      className={`qb-frame qb-frame--${level}${selected ? ' is-selected' : ''}`}
      data-testid={`frame-${id}`}
    >
      <div className="qb-frame__label">
        {editing ? (
          <InlineText
            initial={frame.title}
            confirm="enter"
            label="Frame title"
            placeholder="Untitled"
            className="qb-frame__title-edit"
            onCommit={(t) => void actions.submit([ops.setText(id, 'title', t)], { join: `new:${id}` })}
            onDone={() => ui.stopEditing(id)}
          />
        ) : (
          <span
            className={`qb-frame__title${frame.title ? '' : ' is-empty'}`}
            onDoubleClick={readOnly ? undefined : (e) => (e.stopPropagation(), ui.edit(id, 'title'))}
          >
            {frame.title || 'Untitled'}
          </span>
        )}
        <span className="qb-frame__count">
          {count} {count === 1 ? 'Card' : 'Cards'}
        </span>
      </div>
      {selected &&
        !readOnly &&
        CORNERS.map((c) => (
          <NodeResizeControl
            key={c}
            position={c}
            minWidth={MIN_W}
            minHeight={MIN_H}
            className="qb-frame__corner"
            onResizeEnd={onResizeEnd}
          />
        ))}
    </div>
  )
}

export const FrameNode = memo(FrameNodeImpl)
