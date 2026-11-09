import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { ops, useCommentCount } from '../../../lib'
import type { CommentCount, Status } from '../../../lib'
import { InlineText } from '../InlineText'
import { StatusGlyph } from '../StatusGlyph'
import { StatusMenu } from '../StatusMenu'
import { STATUS_LABEL, STATUS_SHORT, STATUS_TOKEN } from '../status'
import type { CardNodeType } from '../types'
import { ui, useBoardUi } from '../uiStore'
import { useBoardActions } from '../useBoardActions'
import { useZoomLevel } from '../useZoomLevel'

/** M18: a Card's thread on the Board: a speech mark and the count, a tick when resolved. Words for screen readers. */
function CommentBadge({ count, compact = false }: { count: CommentCount; compact?: boolean }) {
  const words = `${count.open} ${count.open === 1 ? 'Comment' : 'Comments'}${count.resolved ? ', resolved' : ''}`
  return (
    <span className={`qb-card__comments${compact ? ' qb-card__comments--compact' : ''}${count.resolved ? ' is-resolved' : ''}`} title={words}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
        <path d="M1.5 2 H8.5 V6.8 H4.4 L2.4 8.6 V6.8 H1.5 Z" />
      </svg>
      <span aria-hidden="true">
        {count.open}
        {count.resolved && ' ✓'}
      </span>
      <span className="qb-sr">{words}</span>
    </span>
  )
}

const SIDES = [
  [Position.Top, 't'],
  [Position.Right, 'r'],
  [Position.Bottom, 'b'],
  [Position.Left, 'l'],
] as const

function CardNodeImpl({ id, data, selected, isConnectable }: NodeProps<CardNodeType>) {
  const { card } = data
  const level = useZoomLevel()
  const readOnly = useBoardUi((s) => s.readOnly)
  const editing = useBoardUi((s) => (s.editing?.id === id ? s.editing.field : null))
  const menuOpen = useBoardUi((s) => s.statusMenu === id)
  const actions = useBoardActions()
  const dead = card.status === 'dead_end'
  // One store read per Card, from the counts the layer fetched once: no request and no work per frame.
  const thread = useCommentCount(id)
  const comments = thread !== null && (thread.open > 0 || thread.resolved) ? thread : null
  const canEdit = !readOnly && level === 'full'

  const pickStatus = (s: Status) => {
    ui.openStatusMenu(null)
    if (s !== card.status) void actions.submit([ops.setStatus(id, s)])
  }

  return (
    <div
      className={`qb-card qb-card--${level}${selected ? ' is-selected' : ''}${dead ? ' is-dead' : ''}`}
      data-status={card.status}
      data-testid={`card-${id}`}
      data-card={id}
      data-tour="card"
      style={{ ['--st' as string]: `var(--q-st-${STATUS_TOKEN[card.status]})` }}
    >
      <div className="qb-card__body">
        {level === 'full' && (
          <>
            <div className="qb-card__top">
              {selected && !readOnly ? (
                <button
                  type="button"
                  className="qb-card__status qb-card__status--btn"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={`Status: ${STATUS_LABEL[card.status]}. Change status`}
                  title="Change status"
                  onClick={(e) => {
                    e.stopPropagation()
                    ui.openStatusMenu(menuOpen ? null : id)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <StatusGlyph status={card.status} size={10} label={null} />
                  <span>{STATUS_LABEL[card.status]}</span>
                </button>
              ) : (
                <span className="qb-card__status">
                  <StatusGlyph status={card.status} size={10} label={null} />
                  <span>{STATUS_LABEL[card.status]}</span>
                </span>
              )}
            </div>
            {editing === 'title' ? (
              <InlineText
                initial={card.title}
                confirm="enter"
                label="Title"
                placeholder="Untitled"
                className="qb-card__title-edit"
                onCommit={(t) => void actions.submit([ops.setText(id, 'title', t)], { join: `new:${id}` })}
                onDone={() => ui.stopEditing(id)}
              />
            ) : (
              <div
                className={`qb-card__title${card.title ? '' : ' is-empty'}`}
                onDoubleClick={canEdit ? (e) => (e.stopPropagation(), ui.edit(id, 'title')) : undefined}
              >
                {card.title || 'Untitled'}
              </div>
            )}
            {editing === 'summary' ? (
              <InlineText
                initial={card.summary}
                confirm="mod-enter"
                label="Summary"
                className="qb-card__summary-edit"
                onCommit={(t) => void actions.submit([ops.setText(id, 'summary', t)])}
                onDone={() => ui.stopEditing(id)}
              />
            ) : (
              <div
                className="qb-card__summary"
                onDoubleClick={canEdit ? (e) => (e.stopPropagation(), ui.edit(id, 'summary')) : undefined}
              >
                {card.summary}
              </div>
            )}
            {(card.blocks > 0 || card.sources > 0 || comments) && (
              <div className="qb-card__foot">
                {card.blocks > 0 && (
                  <span title={`Page: ${card.blocks} ${card.blocks === 1 ? 'block' : 'blocks'}`}>
                    <span aria-hidden="true">¶ {card.blocks}</span>
                    <span className="qb-sr">
                      Page: {card.blocks} {card.blocks === 1 ? 'block' : 'blocks'}
                    </span>
                  </span>
                )}
                {card.sources > 0 && (
                  <span>
                    {card.sources} {card.sources === 1 ? 'Source' : 'Sources'}
                  </span>
                )}
                {comments && <CommentBadge count={comments} />}
              </div>
            )}
          </>
        )}
        {level === 'compact' && (
          <>
            <span className="qb-card__status qb-card__status--compact">
              <StatusGlyph status={card.status} size={14} label={null} />
              <span>{STATUS_SHORT[card.status]}</span>
              {comments && <CommentBadge count={comments} compact />}
            </span>
            <div className={`qb-card__title${card.title ? '' : ' is-empty'}`}>{card.title || 'Untitled'}</div>
          </>
        )}
        {level === 'tile' && (
          <>
            <span className="qb-card__status qb-card__status--tile">
              <StatusGlyph status={card.status} size={40} label={null} />
            </span>
            <div className={`qb-card__title${card.title ? '' : ' is-empty'}`}>{card.title || 'Untitled'}</div>
          </>
        )}
      </div>
      {menuOpen && selected && canEdit && (
        <StatusMenu value={card.status} onPick={pickStatus} onClose={() => ui.openStatusMenu(null)} />
      )}
      {SIDES.map(([pos, hid]) => (
        <Handle
          key={hid}
          id={hid}
          type="source"
          position={pos}
          isConnectable={isConnectable}
          className="qb-handle"
          aria-label="Drag to connect to another Card"
        />
      ))}
    </div>
  )
}

export const CardNode = memo(CardNodeImpl)
