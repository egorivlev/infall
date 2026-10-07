import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { members as people, todos, useMembers, useSession, useTodos } from '../../lib'
import type { CardVM, Member, Todo } from '../../lib'
import { toasts } from '../board/toastStore'
import { count, firstName } from './people'

type Props = { card: CardVM; branchId: string | undefined }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Open To-dos that point at this Card. To-dos are not Research Content, so this works under the soft lock too. */
export function PageTodos({ card, branchId }: Props) {
  const all = useTodos()
  const list = useMembers()
  const session = useSession()
  const me = session.status === 'signed_in' ? session.member : null
  const [text, setText] = useState('')
  const [owner, setOwner] = useState<string | null>(null) // null: you

  const hasMembers = list.length > 0
  useEffect(() => {
    // The owner picker needs the team; the list is empty until someone asks for it.
    if (!hasMembers) void people.reload().catch(() => {})
  }, [hasMembers])

  const open = useMemo(
    () => all.filter((t) => !t.done && t.card?.id === card.id).sort((a, b) => a.created_at - b.created_at),
    [all, card.id],
  )
  const byId = useMemo(() => new Map(list.map((m) => [m.id, m])), [list])
  const owners = useMemo(() => {
    const team: Member[] = list.filter((m) => m.role !== 'guest' && m.id !== me?.id)
    team.sort((a, b) => a.name.localeCompare(b.name))
    return me ? [me, ...team] : team
  }, [list, me])
  const nameOf = (id: string) => firstName(id === me?.id ? me.name : byId.get(id)?.name)

  const tick = (todo: Todo) => {
    todos.setDone(todo.id, true).catch((e: unknown) => {
      toasts.show({ message: 'That To-do could not be ticked. Try again in a moment.', title: message(e) })
    })
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    const to = owner ?? me?.id
    if (!value || !to || !branchId) return
    setText('')
    todos.add({ owner: to, text: value, card: { id: card.id, title: card.title, branch: branchId } }).catch((err: unknown) => {
      setText((current) => current || value) // give the words back unless something new was typed
      toasts.show({ message: 'That To-do could not be added. Try again in a moment.', title: message(err) })
    })
  }

  return (
    <section className="qp-todos" aria-labelledby="qp-todos-head">
      <h2 className="q-caps qp-todos__head" id="qp-todos-head">
        To-dos on this Card · {count(open.length, 'open', 'open')}
      </h2>
      {open.length > 0 && (
        <ul className="qp-todos__list">
          {open.map((t) => {
            const mine = t.owner === me?.id
            return (
              <li key={t.id} className="qp-todo">
                <label className="qp-todo__main">
                  <input
                    type="checkbox"
                    className="qp-todo__box"
                    checked={false}
                    disabled={!mine}
                    title={mine ? undefined : `Only ${nameOf(t.owner)} can tick this`}
                    onChange={() => tick(t)}
                  />
                  <span className="qp-todo__text">{t.text}</span>
                </label>
                <span className="qp-todo__owner">{nameOf(t.owner)}</span>
              </li>
            )
          })}
        </ul>
      )}
      {me && (
        <form className="qp-todos__add" onSubmit={add}>
          <input
            className="q-input qp-todos__input"
            aria-label="New To-do"
            placeholder="Add a To-do for…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <select
            className="q-input qp-todos__owner"
            aria-label="Owner of the new To-do"
            value={owner ?? me.id}
            onChange={(e) => setOwner(e.target.value === me.id ? null : e.target.value)}
          >
            {owners.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === me.id ? `${m.name} (you)` : m.name}
              </option>
            ))}
          </select>
          <button type="submit" className="q-btn q-btn--sm" disabled={!text.trim()}>
            Add To-do
          </button>
        </form>
      )}
    </section>
  )
}
