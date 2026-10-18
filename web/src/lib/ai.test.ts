import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAi } from './ai'
import type { AiOptions } from './ai'
import { forgetDesktopToken } from './ai-providers'
import type { AiProvider, AiTurn } from './ai-providers'
import { storageKey } from './ai-storage'
import { createBoardSync } from './board-sync'
import { ApiError } from './http'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, fakeDesktop, settle } from './testing'
import type { AiEvent, AiMessage, AiScope, AiSetup } from './types'

const SCOPE: AiScope = { branch: 'main-id', branchName: 'main', card: { id: 'a', title: 'Threshold' } }
const KEY = 'sk-or-v1-0123456789abcdefghij'

let server: FakeServer
let timers: FakeTimers
let made: ReturnType<typeof createAi>[] = []
let clock = 1000

/** A storage that tests can look into and break. */
function memoryStorage() {
  const data = new Map<string, string>()
  const s = {
    data,
    sets: 0,
    failSet: false,
    failGet: false,
    getItem(key: string): string | null {
      if (s.failGet) throw new Error('blocked')
      return data.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      if (s.failSet) throw new DOMException('full', 'QuotaExceededError')
      s.sets++
      data.set(key, value)
    },
  }
  return s
}

/** Animation frames run by hand. */
function manualFrames() {
  let pending: { id: number; fn: () => void }[] = []
  let next = 1
  return {
    requested: 0,
    request(fn: () => void): unknown {
      this.requested++
      pending.push({ id: next, fn })
      return next++
    },
    cancel(handle: unknown): void {
      pending = pending.filter((f) => f.id !== handle)
    },
    run(): void {
      const due = pending
      pending = []
      for (const f of due) f.fn()
    },
    get waiting() {
      return pending.length
    },
  }
}

type ScriptedRun = { turn: AiTurn; signal: AbortSignal; emit(e: AiEvent): void; end(): void; fail(e: unknown): void }

/** A provider that does what the test tells it, one run per turn. */
function scripted() {
  const runs: ScriptedRun[] = []
  const provider: AiProvider = {
    send: (turn, onEvent, signal) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ turn, signal, emit: onEvent, end: resolve, fail: reject })
      }),
  }
  return { runs, provider, last: () => runs[runs.length - 1]! }
}

let storage: ReturnType<typeof memoryStorage>
let frames: ReturnType<typeof manualFrames>
let fake: ReturnType<typeof scripted>

function make(options: AiOptions = {}) {
  const a = createAi({
    desktop: () => undefined,
    storage: () => storage,
    provider: () => fake.provider,
    requestFrame: (fn) => frames.request(fn),
    cancelFrame: (h) => frames.cancel(h),
    setTimer: timers.set,
    clearTimer: timers.clear,
    now: () => clock,
    ...options,
  })
  made.push(a)
  return a
}

/** An instance with a usable AI (OpenRouter: key and model set), detected. */
async function ready(options: AiOptions = {}) {
  server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
  const a = make(options)
  await a.api.refresh()
  return a
}

const snap = (a: ReturnType<typeof createAi>) => a.store.getState()
const messages = (a: ReturnType<typeof createAi>) => snap(a).current?.messages ?? []
const answer = (a: ReturnType<typeof createAi>): AiMessage => messages(a).at(-1)!
const stored = (member = ME.id) => JSON.parse(storage.data.get(storageKey(member)) ?? 'null')
const aiCalls = () => server.requests.filter((r) => r.path.startsWith('/api/ai/')).map((r) => `${r.method} ${r.path}`)

/** Asks a question and lets the scripted provider answer it whole. */
async function exchange(a: ReturnType<typeof createAi>, question: string, reply: string, done: Partial<Extract<AiEvent, { type: 'done' }>> = {}) {
  const sending = a.api.send(question, SCOPE)
  const run = fake.last()
  run.emit({ type: 'delta', text: reply })
  run.emit({ type: 'done', ...done })
  run.end()
  await sending
}

beforeEach(() => {
  server = new FakeServer()
  server.now = 100
  timers = new FakeTimers()
  storage = memoryStorage()
  frames = manualFrames()
  fake = scripted()
  made = []
  clock = 1000
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  membersStore.setState({ members: [] })
  forgetDesktopToken()
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
})

afterEach(() => {
  for (const a of made) a.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('which AI', () => {
  const setupOf = async (options: AiOptions = {}): Promise<AiSetup> => {
    const a = make(options)
    await a.api.refresh()
    return snap(a).setup
  }
  const withKey = { enabled: true, key: { last4: 'ghij', added_at: 5 }, model: 'openai/gpt-5' }

  it('is loading until the session is known and the setup was looked at', async () => {
    sessionStore.setState({ status: 'loading' }, true)
    const a = make()
    const loading = { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }
    expect(snap(a).setup).toEqual(loading)
    await a.api.refresh()
    expect(snap(a).setup).toEqual(loading)
    sessionStore.setState({ status: 'signed_out' }, true)
    await a.api.refresh()
    expect(snap(a).setup).toEqual(loading)
    expect(server.requests).toEqual([])
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    expect(snap(a).setup).toEqual(loading)
  })
  it('is none for a Guest, in the browser and in the desktop app, without asking anything', async () => {
    server.actor = GUEST
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'guest', desktop: false, openrouter: { enabled: false } })
    const desk = fakeDesktop()
    expect(await setupOf({ desktop: () => desk })).toEqual({ provider: 'none', reason: 'guest', desktop: true, openrouter: { enabled: false } })
    expect(desk.statusCalls).toBe(0)
    expect(server.requests).toEqual([])
  })
  it('desktop app with claude: Claude Code, with its version and the OpenRouter settings beside it', async () => {
    const desk = fakeDesktop({ claudeVersion: '2.1.0' })
    expect(await setupOf({ desktop: () => desk })).toEqual({
      provider: 'claude-code',
      label: 'Claude Code',
      version: '2.1.0',
      desktop: true,
      openrouter: { enabled: true },
    })
    expect(await setupOf({ desktop: () => fakeDesktop() })).toEqual({ provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: { enabled: true } })
  })
  it('desktop app with claude and an OpenRouter key: Claude Code is preferred, the key is still shown', async () => {
    server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    expect(await setupOf({ desktop: () => fakeDesktop() })).toEqual({ provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: withKey })
  })
  it('desktop app with claude while the status cannot be fetched: Claude Code, OpenRouter reads as off', async () => {
    server.aiFail = { status: 500, code: 'internal' }
    expect(await setupOf({ desktop: () => fakeDesktop() })).toEqual({
      provider: 'claude-code',
      label: 'Claude Code',
      desktop: true,
      openrouter: { enabled: false },
    })
  })
  it('desktop app without claude: OpenRouter when a key and a model are set, else none / desktop_no_claude', async () => {
    const desk = fakeDesktop({ installed: false })
    expect(await setupOf({ desktop: () => desk })).toEqual({ provider: 'none', reason: 'desktop_no_claude', desktop: true, openrouter: { enabled: true } })
    server.aiEnabled = false
    expect(await setupOf({ desktop: () => desk })).toEqual({ provider: 'none', reason: 'desktop_no_claude', desktop: true, openrouter: { enabled: false } })
    server.aiEnabled = true
    server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    expect(await setupOf({ desktop: () => desk })).toEqual({
      provider: 'openrouter',
      label: 'OpenRouter · openai/gpt-5',
      model: 'openai/gpt-5',
      desktop: true,
      openrouter: withKey,
    })
  })
  it('a bridge that does not answer reads as claude not installed', async () => {
    const desk = fakeDesktop()
    desk.statusFails = true
    expect(await setupOf({ desktop: () => desk })).toMatchObject({ provider: 'none', reason: 'desktop_no_claude', desktop: true })
  })
  it('browser: OpenRouter with a key and a model', async () => {
    server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    expect(await setupOf()).toEqual({ provider: 'openrouter', label: 'OpenRouter · openai/gpt-5', model: 'openai/gpt-5', desktop: false, openrouter: withKey })
  })
  it('browser: says what is missing — the key, the model, or the server side', async () => {
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'browser_no_key', desktop: false, openrouter: { enabled: true } })
    server.aiSettings[ME.id] = { model: 'openai/gpt-5' }
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'browser_no_key', desktop: false, openrouter: { enabled: true, model: 'openai/gpt-5' } })
    server.aiSettings[ME.id] = { key: KEY, added_at: 5 }
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'no_model', desktop: false, openrouter: { enabled: true, key: { last4: 'ghij', added_at: 5 } } })
    server.aiEnabled = false
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'server_off', desktop: false, openrouter: { enabled: false } })
  })
  it('refresh never throws: a status that cannot be fetched reads as off', async () => {
    server.aiFail = { status: 500, code: 'internal' }
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'server_off', desktop: false, openrouter: { enabled: false } })
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    expect(await setupOf()).toEqual({ provider: 'none', reason: 'server_off', desktop: false, openrouter: { enabled: false } })
  })
  it('never holds or shows the key itself', async () => {
    server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    const a = make()
    await a.api.refresh()
    expect(JSON.stringify(snap(a))).not.toContain(KEY)
  })
  it('asks nothing until someone looks, then detects by itself; a new Member is detected again', async () => {
    server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    const a = make()
    await settle()
    expect(server.requests).toEqual([])
    const off = a.store.subscribe(() => {})
    await settle()
    expect(aiCalls()).toEqual(['GET /api/ai/status'])
    expect(snap(a).setup.provider).toBe('openrouter')
    server.actor = OTHER
    sessionStore.setState({ status: 'signed_in', member: OTHER }, true)
    expect(snap(a).setup).toMatchObject({ provider: 'none', reason: 'loading' })
    await settle()
    expect(aiCalls()).toEqual(['GET /api/ai/status', 'GET /api/ai/status'])
    expect(snap(a).setup).toMatchObject({ provider: 'none', reason: 'browser_no_key' })
    off()
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    await settle()
    expect(aiCalls()).toHaveLength(2)
  })
  it('keeps the setup object when a refresh brings nothing new', async () => {
    const a = await ready()
    const before = snap(a)
    await a.api.refresh()
    expect(snap(a)).toBe(before)
  })
  it('a refresh that was overtaken by a newer one does not win', async () => {
    const a = make()
    const slow = a.api.refresh()
    server.aiSettings[ME.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    await a.api.refresh()
    await slow
    expect(snap(a).setup.provider).toBe('openrouter')
  })
})

describe('OpenRouter settings', () => {
  it('setKey sends the key once and takes the new status from the answer', async () => {
    const a = make()
    await a.api.refresh()
    server.now = 700
    await a.api.setKey(`  ${KEY} `)
    expect(server.requests.at(-1)).toEqual({ method: 'PUT', path: '/api/ai/key', body: { key: KEY } })
    expect(aiCalls()).toEqual(['GET /api/ai/status', 'PUT /api/ai/key'])
    expect(snap(a).setup).toEqual({ provider: 'none', reason: 'no_model', desktop: false, openrouter: { enabled: true, key: { last4: 'ghij', added_at: 700 } } })
    await a.api.setModel(' anthropic/claude-sonnet-4.5 ')
    expect(server.requests.at(-1)).toEqual({ method: 'PUT', path: '/api/ai/model', body: { model: 'anthropic/claude-sonnet-4.5' } })
    expect(snap(a).setup).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', label: 'OpenRouter · anthropic/claude-sonnet-4.5' })
    await a.api.removeKey()
    expect(server.requests.at(-1)).toEqual({ method: 'DELETE', path: '/api/ai/key', body: undefined })
    expect(snap(a).setup).toEqual({
      provider: 'none',
      reason: 'browser_no_key',
      desktop: false,
      openrouter: { enabled: true, model: 'anthropic/claude-sonnet-4.5' },
    })
  })
  it('keeps the OpenRouter settings fresh inside the desktop app with Claude Code', async () => {
    const a = make({ desktop: () => fakeDesktop() })
    await a.api.refresh()
    await a.api.setKey(KEY)
    expect(snap(a).setup).toEqual({ provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: { enabled: true, key: { last4: 'ghij', added_at: 100 } } })
    await a.api.setModel('openai/gpt-5')
    expect(snap(a).setup).toMatchObject({ provider: 'claude-code', openrouter: { model: 'openai/gpt-5' } })
    await a.api.removeKey()
    expect(snap(a).setup).toEqual({ provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: { enabled: true, model: 'openai/gpt-5' } })
  })
  it('does not keep the key: not in the snapshot, not in storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const a = await ready({ storage: undefined })
    await a.api.setKey(KEY)
    await exchange(a, 'Hello', 'Hi.')
    a.flush()
    expect(setItem).toHaveBeenCalled()
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(KEY)
    expect(JSON.stringify(snap(a))).not.toContain(KEY)
    globalThis.localStorage.clear()
  })
  it('refuses a key or a model that cannot be one, without a request', async () => {
    const a = make()
    for (const bad of ['', 'short', 'has a space in the middle of it', 'x'.repeat(401), `${KEY}é`]) {
      await expect(a.api.setKey(bad)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    }
    for (const bad of ['', '  ', 'two words', 'x'.repeat(121), 'a?b']) {
      await expect(a.api.setModel(bad)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    }
    expect(server.requests).toEqual([])
  })
  it('rejects with what the server says and leaves the setup alone', async () => {
    const a = await ready()
    const before = snap(a)
    server.aiEnabled = false
    await expect(a.api.setKey(KEY)).rejects.toMatchObject({ status: 503, code: 'ai_not_configured' })
    await expect(a.api.removeKey()).rejects.toMatchObject({ status: 503 })
    await expect(a.api.setModel('openai/gpt-5')).rejects.toMatchObject({ status: 503 })
    expect(snap(a)).toBe(before)
  })
  it('lists the models', async () => {
    const a = make()
    expect(await a.api.models()).toEqual([
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context_length: 200000 },
      { id: 'openai/gpt-5', name: 'GPT-5' },
    ])
    expect(server.requests.at(-1)).toEqual({ method: 'GET', path: '/api/ai/models', body: undefined })
    server.aiFail = { status: 502, code: 'upstream_failed' }
    await expect(a.api.models()).rejects.toMatchObject({ status: 502, code: 'upstream_failed' })
  })
  it('refuses everything for a Guest and a signed-out session, without a request', async () => {
    const refused = { status: 403, code: 'forbidden' }
    for (const state of [{ status: 'signed_in', member: GUEST }, { status: 'signed_out' }] as const) {
      sessionStore.setState(state, true)
      const a = make()
      await expect(a.api.setKey(KEY)).rejects.toMatchObject(refused)
      await expect(a.api.removeKey()).rejects.toMatchObject(refused)
      await expect(a.api.setModel('openai/gpt-5')).rejects.toMatchObject(refused)
      await expect(a.api.models()).rejects.toMatchObject(refused)
    }
    expect(server.requests).toEqual([])
  })
})

describe('a turn', () => {
  it('appends the question and streams the answer into a new message', async () => {
    const a = await ready()
    expect(snap(a)).toMatchObject({ current: null, conversations: [], busy: false })
    const sending = a.api.send('  What bounds the threshold?  ', SCOPE)
    expect(snap(a).busy).toBe(true)
    const [q, r] = messages(a)
    expect(q).toEqual({ id: q!.id, role: 'user', text: 'What bounds the threshold?', at: 1000, status: 'done', scope: SCOPE })
    expect(r).toEqual({ id: r!.id, role: 'assistant', text: '', at: 1000, status: 'streaming' })
    expect(q!.id).not.toBe(r!.id)
    const run = fake.last()
    run.emit({ type: 'delta', text: 'Roughly ' })
    run.emit({ type: 'tool', name: 'get_card' })
    run.emit({ type: 'delta', text: '**1%**.' })
    clock = 2000
    run.emit({ type: 'done', model: 'openai/gpt-5-2026' })
    expect(answer(a)).toEqual({ id: r!.id, role: 'assistant', text: 'Roughly **1%**.', at: 1000, status: 'done', tools: ['get_card'], model: 'openai/gpt-5-2026' })
    run.end()
    await sending
    expect(snap(a).busy).toBe(false)
    expect(snap(a).current).toMatchObject({ title: 'What bounds the threshold?', createdAt: 1000, updatedAt: 2000 })
    expect(snap(a).conversations).toEqual([{ id: snap(a).current!.id, title: 'What bounds the threshold?', updatedAt: 2000 }])
  })
  it('tells the provider the prompt, the scope and the Conversation so far', async () => {
    const a = await ready()
    await exchange(a, 'First question', 'First answer')
    const sending = a.api.send('Second question', { branch: 'b-id', branchName: 'try-QEC' })
    const { turn } = fake.last()
    expect(turn).toEqual({
      id: turn.id,
      prompt: 'Second question',
      scope: { branch: 'b-id', branchName: 'try-QEC' },
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
      ],
    })
    expect(turn.id).not.toBe(fake.runs[0]!.turn.id)
    fake.last().end()
    await sending
  })
  it('names the model that answered when `done` does not: the OpenRouter model of the setup', async () => {
    const a = await ready()
    await exchange(a, 'Q', 'A')
    expect(answer(a).model).toBe('openai/gpt-5')
    const b = make({ desktop: () => fakeDesktop() })
    await b.api.refresh()
    await exchange(b, 'Q', 'A')
    expect('model' in answer(b)).toBe(false)
  })
  it('resumes with the session of the last `done` of this Conversation', async () => {
    const a = await ready()
    await exchange(a, 'One', 'A1', { session: 'sess-1' })
    expect('resume' in fake.runs[0]!.turn).toBe(false)
    await exchange(a, 'Two', 'A2', { session: 'sess-2' })
    expect(fake.runs[1]!.turn.resume).toBe('sess-1')
    await exchange(a, 'Three', 'A3')
    expect(fake.runs[2]!.turn.resume).toBe('sess-2')
    a.api.newConversation()
    await exchange(a, 'Elsewhere', 'A')
    expect('resume' in fake.runs[3]!.turn).toBe(false)
    expect(JSON.stringify(snap(a))).not.toContain('sess-')
  })
  it('titles a Conversation after its first question: one line, at most 60 characters', async () => {
    const a = await ready()
    await exchange(a, `Why does\n  the surface   code ${'tolerate '.repeat(10)}`, 'A')
    const title = snap(a).current!.title
    expect(title).toBe('Why does the surface code tolerate tolerate tolerate tolerat')
    expect(title).toHaveLength(60)
    expect(title.length).toBeLessThanOrEqual(60)
    await exchange(a, 'Another question', 'A')
    expect(snap(a).current!.title).toBe(title)
  })
  it('refuses to start: no AI, busy, empty, too long', async () => {
    const none = make()
    await none.api.refresh()
    await expect(none.api.send('Hi', SCOPE)).rejects.toMatchObject({ status: 409, code: 'no_ai' })
    const a = await ready()
    await expect(a.api.send('   ', SCOPE)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(a.api.send('x'.repeat(20_001), SCOPE)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    expect(snap(a).current).toBeNull()
    const sending = a.api.send('x'.repeat(20_000), SCOPE)
    const error = await a.api.send('Second', SCOPE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'busy' })
    expect(messages(a)).toHaveLength(2)
    expect(fake.runs).toHaveLength(1)
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await sending
    await exchange(a, 'Second', 'A')
    expect(messages(a)).toHaveLength(4)
  })
  it('refuses a Guest and a session that is still loading', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    const a = make()
    await a.api.refresh()
    await expect(a.api.send('Hi', SCOPE)).rejects.toMatchObject({ status: 409, code: 'no_ai' })
    a.api.newConversation()
    expect(snap(a).current).toBeNull()
    expect(fake.runs).toEqual([])
  })
  it('stays busy after `done` until the provider has wound down', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'A' })
    fake.last().emit({ type: 'done' })
    await settle()
    expect(answer(a).status).toBe('done')
    expect(snap(a).busy).toBe(true)
    await expect(a.api.send('Too early', SCOPE)).rejects.toMatchObject({ code: 'busy' })
    fake.last().end()
    await sending
    expect(snap(a).busy).toBe(false)
  })
  it('ignores what comes after the end of an answer', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    const run = fake.last()
    run.emit({ type: 'delta', text: 'A' })
    run.emit({ type: 'done' })
    run.emit({ type: 'delta', text: ' and more' })
    run.emit({ type: 'error', message: 'late' })
    run.fail(new Error('late'))
    await sending
    expect(answer(a)).toMatchObject({ text: 'A', status: 'done' })
    expect('error' in answer(a)).toBe(false)
  })
})

describe('stopping and failing', () => {
  it('stop leaves the partial text with status stopped and aborts the provider', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    const run = fake.last()
    run.emit({ type: 'delta', text: 'Half an ans' })
    clock = 3000
    a.api.stop()
    expect(run.signal.aborted).toBe(true)
    expect(answer(a)).toMatchObject({ text: 'Half an ans', status: 'stopped' })
    expect('error' in answer(a)).toBe(false)
    expect(snap(a).busy).toBe(false)
    expect(snap(a).current!.updatedAt).toBe(3000)
    await sending // resolves although the provider never settled
    run.emit({ type: 'delta', text: 'wer' })
    run.emit({ type: 'done' })
    frames.run()
    expect(answer(a)).toMatchObject({ text: 'Half an ans', status: 'stopped' })
    a.api.stop() // nothing to stop: no effect
    await exchange(a, 'Next', 'Fine')
    expect(answer(a)).toMatchObject({ text: 'Fine', status: 'done' })
  })
  it('stop after `done` only lets go of a provider that hangs', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'A' })
    fake.last().emit({ type: 'done' })
    a.api.stop()
    await sending
    expect(answer(a)).toMatchObject({ text: 'A', status: 'done' })
    expect(snap(a).busy).toBe(false)
  })
  it('an `error` event ends the answer with its sentence', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'So far' })
    fake.last().emit({ type: 'error', message: 'OpenRouter refused the key.' })
    fake.last().end()
    await sending
    expect(answer(a)).toMatchObject({ text: 'So far', status: 'error', error: 'OpenRouter refused the key.' })
    expect(snap(a).busy).toBe(false)
  })
  it('a provider that ends without `done` is an error: the answer was cut off', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'So f' })
    fake.last().end()
    await sending
    expect(answer(a)).toMatchObject({ text: 'So f', status: 'error', error: 'The answer was cut off.' })
  })
  it('send resolves when the provider fails; the message carries a plain sentence', async () => {
    const a = await ready()
    const cases: [unknown, string][] = [
      [new ApiError(0, 'network', 'Cannot reach the server.'), 'Cannot reach the server.'],
      [new ApiError(0, 'cut_off', 'The answer was cut off.'), 'The answer was cut off.'],
      [new ApiError(409, 'no_key', 'nope'), 'Add an OpenRouter key under AI access first.'],
      [new ApiError(409, 'no_model', 'nope'), 'Choose a model under AI access first.'],
      [new ApiError(503, 'ai_not_configured', 'nope'), 'The AI is not set up on this server.'],
      [new ApiError(429, 'too_many_requests', 'nope'), 'Too many questions in a minute. Wait a moment and try again.'],
      [new ApiError(0, 'desktop_failed', 'Claude Code could not be started.'), 'Claude Code could not be started.'],
      [new Error('TypeError: secret internals'), 'The AI could not answer.'],
      ['a string', 'The AI could not answer.'],
    ]
    for (const [failure, sentence] of cases) {
      const sending = a.api.send('Q', SCOPE)
      fake.last().fail(failure)
      await sending
      await settle()
      expect(answer(a)).toMatchObject({ text: '', status: 'error', error: sentence })
      expect(snap(a).busy).toBe(false)
    }
  })
  it('looks at the setup again when the server says the key or the model is gone', async () => {
    const a = await ready()
    delete server.aiSettings[ME.id]!.key
    const sending = a.api.send('Q', SCOPE)
    fake.last().fail(new ApiError(409, 'no_key', 'nope'))
    await sending
    await settle()
    expect(snap(a).setup).toMatchObject({ provider: 'none', reason: 'browser_no_key' })
  })
  it('leaves failed and stopped answers out of what a later turn is told', async () => {
    const a = await ready()
    await exchange(a, 'Q1', 'A1')
    let sending = a.api.send('Q2', SCOPE)
    fake.last().emit({ type: 'delta', text: 'broken' })
    fake.last().emit({ type: 'error', message: 'No.' })
    fake.last().end()
    await sending
    sending = a.api.send('Q3', SCOPE)
    fake.last().emit({ type: 'delta', text: 'stopped' })
    a.api.stop()
    await sending
    sending = a.api.send('Q4', SCOPE)
    fake.last().emit({ type: 'done' }) // an empty answer says nothing
    fake.last().end()
    await sending
    sending = a.api.send('Q5', SCOPE)
    expect(fake.last().turn.messages).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'user', content: 'Q3' },
      { role: 'user', content: 'Q4' },
      { role: 'user', content: 'Q5' },
    ])
    a.api.stop()
    await sending
  })
})

describe('retry', () => {
  async function failed(a: ReturnType<typeof createAi>) {
    await exchange(a, 'Q1', 'A1', { session: 'sess-1' })
    const sending = a.api.send('Q2', { branch: 'b-id', branchName: 'try-QEC' })
    fake.last().emit({ type: 'delta', text: 'half' })
    fake.last().emit({ type: 'error', message: 'No.' })
    fake.last().end()
    await sending
    return answer(a)
  }

  it('asks the question again and puts the new answer in place of the failed one', async () => {
    const a = await ready()
    const bad = await failed(a)
    const before = messages(a)
    const trying = a.api.retry(bad.id)
    expect(snap(a).busy).toBe(true)
    expect(messages(a)).toHaveLength(4)
    expect(messages(a).slice(0, 3)).toEqual(before.slice(0, 3))
    expect(messages(a)[0]).toBe(before[0])
    expect(answer(a)).toMatchObject({ role: 'assistant', text: '', status: 'streaming' })
    expect(answer(a).id).not.toBe(bad.id)
    expect('error' in answer(a)).toBe(false)
    const { turn } = fake.last()
    expect(turn).toMatchObject({
      prompt: 'Q2',
      scope: { branch: 'b-id', branchName: 'try-QEC' },
      resume: 'sess-1',
      messages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
      ],
    })
    fake.last().emit({ type: 'delta', text: 'A2' })
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await trying
    expect(messages(a).map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'Q1', 'done'],
      ['assistant', 'A1', 'done'],
      ['user', 'Q2', 'done'],
      ['assistant', 'A2', 'done'],
    ])
  })
  it('works for a stopped answer, and for one that is not the last', async () => {
    const a = await ready()
    const sending = a.api.send('Q1', SCOPE)
    fake.last().emit({ type: 'delta', text: 'part' })
    a.api.stop()
    await sending
    const stopped = answer(a)
    await exchange(a, 'Q2', 'A2')
    const trying = a.api.retry(stopped.id)
    expect(fake.last().turn.messages).toEqual([{ role: 'user', content: 'Q1' }])
    fake.last().emit({ type: 'delta', text: 'A1' })
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await trying
    expect(messages(a).map((m) => m.text)).toEqual(['Q1', 'A1', 'Q2', 'A2'])
  })
  it('refuses what cannot be tried again', async () => {
    const a = await ready()
    const bad = await failed(a)
    const [q1, a1] = messages(a)
    await expect(a.api.retry('ghost')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(a.api.retry(a1!.id)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(a.api.retry(q1!.id)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    const trying = a.api.retry(bad.id)
    await expect(a.api.retry(bad.id)).rejects.toMatchObject({ status: 409, code: 'busy' })
    a.api.stop()
    await trying
    a.api.newConversation()
    await expect(a.api.retry(answer(a)?.id ?? bad.id)).rejects.toMatchObject({ status: 404 })
    expect(fake.runs).toHaveLength(3)
  })
  it('refuses without an AI', async () => {
    const a = await ready()
    const bad = await failed(a)
    await a.api.removeKey()
    await expect(a.api.retry(bad.id)).rejects.toMatchObject({ status: 409, code: 'no_ai' })
  })
})

describe('publishing while streaming', () => {
  it('publishes deltas at most once per frame, and the final text always', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    let published = 0
    const off = a.store.subscribe(() => published++)
    const run = fake.last()
    for (const piece of ['On', 'e ', 'tw', 'o ']) run.emit({ type: 'delta', text: piece })
    run.emit({ type: 'tool', name: 'list_cards' })
    expect(published).toBe(0)
    expect(answer(a).text).toBe('')
    expect(frames.requested).toBe(1)
    frames.run()
    expect(published).toBe(1)
    expect(answer(a)).toMatchObject({ text: 'One two ', tools: ['list_cards'], status: 'streaming' })
    frames.run()
    expect(published).toBe(1)
    for (const piece of ['th', 'ree']) run.emit({ type: 'delta', text: piece })
    expect(frames.requested).toBe(2)
    expect(answer(a).text).toBe('One two ')
    run.emit({ type: 'done' })
    expect(published).toBe(2)
    expect(answer(a)).toMatchObject({ text: 'One two three', status: 'done' })
    expect(frames.waiting).toBe(0)
    run.end()
    await sending
    off()
  })
  it('publishes the text that was waiting for a frame when the answer is stopped or fails', async () => {
    const a = await ready()
    let sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'unseen' })
    a.api.stop()
    await sending
    expect(answer(a)).toMatchObject({ text: 'unseen', status: 'stopped' })
    sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'unseen too' })
    fake.last().end()
    await sending
    expect(answer(a)).toMatchObject({ text: 'unseen too', status: 'error' })
    expect(frames.waiting).toBe(0)
  })
  it('changes only what changed: other messages and the list of Conversations keep their identity', async () => {
    const a = await ready()
    await exchange(a, 'Q1', 'A1')
    const sending = a.api.send('Q2', SCOPE)
    const before = snap(a)
    fake.last().emit({ type: 'delta', text: 'A' })
    frames.run()
    const during = snap(a)
    expect(during).not.toBe(before)
    expect(during.setup).toBe(before.setup)
    expect(during.conversations).toBe(before.conversations)
    expect(during.current).not.toBe(before.current)
    expect(during.current!.messages.slice(0, 3)).toEqual(before.current!.messages.slice(0, 3))
    for (let i = 0; i < 3; i++) expect(during.current!.messages[i]).toBe(before.current!.messages[i])
    expect(during.current!.messages[3]).not.toBe(before.current!.messages[3])
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await sending
  })
  it('does not write to storage for a delta', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    a.flush()
    const sets = storage.sets
    for (let i = 0; i < 50; i++) {
      fake.last().emit({ type: 'delta', text: 'x' })
      frames.run()
    }
    expect(timers.pending).toEqual([])
    expect(storage.sets).toBe(sets)
    fake.last().emit({ type: 'done' })
    expect(timers.pending).toHaveLength(1)
    expect(storage.sets).toBe(sets)
    timers.fireNext()
    expect(storage.sets).toBe(sets + 1)
    fake.last().end()
    await sending
  })
})

describe('Conversations', () => {
  it('newConversation starts an empty current one that is listed once it has a message', async () => {
    const a = await ready()
    a.api.newConversation()
    const empty = snap(a).current!
    expect(empty).toEqual({ id: empty.id, title: '', createdAt: 1000, updatedAt: 1000, messages: [] })
    expect(snap(a).conversations).toEqual([])
    a.api.newConversation()
    expect(snap(a).current).toBe(empty)
    await exchange(a, 'Hello', 'Hi.')
    expect(snap(a).current!.id).toBe(empty.id)
    expect(snap(a).conversations.map((c) => c.id)).toEqual([empty.id])
  })
  it('lists newest first, opens one, and forgets an empty one that was left', async () => {
    const a = await ready()
    await exchange(a, 'First', 'A')
    const first = snap(a).current!.id
    clock = 2000
    a.api.newConversation()
    await exchange(a, 'Second', 'A')
    const second = snap(a).current!.id
    expect(snap(a).conversations.map((c) => c.title)).toEqual(['Second', 'First'])
    a.api.open(first)
    expect(snap(a).current).toMatchObject({ id: first, title: 'First' })
    a.api.open('ghost')
    expect(snap(a).current!.id).toBe(first)
    clock = 3000
    await exchange(a, 'More on the first', 'A')
    expect(snap(a).conversations.map((c) => c.id)).toEqual([first, second])
    a.api.newConversation()
    const empty = snap(a).current!.id
    a.api.open(second)
    a.api.open(empty)
    expect(snap(a).current!.id).toBe(second)
    expect(snap(a).conversations).toHaveLength(2)
  })
  it('removes a Conversation; removing the current one leaves none open', async () => {
    const a = await ready()
    await exchange(a, 'First', 'A', { session: 'sess-1' })
    const first = snap(a).current!.id
    a.api.newConversation()
    await exchange(a, 'Second', 'A')
    a.api.remove(first)
    expect(snap(a).conversations.map((c) => c.title)).toEqual(['Second'])
    expect(snap(a).current!.title).toBe('Second')
    a.api.remove(snap(a).current!.id)
    expect(snap(a)).toMatchObject({ current: null, conversations: [] })
    a.api.remove('ghost')
    a.flush()
    expect(stored()).toEqual({ v: 1, current: null, conversations: [] })
  })
  it('removing the Conversation that is being answered stops the answer', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    const run = fake.last()
    a.api.remove(snap(a).current!.id)
    await sending
    expect(run.signal.aborted).toBe(true)
    expect(snap(a)).toMatchObject({ current: null, conversations: [], busy: false })
    run.emit({ type: 'delta', text: 'late' })
    frames.run()
    expect(snap(a).conversations).toEqual([])
  })
  it('an answer keeps arriving in its Conversation while another one is open', async () => {
    const a = await ready()
    await exchange(a, 'First', 'A')
    const first = snap(a).current!.id
    a.api.newConversation()
    const sending = a.api.send('Second', SCOPE)
    const second = snap(a).current!.id
    a.api.open(first)
    fake.last().emit({ type: 'delta', text: 'Still here' })
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await sending
    expect(snap(a).current!.id).toBe(first)
    expect(messages(a)).toHaveLength(2)
    a.api.open(second)
    expect(answer(a)).toMatchObject({ text: 'Still here', status: 'done' })
  })
})

describe('keeping Conversations on this device', () => {
  it('writes one versioned value per Member, a moment after a message completes', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    expect(storage.sets).toBe(0)
    expect(timers.delays).toEqual([400])
    fake.last().emit({ type: 'delta', text: 'A' })
    fake.last().emit({ type: 'done', session: 'sess-1' })
    fake.last().end()
    await sending
    expect(storage.sets).toBe(0)
    expect(timers.pending).toHaveLength(1)
    timers.fireNext()
    expect([...storage.data.keys()]).toEqual(['qoop.ai.me'])
    const current = snap(a).current!
    expect(stored()).toEqual({ v: 1, current: current.id, conversations: [{ ...current, session: 'sess-1' }] })
    expect(storage.sets).toBe(1)
  })
  it('comes back after a reload: Conversations, the open one, and the session to resume', async () => {
    const a = await ready()
    await exchange(a, 'First', 'A1', { session: 'sess-1' })
    clock = 2000
    a.api.newConversation()
    await exchange(a, 'Second', 'A2')
    a.api.open(snap(a).conversations[1]!.id)
    const before = snap(a)
    a.dispose()
    const b = await ready()
    expect(snap(b).conversations).toEqual(before.conversations)
    expect(snap(b).current).toEqual(before.current)
    await exchange(b, 'Again', 'A3')
    expect(fake.last().turn.resume).toBe('sess-1')
    expect(fake.last().turn.messages.map((m) => m.content)).toEqual(['First', 'A1', 'Again'])
  })
  it('an answer that was still arriving when the page went away comes back as cut off', async () => {
    const a = await ready()
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'never shown' })
    a.flush()
    expect(stored().conversations[0].messages[1]).toMatchObject({ status: 'streaming', text: '' })
    const b = await ready()
    expect(answer(b)).toMatchObject({ role: 'assistant', text: '', status: 'error', error: 'The answer was cut off.' })
    const trying = b.api.retry(answer(b).id)
    expect(fake.last().turn.prompt).toBe('Q')
    b.api.stop()
    a.api.stop()
    await Promise.all([sending, trying])
  })
  it('writes at once when the page is hidden', async () => {
    const a = await ready()
    await exchange(a, 'Q', 'A')
    expect(storage.sets).toBe(0)
    globalThis.dispatchEvent(new Event('pagehide'))
    expect(storage.sets).toBe(1)
    expect(timers.pending).toEqual([])
    globalThis.dispatchEvent(new Event('pagehide'))
    expect(storage.sets).toBe(1)
    expect(snap(a).current).not.toBeNull()
  })
  it('ignores what it cannot read and starts empty', async () => {
    const good = { id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [{ id: 'm1', role: 'user', text: 'Q', at: 1, status: 'done' }] }
    const unreadable = [
      '{not json',
      'null',
      '[]',
      '"text"',
      JSON.stringify({ v: 2, current: null, conversations: [good] }),
      JSON.stringify({ current: null, conversations: [good] }),
      JSON.stringify({ v: 1, conversations: 'many' }),
      JSON.stringify({ v: 1, conversations: [null, 7, { id: 'x' }, { ...good, messages: 'none' }, { ...good, messages: [] }] }),
    ]
    for (const raw of unreadable) {
      storage.data.set('qoop.ai.me', raw)
      const a = make()
      expect(snap(a)).toMatchObject({ current: null, conversations: [] })
    }
  })
  it('keeps what is readable and drops single broken messages and unknown fields', async () => {
    const value = {
      v: 1,
      current: 'c1',
      conversations: [
        {
          id: 'c1',
          title: 'T',
          createdAt: 1,
          updatedAt: 2,
          session: 'sess-1',
          extra: true,
          messages: [
            { id: 'm1', role: 'user', text: 'Q', at: 1, status: 'done', scope: { branch: 'b', branchName: 'main', card: { id: 'a', title: 'A' } }, junk: 1 },
            { id: 'm2', role: 'system', text: 'x', at: 1, status: 'done' },
            { id: 'm3', role: 'assistant', text: 'A', at: 1, status: 'done', tools: ['get_card'], model: 'm', pinned: [{ card: 'a', cardTitle: 'A', block: 'k' }, { card: 1 }] },
            { id: 'm4', role: 'assistant', text: 'A', at: 'yesterday', status: 'done' },
            { id: 'm5', role: 'assistant', text: 'A', at: 1, status: 'odd' },
          ],
        },
        { id: 'c1', title: 'Same id again', createdAt: 1, updatedAt: 2, messages: [{ id: 'm9', role: 'user', text: 'Q', at: 1, status: 'done' }] },
      ],
    }
    storage.data.set('qoop.ai.me', JSON.stringify(value))
    const a = make()
    expect(snap(a).conversations).toEqual([{ id: 'c1', title: 'T', updatedAt: 2 }])
    expect(snap(a).current).toEqual({
      id: 'c1',
      title: 'T',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'm1', role: 'user', text: 'Q', at: 1, status: 'done', scope: { branch: 'b', branchName: 'main', card: { id: 'a', title: 'A' } } },
        { id: 'm3', role: 'assistant', text: 'A', at: 1, status: 'done', tools: ['get_card'], model: 'm', pinned: [{ card: 'a', cardTitle: 'A', block: 'k' }] },
      ],
    })
  })
  it('keeps at most 200 messages in a Conversation: the oldest go', async () => {
    const a = await ready()
    for (let i = 0; i < 101; i++) await exchange(a, `Q${i}`, `A${i}`)
    expect(messages(a)).toHaveLength(200)
    expect(messages(a)[0]!.text).toBe('Q1')
    expect(messages(a).at(-1)!.text).toBe('A100')
    a.flush()
    expect(stored().conversations[0].messages).toHaveLength(200)
  })
  it('keeps at most 30 Conversations: the ones untouched for longest go, never the open one', async () => {
    const a = await ready()
    for (let i = 0; i < 30; i++) {
      clock = 1000 + i
      a.api.newConversation()
      await exchange(a, `Conversation ${i}`, 'A', { session: `sess-${i}` })
    }
    a.api.open(snap(a).conversations.at(-1)!.id) // the oldest, "Conversation 0", is being read
    clock = 5000
    a.api.newConversation()
    await exchange(a, 'One more', 'A')
    expect(snap(a).conversations).toHaveLength(30)
    expect(snap(a).conversations.map((c) => c.title)).not.toContain('Conversation 0')
    expect(snap(a).conversations[0]!.title).toBe('One more')
    a.api.open(snap(a).conversations.at(-1)!.id) // "Conversation 1"
    clock = 6000
    const sending = a.api.send('Asked in the oldest', SCOPE)
    a.api.newConversation()
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await sending
    expect(snap(a).conversations).toHaveLength(30)
    expect(snap(a).conversations[0]!.title).toBe('Conversation 1')
    a.flush()
    expect(stored().conversations).toHaveLength(30)
    expect(JSON.stringify(stored())).not.toContain('sess-0"')
  })
  it('another Member on the same browser does not see the previous Member\'s Conversations', async () => {
    const a = await ready()
    await exchange(a, 'Mine, private', 'A')
    server.actor = OTHER
    server.aiSettings[OTHER.id] = { key: KEY, added_at: 5, model: 'openai/gpt-5' }
    sessionStore.setState({ status: 'signed_in', member: OTHER }, true)
    expect(snap(a)).toMatchObject({ current: null, conversations: [] })
    expect(stored(ME.id).conversations).toHaveLength(1) // written on the way out
    await a.api.refresh()
    await exchange(a, 'Theirs', 'A')
    a.flush()
    expect(stored(OTHER.id).conversations.map((c: { title: string }) => c.title)).toEqual(['Theirs'])
    expect(stored(ME.id).conversations.map((c: { title: string }) => c.title)).toEqual(['Mine, private'])
    expect(storage.data.get('qoop.ai.other')).not.toContain('Mine, private')
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    expect(snap(a).conversations.map((c) => c.title)).toEqual(['Mine, private'])
    expect(snap(a).current!.title).toBe('Mine, private')
  })
  it('signing out puts them away without deleting them, and stops an answer on its way', async () => {
    const a = await ready()
    await exchange(a, 'Kept', 'A')
    const sending = a.api.send('Interrupted', SCOPE)
    const run = fake.last()
    run.emit({ type: 'delta', text: 'Half' })
    sessionStore.setState({ status: 'signed_out' }, true)
    await sending
    expect(run.signal.aborted).toBe(true)
    expect(snap(a)).toMatchObject({ current: null, conversations: [], busy: false, setup: { provider: 'none', reason: 'loading' } })
    a.api.newConversation()
    expect(snap(a).current).toBeNull()
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    expect(messages(a).map((m) => [m.text, m.status])).toEqual([
      ['Kept', 'done'],
      ['A', 'done'],
      ['Interrupted', 'done'],
      ['Half', 'stopped'],
    ])
  })
  it('a Guest has no Conversations and nothing is stored for one', async () => {
    storage.data.set('qoop.ai.guest', JSON.stringify({ v: 1, current: null, conversations: [{ id: 'c', title: 'T', createdAt: 1, updatedAt: 1, messages: [{ id: 'm', role: 'user', text: 'Q', at: 1, status: 'done' }] }] }))
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    const a = make()
    expect(snap(a).conversations).toEqual([])
    a.api.newConversation()
    a.flush()
    expect(storage.sets).toBe(0)
  })
  it('goes on in memory when storage refuses to write', async () => {
    storage.failSet = true
    const a = await ready()
    await exchange(a, 'Q', 'A')
    expect(() => timers.fireNext()).not.toThrow()
    expect(() => a.flush()).not.toThrow()
    expect(messages(a).map((m) => m.text)).toEqual(['Q', 'A'])
    await exchange(a, 'Q2', 'A2')
    storage.failSet = false
    a.flush()
    expect(stored().conversations[0].messages).toHaveLength(4)
  })
  it('writes the newest Conversations when there is not room for all', async () => {
    const a = await ready()
    for (let i = 0; i < 5; i++) {
      clock = 1000 + i
      a.api.newConversation()
      await exchange(a, `Conversation ${i}`, 'x'.repeat(1000))
    }
    const setItem = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
      if (value.length > 3000) throw new DOMException('full', 'QuotaExceededError')
      setItem(key, value)
    }
    a.flush()
    expect(stored().conversations.map((c: { title: string }) => c.title)).toEqual(['Conversation 4', 'Conversation 3'])
    expect(snap(a).conversations).toHaveLength(5)
  })
  it('starts empty and goes on in memory when storage cannot be read or reached', async () => {
    storage.data.set('qoop.ai.me', JSON.stringify({ v: 1, current: null, conversations: [] }))
    storage.failGet = true
    const a = await ready()
    expect(snap(a).conversations).toEqual([])
    const blocked = await ready({
      storage: () => {
        throw new Error('SecurityError')
      },
    })
    await exchange(blocked, 'Q', 'A')
    expect(() => blocked.flush()).not.toThrow()
    expect(messages(blocked)).toHaveLength(2)
    const none = await ready({ storage: () => undefined })
    await exchange(none, 'Q', 'A')
    expect(() => none.flush()).not.toThrow()
    expect(messages(none)).toHaveLength(2)
  })
  it('the default storage is localStorage, and a browser that blocks it does not break anything', async () => {
    const a = await ready({ storage: undefined })
    await exchange(a, 'Q', 'A')
    a.flush()
    expect(JSON.parse(globalThis.localStorage.getItem('qoop.ai.me')!)).toMatchObject({ v: 1, conversations: [{ title: 'Q' }] })
    a.dispose()
    globalThis.localStorage.clear()
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const b = await ready({ storage: undefined })
    await exchange(b, 'Q', 'A')
    expect(() => b.flush()).not.toThrow()
    expect(messages(b)).toHaveLength(2)
  })
})

describe('a turn on Claude Code, end to end', () => {
  it('runs through the desktop bridge, and the token never reaches storage, a Conversation or an error', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const desk = fakeDesktop({ claudeVersion: '2.1.0' })
    const a = make({ desktop: () => desk, provider: undefined, storage: undefined })
    await a.api.refresh()
    expect(snap(a).setup.provider).toBe('claude-code')

    let sending = a.api.send('What bounds the threshold?', SCOPE)
    await vi.waitFor(() => expect(desk.runs).toHaveLength(1))
    const secret = server.secrets[0]!
    expect(desk.runs[0]!.request.tools.token).toBe(secret)
    desk.runs[0]!.emit({ type: 'delta', text: 'About 1%.' })
    desk.runs[0]!.emit({ type: 'tool', name: 'get_card' })
    desk.runs[0]!.emit({ type: 'done', model: 'claude-sonnet-4-5', session: 'sess-1' })
    desk.runs[0]!.end()
    await sending
    expect(answer(a)).toMatchObject({ text: 'About 1%.', status: 'done', tools: ['get_card'], model: 'claude-sonnet-4-5' })

    sending = a.api.send('And the toric code?', SCOPE)
    await vi.waitFor(() => expect(desk.runs).toHaveLength(2))
    expect(desk.runs[1]!.request).toMatchObject({ prompt: 'And the toric code?', resume: 'sess-1', tools: { token: secret } })
    desk.runs[1]!.emit({ type: 'error', message: `config ${secret} rejected` })
    desk.runs[1]!.fail(new Error(`boom ${secret}`))
    await sending
    expect(answer(a)).toMatchObject({ status: 'error', error: 'config … rejected' })

    sending = a.api.send('Stop me', SCOPE)
    await vi.waitFor(() => expect(desk.runs).toHaveLength(3))
    a.api.stop()
    await sending
    expect(desk.cancelled).toEqual([desk.runs[2]!.request.id])
    expect(server.secrets).toHaveLength(1)

    a.flush()
    expect(setItem).toHaveBeenCalled()
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(setItem.mock.calls)).not.toContain('qoop_pat_')
    expect(globalThis.sessionStorage).toHaveLength(0)
    expect(JSON.stringify(snap(a))).not.toContain(secret)
    expect(Object.keys(globalThis.localStorage).map((k) => globalThis.localStorage.getItem(k)).join()).not.toContain('qoop_pat_')
    globalThis.localStorage.clear()
  })
  it('a turn on OpenRouter runs through the server', async () => {
    const a = await ready({ provider: undefined })
    server.aiScript = [{ type: 'delta', text: 'Be' }, { type: 'tool', name: 'list_cards' }, { type: 'delta', text: 'low 1%.' }, { type: 'done' }]
    server.aiChunk = 3
    await a.api.send('What bounds the threshold?', SCOPE)
    expect(answer(a)).toMatchObject({ text: 'Below 1%.', tools: ['list_cards'], status: 'done', model: 'openai/gpt-5' })
    expect(server.requests.at(-1)).toEqual({
      method: 'POST',
      path: '/api/ai/chat',
      body: { messages: [{ role: 'user', content: 'What bounds the threshold?' }], scope: { branch: 'main', card: 'a' } },
    })
    server.aiScript = [{ type: 'delta', text: 'Half' }]
    server.aiDrop = true
    await a.api.send('And then?', SCOPE)
    expect(answer(a)).toMatchObject({ text: 'Half', status: 'error', error: 'The answer was cut off.' })
    server.aiDrop = false
    server.aiScript = [{ type: 'done' }]
    await a.api.retry(answer(a).id)
    expect((server.requests.at(-1)!.body as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'What bounds the threshold?' },
      { role: 'assistant', content: 'Below 1%.' },
      { role: 'user', content: 'And then?' },
    ])
  })
})

describe('pin', () => {
  let sync: ReturnType<typeof createBoardSync>

  async function openBoard() {
    await sync.open()
    const ws = FakeSocket.last()
    ws.open()
    ws.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
    await settle()
  }

  beforeEach(() => {
    sync = createBoardSync({ WebSocketCtor: FakeSocket, setTimer: timers.set, clearTimer: timers.clear, socketUrl: () => 'ws://test/api/ws' })
    server.commit(
      [
        ops.createCard({ id: 'a', x: 0, y: 0, title: 'Threshold' }),
        ops.createCard({ id: 'b', x: 0, y: 0, title: 'Decoder' }),
        ops.addBlock({ id: 'k1', card: 'a', text: 'one', order: 'G' }),
        ops.addBlock({ id: 'k2', card: 'a', text: 'two', order: 'V' }),
      ],
      ME.id,
    )
  })
  afterEach(() => sync.close())

  const posted = () => server.requests.filter((r) => r.path.endsWith('/ops')).map((r) => (r.body as { ops: unknown[] }).ops)

  it('copies the answer into the Page as a new last Block with the AI fields, and records where', async () => {
    const a = await ready({ board: sync })
    await openBoard()
    await exchange(a, 'Q', '## Bound\n\nBelow $p_{th}$.', { model: 'openai/gpt-5-2026' })
    clock = 7777
    const { block } = await a.api.pin(answer(a).id, { id: 'a', title: 'Threshold' })
    expect(posted()).toEqual([
      [
        {
          Create: {
            entity: block,
            kind: 'Block',
            fields: {
              card: { Ref: 'a' },
              type: { Text: 'text' },
              order: { Text: 'W' },
              text: { Text: '## Bound\n\nBelow $p_{th}$.' },
              ai_model: { Text: 'openai/gpt-5-2026' },
              ai_pinned_by: { Text: 'me' },
              ai_pinned_at: { Float: 7777 },
            },
          },
        },
      ],
    ])
    expect(sync.page('a').blocks.map((b) => b.id)).toEqual(['k1', 'k2', block])
    expect(sync.page('a').blocks[2]!.ai).toEqual({ model: 'openai/gpt-5-2026', pinnedBy: 'me', pinnedAt: 7777 })
    expect(answer(a).pinned).toEqual([{ card: 'a', cardTitle: 'Threshold', block }])
    a.flush()
    expect(stored().conversations[0].messages[1].pinned).toEqual([{ card: 'a', cardTitle: 'Threshold', block }])
  })
  it('pins to an empty Page with the first order key, and can pin one answer more than once', async () => {
    const a = await ready({ board: sync })
    await openBoard()
    await exchange(a, 'Q', 'Answer')
    const first = await a.api.pin(answer(a).id, { id: 'b', title: 'Decoder' })
    const second = await a.api.pin(answer(a).id, { id: 'b', title: 'Decoder' })
    expect(sync.page('b').blocks.map((b) => [b.id, b.order])).toEqual([
      [first.block, 'U'],
      [second.block, 'V'],
    ])
    expect(answer(a).pinned).toEqual([
      { card: 'b', cardTitle: 'Decoder', block: first.block },
      { card: 'b', cardTitle: 'Decoder', block: second.block },
    ])
  })
  it('names the setup when the message does not say what answered', async () => {
    const desk = fakeDesktop()
    const a = make({ desktop: () => desk, board: sync })
    await a.api.refresh()
    await openBoard()
    await exchange(a, 'Q', 'Answer')
    const { block } = await a.api.pin(answer(a).id, { id: 'a', title: 'Threshold' })
    expect(sync.page('a').blocks.find((b) => b.id === block)!.ai!.model).toBe('Claude Code')
    await exchange(a, 'Q', 'Answer', { model: 'claude-sonnet-4-5' })
    const named = await a.api.pin(answer(a).id, { id: 'a', title: 'Threshold' })
    expect(sync.page('a').blocks.find((b) => b.id === named.block)!.ai!.model).toBe('claude-sonnet-4-5')
  })
  it('pins a stopped answer and one from a Conversation that is not open', async () => {
    const a = await ready({ board: sync })
    await openBoard()
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'Useful half' })
    a.api.stop()
    await sending
    const stopped = answer(a).id
    a.api.newConversation()
    const { block } = await a.api.pin(stopped, { id: 'a', title: 'Threshold' })
    expect(sync.page('a').blocks.at(-1)).toMatchObject({ id: block, text: 'Useful half' })
    expect(snap(a).current!.messages).toEqual([])
    a.api.open(snap(a).conversations[0]!.id)
    expect(answer(a).pinned).toEqual([{ card: 'a', cardTitle: 'Threshold', block }])
  })
  it('refuses what cannot be pinned, without a request', async () => {
    const a = await ready({ board: sync })
    await exchange(a, 'Q', 'Answer')
    const good = answer(a).id
    await expect(a.api.pin(good, { id: 'a', title: 'Threshold' })).rejects.toMatchObject({ status: 400, code: 'board_not_open' })
    await openBoard()
    await expect(a.api.pin('ghost', { id: 'a', title: 'Threshold' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(a.api.pin(messages(a)[0]!.id, { id: 'a', title: 'Threshold' })).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(a.api.pin(good, { id: 'ghost', title: 'Gone' })).rejects.toMatchObject({ status: 400, code: 'stale' })
    await sync.submit([ops.remove('b')])
    await expect(a.api.pin(good, { id: 'b', title: 'Decoder' })).rejects.toMatchObject({ status: 400, code: 'stale' })
    const sending = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'delta', text: 'On its way' })
    await expect(a.api.pin(answer(a).id, { id: 'a', title: 'Threshold' })).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await sending
    const empty = a.api.send('Q', SCOPE)
    fake.last().emit({ type: 'done' })
    fake.last().end()
    await empty
    await expect(a.api.pin(answer(a).id, { id: 'a', title: 'Threshold' })).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    expect(posted()).toHaveLength(1) // only the removal of the Card
    expect(messages(a).some((m) => m.pinned)).toBe(false)
  })
  it('rejects like board.submit when the server refuses, and records nothing', async () => {
    const a = await ready({ board: sync })
    await openBoard()
    await exchange(a, 'Q', 'Answer')
    server.failNext = { status: 409, code: 'rejected' }
    const error = await a.api.pin(answer(a).id, { id: 'a', title: 'Threshold' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'rejected' })
    expect(sync.page('a').blocks.map((b) => b.id)).toEqual(['k1', 'k2'])
    expect('pinned' in answer(a)).toBe(false)
  })
  it('refuses a Guest', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    const a = make({ board: sync })
    await expect(a.api.pin('any', { id: 'a', title: 'Threshold' })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })
})
