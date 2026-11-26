// To-dos: not Research Content, so they are outside the Board store — one list, the same on every Branch.
// What the UI sees is the server's list (`confirmed`) with the edits still on their way applied on top, so an
// answer, a `todos` frame and a refetch can arrive in any order without an optimistic edit flickering.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { ApiError, MOVED_SENTENCE, request } from './http'
import { newId } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { workspaceStore } from './workspace'
import type { Member, Todo } from './types'

type CardPointer = { id: string; title: string; branch: string }
type Edit = (list: Todo[]) => Todo[]

const EMPTY: Todo[] = []
const MAX_TEXT = 500
const store = createStore<{ todos: Todo[] }>(() => ({ todos: EMPTY }))

let confirmed: Todo[] = EMPTY
let pending: Edit[] = []

function self(): Member | null {
  const s = sessionStore.getState()
  return s.status === 'signed_in' ? s.member : null
}

function inOrder(a: Todo, b: Todo): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

// Shows `confirmed` with the pending edits on top. To-dos and the list keep their identity while unchanged.
function publish() {
  const prev = store.getState().todos
  const old = new Map(prev.map((t) => [t.id, t]))
  const next = pending
    .reduce((list, edit) => edit(list), confirmed)
    .map((t) => {
      const before = old.get(t.id)
      return before && JSON.stringify(before) === JSON.stringify(t) ? before : t
    })
  if (next.length !== prev.length || next.some((t, i) => t !== prev[i])) store.setState({ todos: next })
}

function forget() {
  confirmed = EMPTY
  pending = []
  publish()
}

/** The server's full list, from `GET /api/todos` or a `todos` frame. Ignored for Guests and signed-out sessions. */
export function setTodos(list: Todo[]): void {
  const me = self()
  if (!me || me.role === 'guest') return
  confirmed = [...list].sort(inOrder)
  publish()
}

function upsert(todo: Todo) {
  confirmed = [...confirmed.filter((t) => t.id !== todo.id), todo].sort(inOrder)
}

/**
 * M18 decision 6: in a Local Workspace made from a Team file, the other Members are names only, who never sign in
 * here. Their To-dos keep them as owner and are the Local Member's to tick, change and delete. Never on a Team
 * server, where whoever claims the name takes over its To-dos.
 */
export function isNameOnly(owner: string): boolean {
  if (workspaceStore.getState().kind !== 'local') return false
  const m = membersStore.getState().members.find((x) => x.id === owner)
  return m !== undefined && m.role !== 'guest' && m.claimed === false
}

function member(action: string): Member {
  const me = self()
  if (!me || me.role === 'guest') throw new ApiError(403, 'forbidden', `Guests cannot ${action} To-dos.`)
  // M18: a moved Workspace refuses every write; say so without asking.
  if (workspaceStore.getState().readOnly) throw new ApiError(403, 'moved', MOVED_SENTENCE)
  return me
}

function visible(id: string): Todo {
  const todo = store.getState().todos.find((t) => t.id === id)
  if (!todo) throw new ApiError(404, 'not_found', 'There is no such To-do.')
  return todo
}

function checkText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_TEXT) {
    throw new ApiError(400, 'bad_request', `A To-do needs 1 to ${MAX_TEXT} characters.`)
  }
  return trimmed
}

// Shows `edit` at once, sends the request, then takes the server's answer; a failure takes the edit back.
async function optimistic<T>(edit: Edit, send: () => Promise<T>, settle: (answer: T) => void): Promise<T> {
  pending.push(edit)
  publish()
  try {
    const answer = await send()
    // A sign-out or a new session in between already forgot the list.
    if (pending.includes(edit)) settle(answer)
    return answer
  } finally {
    pending = pending.filter((e) => e !== edit)
    publish()
  }
}

const change = (id: string, to: (t: Todo) => Todo): Edit => (list) => list.map((t) => (t.id === id ? to(t) : t))
const path = (id: string) => `/api/todos/${encodeURIComponent(id)}`

export const todos = {
  // A Guest has no To-dos: resolves without a request and the list stays empty.
  async reload(): Promise<void> {
    const me = self()
    if (!me || me.role === 'guest') return
    const { todos: list } = await request<{ todos: Todo[] }>('GET', '/api/todos')
    if (self()?.id === me.id) setTodos(list)
  },
  async add(input: { owner: string; text: string; card?: CardPointer }): Promise<Todo> {
    const me = member('add')
    const text = checkText(input.text)
    const draft: Todo = {
      id: `pending:${newId()}`,
      owner: input.owner,
      text,
      done: false,
      created_by: me.id,
      created_at: Date.now(),
    }
    const body: { owner: string; text: string; card?: CardPointer } = { owner: input.owner, text }
    if (input.card) draft.card = body.card = { id: input.card.id, title: input.card.title, branch: input.card.branch }
    // A `todos` frame can bring the real To-do before the answer does: the draft then steps aside.
    const known = new Set(confirmed.map((t) => t.id))
    const arrived = (t: Todo) => !known.has(t.id) && t.owner === draft.owner && t.text === text && t.created_by === me.id
    const { todo } = await optimistic(
      (list) => (list.some(arrived) ? list : [...list, draft]),
      () => request<{ todo: Todo }>('POST', '/api/todos', body),
      (answer) => upsert(answer.todo),
    )
    return todo
  },
  async setDone(id: string, done: boolean): Promise<void> {
    const me = member('tick')
    const owner = visible(id).owner
    if (owner !== me.id && !isNameOnly(owner)) throw new ApiError(403, 'forbidden', 'Only its owner can tick a To-do.')
    const at = Date.now()
    await optimistic(
      change(id, (t) => {
        const { done_at: _was, ...rest } = t
        return done ? { ...rest, done, done_at: t.done ? (t.done_at ?? at) : at } : { ...rest, done }
      }),
      () => request<{ todo: Todo }>('PATCH', path(id), { done }),
      (answer) => upsert(answer.todo),
    )
  },
  async edit(id: string, patch: { text?: string; card?: CardPointer | null }): Promise<void> {
    member('edit')
    visible(id)
    const body: { text?: string; card?: CardPointer | null } = {}
    if (patch.text !== undefined) body.text = checkText(patch.text)
    if (patch.card !== undefined) {
      body.card = patch.card === null ? null : { id: patch.card.id, title: patch.card.title, branch: patch.card.branch }
    }
    if (body.text === undefined && body.card === undefined) return
    await optimistic(
      change(id, (t) => {
        const { card: _was, ...rest } = t
        const next: Todo = body.text === undefined ? rest : { ...rest, text: body.text }
        const card = body.card === undefined ? t.card : body.card
        if (card) next.card = card
        return next
      }),
      () => request<{ todo: Todo }>('PATCH', path(id), body),
      (answer) => upsert(answer.todo),
    )
  },
  async remove(id: string): Promise<void> {
    member('remove')
    visible(id)
    await optimistic(
      (list) => list.filter((t) => t.id !== id),
      () => request('DELETE', path(id)),
      () => {
        confirmed = confirmed.filter((t) => t.id !== id)
      },
    )
  },
}

export function useTodos(): Todo[] {
  return useStore(store, (s) => s.todos)
}

/** For tests and the Board layer; not part of the UI surface. */
export const todosInternal = { store, reset: forget }

// Forget the list when the session ends, belongs to a Guest, or changes hands.
let owner: string | null = self()?.id ?? null
sessionStore.subscribe((s) => {
  const now = s.status === 'signed_in' && s.member.role !== 'guest' ? s.member.id : s.status === 'loading' ? owner : null
  if (now !== owner) {
    owner = now
    forget()
  }
})
