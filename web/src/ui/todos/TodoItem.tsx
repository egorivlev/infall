import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { Member, Todo } from '../../lib'
import { boardBridge } from '../bridge'
import { formatShortDate } from '../shell/dates'
import { Link } from '../shell/Link'
import { branchPath } from '../shell/router'
import { useOnBoard } from '../shell/useOnBoard'
import { firstName, MAX_TEXT } from './model'
import type { CardRef } from './model'

export const CARD_REMOVED_TITLE = 'The To-do is kept; the Card it pointed to was removed.'

type ItemProps = {
  todo: Todo
  owner: Member
  me: Member
  /** Who assigned it, when that is not the owner; `null` for someone who is no longer a Member. */
  assignedBy: Member | null | undefined
  card: CardRef | null
  onToggle: (todo: Todo, done: boolean) => void
  onEdit: (todo: Todo, text: string) => void
  onDelete: (todo: Todo) => void
  /** M18: a moved copy — To-dos are read, not ticked or changed. */
  readOnly?: boolean
}

export function TodoItem({ todo, owner, me, assignedBy, card, onToggle, onEdit, onDelete, readOnly = false }: ItemProps) {
  const textId = useId()
  const mine = todo.owner === me.id && !readOnly
  const canChange = !readOnly && (todo.owner === me.id || todo.created_by === me.id)
  const [editing, setEditing] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false) // the editor was closed from the keyboard: focus goes back to "Edit"

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    editButton.current?.focus()
  }, [editing])

  return (
    <li className={`qt-item${todo.done ? ' is-done' : ''}`}>
      <input
        type="checkbox"
        className="qt-check"
        checked={todo.done}
        disabled={!mine}
        aria-labelledby={editing ? undefined : textId}
        aria-label={editing ? todo.text : undefined}
        title={readOnly ? 'This copy is read-only' : mine ? (todo.done ? 'Mark not done' : 'Mark done') : `Only ${firstName(owner.name)} can tick this`}
        onChange={(e) => onToggle(todo, e.target.checked)}
      />
      <div className="qt-item__main">
        {editing ? (
          <TodoEditor
            initial={todo.text}
            onCommit={(text) => onEdit(todo, text)}
            onDone={(byKey) => {
              refocus.current = byKey
              setEditing(false)
            }}
          />
        ) : (
          <span id={textId} className="qt-item__text">
            {todo.text}
          </span>
        )}
        {(card || assignedBy !== undefined) && (
          <div className="qt-item__meta">
            {card && <CardChip card={card} />}
            {assignedBy !== undefined && (
              <span className="qt-item__by">
                Assigned by {assignedBy ? firstName(assignedBy.name) : 'a former Member'} · {formatShortDate(todo.created_at)}
              </span>
            )}
          </div>
        )}
      </div>
      {canChange && !editing && (
        <div className="qt-item__controls">
          <button
            ref={editButton}
            type="button"
            className="qt-ctl"
            aria-label={`Edit To-do: ${todo.text}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className="qt-ctl qt-ctl--danger"
            aria-label={`Delete To-do: ${todo.text}`}
            onClick={() => onDelete(todo)}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}

/**
 * Edits the text in place. Keeps its own draft, so an update from someone else never overwrites typing.
 * Enter or blur confirms, Esc cancels; an empty text changes nothing.
 */
function TodoEditor({ initial, onCommit, onDone }: { initial: string; onCommit: (text: string) => void; onDone: (byKey: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)

  useLayoutEffect(() => {
    // StrictMode runs this twice in development: the simulated unmount must not leave the editor "finished".
    finished.current = false
    const el = ref.current
    if (el) {
      el.focus({ preventScroll: true })
      el.select()
    }
    return () => {
      finished.current = true // unmounting: a late blur commits nothing
    }
  }, [])

  const finish = (commit: boolean, byKey: boolean) => {
    if (finished.current) return
    finished.current = true
    const text = (ref.current?.value ?? '').trim()
    if (commit && text && text !== initial) onCommit(text)
    onDone(byKey)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(false, true)
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      finish(true, true)
    }
  }

  return (
    <textarea
      ref={ref}
      className="qt-edit"
      defaultValue={initial}
      aria-label="To-do text"
      rows={2}
      maxLength={MAX_TEXT}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true, false)}
    />
  )
}

// A real space between the parts of a chip: the gap is only visual, and a chip is read out as one name.
const SP = ' '

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

function CardChip({ card }: { card: CardRef }) {
  const onBoard = useOnBoard()
  if (card.kind === 'live') {
    return (
      <button
        type="button"
        className="qt-chip qt-chip--card"
        title="Shows the Card on the Board"
        onClick={() => onBoard(() => boardBridge.focus('card', card.id))}
      >
        <span className="qt-chip__key">Card:</span>{SP}
        <span className="qt-chip__title">{card.title}</span>
      </button>
    )
  }
  if (card.kind === 'branch') {
    return (
      <Link
        href={branchPath(card.branch)}
        className="qt-chip qt-chip--branch"
        title={`Opens ${card.branch} and selects the Card`}
        // The Board honours the request once that Branch has loaded the Card.
        onClick={(e) => {
          if (plainClick(e)) boardBridge.focus('card', card.id)
        }}
      >
        <span className="qt-chip__branch">
          <span aria-hidden="true">⑂ </span>
          <span className="q-sr">Branch </span>
          {card.branch}
        </span>{SP}
        <span className="qt-chip__key">· Card:</span>{SP}
        <span className="qt-chip__title">{card.title}</span>{SP}
        <span className="qt-chip__arrow" aria-hidden="true">
          ↗
        </span>
      </Link>
    )
  }
  if (card.kind === 'pending') {
    return (
      <span className="qt-chip">
        <span className="qt-chip__key">Card:</span>{SP}
        <span className="qt-chip__title">{card.title}</span>
      </span>
    )
  }
  return (
    <span className="qt-chip qt-chip--gone" title={CARD_REMOVED_TITLE}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="8" height="8" rx="1" />
        <path d="M3 3 L7 7 M7 3 L3 7" />
      </svg>
      <span className="qt-chip__key">Card removed ·</span>{SP}
      <span className="qt-chip__title qt-chip__title--gone">{card.title}</span>
    </span>
  )
}
