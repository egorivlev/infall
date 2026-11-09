import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { todos, useBoard, useBranches, useForYou, useMembers, useTodos } from '../../lib'
import type { Member, Todo } from '../../lib'
import { initials } from '../shell/initials'
import { useDelayedFlag } from '../shell/useDelayedFlag'
import { cardRefOf, columnsOf, failure, FILTERS, firstName, matches, MAX_TEXT } from './model'
import type { Column, Filter } from './model'
import { TodoItem } from './TodoItem'
import { TodoTabs } from './TodoTabs'
import './todos.css'

const UNDO_MS = 6000

type Failure = { owner: string; text: string }

/** Runs a call of the data layer; a throw and a rejection are the same failure. */
function attempt<T>(call: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(call)
}

/** The To-dos of the whole team: one column per Member. Not Research Content — the same on every Branch. */
export function Todos({ me }: { me: Member }) {
  const list = useTodos()
  const people = useMembers()
  const board = useBoard()
  const branches = useBranches()
  const unseen = useForYou().unseen
  const readOnly = board.readOnly // M18: a moved copy (Guests never come here)

  const [filter, setFilter] = useState<Filter>('open')
  const [failed, setFailed] = useState<Failure | null>(null)
  const [deleted, setDeleted] = useState<Todo | null>(null) // offered back by "Undo" for a few seconds
  const undoTimer = useRef<number | undefined>(undefined)

  // The list is normally there already (the Board loads it); asking again tells us when "empty" is really empty.
  const [load, setLoad] = useState<{ state: 'loading' | 'ready' } | { state: 'error'; text: string }>({ state: 'loading' })
  const [loadRun, setLoadRun] = useState(0)
  useEffect(() => {
    let stale = false
    attempt(() => todos.reload()).then(
      () => {
        if (!stale) setLoad({ state: 'ready' })
      },
      (e: unknown) => {
        if (!stale) setLoad({ state: 'error', text: failure('loaded', e) })
      },
    )
    return () => {
      stale = true
    }
  }, [loadRun])
  const retryLoad = () => {
    setLoad({ state: 'loading' })
    setLoadRun((n) => n + 1)
  }

  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  const columns = columnsOf(me, people, list)
  const byId = new Map(people.map((m) => [m.id, m]))
  const open = columns.reduce((n, c) => n + c.open, 0)
  const waiting = load.state === 'loading' && list.length === 0
  const showLoading = useDelayedFlag(waiting, 150)

  const fail = (owner: string, what: Parameters<typeof failure>[0]) => (e: unknown) => setFailed({ owner, text: failure(what, e) })
  const succeed = (owner: string) => () => setFailed((f) => (f?.owner === owner ? null : f))

  const add = useCallback((owner: string, text: string): Promise<boolean> => {
    return attempt(() => todos.add({ owner, text })).then(
      () => {
        setFailed((f) => (f?.owner === owner ? null : f))
        return true
      },
      (e: unknown) => {
        setFailed({ owner, text: failure('added', e) })
        return false
      },
    )
  }, [])

  const toggle = (todo: Todo, done: boolean) => {
    attempt(() => todos.setDone(todo.id, done)).then(succeed(todo.owner), fail(todo.owner, 'updated'))
  }
  const edit = (todo: Todo, text: string) => {
    attempt(() => todos.edit(todo.id, { text })).then(succeed(todo.owner), fail(todo.owner, 'changed'))
  }
  const forget = () => {
    window.clearTimeout(undoTimer.current)
    setDeleted(null)
  }
  const remove = (todo: Todo) => {
    // Deleted at once, without a dialog; "Undo" adds it again.
    window.clearTimeout(undoTimer.current)
    setDeleted(todo)
    undoTimer.current = window.setTimeout(() => setDeleted(null), UNDO_MS)
    attempt(() => todos.remove(todo.id)).then(succeed(todo.owner), (e: unknown) => {
      setDeleted((d) => (d?.id === todo.id ? null : d))
      fail(todo.owner, 'deleted')(e)
    })
  }
  const undo = (todo: Todo) => {
    forget()
    attempt(() => todos.add({ owner: todo.owner, text: todo.text, ...(todo.card ? { card: todo.card } : {}) }))
      .then((again) => {
        // Only the owner can tick: a done To-do of your own comes back done.
        if (todo.done && todo.owner === me.id && again?.id) return todos.setDone(again.id, true)
      })
      .then(succeed(todo.owner), fail(todo.owner, 'brought back'))
  }

  return (
    <div className="qt">
      <header className="qt__head">
        <TodoTabs current="todos" unseen={unseen} />
        <h1 className="qt__title">To-dos</h1>
        <span className="qt__count">
          {open} open · {columns.length} {columns.length === 1 ? 'Member' : 'Members'}
        </span>
        <span className="qt__grow" />
        <fieldset className="qt-filter">
          <legend className="q-sr">Show</legend>
          {FILTERS.map((f) => (
            <label key={f.value} className="qt-filter__opt">
              <input type="radio" name="qt-filter" value={f.value} checked={filter === f.value} onChange={() => setFilter(f.value)} />
              <span>{f.label}</span>
            </label>
          ))}
        </fieldset>
      </header>

      {load.state === 'error' && (
        <p className="qt__note q-error" role="alert">
          {load.text}{' '}
          <button type="button" className="qt-ctl" onClick={retryLoad}>
            Try again
          </button>
        </p>
      )}

      {waiting ? (
        showLoading && (
          <p className="qt__loading" role="status">
            Loading To-dos…
          </p>
        )
      ) : (
        <div className="qt__cols">
          {columns.map((col) => (
            <TodoColumn
              key={col.member.id}
              col={col}
              filter={filter}
              failed={failed?.owner === col.member.id ? failed.text : null}
              deleted={deleted?.owner === col.member.id ? deleted : null}
              onAdd={add}
              onUndo={undo}
              onForget={forget}
              readOnly={readOnly}
              renderItem={(todo) => (
                <TodoItem
                  key={todo.id}
                  todo={todo}
                  owner={col.member}
                  me={me}
                  assignedBy={todo.created_by === todo.owner ? undefined : (byId.get(todo.created_by) ?? null)}
                  card={todo.card ? cardRefOf(todo.card, board, branches) : null}
                  onToggle={toggle}
                  onEdit={edit}
                  onDelete={remove}
                  readOnly={readOnly}
                />
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type ColumnProps = {
  col: Column
  filter: Filter
  failed: string | null
  deleted: Todo | null
  onAdd: (owner: string, text: string) => Promise<boolean>
  onUndo: (todo: Todo) => void
  onForget: () => void
  renderItem: (todo: Todo) => ReactNode
  readOnly?: boolean
}

function TodoColumn({ col, filter, failed, deleted, onAdd, onUndo, onForget, renderItem, readOnly = false }: ColumnProps) {
  const headId = useId()
  const { member, mine } = col
  const shown = col.items.filter((t) => matches(filter, t))
  const role = member.role === 'admin' ? 'Admin' : 'Member'
  const empty =
    col.items.length === 0 ? (readOnly ? 'No To-dos.' : 'No To-dos yet. Add one below.') : filter === 'open' ? 'No open To-dos.' : filter === 'done' ? 'No done To-dos.' : ''

  return (
    <section className={`qt-col${mine ? ' qt-col--mine' : ''}`} aria-labelledby={headId}>
      <div className="qt-col__head">
        <span className="q-avatar" style={{ background: member.color }} aria-hidden="true">
          {initials(member.name)}
        </span>
        <h2 className="qt-col__name" id={headId}>
          {member.name}
        </h2>
        <span className="qt-col__role">{mine ? `${role} (you)` : role}</span>
        <span className="qt__grow" />
        <span className="qt-col__open">{col.open} open</span>
      </div>
      <div className="qt-col__body">
        {shown.length > 0 ? <ul className="qt-col__list">{shown.map(renderItem)}</ul> : <p className="qt-col__empty">{empty}</p>}
      </div>
      <div className="qt-col__foot">
        {deleted && <UndoRow todo={deleted} onUndo={onUndo} onForget={onForget} />}
        {failed && (
          <p className="qt-col__failed q-error" role="alert">
            {failed}
          </p>
        )}
        {!readOnly && <AddTodo owner={member} mine={mine} onAdd={onAdd} />}
      </div>
    </section>
  )
}

/** The page's own "Deleted. Undo" row: the Board's toasts are only on screen with the Board. */
function UndoRow({ todo, onUndo, onForget }: { todo: Todo; onUndo: (todo: Todo) => void; onForget: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // The "Delete" button that had focus is gone with its To-do; keep the keyboard next to "Undo".
    const active = document.activeElement
    if (!active || active === document.body) button.current?.focus({ preventScroll: true })
  }, [todo.id])
  return (
    <div className="qt-undo" role="status">
      <span className="qt-undo__msg">Deleted.</span>
      <button ref={button} type="button" className="q-btn q-btn--sm" onClick={() => onUndo(todo)}>
        Undo
      </button>
      <button type="button" className="qt-undo__close" aria-label="Dismiss" title="Dismiss" onClick={onForget}>
        ×
      </button>
    </div>
  )
}

function AddTodo({ owner, mine, onAdd }: { owner: Member; mine: boolean; onAdd: (owner: string, text: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const label = mine ? 'Add a To-do' : `Assign to ${firstName(owner.name)}`
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (!value) return
    setText('')
    // If it could not be added, the words come back — unless something new is being typed already.
    void onAdd(owner.id, value).then((ok) => {
      if (!ok) setText((now) => (now === '' ? value : now))
    })
  }
  return (
    <form className="qt-add" onSubmit={submit}>
      <span className="qt-add__plus" aria-hidden="true">
        +
      </span>
      <input
        className="qt-add__input"
        type="text"
        value={text}
        aria-label={label}
        placeholder={`${label}…`}
        maxLength={MAX_TEXT}
        enterKeyHint="done"
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  )
}
