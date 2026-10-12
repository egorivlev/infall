// Runs and the Runner: whether this device can execute Runs, the one execution in flight in this window, and
// recording what it captured as the Run's result. Code is executed by the desktop app (desktop.md, "M8 — the
// Runner"), never here; results and code are kept in memory only — nothing is written to storage.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { sync } from './board-sync'
import type { BoardSync } from './board-sync'
import { previewing as historyPreviewing } from './history'
import { ApiError } from './http'
import { newId, ops } from './ops'
import { MAX_OUTPUT, toRunEvent, toRunResult, UNREADABLE_RESULT } from './run-result'
import { sessionStore } from './session-store'
import type { BlockVM, Member, QoopRunner, RunLive, RunnerSetup, RunOutcome, RunResult, RunsSnapshot, SessionSnapshot } from './types'

export const STOPPED_ANSWERING = 'The Runner stopped answering.'
const COULD_NOT_RUN = 'The Run could not be executed.'
const MAX_MESSAGE = 500
/** How long a `done` may still arrive after the bridge's promise has settled, before the execution reads as failed. */
export const GRACE_MS = 300

export type RunsOptions = {
  /** `window.qoopDesktop`, whatever it holds. Default: read from the page. */
  desktop?: () => unknown
  /** The Board that Runs are read from and results are recorded on. */
  board?: Pick<BoardSync, 'submit' | 'store' | 'internal'>
  /** Whether a moment in History is being previewed (nothing is executed then). Default: the History store. */
  previewing?: () => boolean
  /** Runs `fn` before the next paint (live output is published once per frame). */
  requestFrame?: (fn: () => void) => unknown
  cancelFrame?: (handle: unknown) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

type Found = { python?: { path: string; version: string }; folder?: string }

// The execution in flight. `over`: it has its outcome coming (a `done` or `error` was read, or it was let go) —
// events after that are ignored.
type Execution = {
  id: string
  block: string
  branch: string
  branchName: string
  member: string
  runner: QoopRunner
  state: RunLive['state']
  output: string
  startedAt: number | undefined
  over: boolean
  frame: unknown
  hasFrame: boolean
  grace: unknown
  finish: () => void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function defaultDesktop(): unknown {
  return (globalThis as { qoopDesktop?: unknown }).qoopDesktop
}

function defaultRequestFrame(fn: () => void): unknown {
  return typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 16)
}

function defaultCancelFrame(handle: unknown): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle as number)
  else globalThis.clearTimeout(handle as number)
}

// The Runner of a bridge, or null for an app from before M8 (a bridge without a usable `runner`).
function runnerOf(bridge: unknown): QoopRunner | null {
  if (!isRecord(bridge)) return null
  const r = bridge.runner
  const complete = isRecord(r) && ['status', 'configure', 'run', 'cancel'].every((name) => typeof r[name] === 'function')
  return complete ? (r as QoopRunner) : null
}

function readStatus(answer: unknown): Found {
  const found: Found = {}
  if (!isRecord(answer)) return found
  const python = answer.python
  if (isRecord(python) && typeof python.path === 'string' && typeof python.version === 'string') {
    found.python = { path: python.path, version: python.version }
  }
  if (typeof answer.folder === 'string' && answer.folder !== '') found.folder = answer.folder
  return found
}

// The last `MAX_OUTPUT` characters, never starting in the middle of a character.
function tail(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  const cut = text.slice(-MAX_OUTPUT)
  const first = cut.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut
}

// Why a result could not be recorded, as a sentence for the Member.
function notRecorded(e: unknown): string {
  if (e instanceof RangeError) return 'The output was not recorded: it is too large.'
  if (!(e instanceof ApiError)) return 'The output was not recorded.'
  if (e.code === 'network') return 'The output was not recorded: the server cannot be reached.'
  if (e.code === 'closed' || e.code === 'board_not_open') return 'The output was not recorded: the Board was closed.'
  if (e.code === 'rejected') return 'The output was not recorded: this Run is no longer on its Page.'
  const said = e.message.trim()
  return said === '' ? 'The output was not recorded: the server did not accept it.' : `The output was not recorded: ${said.slice(0, MAX_MESSAGE)}`
}

const LOADING: RunnerSetup = { available: false, reason: 'loading' }
const BROWSER: RunnerSetup = { available: false, reason: 'browser' }
const OLD_APP: RunnerSetup = { available: false, reason: 'old_app' }
const GUEST: RunnerSetup = { available: false, reason: 'guest' }

export function createRuns(options: RunsOptions = {}) {
  const desktop = options.desktop ?? defaultDesktop
  const board = options.board ?? sync
  const previewing = options.previewing ?? historyPreviewing
  const requestFrame = options.requestFrame ?? defaultRequestFrame
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame
  const setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => globalThis.clearTimeout(h as number))
  const now = options.now ?? Date.now

  const store = createStore<RunsSnapshot>(() => ({ runner: LOADING, live: null, last: null }))

  let ownerKey: string | null | undefined // id and role of the session this state belongs to
  let runner: RunnerSetup = LOADING
  let found: Found | null = null // what `runner.status()` last said; null until it answered
  let detecting = 0
  let undetected = true // the status was not asked yet for this session
  let watchers = 0 // subscriptions to the store (mounted `useRuns()` hooks)
  let current: Execution | null = null
  let live: RunLive | null = null
  let last: RunOutcome | null = null
  let savingAgain = false

  function self(): Member | null {
    const s = sessionStore.getState()
    return s.status === 'signed_in' ? s.member : null
  }

  function publish() {
    const prev = store.getState()
    if (prev.runner !== runner || prev.live !== live || prev.last !== last) store.setState({ runner, live, last }, true)
  }

  // ---- the Runner ----

  // A Guest executes nothing, wherever they are: that is said before where the page runs.
  function setupNow(): RunnerSetup {
    const me = self()
    if (!me) return LOADING
    if (me.role === 'guest') return GUEST
    const bridge = desktop()
    if (!isRecord(bridge)) return BROWSER
    if (!runnerOf(bridge)) return OLD_APP
    return found === null ? LOADING : { available: true, ...found }
  }

  function applySetup() {
    const next = setupNow()
    if (JSON.stringify(next) !== JSON.stringify(runner)) runner = next
    publish()
  }

  // Never throws. A Runner whose `status()` fails is still a Runner: it reads as one with nothing chosen yet.
  async function refresh(): Promise<void> {
    const mine = ++detecting
    undetected = false
    const me = self()
    const bridge = me && me.role !== 'guest' ? runnerOf(desktop()) : null
    if (!bridge) {
      found = null
      applySetup()
      return
    }
    let next: Found
    try {
      next = readStatus(await bridge.status())
    } catch {
      next = {}
    }
    if (mine !== detecting) return
    found = next
    applySetup()
  }

  async function configure(): Promise<void> {
    const me = self()
    const bridge = me && me.role !== 'guest' ? runnerOf(desktop()) : null
    if (!bridge) return
    try {
      await bridge.configure()
    } catch {
      // the window could not be opened: the status is read again all the same
    }
    await refresh()
  }

  // ---- reading the Board ----

  // The live Run with this id on the open Board, optimistic edits included.
  function findRun(id: string): BlockVM | undefined {
    for (const list of board.store.getState().pages.blocks.values()) {
      for (const b of list) if (b.id === id) return b.type === 'run' ? b : undefined
    }
    return undefined
  }

  // ---- an execution ----

  function show(x: Execution) {
    if (x.hasFrame) cancelFrame(x.frame)
    x.hasFrame = false
    if (current !== x) return
    const next: RunLive = { block: x.block, branch: x.branch, state: x.state, output: x.output }
    if (x.startedAt !== undefined) next.startedAt = x.startedAt
    live = next
    publish()
  }

  function letGo(x: Execution) {
    x.over = true
    if (x.hasFrame) cancelFrame(x.frame)
    x.hasFrame = false
    if (x.grace !== null) clearTimer(x.grace)
    x.grace = null
  }

  // The execution has its outcome: it is shown as `last`, and the Runner's status is read again.
  function end(x: Execution, outcome: RunOutcome) {
    letGo(x)
    if (current === x) {
      current = null
      live = null
      last = outcome
      publish()
      void refresh()
    }
    x.finish()
  }

  function cancel(x: Execution) {
    Promise.resolve()
      .then(() => x.runner.cancel(x.id))
      .catch(() => {})
  }

  // The session ended or changed hands: the execution is stopped in the app, and what it captures is nobody's to
  // record — a result says who executed it, and that Member is gone from this window.
  function abandon() {
    const x = current
    if (!x) return
    letGo(x)
    cancel(x)
    current = null
    live = null
    x.finish()
  }

  // Why the result cannot be recorded right now, or null: it goes to the Branch the execution started on, on the
  // Run it was started from.
  function cannotRecord(block: string, branch: string, branchName: string): string | null {
    const t = board.internal.target()
    if (!t || t.id !== branch) {
      const where = branchName === '' ? 'that Branch' : branchName
      return `The output was not recorded: the Board no longer shows the Branch it was executed on. Open ${where} and save it again.`
    }
    return findRun(block) ? null : 'The output was not recorded: this Run is no longer on its Page.'
  }

  async function record(x: Execution, result: RunResult): Promise<RunOutcome> {
    const where = { block: x.block, branch: x.branch }
    const problem = cannotRecord(x.block, x.branch, x.branchName)
    if (problem !== null) return { ...where, status: 'unsaved', message: problem, unsaved: result }
    try {
      await board.submit([ops.setRunResult(x.block, result)])
    } catch (e) {
      return { ...where, status: 'unsaved', message: notRecorded(e), unsaved: result }
    }
    return { ...where, status: 'recorded' }
  }

  function failed(x: Execution, message: string): RunOutcome {
    const said = message.trim()
    return { block: x.block, branch: x.branch, status: 'failed', message: said === '' ? COULD_NOT_RUN : said.slice(0, MAX_MESSAGE) }
  }

  function onEvent(x: Execution, raw: unknown) {
    if (x.over || current !== x) return
    const event = toRunEvent(raw)
    if (!event) return
    if (event.type === 'approval') return // the state it starts in
    if (event.type === 'started') {
      if (x.state !== 'approval') return
      x.state = 'running'
      x.startedAt = now()
      show(x)
    } else if (event.type === 'output') {
      x.output = tail(x.output + event.text)
      if (!x.hasFrame) {
        x.hasFrame = true
        x.frame = requestFrame(() => {
          x.hasFrame = false
          show(x)
        })
      }
    } else if (event.type === 'error') {
      end(x, event.reason === 'declined' ? { block: x.block, branch: x.branch, status: 'declined' } : failed(x, event.message))
    } else {
      x.over = true
      const result = toRunResult(event, x.member, now())
      if (!result) {
        end(x, failed(x, UNREADABLE_RESULT))
        return
      }
      x.state = 'saving'
      show(x)
      void record(x, result).then((outcome) => end(x, outcome))
    }
  }

  // The bridge's promise settled. With a `done` or `error` read, nothing is left to do; without one the execution
  // failed — after a moment's grace, since the last event and the promise do not travel the same way.
  function settled(x: Execution) {
    if (x.over || current !== x || x.grace !== null) return
    x.grace = setTimer(() => {
      x.grace = null
      if (!x.over) end(x, failed(x, STOPPED_ANSWERING))
    }, GRACE_MS)
  }

  async function run(blockId: string): Promise<void> {
    const me = self()
    if (me?.role === 'guest') throw new ApiError(400, 'read_only', 'Guests cannot execute Runs.')
    if (previewing()) throw new ApiError(400, 'read_only', 'An earlier moment is shown. Go back to now to execute a Run.')
    const bridge = me ? runnerOf(desktop()) : null
    if (!me || !bridge) throw new ApiError(409, 'no_runner', 'Executing a Run needs the Qoop desktop app.')
    if (current) throw new ApiError(409, 'busy', 'Another Run is being executed in this window.')
    const target = board.internal.target()
    const block = target ? findRun(blockId) : undefined
    if (!target || !block) throw new ApiError(404, 'not_found', 'There is no such Run on the open Board.')
    if (block.text.trim() === '') throw new ApiError(400, 'bad_request', 'This Run has no code yet.')

    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const x: Execution = {
      id: newId(),
      block: block.id,
      branch: target.id,
      branchName: board.store.getState().snapshot.branch?.name ?? '',
      member: me.id,
      runner: bridge,
      state: 'approval',
      output: '',
      startedAt: undefined,
      over: false,
      frame: null,
      hasFrame: false,
      grace: null,
      finish,
    }
    current = x
    last = null // the next execution starts: the last outcome, an unsaved result included, is let go
    show(x)
    const request = { id: x.id, code: block.text, title: block.title.trim() === '' ? 'Untitled Run' : block.title.trim() }
    Promise.resolve()
      .then(() => bridge.run(request, (event) => onEvent(x, event)))
      .then(
        () => settled(x),
        () => settled(x),
      )
    await finished
  }

  // Asks the app to stop; what it captured then arrives as a `done` and is recorded as a stopped result.
  function stop() {
    const x = current
    if (!x || x.over) return
    cancel(x)
  }

  async function saveAgain(): Promise<void> {
    const o = last
    if (!o || o.status !== 'unsaved' || !o.unsaved) throw new ApiError(400, 'bad_request', 'There is no output waiting to be recorded.')
    if (savingAgain) throw new ApiError(409, 'busy', 'The output is being recorded.')
    const t = board.internal.target()
    if (!t || t.id !== o.branch) throw new ApiError(400, 'board_not_open', 'Open the Branch this Run was executed on first.')
    if (!findRun(o.block)) throw new ApiError(404, 'not_found', 'This Run is no longer on its Page.')
    savingAgain = true
    try {
      await board.submit([ops.setRunResult(o.block, o.unsaved)])
    } catch (e) {
      if (last === o) {
        last = { ...o, message: notRecorded(e) }
        publish()
      }
      throw e
    } finally {
      savingAgain = false
    }
    if (last === o) {
      last = { block: o.block, branch: o.branch, status: 'recorded' }
      publish()
    }
  }

  function dismiss() {
    if (last === null) return
    last = null
    publish()
  }

  // ---- whose window ----

  function onSession(s: SessionSnapshot) {
    if (s.status === 'loading' && ownerKey !== undefined) return
    const key = s.status === 'signed_in' ? `${s.member.role === 'guest' ? 'guest' : 'member'}:${s.member.id}` : null
    if (key === ownerKey) return
    ownerKey = key
    abandon()
    last = null
    detecting++
    undetected = true
    found = null
    applySetup()
    detect()
  }

  // The status waits until someone looks: the first `useRuns()` (or a call to `refresh`) asks the app.
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

  function dispose() {
    unsubscribe()
    abandon()
  }

  return { store, api: { refresh, configure, run, stop, saveAgain, dismiss }, dispose }
}

export const runsSync = createRuns()

export const runs = runsSync.api

export function useRuns(): RunsSnapshot {
  return useStore(runsSync.store)
}
