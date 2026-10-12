import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { sha256Hex } from './code-hash'
import { ApiError } from './http'
import { ops } from './ops'
import { membersStore } from './people'
import { MAX_RESULT } from './run-result'
import { createRuns, GRACE_MS, STOPPED_ANSWERING } from './runs'
import type { RunsOptions } from './runs'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, TINY_PNG, fakeDesktop, fakeRunner, fakeRunResult, installDesktop, settle } from './testing'
import type { FakeRunner } from './testing'
import type { BlockVM, RunResult } from './types'

// Half of a character pair standing alone: what a careless cut leaves behind.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const CODE = 'import numpy as np\nprint(np.pi)\n'

let server: FakeServer
let timers: FakeTimers
let board: ReturnType<typeof createBoardSync>
let runner: FakeRunner
let desk: unknown
let previewing = false
let clock = 5000
let made: ReturnType<typeof createRuns>[] = []

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
let frames: ReturnType<typeof manualFrames>

function make(options: RunsOptions = {}) {
  const r = createRuns({
    desktop: () => desk,
    board,
    previewing: () => previewing,
    requestFrame: (fn) => frames.request(fn),
    cancelFrame: (h) => frames.cancel(h),
    setTimer: timers.set,
    clearTimer: timers.clear,
    now: () => clock,
    ...options,
  })
  made.push(r)
  return r
}

const snap = (r: ReturnType<typeof createRuns>) => r.store.getState()
const blockOf = (id = 'r1', card = 'a'): BlockVM => board.page(card).blocks.find((b) => b.id === id)!
const stored = (id = 'r1', branch?: string): RunResult | null => {
  const v = server.find(branch).entities[id]?.fields.result
  return typeof v === 'object' && 'Text' in v ? (JSON.parse(v.Text) as RunResult) : null
}
const opsPosts = () => server.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/ops'))
const caught = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('did not reject')
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

async function openBoard(name = 'main') {
  await board.open(name)
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.find(name).info.id, seq: server.find(name).log.length })
  await settle()
}

/** An instance in the desktop app, the Board open on main, where Card `a` holds the Run `r1` ("Sweep"). */
async function ready(options: RunsOptions = {}) {
  await openBoard()
  const r = make(options)
  await r.api.refresh()
  return r
}

/** Starts `r1` and waits until the fake Runner has been asked. */
async function start(r: ReturnType<typeof createRuns>, id = 'r1') {
  const running = r.api.run(id)
  await settle()
  return { running, x: runner.last() }
}

beforeEach(() => {
  server = new FakeServer()
  server.now = 100
  server.commit(
    [
      ops.createCard({ id: 'a', x: 0, y: 0, title: 'Threshold' }),
      ops.addBlock({ id: 'k1', card: 'a', text: 'Notes', order: 'G' }),
      ops.addBlock({ id: 'r1', card: 'a', type: 'run', text: CODE, title: 'Sweep', order: 'V' }),
      ops.addBlock({ id: 'r2', card: 'a', type: 'run', text: 'print(2)', order: 'k' }),
      ops.addBlock({ id: 'r3', card: 'a', type: 'run', text: '  \n', title: 'Empty', order: 'm' }),
    ],
    OTHER.id,
  )
  timers = new FakeTimers()
  frames = manualFrames()
  FakeSocket.all = []
  runner = fakeRunner()
  desk = fakeDesktop({ runner })
  previewing = false
  clock = 5000
  made = []
  vi.stubGlobal('fetch', server.fetch)
  membersStore.setState({ members: [] })
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  board = createBoardSync({ WebSocketCtor: FakeSocket, setTimer: timers.set, clearTimer: timers.clear, socketUrl: () => 'ws://test/api/ws' })
})

afterEach(() => {
  for (const r of made) r.dispose()
  board.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Runner', () => {
  const setupOf = async (options: RunsOptions = {}) => {
    const r = make(options)
    await r.api.refresh()
    return snap(r).runner
  }

  it('is loading until the session is known', async () => {
    sessionStore.setState({ status: 'loading' }, true)
    const r = make()
    expect(snap(r)).toEqual({ runner: { available: false, reason: 'loading' }, live: null, last: null })
    await r.api.refresh()
    expect(snap(r).runner).toEqual({ available: false, reason: 'loading' })
    expect(runner.statusCalls).toBe(0)
  })
  it('is `browser` without the desktop bridge', async () => {
    expect(await setupOf({ desktop: () => undefined })).toEqual({ available: false, reason: 'browser' })
  })
  it('is `old_app` for a bridge without a Runner, or with half of one', async () => {
    expect(await setupOf({ desktop: () => fakeDesktop({ runner: false }) })).toEqual({ available: false, reason: 'old_app' })
    expect(await setupOf({ desktop: () => ({ version: '0.7.0', runner: { status: async () => ({}) } }) })).toEqual({ available: false, reason: 'old_app' })
  })
  it('is `guest` for a Guest, in the app and in a browser, without asking the app', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(await setupOf()).toEqual({ available: false, reason: 'guest' })
    expect(await setupOf({ desktop: () => undefined })).toEqual({ available: false, reason: 'guest' })
    expect(runner.statusCalls).toBe(0)
  })
  it('is available with what the app says: the interpreter and the folder', async () => {
    expect(await setupOf()).toEqual({ available: true, python: { path: '/usr/bin/python3', version: '3.12.3' } })
    runner.folder = '/Users/ana/qec'
    expect(await setupOf()).toEqual({ available: true, python: { path: '/usr/bin/python3', version: '3.12.3' }, folder: '/Users/ana/qec' })
    runner.python = null
    runner.folder = undefined
    expect(await setupOf()).toEqual({ available: true })
  })
  it('is still available when the status cannot be read, and reads an odd answer defensively', async () => {
    runner.statusFails = true
    expect(await setupOf()).toEqual({ available: true })
    const odd = { ...fakeRunner(), status: async () => ({ python: { path: 5 }, folder: '' }) as never }
    expect(await setupOf({ desktop: () => ({ runner: odd }) })).toEqual({ available: true })
  })
  it('asks nothing until someone looks; the first subscription asks the app once', async () => {
    const r = make()
    expect(runner.statusCalls).toBe(0)
    expect(snap(r).runner).toEqual({ available: false, reason: 'loading' })
    const off = r.store.subscribe(() => {})
    const off2 = r.store.subscribe(() => {})
    await settle()
    expect(runner.statusCalls).toBe(1)
    expect(snap(r).runner).toMatchObject({ available: true })
    off()
    off2()
  })
  it('keeps the same object when a refresh brings nothing new', async () => {
    const r = make()
    await r.api.refresh()
    const before = snap(r)
    await r.api.refresh()
    expect(snap(r)).toBe(before)
  })
  it('configure opens the settings window of the app and reads the status again', async () => {
    const r = make()
    await r.api.refresh()
    runner.onConfigure = () => {
      runner.python = { path: '/opt/conda/bin/python', version: '3.11.9' }
    }
    await r.api.configure()
    expect(runner.configureCalls).toBe(1)
    expect(snap(r).runner).toEqual({ available: true, python: { path: '/opt/conda/bin/python', version: '3.11.9' } })
  })
  it('configure does nothing without a Runner, and survives a window that cannot open', async () => {
    const browser = make({ desktop: () => undefined })
    await browser.api.configure()
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await make().api.configure()
    expect(runner.configureCalls).toBe(0)
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    const r = make()
    runner.configure = async () => {
      throw new Error('no window')
    }
    await expect(r.api.configure()).resolves.toBeUndefined()
    expect(snap(r).runner).toMatchObject({ available: true })
  })
  it('follows the session: a Guest after a Member, a Member after signing out', async () => {
    const r = make()
    await r.api.refresh()
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(snap(r).runner).toEqual({ available: false, reason: 'guest' })
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(snap(r).runner).toEqual({ available: false, reason: 'loading' })
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    await r.api.refresh()
    expect(snap(r).runner).toMatchObject({ available: true })
  })
  it('reads the bridge from the page by default', async () => {
    const uninstall = installDesktop(fakeDesktop({ runner }))
    try {
      const r = createRuns({ board })
      made.push(r)
      await r.api.refresh()
      expect(snap(r).runner).toMatchObject({ available: true })
      uninstall()
      await r.api.refresh()
      expect(snap(r).runner).toEqual({ available: false, reason: 'browser' })
    } finally {
      uninstall()
    }
  })
})

describe('an execution', () => {
  it('runs the present code of the Run, mirrors the app, and records the result on the Branch', async () => {
    const r = await ready()
    const states: (string | null)[] = []
    r.store.subscribe((s) => states.push(s.live?.state ?? null))
    const { running, x } = await start(r)
    expect(x.request).toEqual({ id: expect.any(String), code: CODE, title: 'Sweep' })
    expect(snap(r).live).toEqual({ block: 'r1', branch: 'main-id', state: 'approval', output: '' })
    x.approval()
    expect(snap(r).live!.state).toBe('approval')
    clock = 6000
    x.start()
    expect(snap(r).live).toEqual({ block: 'r1', branch: 'main-id', state: 'running', output: '', startedAt: 6000 })
    x.write('3.14159\n')
    frames.run()
    expect(snap(r).live!.output).toBe('3.14159\n')
    clock = 9000
    x.done({ duration_ms: 2900, figures: [{ png: TINY_PNG }], env: { python: '3.12.3', packages: { numpy: '2.1.0' }, os: 'macos', arch: 'arm64' } })
    expect(snap(r).live).toMatchObject({ state: 'saving', output: '3.14159\n' })
    await running
    expect(snap(r).live).toBeNull()
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'recorded' })
    const want: RunResult = {
      v: 1,
      by: ME.id,
      at: 9000,
      code_sha256: sha256Hex(CODE),
      exit: 0,
      duration_ms: 2900,
      output: '3.14159\n',
      figures: [{ png: TINY_PNG }],
      env: { python: '3.12.3', packages: { numpy: '2.1.0' }, os: 'macos', arch: 'arm64' },
    }
    expect(stored()).toEqual(want)
    expect(blockOf().run).toEqual({ result: want, broken: false })
    expect(server.log.at(-1)).toMatchObject({ author: ME.id, op: { Set: { entity: 'r1', field: 'result' } } })
    expect(opsPosts()).toHaveLength(1)
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(['approval', 'running', 'saving', null])
  })
  it('executes the code as it is on the Board at that moment, an edit not yet confirmed included', async () => {
    const r = await ready()
    server.gate = new Promise(() => {})
    void board.submit([ops.setBlockText('r1', 'print("edited")'), ops.setBlockTitle('r1', '')]).catch(() => {})
    const { x } = await start(r)
    expect(x.request).toMatchObject({ code: 'print("edited")', title: 'Untitled Run' })
  })
  it('takes the code hash from the app, not from the code it sent', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    x.done({ code_sha256: sha256Hex('what the app really executed') })
    await running
    expect(stored()!.code_sha256).toBe(sha256Hex('what the app really executed'))
  })
  it('goes straight to running when the app does not ask (code approved before)', async () => {
    const r = await ready()
    runner.script = (x) => {
      x.start()
      x.write('ok\n')
      x.done()
    }
    await r.api.run('r1')
    expect(snap(r).last).toMatchObject({ status: 'recorded' })
    expect(stored()).toMatchObject({ output: 'ok\n', exit: 0 })
    expect('stopped' in stored()!).toBe(false)
    expect('output_truncated' in stored()!).toBe(false)
  })
  it('waits at the approval for as long as the Member takes', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.approval()
    let ended = false
    void running.then(() => (ended = true))
    await settle()
    expect(ended).toBe(false)
    expect(snap(r).live).toEqual({ block: 'r1', branch: 'main-id', state: 'approval', output: '' })
    expect(snap(r).last).toBeNull()
    x.start()
    x.done()
    await running
    expect(snap(r).last!.status).toBe('recorded')
  })
  it('records a failed execution like any other: the exit code and the traceback are the result', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    x.write('Traceback (most recent call last):\nZeroDivisionError\n')
    x.done({ exit: 1 })
    await running
    expect(snap(r).last!.status).toBe('recorded')
    expect(stored()).toMatchObject({ exit: 1, output: 'Traceback (most recent call last):\nZeroDivisionError\n' })
  })
  it('reads the status of the Runner again after every execution', async () => {
    const r = await ready()
    const calls = runner.statusCalls
    runner.script = (x) => x.error('declined')
    await r.api.run('r1')
    await settle()
    expect(runner.statusCalls).toBe(calls + 1)
  })
  it('clears the last outcome when the next execution starts', async () => {
    const r = await ready()
    runner.script = (x) => x.error('failed', 'Python crashed.')
    await r.api.run('r1')
    expect(snap(r).last!.status).toBe('failed')
    runner.script = null
    const { running, x } = await start(r)
    expect(snap(r).last).toBeNull()
    x.error('declined')
    await running
  })
  it('ignores what the app says after the end, and what is not an event', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.emit(null)
    x.emit({ type: 'progress', value: 3 })
    x.start()
    x.emit({ type: 'done', exit: 0, stopped: false, duration_ms: 1, code_sha256: sha256Hex(CODE), output: 'first', output_truncated: false, figures: [], env: {} })
    x.emit({ type: 'output', text: 'late' })
    x.emit({ type: 'error', reason: 'failed', message: 'late' })
    x.end()
    await running
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'recorded' })
    expect(stored()!.output).toBe('first')
    expect(opsPosts()).toHaveLength(1)
  })
})

describe('live output', () => {
  it('publishes at most once per animation frame, however many events arrive', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    let updates = 0
    r.store.subscribe(() => updates++)
    for (let i = 0; i < 50; i++) x.write(`line ${i}\n`)
    expect(frames.requested).toBe(1)
    expect(updates).toBe(0)
    expect(snap(r).live!.output).toBe('')
    frames.run()
    expect(updates).toBe(1)
    expect(snap(r).live!.output.split('\n')).toHaveLength(51)
    for (let i = 0; i < 50; i++) x.write('more\n')
    expect(frames.requested).toBe(2)
    frames.run()
    expect(updates).toBe(2)
    frames.run()
    expect(updates).toBe(2)
    x.done()
    await running
  })
  it('keeps only the last 64 000 characters of the live output', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    x.write('HEAD' + 'a'.repeat(40_000))
    x.write('b'.repeat(40_000) + 'TAIL')
    frames.run()
    const out = snap(r).live!.output
    expect(out).toHaveLength(64_000)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(out.startsWith('a')).toBe(true)
    x.write('😀'.repeat(32_000) + 'x')
    frames.run()
    expect(snap(r).live!.output.length).toBeLessThanOrEqual(64_000)
    expect(snap(r).live!.output).not.toMatch(LONE_SURROGATE)
    // What is recorded is the app's own (already shortened) output, not the live tail.
    x.done({ output: 'HEAD\n… 50 000 characters left out …\nTAIL', output_truncated: true })
    await running
    expect(stored()).toMatchObject({ output: 'HEAD\n… 50 000 characters left out …\nTAIL', output_truncated: true })
  })
  it('shows the whole output at once when the execution ends, without waiting for a frame', async () => {
    const r = await ready()
    server.gate = deferred().promise
    const { x } = await start(r)
    x.start()
    x.write('never painted\n')
    expect(frames.waiting).toBe(1)
    x.done()
    expect(snap(r).live).toMatchObject({ state: 'saving', output: 'never painted\n' })
    expect(frames.waiting).toBe(0)
  })
  it('takes output that arrives before `started`', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.write('warming up\n')
    frames.run()
    expect(snap(r).live).toEqual({ block: 'r1', branch: 'main-id', state: 'approval', output: 'warming up\n' })
    x.error('declined')
    await running
  })
})

describe('stop', () => {
  it('asks the app to stop; what it captured is recorded as a stopped result', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    x.write('step 1\nstep 2\n')
    r.api.stop()
    await running
    expect(runner.cancelled).toEqual([x.request.id])
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'recorded' })
    expect(stored()).toMatchObject({ exit: null, stopped: true, output: 'step 1\nstep 2\n', figures: [] })
  })
  it('at the approval ends as the app says: declined', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.approval()
    r.api.stop()
    await running
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'declined' })
    expect(opsPosts()).toHaveLength(0)
  })
  it('does nothing without an execution, and nothing while the result is being recorded', async () => {
    const r = await ready()
    r.api.stop()
    expect(runner.cancelled).toEqual([])
    const gate = deferred()
    server.gate = gate.promise
    const { running, x } = await start(r)
    x.start()
    x.done()
    expect(snap(r).live!.state).toBe('saving')
    r.api.stop()
    await settle()
    expect(runner.cancelled).toEqual([])
    gate.release()
    await running
    expect(snap(r).last!.status).toBe('recorded')
  })
  it('keeps waiting for an app that does not react, and survives a cancel that fails', async () => {
    const r = await ready()
    runner.cancelStops = false
    const { running, x } = await start(r)
    x.start()
    r.api.stop()
    await settle()
    expect(snap(r).live!.state).toBe('running')
    runner.cancel = async () => {
      throw new Error('no such run')
    }
    r.api.stop()
    await settle()
    x.done({ exit: null, stopped: true })
    await running
    expect(stored()).toMatchObject({ stopped: true })
  })
})

describe('when the app does not run it', () => {
  it('declined: says so, without a message, and records nothing', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.approval()
    x.error('declined', 'The Member chose not to run it.')
    await running
    expect(snap(r)).toMatchObject({ live: null, last: { block: 'r1', branch: 'main-id', status: 'declined' } })
    expect(snap(r).last).not.toHaveProperty('message')
    expect(stored()).toBeNull()
  })
  it.each([
    ['no_python', 'Choose a Python interpreter in the Runner settings first.'],
    ['busy', 'Another Run is being executed on this computer.'],
    ['failed', 'Python could not be started.'],
  ] as const)('%s: failed, with the sentence of the app', async (reason, message) => {
    const r = await ready()
    const { running, x } = await start(r)
    x.error(reason, message)
    await running
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'failed', message })
    expect(stored()).toBeNull()
  })
  it('failed without a sentence still says something; an unknown reason reads as failed', async () => {
    const r = await ready()
    const first = await start(r)
    first.x.error('failed', '  ')
    await first.running
    expect(snap(r).last).toMatchObject({ status: 'failed', message: 'The Run could not be executed.' })
    const second = await start(r)
    second.x.emit({ type: 'error', reason: 'meltdown', message: 'Something new.' })
    second.x.end()
    await second.running
    expect(snap(r).last).toMatchObject({ status: 'failed', message: 'Something new.' })
  })
  it('a bridge that ends without done or error: failed, after a moment of grace', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    x.write('half\n')
    x.end()
    await settle()
    expect(snap(r).live!.state).toBe('running') // the last event may still be on its way
    expect(timers.delays.at(-1)).toBe(GRACE_MS)
    timers.fireNext()
    await running
    expect(snap(r)).toMatchObject({ live: null, last: { block: 'r1', branch: 'main-id', status: 'failed', message: STOPPED_ANSWERING } })
    expect(STOPPED_ANSWERING).toBe('The Runner stopped answering.')
    expect(stored()).toBeNull()
  })
  it('a done that arrives just after the promise settled still counts', async () => {
    const r = await ready()
    // The page keeps its callback after the promise resolved: play the last event being overtaken by it.
    let toPage: (event: unknown) => void = () => {}
    const run = runner.run
    runner.run = (request, onEvent) => {
      toPage = onEvent as (event: unknown) => void
      return run(request, onEvent)
    }
    const { running, x } = await start(r)
    x.start()
    x.end()
    await settle()
    expect(timers.pending).toHaveLength(1)
    toPage({ type: 'done', exit: 0, stopped: false, duration_ms: 1, code_sha256: sha256Hex(CODE), output: 'late but whole', output_truncated: false, figures: [], env: {} })
    await running
    expect(snap(r).last!.status).toBe('recorded')
    expect(stored()!.output).toBe('late but whole')
    expect(timers.pending).toHaveLength(0)
  })
  it('a bridge whose promise rejects: failed, never in the words of the bridge', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.reject(new Error('IPC channel closed: token=abc'))
    await settle()
    timers.fireNext()
    await running
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'failed', message: 'The Runner stopped answering.' })
  })
  it('a bridge that throws at once: failed', async () => {
    const r = await ready()
    runner.run = () => {
      throw new Error('not a function, really')
    }
    const running = r.api.run('r1')
    await settle()
    timers.fireNext()
    await running
    expect(snap(r).last).toMatchObject({ status: 'failed', message: 'The Runner stopped answering.' })
  })
  it('a done that cannot be a result: failed, nothing sent to the server', async () => {
    const r = await ready()
    const first = await start(r)
    first.x.start()
    first.x.done({ code_sha256: 'not-a-hash' })
    await first.running
    expect(snap(r).last).toMatchObject({ status: 'failed', message: 'The Runner sent a result that cannot be read.' })
    const second = await start(r)
    second.x.emit({ type: 'done', exit: 0 })
    second.x.end()
    await second.running
    expect(snap(r).last).toMatchObject({ status: 'failed', message: 'The Runner sent a result that cannot be read.' })
    expect(opsPosts()).toHaveLength(0)
  })
})

describe('when it cannot start', () => {
  it('one at a time per window: 409 busy while another is in flight, in any state', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    expect(await caught(r.api.run('r2'))).toMatchObject({ status: 409, code: 'busy' })
    expect(await caught(r.api.run('r1'))).toMatchObject({ status: 409, code: 'busy' })
    x.start()
    expect(await caught(r.api.run('r2'))).toMatchObject({ status: 409, code: 'busy' })
    const gate = deferred()
    server.gate = gate.promise
    x.done()
    expect(snap(r).live!.state).toBe('saving')
    expect(await caught(r.api.run('r2'))).toMatchObject({ status: 409, code: 'busy' })
    gate.release()
    await running
    expect(runner.executions).toHaveLength(1)
    runner.script = (e) => e.error('declined')
    await r.api.run('r2')
    expect(runner.executions).toHaveLength(2)
    expect(runner.last().request).toMatchObject({ code: 'print(2)', title: 'Untitled Run' })
  })
  it('409 no_runner in a browser, in an old app, and while signed out', async () => {
    await openBoard()
    expect(await caught(make({ desktop: () => undefined }).api.run('r1'))).toMatchObject({ status: 409, code: 'no_runner' })
    expect(await caught(make({ desktop: () => fakeDesktop({ runner: false }) }).api.run('r1'))).toMatchObject({ status: 409, code: 'no_runner' })
    const r = make()
    sessionStore.setState({ status: 'loading' }, true)
    expect(await caught(r.api.run('r1'))).toMatchObject({ status: 409, code: 'no_runner' })
    expect(runner.executions).toHaveLength(0)
  })
  it('400 read_only for a Guest, even inside the app', async () => {
    server.actor = GUEST
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    const r = await ready()
    expect(blockOf().type).toBe('run') // a Guest reads the Run
    expect(await caught(r.api.run('r1'))).toMatchObject({ status: 400, code: 'read_only' })
    expect(await caught(make({ desktop: () => undefined }).api.run('r1'))).toMatchObject({ status: 400, code: 'read_only' })
    expect(runner.executions).toHaveLength(0)
    expect(snap(r)).toEqual({ runner: { available: false, reason: 'guest' }, live: null, last: null })
  })
  it('400 read_only while a moment in History is previewed: what is shown is not the present code', async () => {
    const r = await ready()
    previewing = true
    expect(await caught(r.api.run('r1'))).toMatchObject({ status: 400, code: 'read_only' })
    expect(runner.executions).toHaveLength(0)
    previewing = false
    runner.script = (x) => x.error('declined')
    await expect(r.api.run('r1')).resolves.toBeUndefined()
  })
  it('404 not_found: no Board, an unknown id, a block that is not a Run, a removed Run, a Run of a removed Card', async () => {
    const closed = make()
    expect(await caught(closed.api.run('r1'))).toMatchObject({ status: 404, code: 'not_found' })
    const r = await ready()
    expect(await caught(r.api.run('nope'))).toMatchObject({ status: 404, code: 'not_found' })
    expect(await caught(r.api.run('k1'))).toMatchObject({ status: 404, code: 'not_found' })
    await board.submit([ops.remove('r2')])
    expect(await caught(r.api.run('r2'))).toMatchObject({ status: 404, code: 'not_found' })
    await board.submit([ops.remove('a')])
    expect(await caught(r.api.run('r1'))).toMatchObject({ status: 404, code: 'not_found' })
    expect(runner.executions).toHaveLength(0)
  })
  it('400 bad_request for a Run without code', async () => {
    const r = await ready()
    expect(await caught(r.api.run('r3'))).toMatchObject({ status: 400, code: 'bad_request' })
    expect(snap(r).live).toBeNull()
  })
  it('leaves the last outcome alone when it cannot start', async () => {
    const r = await ready()
    runner.script = (x) => x.error('failed', 'Broken.')
    await r.api.run('r1')
    const before = snap(r)
    await caught(r.api.run('r3'))
    expect(snap(r)).toBe(before)
  })
})

describe('when the result cannot be recorded', () => {
  const finish = async (r: ReturnType<typeof createRuns>, between: () => Promise<void> | void) => {
    const { running, x } = await start(r)
    x.start()
    x.write('42\n')
    await between()
    x.done()
    await running
    return snap(r).last!
  }

  it('the Board shows another Branch: unsaved, kept in memory, and nothing is written anywhere', async () => {
    server.fork('try', { branch: 'main-id', seq: server.seq })
    const r = await ready()
    const last = await finish(r, () => openBoard('try'))
    expect(last).toMatchObject({ block: 'r1', branch: 'main-id', status: 'unsaved' })
    expect(last.message).toBe('The output was not recorded: the Board no longer shows the Branch it was executed on. Open main and save it again.')
    expect(last.unsaved).toMatchObject({ v: 1, by: ME.id, output: '42\n', code_sha256: sha256Hex(CODE) })
    expect(opsPosts()).toHaveLength(0)
    expect(stored('r1', 'try')).toBeNull() // the same Run exists on `try`: it must not get the result
    expect(stored()).toBeNull()
    expect(blockOf().run!.result).toBeNull()
  })
  it('saveAgain needs that Branch open again, then records it', async () => {
    server.fork('try', { branch: 'main-id', seq: server.seq })
    const r = await ready()
    const last = await finish(r, () => openBoard('try'))
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'board_not_open' })
    expect(snap(r).last).toBe(last)
    board.close()
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'board_not_open' })
    await openBoard('main')
    await r.api.saveAgain()
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'recorded' })
    expect(stored()).toEqual(last.unsaved)
    expect(stored('r1', 'try')).toBeNull()
  })
  it('the Board was closed: unsaved', async () => {
    const r = await ready()
    const last = await finish(r, () => board.close())
    expect(last).toMatchObject({ status: 'unsaved', unsaved: { output: '42\n' } })
    expect(last.message).toContain('Open main and save it again.')
  })
  it('the Run was removed meanwhile: unsaved; saveAgain works once it is back', async () => {
    const r = await ready()
    const last = await finish(r, () => board.submit([ops.remove('r1')]))
    expect(last).toMatchObject({ status: 'unsaved', message: 'The output was not recorded: this Run is no longer on its Page.' })
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 404, code: 'not_found' })
    await board.submit([ops.restore('r1')])
    await r.api.saveAgain()
    expect(snap(r).last!.status).toBe('recorded')
    expect(stored()).toMatchObject({ output: '42\n' })
  })
  it('the Run was removed by someone else just before the result arrived: unsaved', async () => {
    const r = await ready()
    const last = await finish(r, () => {
      FakeSocket.last().receive(server.external([ops.remove('r1')]))
    })
    expect(last).toMatchObject({ status: 'unsaved', message: 'The output was not recorded: this Run is no longer on its Page.' })
  })
  it('the server refuses: unsaved with the sentence of the server; the optimistic result is taken back', async () => {
    const r = await ready()
    // The server sees another Member than the page believes: `by` is not who sends it.
    const last = await finish(r, () => {
      server.actor = OTHER
    })
    expect(last.status).toBe('unsaved')
    expect(last.message).toBe('The output was not recorded: A result is recorded by the Member who executed the Run.')
    expect(blockOf().run).toEqual({ result: null, broken: false })
    expect(stored()).toBeNull()
    server.actor = ME
    await r.api.saveAgain()
    expect(stored()).toEqual(last.unsaved)
  })
  it('the server cannot be reached: unsaved; saveAgain rejects like board.submit while it stays so, then records', async () => {
    const r = await ready()
    const last = await finish(r, () => {
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('offline')
      })
    })
    expect(last).toMatchObject({ status: 'unsaved', message: 'The output was not recorded: the server cannot be reached.' })
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 0, code: 'network' })
    expect(snap(r).last).toMatchObject({ status: 'unsaved', unsaved: last.unsaved })
    vi.stubGlobal('fetch', server.fetch)
    server.failNext = { status: 500, code: 'internal' }
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 500 })
    expect(snap(r).last!.message).toBe('The output was not recorded: nope')
    await r.api.saveAgain()
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'recorded' })
    expect(stored()).toEqual(last.unsaved)
  })
  it('the Branch was switched while the result was on its way: unsaved', async () => {
    server.fork('try', { branch: 'main-id', seq: server.seq })
    const r = await ready()
    server.gate = new Promise(() => {})
    const { running, x } = await start(r)
    x.start()
    x.done()
    expect(snap(r).live!.state).toBe('saving')
    server.gate = null
    await openBoard('try')
    await running
    expect(snap(r).last).toMatchObject({ status: 'unsaved', branch: 'main-id', message: 'The output was not recorded: the Board was closed.' })
  })
  it('saveAgain rejects 400 bad_request when there is nothing unsaved', async () => {
    const r = await ready()
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'bad_request' })
    runner.script = (x) => {
      x.start()
      x.done()
    }
    await r.api.run('r1')
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'bad_request' })
    runner.script = (x) => x.error('failed', 'x')
    await r.api.run('r1')
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'bad_request' })
  })
  it('saveAgain twice at once sends one request', async () => {
    const r = await ready()
    await finish(r, () => board.submit([ops.remove('r1')]))
    await board.submit([ops.restore('r1')])
    const posts = opsPosts().length
    const gate = deferred()
    server.gate = gate.promise
    const first = r.api.saveAgain()
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 409, code: 'busy' })
    gate.release()
    await first
    expect(opsPosts()).toHaveLength(posts + 1)
  })
  it('dismiss clears the last outcome, an unsaved result with it', async () => {
    const r = await ready()
    await finish(r, () => board.close())
    expect(snap(r).last!.unsaved).toBeDefined()
    r.api.dismiss()
    expect(snap(r).last).toBeNull()
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'bad_request' })
    const before = snap(r)
    r.api.dismiss()
    expect(snap(r)).toBe(before)
  })
  it('dismiss during saveAgain: the result is still recorded, the outcome stays dismissed', async () => {
    const r = await ready()
    await finish(r, () => board.submit([ops.remove('r1')]))
    await board.submit([ops.restore('r1')])
    const gate = deferred()
    server.gate = gate.promise
    const saving = r.api.saveAgain()
    r.api.dismiss()
    gate.release()
    await saving
    expect(snap(r).last).toBeNull()
    expect(stored()).toMatchObject({ output: '42\n' })
  })
  it('starting the next execution lets an unsaved result go', async () => {
    const r = await ready()
    await finish(r, () => board.close())
    await openBoard()
    const { running, x } = await start(r, 'r2')
    expect(snap(r).last).toBeNull()
    x.error('declined')
    await running
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'bad_request' })
  })
  it('makes a result with many escapes fit the limit of the server instead of losing it', async () => {
    const r = await ready()
    const fig = { png: TINY_PNG.slice(0, 12) + 'A'.repeat(159_988) }
    const { running, x } = await start(r)
    x.start()
    x.done({ output: `BEGIN${'\u001b'.repeat(63_000)}END`, figures: [fig, fig, fig] })
    await running
    expect(snap(r).last).toEqual({ block: 'r1', branch: 'main-id', status: 'recorded' })
    const text = (server.entities.r1!.fields.result as { Text: string }).Text
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT)
    const saved = stored()!
    expect(saved.figures).toHaveLength(3)
    expect(saved.output_truncated).toBe(true)
    expect(saved.output.startsWith('BEGIN')).toBe(true)
    expect(saved.output.endsWith('END')).toBe(true)
  })
  it('never touches localStorage or sessionStorage', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const r = await ready()
    await finish(r, () => board.close())
    await openBoard()
    await r.api.saveAgain()
    expect(set).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('the session during an execution', () => {
  it('signing out stops it in the app and lets go of everything', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    x.write('secret\n')
    sessionStore.setState({ status: 'signed_out' }, true)
    await running
    await settle()
    expect(runner.cancelled).toEqual([x.request.id])
    expect(snap(r)).toEqual({ runner: { available: false, reason: 'loading' }, live: null, last: null })
    // The app's stopped `done` arrived after the session ended: it is nobody's to record.
    expect(x.ended).toBe(true)
    expect(opsPosts()).toHaveLength(0)
    expect(frames.waiting).toBe(0)
  })
  it('another Member signing in does not inherit an unsaved result', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    board.close()
    x.done()
    await running
    expect(snap(r).last!.status).toBe('unsaved')
    sessionStore.setState({ status: 'signed_in', member: OTHER }, true)
    expect(snap(r).last).toBeNull()
    expect(await caught(r.api.saveAgain())).toMatchObject({ status: 400, code: 'bad_request' })
  })
  it('signing out while the result is being recorded drops the outcome', async () => {
    const r = await ready()
    server.gate = new Promise(() => {})
    const { running, x } = await start(r)
    x.start()
    x.done()
    expect(snap(r).live!.state).toBe('saving')
    sessionStore.setState({ status: 'signed_out' }, true)
    await running
    await settle()
    expect(snap(r)).toMatchObject({ live: null, last: null })
  })
  it('a new execution can start for the next Member', async () => {
    const r = await ready()
    const { running } = await start(r)
    sessionStore.setState({ status: 'signed_out' }, true)
    await running
    server.actor = OTHER
    sessionStore.setState({ status: 'signed_in', member: OTHER }, true)
    await openBoard()
    runner.script = (x) => {
      x.start()
      x.done()
    }
    await r.api.run('r2')
    expect(snap(r).last).toEqual({ block: 'r2', branch: 'main-id', status: 'recorded' })
    expect(stored('r2')!.by).toBe(OTHER.id)
  })
  it('dispose stops an execution in flight', async () => {
    const r = await ready()
    const { running, x } = await start(r)
    x.start()
    r.dispose()
    await running
    await settle()
    expect(runner.cancelled).toEqual([x.request.id])
  })
})

describe('the fake server and Runs', () => {
  const post = async (list: unknown[]) => {
    const res = await server.fetch('/api/branches/main-id/ops', { method: 'POST', body: JSON.stringify({ ops: list }) })
    return { status: res.status, body: JSON.parse(await res.text()) as { error?: { code: string; message: string } } }
  }
  const good = fakeRunResult(CODE, { output: 'ok' })
  const setRaw = (entity: string, text: string) => ({ Set: { entity, field: 'result', value: { Text: text } } })

  it('takes a result from its Member on a Run, and Null from anyone', async () => {
    expect((await post([ops.setRunResult('r1', good)])).status).toBe(200)
    expect(stored()).toEqual(good)
    server.actor = OTHER
    expect((await post([ops.setRunResult('r1', null)])).status).toBe(200)
    expect(stored()).toBeNull()
  })
  it('takes a Run created with its result, and a block that becomes a Run in the same batch', async () => {
    const create = ops.addBlock({ id: 'r9', card: 'a', type: 'run', text: CODE, order: 'z' })
    expect((await post([create, ops.setRunResult('r9', good)])).status).toBe(200)
    expect((await post([{ Set: { entity: 'k1', field: 'type', value: { Text: 'run' } } }, ops.setRunResult('k1', good)])).status).toBe(200)
  })
  it.each([
    ['text that is not JSON', setRaw('r1', 'hello')],
    ['another shape', setRaw('r1', JSON.stringify({ ...good, v: 2 }))],
    ['an unknown key', setRaw('r1', JSON.stringify({ ...good, note: 'x' }))],
    ['a result by someone else', setRaw('r1', JSON.stringify({ ...good, by: OTHER.id }))],
    ['a result on a text block', setRaw('k1', JSON.stringify(good))],
    ['a result on a Card', setRaw('a', JSON.stringify(good))],
    ['a text over the limit', setRaw('r1', JSON.stringify(good) + ' '.repeat(600_000))],
    ['a number', { Set: { entity: 'r1', field: 'result', value: { Float: 1 } } }],
  ])('refuses %s with 400 bad_request and a sentence', async (_what, op) => {
    const before = server.seq
    const answer = await post([op])
    expect(answer.status).toBe(400)
    expect(answer.body.error).toMatchObject({ code: 'bad_request' })
    expect(answer.body.error!.message).toMatch(/\.$/)
    expect(server.seq).toBe(before)
  })
})
