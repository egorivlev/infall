// M18: Comments and For you (docs/specs/team-move.md, decision 9 and Contract B). Like To-dos they are outside
// versioning: the same on every Branch, not in History, never merged, kept when their Card is removed. So they live
// beside the Board store, kept fresh by the socket's `comments` and `for_you` frames (board-sync tells this module).
// Members and Admins only: for a Guest everything refuses locally and nothing is ever asked.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { sync } from './board-sync'
import { ApiError, MOVED_SENTENCE, request } from './http'
import { sessionStore } from './session-store'
import { workspaceStore } from './workspace'
import type { Comment, CommentCount, ForYouItem, ForYouSnapshot, Member, ThreadSnapshot } from './types'

/** The longest Comment, in characters (not UTF-16 units). */
export const MAX_COMMENT = 10_000

type State = {
  threads: Record<string, ThreadSnapshot>
  counts: Record<string, CommentCount>
  forYou: ForYouSnapshot
}

const NO_FOR_YOU: ForYouSnapshot = { status: 'idle', items: [], unseen: 0 }
const EMPTY: State = { threads: {}, counts: {}, forYou: NO_FOR_YOU }
const store = createStore<State>(() => EMPTY)

const IDLE_THREADS = new Map<string, ThreadSnapshot>()
function idleThread(card: string): ThreadSnapshot {
  let t = IDLE_THREADS.get(card)
  if (!t) {
    t = { card, status: 'idle', resolved: false, comments: [] }
    IDLE_THREADS.set(card, t)
  }
  return t
}

function self(): Member | null {
  const s = sessionStore.getState()
  return s.status === 'signed_in' ? s.member : null
}

function member(what: string): Member {
  const me = self()
  if (!me || me.role === 'guest') throw new ApiError(403, 'forbidden', `Guests cannot ${what}.`)
  return me
}

/** A write: a Member, in a Workspace that was not moved away (a moved copy refuses every write). */
function writer(what: string): Member {
  const me = member(what)
  if (workspaceStore.getState().readOnly) throw new ApiError(403, 'moved', MOVED_SENTENCE)
  return me
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** One Comment as the wire has it; null when it cannot be read. */
export function readComment(v: unknown): Comment | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.author !== 'string' || typeof v.text !== 'string') return null
  return {
    id: v.id,
    author: v.author,
    text: v.text,
    mentions: Array.isArray(v.mentions) ? v.mentions.filter((m): m is string => typeof m === 'string') : [],
    created_at: num(v.created_at),
    edited_at: typeof v.edited_at === 'number' && Number.isFinite(v.edited_at) ? v.edited_at : null,
  }
}

function sameComment(a: Comment, b: Comment): boolean {
  return a.id === b.id && a.author === b.author && a.text === b.text && a.created_at === b.created_at && a.edited_at === b.edited_at && a.mentions.join() === b.mentions.join()
}

const byTime = (a: Comment, b: Comment) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Comments keep their identity when unchanged, so a row does not re-render for a neighbour's edit.
function keep(prev: readonly Comment[], next: Comment[]): Comment[] {
  const old = new Map(prev.map((c) => [c.id, c]))
  const out = next.sort(byTime).map((c) => {
    const was = old.get(c.id)
    return was && sameComment(was, c) ? was : c
  })
  return out.length === prev.length && out.every((c, i) => c === prev[i]) ? (prev as Comment[]) : out
}

function setThread(card: string, patch: Partial<ThreadSnapshot>) {
  const s = store.getState()
  const prev = s.threads[card] ?? idleThread(card)
  const next: ThreadSnapshot = { ...prev, ...patch, card }
  if (patch.comments) next.comments = keep(prev.comments, patch.comments)
  if (patch.status !== 'error') delete next.error
  const same =
    next.status === prev.status && next.resolved === prev.resolved && next.comments === prev.comments && next.error === prev.error
  if (same && s.threads[card]) return
  store.setState({ threads: { ...s.threads, [card]: next } })
}

// ---- threads ----

const watched = new Map<string, number>() // card → how many are looking
const loading = new Map<string, Promise<void>>()
const loadingToken = new Map<string, object>()
const again = new Set<string>() // asked for while a load was running: one more afterwards
let session = 0 // bumped when the session changes hands: late answers are dropped

const path = (card: string) => `/api/cards/${encodeURIComponent(card)}/comments`

function loadThread(card: string): Promise<void> {
  const running = loading.get(card)
  if (running) {
    again.add(card)
    return running
  }
  const ticket = session
  const s = store.getState().threads[card]
  if (!s || s.status === 'idle' || s.status === 'error') setThread(card, { status: 'loading' })
  const mine = {}
  loadingToken.set(card, mine)
  const run = (async () => {
    try {
      const answer = await request<unknown>('GET', path(card))
      if (ticket !== session) return
      const b = isRecord(answer) ? answer : {}
      const list = Array.isArray(b.comments) ? b.comments.map(readComment).filter((c): c is Comment => c !== null) : []
      setThread(card, { status: 'ready', resolved: b.resolved === true, comments: list })
    } catch (e) {
      if (ticket !== session) return
      const shown = store.getState().threads[card]
      // A thread already shown stays; only a first load shows the failure.
      if (shown?.status !== 'ready') setThread(card, { status: 'error', error: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      if (loadingToken.get(card) === mine) {
        loadingToken.delete(card)
        loading.delete(card)
      }
    }
  })()
  loading.set(card, run)
  return run.then(
    () => {
      if (again.delete(card) && ticket === session) return loadThread(card)
    },
    (e: unknown) => {
      again.delete(card)
      throw e
    },
  )
}

// ---- counts (one request for every Card; never one per Card) ----

let counting: Promise<void> | null = null
let countAgain = false

function readCounts(v: unknown): Record<string, CommentCount> {
  const out: Record<string, CommentCount> = {}
  if (!isRecord(v)) return out
  for (const [card, c] of Object.entries(v)) {
    if (!isRecord(c)) continue
    out[card] = { open: Math.max(0, Math.round(num(c.open))), resolved: c.resolved === true }
  }
  return out
}

function setCounts(next: Record<string, CommentCount>) {
  const prev = store.getState().counts
  const out: Record<string, CommentCount> = {}
  let same = Object.keys(prev).length === Object.keys(next).length
  for (const [card, c] of Object.entries(next)) {
    const was = prev[card]
    if (was && was.open === c.open && was.resolved === c.resolved) out[card] = was
    else {
      out[card] = c
      same = false
    }
  }
  if (!same) store.setState({ counts: out })
}

function loadCounts(): Promise<void> {
  if (counting) {
    countAgain = true
    return counting
  }
  const ticket = session
  counting = (async () => {
    try {
      const answer = await request<unknown>('GET', '/api/comments/counts')
      if (ticket === session) setCounts(readCounts(answer))
    } finally {
      counting = null
      if (countAgain && ticket === session) {
        countAgain = false
        void loadCounts().catch(() => {})
      }
      countAgain = false
    }
  })()
  return counting
}

// ---- For you ----

const mentionListeners = new Set<(item: ForYouItem) => void>()
let forYouLoading: Promise<void> | null = null
let forYouAgain = false

function readItem(v: unknown): ForYouItem | null {
  if (!isRecord(v) || typeof v.comment !== 'string' || typeof v.card !== 'string' || typeof v.author !== 'string') return null
  return { comment: v.comment, card: v.card, author: v.author, at: num(v.at), seen: v.seen === true }
}

function setForYou(patch: Partial<ForYouSnapshot>) {
  const prev = store.getState().forYou
  let items = patch.items ?? prev.items
  if (patch.items) {
    const old = new Map(prev.items.map((i) => [i.comment, i]))
    items = patch.items.map((i) => {
      const was = old.get(i.comment)
      return was && was.card === i.card && was.author === i.author && was.at === i.at && was.seen === i.seen ? was : i
    })
    if (items.length === prev.items.length && items.every((i, k) => i === prev.items[k])) items = prev.items
  }
  const next: ForYouSnapshot = { status: patch.status ?? prev.status, items, unseen: patch.unseen ?? prev.unseen }
  if (next.status === prev.status && next.items === prev.items && next.unseen === prev.unseen) return
  store.setState({ forYou: next })
}

function loadForYou(announce: boolean): Promise<void> {
  if (forYouLoading) {
    forYouAgain = forYouAgain || true
    return forYouLoading
  }
  const ticket = session
  const before = new Set(store.getState().forYou.items.map((i) => i.comment))
  const first = store.getState().forYou.status !== 'ready'
  if (first) setForYou({ status: 'loading' })
  forYouLoading = (async () => {
    try {
      const answer = await request<unknown>('GET', '/api/for-you')
      if (ticket !== session) return
      const list = isRecord(answer) && Array.isArray(answer.items) ? answer.items.map(readItem).filter((i): i is ForYouItem => i !== null) : []
      list.sort((a, b) => b.at - a.at)
      const items = list.slice(0, 200)
      setForYou({ status: 'ready', items, unseen: items.filter((i) => !i.seen).length })
      if (announce && !first) {
        // The newest mention that was not there before and is not seen: one notice, not one per item.
        const fresh = items.find((i) => !i.seen && !before.has(i.comment))
        if (fresh) for (const fn of [...mentionListeners]) fn(fresh)
      }
    } catch (e) {
      if (ticket === session && store.getState().forYou.status !== 'ready') setForYou({ status: 'error' })
      throw e
    } finally {
      forYouLoading = null
      if (forYouAgain && ticket === session) {
        forYouAgain = false
        void loadForYou(announce).catch(() => {})
      }
      forYouAgain = false
    }
  })()
  return forYouLoading
}

// ---- what the Board layer tells (frames, opening, reconnecting) ----

let started: string | null = null // the Member whose counts and For you were loaded

function signedMember(): Member | null {
  const me = self()
  return me && me.role !== 'guest' ? me : null
}

sync.internal.watch((e) => {
  const me = signedMember()
  if (!me) return
  if (e.type === 'opened' && started !== me.id) {
    started = me.id
    void loadCounts().catch(() => {})
    void loadForYou(false).catch(() => {})
  } else if (e.type === 'reconnected') {
    // Frames sent while away are not repeated.
    void loadCounts().catch(() => {})
    void loadForYou(true).catch(() => {})
    for (const card of watched.keys()) void loadThread(card).catch(() => {})
  } else if (e.type === 'comments') {
    void loadCounts().catch(() => {})
    if (watched.has(e.card)) void loadThread(e.card).catch(() => {})
  } else if (e.type === 'for_you') {
    const was = store.getState().forYou.unseen
    setForYou({ unseen: Math.max(0, Math.round(e.count)) })
    if (e.count > was || store.getState().forYou.status === 'ready') void loadForYou(e.count > was).catch(() => {})
  }
})

function forget() {
  session++
  started = null
  watched.clear()
  loading.clear()
  loadingToken.clear()
  again.clear()
  counting = null
  countAgain = false
  forYouLoading = null
  forYouAgain = false
  if (store.getState() !== EMPTY) store.setState(EMPTY, true)
}

let owner: string | null = signedMember()?.id ?? null
sessionStore.subscribe((s) => {
  const now = s.status === 'signed_in' && s.member.role !== 'guest' ? s.member.id : s.status === 'loading' ? owner : null
  if (now !== owner) {
    owner = now
    forget()
  }
})

// ---- the surface ----

function checkText(text: string): string {
  const t = text.trim()
  if (t === '') throw new ApiError(400, 'bad_request', 'Write something first.')
  if ([...t].length > MAX_COMMENT) throw new ApiError(400, 'bad_request', `A Comment can be at most ${MAX_COMMENT.toLocaleString('en-US')} characters long.`)
  return t
}

function cardOf(id: string): string | null {
  for (const [card, t] of Object.entries(store.getState().threads)) if (t.comments.some((c) => c.id === id)) return card
  return null
}

function uniq(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))]
}

export const comments = {
  /**
   * Starts following the thread of `card`: loads it now, and again whenever its `comments` frame arrives or the
   * socket comes back. Returns the function that stops following. A Guest gets nothing (no request).
   */
  watch(card: string): () => void {
    if (!signedMember()) return () => {}
    watched.set(card, (watched.get(card) ?? 0) + 1)
    void loadThread(card).catch(() => {})
    let done = false
    return () => {
      if (done) return
      done = true
      const n = (watched.get(card) ?? 1) - 1
      if (n <= 0) watched.delete(card)
      else watched.set(card, n)
    }
  },

  /** Fetches the thread again now. Rejects with the ApiError (a Guest: 403 locally). */
  async reload(card: string): Promise<void> {
    member('read Comments')
    await loadThread(card)
  },

  /** `GET /api/comments/counts` again (the Board layer does it on open and on every `comments` frame). */
  async reloadCounts(): Promise<void> {
    if (!signedMember()) return
    await loadCounts()
  },

  /**
   * Adds a Comment to the thread of `card` (`POST /api/cards/{card}/comments`). `mentions` are Member ids (the UI
   * works them out with `findMentions`). Resolves with the Comment once the server has it — it is then in the thread.
   * Rejects locally: 403 `forbidden` (Guest), 400 `bad_request` (empty, or over 10 000 characters after trimming).
   */
  async post(card: string, text: string, mentions: readonly string[] = []): Promise<Comment> {
    const me = writer('write Comments')
    const body = { text: checkText(text), mentions: uniq(mentions) }
    const ticket = session
    const answer = readComment(await request<unknown>('POST', path(card), body))
    if (ticket !== session || self()?.id !== me.id) throw new ApiError(0, 'closed', 'The session changed.')
    if (!answer) {
      await loadThread(card)
      const last = store.getState().threads[card]?.comments.at(-1)
      if (!last) throw new ApiError(500, 'internal', 'The server sent an unreadable response.')
      return last
    }
    const t = store.getState().threads[card]
    setThread(card, { status: t?.status === 'ready' ? 'ready' : (t?.status ?? 'idle'), comments: [...(t?.comments ?? []).filter((c) => c.id !== answer.id), answer] })
    void loadCounts().catch(() => {})
    return answer
  },

  /** Changes your own Comment (`PATCH /api/comments/{id}`). Rejects like `post`; 404 `not_found` locally for a Comment not in a loaded thread. */
  async edit(id: string, text: string, mentions: readonly string[] = []): Promise<void> {
    writer('edit Comments')
    const card = cardOf(id)
    if (card === null) throw new ApiError(404, 'not_found', 'There is no such Comment.')
    const body = { text: checkText(text), mentions: uniq(mentions) }
    const ticket = session
    const answer = readComment(await request<unknown>('PATCH', `/api/comments/${encodeURIComponent(id)}`, body))
    if (ticket !== session) return
    const t = store.getState().threads[card]
    if (answer && t) setThread(card, { comments: t.comments.map((c) => (c.id === id ? answer : c)) })
    else await loadThread(card).catch(() => {})
  },

  /** Deletes a Comment (`DELETE /api/comments/{id}`): the author's own, or any as an Admin (the server decides). */
  async remove(id: string): Promise<void> {
    writer('delete Comments')
    const card = cardOf(id)
    if (card === null) throw new ApiError(404, 'not_found', 'There is no such Comment.')
    const ticket = session
    await request('DELETE', `/api/comments/${encodeURIComponent(id)}`)
    if (ticket !== session) return
    const t = store.getState().threads[card]
    if (t) setThread(card, { comments: t.comments.filter((c) => c.id !== id) })
    void loadCounts().catch(() => {})
  },

  /** Marks the thread resolved or open again (`PUT …/comments/resolved`): any Member. */
  async setResolved(card: string, resolved: boolean): Promise<void> {
    writer('resolve Comments')
    const ticket = session
    await request('PUT', `${path(card)}/resolved`, { resolved })
    if (ticket !== session) return
    setThread(card, { resolved })
    void loadCounts().catch(() => {})
  },
}

/** The thread of a Card as last loaded (`status: 'idle'` until `comments.watch(card)` has been called). */
export function useThread(card: string | null): ThreadSnapshot {
  return useStore(store, (s) => (card === null ? idleThread('') : (s.threads[card] ?? idleThread(card))))
}

/** The badge of one Card: its count from `GET /api/comments/counts`, or null when it has no thread. Re-renders only that Card. */
export function useCommentCount(card: string): CommentCount | null {
  return useStore(store, (s) => s.counts[card] ?? null)
}

export const forYou = {
  /** `GET /api/for-you` again. A Guest: nothing. Rejects with the ApiError. */
  async reload(): Promise<void> {
    if (!signedMember()) return
    await loadForYou(false)
  },

  /**
   * Marks the mentions up to `comment` as seen (`POST /api/for-you/seen {up_to}`): that one and every older one.
   * Shown at once; the `for_you` frame confirms the count. Rejects with the ApiError (the marks are then taken back).
   */
  async seen(comment: string): Promise<void> {
    writer('mark mentions as seen')
    const prev = store.getState().forYou
    const at = prev.items.findIndex((i) => i.comment === comment)
    if (at >= 0) {
      const items = prev.items.map((i, k) => (k >= at && !i.seen ? { ...i, seen: true } : i))
      setForYou({ items, unseen: items.filter((i) => !i.seen).length })
    }
    try {
      await request('POST', '/api/for-you/seen', { up_to: comment })
    } catch (e) {
      if (at >= 0) setForYou({ items: prev.items, unseen: prev.unseen })
      throw e
    }
  },

  /** Called with the newest new mention when the `for_you` frame says one arrived (for the short notice). */
  onMention(fn: (item: ForYouItem) => void): () => void {
    mentionListeners.add(fn)
    return () => {
      mentionListeners.delete(fn)
    }
  },
}

export function useForYou(): ForYouSnapshot {
  return useStore(store, (s) => s.forYou)
}

/** For tests: forget everything as if the session had changed. */
export const commentsInternal = { store, reset: forget }
