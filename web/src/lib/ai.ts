// The AI sidebar's data layer: which AI answers, the Member's private Conversations (kept on this device), running
// a turn through a provider, and Pin — the only way AI text becomes Research Content.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { claudeProvider, openRouterProvider } from './ai-providers'
import type { AiProvider, AiTurn, ChatMessage } from './ai-providers'
import { CUT_OFF, loadAi, saveAi, withinLimits } from './ai-storage'
import type { StorageLike, StoredConversation } from './ai-storage'
import { sync } from './board-sync'
import type { BoardSync } from './board-sync'
import { ApiError, request } from './http'
import { newId, ops } from './ops'
import { orderBetween } from './order'
import { sessionStore } from './session-store'
import type { AiConversation, AiEvent, AiOpenRouter, AiMessage, AiModel, AiScope, AiSetup, AiSnapshot, Member, QoopDesktop, SessionSnapshot } from './types'

export const MAX_PROMPT = 20_000
const MAX_TITLE = 60
const MAX_ERROR = 500
const SAVE_DELAY_MS = 400
const NO_ANSWER = 'The AI could not answer.'

type AiStatus = AiOpenRouter
type Summary = AiSnapshot['conversations'][number]

export type AiOptions = {
  /** The desktop bridge, when inside the desktop app. Default: `window.qoopDesktop`. */
  desktop?: () => QoopDesktop | undefined
  /** Where Conversations are kept. Default: `localStorage`. */
  storage?: () => StorageLike | undefined
  /** The provider for a setup; default: the desktop bridge for `claude-code`, the server for `openrouter`. */
  provider?: (setup: AiSetup) => AiProvider | null
  /** The Board that `pin` writes to. */
  board?: Pick<BoardSync, 'submit' | 'page' | 'internal'>
  /** Runs `fn` before the next paint (streaming text is published once per frame). */
  requestFrame?: (fn: () => void) => unknown
  cancelFrame?: (handle: unknown) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

// One answer on its way. `settled`: its message has its final status; the provider may still be winding down.
type Run = {
  conversation: string
  message: string
  text: string
  tools: string[]
  frame: unknown
  hasFrame: boolean
  settled: boolean
  control: AbortController
  release: () => void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function defaultDesktop(): QoopDesktop | undefined {
  const d = (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  return isRecord(d) && isRecord(d.claude) && typeof d.claude.status === 'function' && typeof d.claude.send === 'function'
    ? (d as QoopDesktop)
    : undefined
}

function defaultStorage(): StorageLike | undefined {
  return globalThis.localStorage
}

function defaultRequestFrame(fn: () => void): unknown {
  return typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 16)
}

function defaultCancelFrame(handle: unknown): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle as number)
  else globalThis.clearTimeout(handle as number)
}

function readStatus(json: unknown): AiStatus {
  if (!isRecord(json) || json.enabled !== true) return { enabled: false }
  const status: AiStatus = { enabled: true }
  const key = json.key
  if (isRecord(key) && typeof key.last4 === 'string' && typeof key.added_at === 'number') status.key = { last4: key.last4, added_at: key.added_at }
  if (typeof json.model === 'string' && json.model !== '') status.model = json.model
  return status
}

/** Which AI the sidebar uses, from what was detected. Claude Code in the desktop app always wins. */
export function chooseSetup(
  session: SessionSnapshot,
  found: { desktop: boolean; claude: { installed: boolean; version?: string } | null; status: AiStatus | null },
): AiSetup {
  const { desktop } = found
  const openrouter = found.status ?? { enabled: false }
  const none = (reason: Extract<AiSetup, { provider: 'none' }>['reason']): AiSetup => ({ provider: 'none', reason, desktop, openrouter })
  if (session.status !== 'signed_in') return { provider: 'none', reason: 'loading', desktop, openrouter: { enabled: false } }
  if (session.member.role === 'guest') return { provider: 'none', reason: 'guest', desktop, openrouter: { enabled: false } }
  // Both answers are waited for: the bridge's (inside the app) and the server's.
  if ((desktop && found.claude === null) || found.status === null) return none('loading')
  if (desktop && found.claude?.installed) {
    const setup: AiSetup = { provider: 'claude-code', label: 'Claude Code', desktop, openrouter }
    if (found.claude.version) setup.version = found.claude.version
    return setup
  }
  if (openrouter.enabled && openrouter.key && openrouter.model) {
    return { provider: 'openrouter', label: `OpenRouter · ${openrouter.model}`, model: openrouter.model, desktop, openrouter }
  }
  return none(desktop ? 'desktop_no_claude' : !openrouter.enabled ? 'server_off' : !openrouter.key ? 'browser_no_key' : 'no_model')
}

// A Conversation is named after its first question: one line, at most 60 characters.
function titleOf(text: string): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, MAX_TITLE).join('').trimEnd()
}

// What a later turn is told of the Conversation: questions, and the answers that arrived whole.
function goodMessages(messages: readonly AiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text })
    else if (m.status === 'done' && m.text.trim() !== '') out.push({ role: 'assistant', content: m.text })
  }
  return out
}

// Why a turn failed, as a sentence for the Member. Only an ApiError's own words are passed on.
function sentence(e: unknown): string {
  if (!(e instanceof ApiError)) return NO_ANSWER
  if (e.code === 'no_key') return 'Add an OpenRouter key in the AI settings first.'
  if (e.code === 'no_model') return 'Choose a model in the AI settings first.'
  if (e.code === 'ai_not_configured') return 'The AI is not set up on this server.'
  if (e.code === 'too_many_requests') return 'Too many questions in a minute. Wait a moment and try again.'
  return e.message.trim() === '' ? NO_ANSWER : e.message.slice(0, MAX_ERROR)
}

const LOADING: AiSetup = { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }
const NO_SUMMARIES: Summary[] = []

export function createAi(options: AiOptions = {}) {
  const desktop = options.desktop ?? defaultDesktop
  // Reaching for storage can itself throw (a browser that blocks it): that reads as no storage.
  const storage = (): StorageLike | undefined => {
    try {
      return (options.storage ?? defaultStorage)()
    } catch {
      return undefined
    }
  }
  const board = options.board ?? sync
  const requestFrame = options.requestFrame ?? defaultRequestFrame
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame
  const setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => globalThis.clearTimeout(h as number))
  const now = options.now ?? Date.now
  const providerFor =
    options.provider ??
    ((setup: AiSetup): AiProvider | null => {
      if (setup.provider === 'openrouter') return openRouterProvider()
      const bridge = setup.provider === 'claude-code' ? desktop() : undefined
      return bridge ? claudeProvider(bridge) : null
    })

  const store = createStore<AiSnapshot>(() => ({ setup: LOADING, conversations: NO_SUMMARIES, current: null, busy: false }))

  // ---- what is held ----
  let owner: string | null = null // the Member whose Conversations these are; null for a Guest or nobody
  let ownerKey: string | null | undefined // id and role of the session this state belongs to
  let list: AiConversation[] = [] // Conversations with at least one message
  let draft: AiConversation | null = null // an empty current Conversation: not listed, not stored
  let currentId: string | null = null
  const sessions = new Map<string, string>() // Conversation id → the Claude Code session of its last `done`
  let run: Run | null = null
  let setup: AiSetup = LOADING
  let found: { claude: { installed: boolean; version?: string } | null; status: AiStatus | null } = { claude: null, status: null }
  let detecting = 0
  let undetected = true // nothing was asked yet for this session
  let watchers = 0 // subscriptions to the store (mounted `useAi()` hooks)
  let saveTimer: unknown = null
  let saving = false

  function self(): Member | null {
    const s = sessionStore.getState()
    return s.status === 'signed_in' ? s.member : null
  }

  function member(action: string): Member {
    const me = self()
    if (!me || me.role === 'guest') throw new ApiError(403, 'forbidden', `Guests cannot ${action}.`)
    return me
  }

  const find = (id: string | null): AiConversation | undefined => (id === null ? undefined : draft?.id === id ? draft : list.find((c) => c.id === id))

  // ---- publishing ----

  function publish() {
    const prev = store.getState()
    const old = new Map(prev.conversations.map((s) => [s.id, s]))
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    let conversations: Summary[] = sorted.map((c) => {
      const before = old.get(c.id)
      return before && before.title === c.title && before.updatedAt === c.updatedAt ? before : { id: c.id, title: c.title, updatedAt: c.updatedAt }
    })
    if (conversations.length === prev.conversations.length && conversations.every((s, i) => s === prev.conversations[i])) {
      conversations = prev.conversations
    }
    const current = find(currentId) ?? null
    const busy = run !== null
    if (prev.setup !== setup || prev.conversations !== conversations || prev.current !== current || prev.busy !== busy) {
      store.setState({ setup, conversations, current, busy }, true)
    }
  }

  function setSetup(next: AiSetup) {
    if (JSON.stringify(next) !== JSON.stringify(setup)) setup = next
  }

  function replaceConversation(id: string, to: (c: AiConversation) => AiConversation) {
    if (draft?.id === id) draft = to(draft)
    else list = list.map((c) => (c.id === id ? to(c) : c))
  }

  function replaceMessage(conversation: string, message: string, to: (m: AiMessage) => AiMessage, touch?: number) {
    replaceConversation(conversation, (c) => {
      const messages = c.messages.map((m) => (m.id === message ? to(m) : m))
      return touch === undefined ? { ...c, messages } : { ...c, messages, updatedAt: touch }
    })
  }

  // ---- storage ----

  function write() {
    saving = false
    if (saveTimer !== null) clearTimer(saveTimer)
    saveTimer = null
    if (owner === null) return
    const conversations: StoredConversation[] = list.map((c) => {
      const session = sessions.get(c.id)
      return session === undefined ? c : { ...c, session }
    })
    saveAi(storage(), owner, { conversations, current: currentId })
  }

  // Called when a message completes or the list changes — never for a delta. The write waits a moment for more.
  function save() {
    if (owner === null) return
    if (saveTimer !== null) clearTimer(saveTimer)
    saving = true
    saveTimer = setTimer(write, SAVE_DELAY_MS)
  }

  function flush() {
    if (saving) write()
  }

  function enforceLimits() {
    const kept = withinLimits(list, [currentId, run?.conversation ?? null])
    if (kept === list) return
    list = kept
    for (const id of [...sessions.keys()]) if (!list.some((c) => c.id === id)) sessions.delete(id)
  }

  // ---- a turn ----

  function showProgress(r: Run) {
    r.hasFrame = false
    if (r.settled) return
    const tools = [...r.tools]
    replaceMessage(r.conversation, r.message, (m) => (tools.length > 0 ? { ...m, text: r.text, tools } : { ...m, text: r.text }))
    publish()
  }

  function settle(r: Run, status: 'done' | 'error' | 'stopped', extra: { error?: string; model?: string; session?: string } = {}) {
    if (r.settled) return
    r.settled = true
    if (r.hasFrame) cancelFrame(r.frame)
    r.hasFrame = false
    replaceMessage(
      r.conversation,
      r.message,
      (m) => {
        const next: AiMessage = { ...m, text: r.text, status }
        if (r.tools.length > 0) next.tools = [...r.tools]
        if (extra.error !== undefined) next.error = extra.error
        if (extra.model !== undefined) next.model = extra.model
        return next
      },
      now(),
    )
    if (extra.session) sessions.set(r.conversation, extra.session)
    enforceLimits()
    publish()
    save()
  }

  function release(r: Run) {
    if (run !== r) return
    run = null
    publish()
  }

  function stop() {
    const r = run
    if (!r) return
    settle(r, 'stopped')
    r.control.abort()
    r.release()
    release(r)
  }

  async function execute(r: Run, turn: AiTurn, provider: AiProvider, fallbackModel: string | undefined): Promise<void> {
    const onEvent = (event: AiEvent) => {
      if (r.settled) return
      if (event.type === 'done') {
        settle(r, 'done', { model: event.model ?? fallbackModel, session: event.session })
      } else if (event.type === 'error') {
        const message = event.message.trim()
        settle(r, 'error', { error: message === '' ? NO_ANSWER : message.slice(0, MAX_ERROR) })
      } else {
        if (event.type === 'delta') r.text += event.text
        else r.tools.push(event.name)
        if (!r.hasFrame) {
          r.hasFrame = true
          r.frame = requestFrame(() => showProgress(r))
        }
      }
    }
    const released = new Promise<void>((resolve) => {
      r.release = resolve
    })
    const work = (async () => {
      try {
        await provider.send(turn, onEvent, r.control.signal)
        settle(r, 'error', { error: CUT_OFF })
      } catch (e) {
        settle(r, 'error', { error: sentence(e) })
        // The setup this turn relied on is not what the server has: look again.
        if (e instanceof ApiError && ['no_key', 'no_model', 'ai_not_configured'].includes(e.code)) void refresh()
      }
    })()
    // Busy until the provider has wound down (one run at a time), or until stop() lets go.
    await Promise.race([work, released])
    release(r)
  }

  // Checks that a turn can start; the provider and what to call the model when `done` does not say.
  function ready(): { provider: AiProvider; fallbackModel: string | undefined } {
    const provider = setup.provider === 'none' || owner === null ? null : providerFor(setup)
    if (!provider) throw new ApiError(409, 'no_ai', 'No AI is set up.')
    if (run) throw new ApiError(409, 'busy', 'An answer is still being written.')
    return { provider, fallbackModel: setup.provider === 'openrouter' ? setup.model : undefined }
  }

  function begin(conversation: string, message: string): Run {
    const r: Run = {
      conversation,
      message,
      text: '',
      tools: [],
      frame: null,
      hasFrame: false,
      settled: false,
      control: new AbortController(),
      release: () => {},
    }
    run = r
    return r
  }

  async function send(text: string, scope: AiScope): Promise<void> {
    const { provider, fallbackModel } = ready()
    const prompt = text.trim()
    if (prompt === '' || prompt.length > MAX_PROMPT) {
      throw new ApiError(400, 'bad_request', `A message needs 1 to ${MAX_PROMPT} characters.`)
    }
    const at = now()
    let conversation = find(currentId)
    if (!conversation) {
      conversation = { id: newId(), title: '', createdAt: at, updatedAt: at, messages: [] }
      currentId = conversation.id
    }
    const question: AiMessage = { id: newId(), role: 'user', text: prompt, at, status: 'done', scope: { ...scope } }
    if (scope.card) question.scope!.card = { id: scope.card.id, title: scope.card.title }
    const answer: AiMessage = { id: newId(), role: 'assistant', text: '', at, status: 'streaming' }
    const turn: AiTurn = {
      id: newId(),
      prompt,
      scope: question.scope!,
      messages: [...goodMessages(conversation.messages), { role: 'user', content: prompt }],
    }
    const resume = sessions.get(conversation.id)
    if (resume) turn.resume = resume
    const next: AiConversation = {
      ...conversation,
      title: conversation.title === '' ? titleOf(prompt) : conversation.title,
      updatedAt: at,
      messages: [...conversation.messages, question, answer],
    }
    if (draft?.id === next.id) draft = null
    list = [...list.filter((c) => c.id !== next.id), next]
    const r = begin(next.id, answer.id)
    enforceLimits()
    publish()
    save()
    await execute(r, turn, provider, fallbackModel)
  }

  // "Try again": asks the question behind a failed or stopped answer once more; the new answer takes its place.
  async function retry(messageId: string): Promise<void> {
    const { provider, fallbackModel } = ready()
    const conversation = find(currentId)
    const at = conversation ? conversation.messages.findIndex((m) => m.id === messageId) : -1
    const failed = conversation?.messages[at]
    if (!conversation || !failed) throw new ApiError(404, 'not_found', 'There is no such message in this Conversation.')
    let asked = at - 1
    while (asked >= 0 && conversation.messages[asked]!.role !== 'user') asked--
    const question = conversation.messages[asked]
    if (failed.role !== 'assistant' || (failed.status !== 'error' && failed.status !== 'stopped') || !question?.scope) {
      throw new ApiError(400, 'bad_request', 'Only an answer that failed or was stopped can be tried again.')
    }
    const answer: AiMessage = { id: newId(), role: 'assistant', text: '', at: now(), status: 'streaming' }
    const turn: AiTurn = {
      id: newId(),
      prompt: question.text,
      scope: question.scope,
      messages: [...goodMessages(conversation.messages.slice(0, asked)), { role: 'user', content: question.text }],
    }
    const resume = sessions.get(conversation.id)
    if (resume) turn.resume = resume
    replaceConversation(conversation.id, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === messageId ? answer : m)) }))
    const r = begin(conversation.id, answer.id)
    publish()
    await execute(r, turn, provider, fallbackModel)
  }

  // ---- Conversations ----

  function newConversation() {
    if (owner === null || draft?.id === currentId) return
    const at = now()
    draft = { id: newId(), title: '', createdAt: at, updatedAt: at, messages: [] }
    currentId = draft.id
    publish()
    save()
  }

  function open(id: string) {
    if (id === currentId || !list.some((c) => c.id === id)) return
    draft = null
    currentId = id
    publish()
    save()
  }

  function remove(id: string) {
    if (!find(id)) return
    if (run?.conversation === id) stop()
    if (draft?.id === id) draft = null
    list = list.filter((c) => c.id !== id)
    sessions.delete(id)
    if (currentId === id) currentId = null
    publish()
    save()
  }

  // ---- Pin ----

  async function pin(messageId: string, card: { id: string; title: string }): Promise<{ block: string }> {
    const me = member('pin an AI answer')
    const all = [find(currentId), ...list]
    const home = all.find((c) => c?.messages.some((m) => m.id === messageId))
    const message = home?.messages.find((m) => m.id === messageId)
    if (!home || !message) throw new ApiError(404, 'not_found', 'There is no such message.')
    if (message.role !== 'assistant' || message.status === 'streaming' || message.text.trim() === '') {
      throw new ApiError(400, 'bad_request', 'Only a finished AI answer can be pinned.')
    }
    if (!board.internal.target()) throw new ApiError(400, 'board_not_open', 'The Board is not open.')
    const page = board.page(card.id)
    if (!page.card) throw new ApiError(400, 'stale', 'That Card is not on this Branch any more.')
    const block = newId()
    const op = ops.pinBlock({
      id: block,
      card: card.id,
      text: message.text,
      order: orderBetween(page.blocks.at(-1)?.order),
      model: message.model ?? (setup.provider === 'none' ? 'AI' : setup.label),
      pinnedBy: me.id,
      pinnedAt: now(),
    })
    await board.submit([op])
    // The Member may have signed out, or removed the Conversation, while the Block was on its way.
    if (owner === me.id && find(home.id)) {
      const where = { card: card.id, cardTitle: card.title, block }
      replaceMessage(home.id, messageId, (m) => ({ ...m, pinned: [...(m.pinned ?? []), where] }))
      publish()
      save()
    }
    return { block }
  }

  // ---- which AI ----

  function applySetup() {
    setSetup(chooseSetup(sessionStore.getState(), { desktop: desktop() !== undefined, ...found }))
    publish()
  }

  // Never throws: whatever cannot be asked reads as "not there".
  async function refresh(): Promise<void> {
    const mine = ++detecting
    undetected = false
    const me = self()
    if (!me || me.role === 'guest') {
      applySetup()
      return
    }
    const bridge = desktop()
    let claude: { installed: boolean; version?: string } | null = null
    if (bridge) {
      try {
        const answer: unknown = await bridge.claude.status()
        claude = { installed: isRecord(answer) && answer.installed === true }
        if (claude.installed && isRecord(answer) && typeof answer.version === 'string') claude.version = answer.version
      } catch {
        claude = { installed: false }
      }
      if (mine !== detecting) return
    }
    // Asked in the desktop app too: the settings screen shows a stored key whichever AI answers.
    let status: AiStatus
    try {
      status = readStatus(await request<unknown>('GET', '/api/ai/status'))
    } catch {
      status = { enabled: false }
    }
    if (mine !== detecting) return
    found = { claude, status }
    applySetup()
  }

  // An OpenRouter setting changed: the server answers with the new status, so nothing is asked again.
  async function setting(method: string, path: string, body?: unknown): Promise<void> {
    const me = member('change the AI settings')
    const status = readStatus(await request<unknown>(method, path, body))
    if (self()?.id !== me.id) return
    detecting++ // a detection on its way would bring older news
    found = { ...found, status }
    applySetup()
  }

  async function setKey(key: string): Promise<void> {
    member('change the AI settings')
    const trimmed = key.trim()
    if (!/^[\x21-\x7e]{20,400}$/.test(trimmed)) {
      throw new ApiError(400, 'bad_request', 'That does not look like an OpenRouter key.')
    }
    // Passed straight on: the key is not kept here, in memory or anywhere else.
    await setting('PUT', '/api/ai/key', { key: trimmed })
  }

  async function setModel(model: string): Promise<void> {
    member('change the AI settings')
    const trimmed = model.trim()
    if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(trimmed)) throw new ApiError(400, 'bad_request', 'That is not a model id.')
    await setting('PUT', '/api/ai/model', { model: trimmed })
  }

  async function models(): Promise<AiModel[]> {
    member('use the AI')
    const { models: found } = await request<{ models?: unknown }>('GET', '/api/ai/models')
    const out: AiModel[] = []
    for (const m of Array.isArray(found) ? found : []) {
      if (!isRecord(m) || typeof m.id !== 'string') continue
      const model: AiModel = { id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id }
      if (typeof m.context_length === 'number') model.context_length = m.context_length
      out.push(model)
    }
    return out
  }

  // ---- whose Conversations ----

  // Each Member has their own, on this device. When the session changes hands the previous Member's are written
  // and put away, an answer on its way is stopped, and the next Member's are read.
  function onSession(s: SessionSnapshot) {
    if (s.status === 'loading' && ownerKey !== undefined) return
    const key = s.status === 'signed_in' ? `${s.member.role === 'guest' ? 'guest' : 'member'}:${s.member.id}` : null
    if (key === ownerKey) return
    stop()
    flush()
    ownerKey = key
    owner = s.status === 'signed_in' && s.member.role !== 'guest' ? s.member.id : null
    sessions.clear()
    draft = null
    list = []
    currentId = null
    if (owner !== null) {
      const stored = loadAi(storage(), owner)
      list = stored.conversations.map(({ session, ...conversation }) => {
        if (session !== undefined) sessions.set(conversation.id, session)
        return conversation
      })
      currentId = stored.current
    }
    detecting++
    undetected = true
    found = { claude: null, status: null }
    applySetup()
    detect()
  }

  // Detection waits until someone looks: the first `useAi()` (or a call to `refresh`) starts it, so that signing in
  // costs no request on screens without the sidebar.
  function detect() {
    if (undetected && watchers > 0 && self()) void refresh()
  }

  const subscribe = store.subscribe
  store.subscribe = (listener) => {
    const off = subscribe(listener)
    watchers++
    detect()
    let on = true
    return () => {
      if (on) watchers--
      on = false
      off()
    }
  }

  onSession(sessionStore.getState())
  const unsubscribe = sessionStore.subscribe(onSession)
  // A reload or a closed window must not lose the last message to the wait before a write.
  const canListen = typeof globalThis.addEventListener === 'function'
  if (canListen) globalThis.addEventListener('pagehide', flush)

  function dispose() {
    unsubscribe()
    if (canListen) globalThis.removeEventListener('pagehide', flush)
    stop()
    flush()
  }

  return {
    store,
    api: {
      refresh,
      newConversation,
      open,
      remove,
      send,
      retry,
      stop,
      pin,
      setKey,
      removeKey: () => setting('DELETE', '/api/ai/key'),
      setModel,
      models,
    },
    flush,
    dispose,
  }
}

export const aiSync = createAi()

export const ai = aiSync.api

export function useAi(): AiSnapshot {
  return useStore(aiSync.store)
}
