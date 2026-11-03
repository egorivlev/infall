// Suggestions of the open Branch: what an AI proposed through the tool layer, waiting for a Member to decide.
// Not Research Content, so they live outside the Board store, like To-dos: the server's list (`confirmed`) with the
// decisions still on their way applied on top. What the UI gets is that list resolved against the open Board.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { BoardSync } from './board-sync'
import { sync } from './board-sync'
import { ApiError, request } from './http'
import { newId, ops } from './ops'
import { sessionStore } from './session-store'
import { findSourceIn, normalizeDoi, normalizeUrl } from './sources'
import { undoFor } from './undo-store'
import type { CardVM, Change, Member, Op, SourceVM, Suggestion, SuggestionVM } from './types'

/** What a Suggestion is read against: the live Cards and Sources of the open Branch, and its name. */
export type SuggestionWorld = { cards: readonly CardVM[]; sources: readonly SourceVM[]; branchName: string }

const NO_SUGGESTIONS: Suggestion[] = []
const NO_ITEMS: SuggestionVM[] = []
const ARXIV_HOST = /^(?:www\.|export\.)?arxiv\.org$/
const ARXIV_PATH = /^\/(?:abs|pdf|html|format|ps)\/(.+?)(?:\.pdf)?$/

// "Wang, Fowler, Hollenberg" → "Wang et al."; one or two names stay as they are.
function shortAuthors(authors: string): string {
  const names = authors
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  return names.length >= 3 ? `${names[0]} et al.` : names.join(', ')
}

// What identifies the reference, in the shortest form a reader knows: an arXiv id, a DOI, else where it lives.
function identifier(source: { url?: string; doi?: string }): string {
  const address = normalizeUrl(source.url ?? '')
  const url = address === '' ? null : new URL(address)
  if (url && ARXIV_HOST.test(url.hostname)) {
    const id = ARXIV_PATH.exec(url.pathname)?.[1]
    if (id) return `arXiv:${id}`
  }
  const doi = normalizeDoi(source.doi ?? '') || normalizeDoi(source.url ?? '')
  if (doi !== '') return `doi:${doi}`
  return url ? url.hostname.replace(/^www\./, '') : ''
}

/** The line under a suggested Source's title: "Wang et al. · 2021 · arXiv:2007.14384"; parts that are missing are left out. */
export function sourceMeta(source: NonNullable<Suggestion['source']>): string {
  return [shortAuthors(source.authors ?? ''), (source.year ?? '').trim(), identifier(source)].filter((part) => part !== '').join(' · ')
}

// Pending first, newest first; then the decided ones, the latest decision first.
function inOrder(a: Suggestion, b: Suggestion): number {
  const pa = a.state === 'pending'
  const pb = b.state === 'pending'
  if (pa !== pb) return pa ? -1 : 1
  const ta = pa ? a.created_at : (a.decided_at ?? a.created_at)
  const tb = pb ? b.created_at : (b.decided_at ?? b.created_at)
  return tb - ta || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function resolve(s: Suggestion, world: SuggestionWorld, live: Map<string, CardVM>): SuggestionVM {
  const titleOf = (id: string) => {
    const card = live.get(id)
    if (!card) return 'Removed Card'
    return card.title.trim() === '' ? 'Untitled' : card.title
  }
  if (s.kind === 'connection') {
    const c = s.connection ?? { from: '', to: '', kind: 'related' as const }
    const needed = [c.from, c.to]
    return {
      suggestion: s,
      title: `${titleOf(c.from)} ${c.kind === 'directed' ? '→' : '—'} ${titleOf(c.to)}`,
      meta: (c.label ?? '').trim() || c.kind,
      target: `Board: ${world.branchName}`,
      cards: [...new Set(needed)].filter((id) => live.has(id)),
      stale: needed.some((id) => !live.has(id)),
    }
  }
  const source = s.source ?? {}
  const card = s.card ?? ''
  const vm: SuggestionVM = {
    suggestion: s,
    title: (source.title ?? '').trim() || 'Untitled Source',
    meta: sourceMeta(source),
    target: `for Card: ${titleOf(card)}`,
    cards: live.has(card) ? [card] : [],
    stale: !live.has(card),
  }
  // Once accepted, the Source on the Branch is the one the Suggestion became: there is nothing left to attach.
  const existing = s.state === 'accepted' ? undefined : findSourceIn(world.sources, source)
  if (existing) vm.existingSource = existing.id
  return vm
}

function sameVM(a: SuggestionVM, b: SuggestionVM): boolean {
  return (
    a.title === b.title &&
    a.meta === b.meta &&
    a.target === b.target &&
    a.stale === b.stale &&
    a.existingSource === b.existingSource &&
    sameItems(a.cards, b.cards) &&
    (a.suggestion === b.suggestion || JSON.stringify(a.suggestion) === JSON.stringify(b.suggestion))
  )
}

/**
 * `list` ready to show, in the order the UI lists it. `prev` is what was built before: an item that reads the same
 * is the same object again, and so is the whole array when nothing in it changed.
 */
export function toSuggestionVMs(list: readonly Suggestion[], world: SuggestionWorld, prev: SuggestionVM[] = NO_ITEMS): SuggestionVM[] {
  const live = new Map(world.cards.map((c) => [c.id, c]))
  const old = new Map(prev.map((vm) => [vm.suggestion.id, vm]))
  const next = [...list].sort(inOrder).map((s) => {
    const vm = resolve(s, world, live)
    const before = old.get(s.id)
    return before && sameVM(before, vm) ? before : vm
  })
  return sameItems(prev, next) ? prev : next
}

/**
 * The ops that make a Suggestion Research Content: a new Source and its Attachment, or only the Attachment when the
 * Branch already has that Source, or the Connection. `sourceId` / `cardId` say what the UI can show afterwards.
 */
export function acceptOps(vm: SuggestionVM): { ops: Op[]; sourceId?: string; cardId?: string } {
  const s = vm.suggestion
  if (s.kind === 'connection') {
    const c = s.connection
    if (!c) throw new ApiError(400, 'bad_request', 'The Suggestion has no Connection.')
    return { ops: [ops.createConnection({ from: c.from, to: c.to, kind: c.kind, label: c.label?.trim() })], cardId: c.from }
  }
  const card = s.card
  if (!card || !s.source) throw new ApiError(400, 'bad_request', 'The Suggestion has no Source.')
  if (vm.existingSource !== undefined) {
    return { ops: [ops.attach({ card, source: vm.existingSource })], sourceId: vm.existingSource, cardId: card }
  }
  const { url, doi, title, authors, year } = s.source
  const sourceId = newId()
  return { ops: [ops.createSource({ id: sourceId, url, doi, title, authors, year }), ops.attach({ card, source: sourceId })], sourceId, cardId: card }
}

type Edit = (list: Suggestion[]) => Suggestion[]
type Answer = { suggestion: Suggestion }

function self(): Member | null {
  const s = sessionStore.getState()
  return s.status === 'signed_in' ? s.member : null
}

function member(action: string): Member {
  const me = self()
  if (!me || me.role === 'guest') throw new ApiError(403, 'forbidden', `Guests cannot ${action} Suggestions.`)
  return me
}

const change = (id: string, to: (s: Suggestion) => Suggestion): Edit => (list) => list.map((s) => (s.id === id ? to(s) : s))
const path = (id: string, what: string) => `/api/suggestions/${encodeURIComponent(id)}/${what}`

export function createSuggestions(boardSync: BoardSync) {
  const store = createStore<{ items: SuggestionVM[] }>(() => ({ items: NO_ITEMS }))

  let confirmed: Suggestion[] = NO_SUGGESTIONS
  let pending: Edit[] = []
  // What the items on show were built from: nothing is rebuilt while all of it is the same.
  let shown: { list: Suggestion[]; cards: unknown; sources: unknown; branchName: string } | null = null

  function publish() {
    const { snapshot, pages } = boardSync.store.getState()
    const world: SuggestionWorld = { cards: snapshot.cards, sources: pages.sources, branchName: snapshot.branch?.name ?? '' }
    const list = pending.reduce((l, edit) => edit(l), confirmed)
    if (shown && shown.list === list && shown.cards === world.cards && shown.sources === world.sources && shown.branchName === world.branchName) return
    shown = { list, ...world }
    const prev = store.getState().items
    const next = list.length === 0 ? NO_ITEMS : toSuggestionVMs(list, world, prev)
    if (next !== prev) store.setState({ items: next })
  }

  function forget() {
    confirmed = NO_SUGGESTIONS
    pending = []
    publish()
  }

  function setList(list: Suggestion[]) {
    confirmed = [...list]
    publish()
  }

  function upsert(s: Suggestion) {
    confirmed = confirmed.some((x) => x.id === s.id) ? confirmed.map((x) => (x.id === s.id ? s : x)) : [...confirmed, s]
  }

  function open(): { id: string; token: number } {
    const at = boardSync.internal.target()
    if (!at) throw new ApiError(400, 'board_not_open', 'The Board is not open.')
    return at
  }

  function visible(id: string): SuggestionVM {
    const vm = store.getState().items.find((x) => x.suggestion.id === id)
    if (!vm) throw new ApiError(404, 'not_found', 'There is no such Suggestion.')
    return vm
  }

  function decided(): ApiError {
    return new ApiError(409, 'already_decided', 'This Suggestion was already decided.')
  }

  async function reload(): Promise<void> {
    const me = member('read')
    const at = open()
    const { suggestions: list } = await request<{ suggestions: Suggestion[] }>('GET', `/api/suggestions?branch=${encodeURIComponent(at.id)}`)
    if (boardSync.internal.target()?.token === at.token && self()?.id === me.id) setList(list)
  }

  // Shows `edit` at once, sends the request, then takes the server's answer; a failure takes the edit back.
  async function decide<T extends Answer>(edit: Edit, send: () => Promise<T>, settle?: (answer: T) => void): Promise<void> {
    pending.push(edit)
    publish()
    try {
      const answer = await send()
      // A Branch switch, a close or a new session in between already forgot the list.
      if (pending.includes(edit)) {
        upsert(answer.suggestion)
        settle?.(answer)
      }
    } catch (e) {
      // Someone else decided it first: the list here is behind, fetch what is true now.
      if (e instanceof ApiError && e.code === 'already_decided' && pending.includes(edit)) void reload().catch(() => {})
      throw e
    } finally {
      pending = pending.filter((x) => x !== edit)
      publish()
    }
  }

  const api = {
    reload,
    async accept(id: string): Promise<{ sourceId?: string; cardId?: string }> {
      const me = member('accept')
      const at = open()
      const vm = visible(id)
      if (vm.suggestion.state !== 'pending') throw decided()
      if (vm.stale) throw new ApiError(400, 'stale', 'A Card this Suggestion needs is no longer on this Branch.')
      const { ops: toSend, ...made } = acceptOps(vm)
      const now = Date.now()
      await decide(
        change(id, (s) => ({ ...s, state: 'accepted', decided_by: me.id, decided_at: now })),
        () => request<Answer & { seq: number; changes: Change[] }>('POST', path(id, 'accept'), { ops: toSend }),
        // The Changes are ordinary edits: the Board takes them from here or from the socket, whichever comes first.
        // Accepting is one step of Undo (decision 4): taking it back removes what it added.
        (answer) => {
          boardSync.internal.confirm(at.token, answer.seq, answer.changes)
          undoFor(boardSync).internal.record(at.token, toSend, answer.changes, answer.seq)
        },
      )
      return made
    },
    async reject(id: string): Promise<void> {
      const me = member('reject')
      open()
      if (visible(id).suggestion.state !== 'pending') throw decided()
      const now = Date.now()
      await decide(
        change(id, (s) => ({ ...s, state: 'rejected', decided_by: me.id, decided_at: now })),
        () => request<Answer>('POST', path(id, 'reject')),
      )
    },
    async reopen(id: string): Promise<void> {
      member('reopen')
      open()
      if (visible(id).suggestion.state !== 'rejected') throw decided()
      await decide(
        change(id, ({ decided_by: _by, decided_at: _at, ...rest }) => ({ ...rest, state: 'pending' })),
        () => request<Answer>('POST', path(id, 'reopen')),
      )
    },
  }

  const isMember = () => {
    const me = self()
    return me !== null && me.role !== 'guest'
  }

  const stop = [
    // Titles, `stale` and `existingSource` follow the Board.
    boardSync.store.subscribe(publish),
    boardSync.internal.watch((e) => {
      if (e.type === 'closed') forget()
      else if (!isMember()) return
      else if (e.type === 'suggestions') setList(e.suggestions)
      else void reload().catch(() => {}) // opened, or back after a drop: frames sent meanwhile are not repeated
    }),
    // Forget the list when the session ends, becomes a Guest's, or changes hands.
    (() => {
      let owner = isMember() ? self()!.id : null
      return sessionStore.subscribe((s) => {
        const now = s.status === 'signed_in' && s.member.role !== 'guest' ? s.member.id : s.status === 'loading' ? owner : null
        if (now !== owner) {
          owner = now
          forget()
        }
      })
    })(),
  ]

  return {
    ...api,
    /** For tests; not part of the UI surface. */
    internal: { store, reset: forget, dispose: () => stop.forEach((off) => off()) },
  }
}

const own = createSuggestions(sync)

export const suggestions = { reload: own.reload, accept: own.accept, reject: own.reject, reopen: own.reopen }

export function useSuggestions(): SuggestionVM[] {
  return useStore(own.internal.store, (s) => s.items)
}
