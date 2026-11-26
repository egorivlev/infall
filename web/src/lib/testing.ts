// Test helpers: a fake infall server (fetch + WebSocket) and a manual timer. Not exported from index.ts.
import { groupShapes } from './activities'
import { applyOps } from './board-state'
import type { Entities } from './board-state'
import type { SocketLike } from './board-sync'
import { sha256Hex } from './code-hash'
import { isEnvName, isLangId } from './run-lang'
import { FakePdfStore } from './files.fake'
export { FakePdfStore, contentHash, tinyPdf } from './files.fake'
import { checkRunResult, MAX_RESULT } from './run-result'
import type {
  AccessToken,
  AiEvent,
  AiModel,
  BranchInfo,
  Change,
  Checkpoint,
  ClientFrame,
  Comment,
  Conflict,
  ConflictKey,
  Decision,
  ForYouItem,
  GraphActivity,
  GraphBranch,
  GraphResponse,
  ImportResult,
  Invite,
  Member,
  MergePlan,
  Moment,
  Op,
  Origin,
  InfallDesktop,
  InfallRunner,
  RunEvent,
  RunResult,
  RunUsage,
  RunnerLanguage,
  Value,
  ServerFrame,
  Suggestion,
  Todo,
} from './types'

export const ME: Member = { id: 'me', name: 'Me', role: 'member', color: '#111' }
export const OTHER: Member = { id: 'other', name: 'Other', role: 'member', color: '#222' }
export const GUEST: Member = { id: 'guest', name: 'Guest', role: 'guest', color: '#333' }

/** The shared fixture of the Activity rule (docs/specs/branch-graph-activities.json), read by the server's tests too. */
export type ActivityFixture = {
  cases: {
    name: string
    gap_ms: number
    checkpoints: number[]
    changes: Change[]
    expected: GraphActivity[]
  }[]
}

export async function loadActivityFixture(): Promise<ActivityFixture> {
  const { readFileSync } = await import('node:fs')
  return JSON.parse(readFileSync(`${process.cwd()}/../docs/specs/branch-graph-activities.json`, 'utf8')) as ActivityFixture
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  url: string
  sent: ClientFrame[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  receive(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.onclose?.()
  }
  static last(): FakeSocket {
    const s = FakeSocket.all[FakeSocket.all.length - 1]
    if (!s) throw new Error('no socket')
    return s
  }
}

export class FakeTimers {
  pending: { id: number; fn: () => void; ms: number }[] = []
  delays: number[] = []
  private next = 1
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++
    this.pending.push({ id, fn, ms })
    this.delays.push(ms)
    return id
  }
  clear = (h: unknown): void => {
    this.pending = this.pending.filter((t) => t.id !== h)
  }
  fireNext(): void {
    const t = this.pending.shift()
    if (!t) throw new Error('no timer')
    t.fn()
  }
}

export type Logged = { method: string; path: string; body: unknown }

/** One step of a scripted AI answer: an event (sent as a `data:` line), bytes as they are, or a pause. */
export type AiStep = AiEvent | { raw: string } | { wait: Promise<void> }

export type FakeRun = {
  request: Parameters<InfallDesktop['claude']['send']>[0]
  ended: boolean
  /** Hands an event to the page as the app would (anything can be passed, to play a misbehaving app). */
  emit(event: unknown): void
  end(): void
  fail(error?: unknown): void
}

type DoneEvent = Extract<RunEvent, { type: 'done' }>
type RunError = Extract<RunEvent, { type: 'error' }>['reason']

/** A 1×1 PNG in base64: a figure the fake server and the layer accept. */
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A result as the layer would record it for `code`, executed by `ME` unless `patch` says otherwise. */
export function fakeRunResult(code: string, patch: Partial<RunResult> = {}): RunResult {
  return { v: 1, by: ME.id, at: 0, code_sha256: sha256Hex(code), exit: 0, duration_ms: 1200, output: '', figures: [], ...patch }
}

/** What `FakeExecution.stats()` reports unless told otherwise. */
export const FAKE_USAGE: RunUsage = { cpu_percent: 96, cores: 10, memory_bytes: 512 * 1024 ** 2, memory_total_bytes: 16 * 1024 ** 3, processes: 1 }

/** One execution inside the fake Runner: what the page asked for, and the handles a test drives it with. */
export type FakeExecution = {
  /** What the page asked for: through `run` `{ id, code, title }`, through `start` also `lang` and `env` when named. */
  request: { id: string; code: string; title: string; lang?: string; env?: string }
  /** Which call of the bridge asked for it (M19b): `start` names a language and an environment, `run` does not. */
  via: 'run' | 'start'
  /** The bridge's promise has settled. */
  ended: boolean
  started: boolean
  /** Everything `write` sent so far: what a `done` reports as the output unless told otherwise. */
  output: string
  /** Hands anything to the page as an event (to play a misbehaving app). Nothing arrives once it has ended. */
  emit(event: unknown): void
  /** The app shows the code and waits: `approval`. Leave it there to hold at the approval. */
  approval(): void
  /** `started`. */
  start(): void
  /** An `output` event. */
  write(text: string): void
  /** A `stats` event (M9): a quiet Run on a 10-core, 16 GB computer with no graphics reading, or what `patch` says. */
  stats(patch?: Partial<RunUsage>): void
  /** `done` (exit 0, the hash of the code it was given, the output written so far — or what `patch` says), then the promise resolves. */
  done(patch?: Partial<DoneEvent>): void
  /** `error` with that reason, then the promise resolves. */
  error(reason: RunError, message?: string): void
  /** The promise resolves without `done` or `error`: the app went silent. */
  end(): void
  /** The promise rejects. */
  reject(error?: unknown): void
}

/**
 * A fake `window.infallDesktop.runner` (desktop.md, M8). Every `run` becomes an entry of `executions` that the test
 * drives by hand; with `script` set, it is called with each new execution as soon as it is asked for (e.g.
 * `(x) => { x.start(); x.write('hi\n'); x.done() }`). `cancel` answers as the app does: a started execution ends
 * with a stopped `done` carrying what was written, one still at the approval with `declined` — unless
 * `cancelStops` is false, which plays an app that does not react.
 */
export function fakeRunner(
  options: {
    python?: { path: string; version: string } | null
    folder?: string
    /** M19b: the languages `status()` lists. Without: an app from before M19b (no `languages`, and no `start` unless `start` says so). */
    languages?: Record<string, RunnerLanguage>
    /** M19: the environments `status()` lists (with `languages`; default none). */
    environments?: string[]
    /** Whether the bridge has `start`. Default: when `languages` is given. */
    start?: boolean
  } = {},
) {
  const executions: FakeExecution[] = []
  const cancelled: string[] = []
  const hasStart = options.start ?? options.languages !== undefined
  const runner = {
    /** What `status()` reports; null plays a Runner with no interpreter chosen. */
    python: (options.python === undefined ? { path: '/usr/bin/python3', version: '3.12.3' } : options.python) as { path: string; version: string } | null,
    folder: options.folder as string | undefined,
    /** What `status().languages` lists; undefined leaves it out (an older app). */
    languages: options.languages as Record<string, RunnerLanguage> | undefined,
    environments: options.environments as string[] | undefined,
    /** When true, `status()` rejects. */
    statusFails: false,
    statusCalls: 0,
    configureCalls: 0,
    /** The language each `configure` call named (undefined: none). */
    configureLangs: [] as (string | undefined)[],
    /** Called while the settings window is "open": change `python` / `folder` here. */
    onConfigure: null as (() => void) | null,
    cancelStops: true,
    script: null as ((execution: FakeExecution) => void) | null,
    executions,
    cancelled,
    last(): FakeExecution {
      const x = executions[executions.length - 1]
      if (!x) throw new Error('fake Runner: nothing was executed')
      return x
    },
    async status(): Promise<Awaited<ReturnType<InfallRunner['status']>>> {
      runner.statusCalls++
      if (runner.statusFails) throw new Error('bridge down')
      const status: Awaited<ReturnType<InfallRunner['status']>> = {}
      if (runner.python) status.python = { ...runner.python }
      if (runner.folder !== undefined) status.folder = runner.folder
      if (runner.languages !== undefined) {
        status.languages = structuredClone(runner.languages)
        status.environments = [...(runner.environments ?? [])]
      }
      return status
    },
    async configure(lang?: string): Promise<void> {
      runner.configureCalls++
      runner.configureLangs.push(lang)
      runner.onConfigure?.()
    },
    run(request: { id: string; code: string; title: string }, onEvent: (event: RunEvent) => void): Promise<void> {
      return execute('run', request, onEvent)
    },
    /** M19b; undefined plays an app from before it. */
    start: (hasStart ? (request: FakeExecution['request'], onEvent: (event: RunEvent) => void) => execute('start', request, onEvent) : undefined) as
      | ((request: FakeExecution['request'], onEvent: (event: RunEvent) => void) => Promise<void>)
      | undefined,
    async cancel(id: string): Promise<void> {
      cancelled.push(id)
      const x = executions.find((e) => e.request.id === id && !e.ended)
      if (!x || !runner.cancelStops) return
      if (x.started) x.done({ exit: null, stopped: true, figures: [] })
      else x.error('declined')
    },
  }

  function execute(via: FakeExecution['via'], request: FakeExecution['request'], onEvent: (event: RunEvent) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const lang = via === 'start' ? (request.lang ?? 'python') : undefined
      const x: FakeExecution = {
        request: { ...request },
        via,
        ended: false,
        started: false,
        output: '',
        emit: (event) => {
          if (!x.ended) onEvent(event as RunEvent)
        },
        approval: () => x.emit({ type: 'approval' }),
        start: () => {
          x.started = true
          x.emit({ type: 'started' })
        },
        write: (text) => {
          x.output += text
          x.emit({ type: 'output', text })
        },
        stats: (patch = {}) => x.emit({ type: 'stats', ...FAKE_USAGE, ...patch }),
        done: (patch = {}) => {
          x.emit({
            type: 'done',
            exit: 0,
            stopped: false,
            duration_ms: 1200,
            code_sha256: sha256Hex(request.code),
            output: x.output,
            output_truncated: false,
            figures: [],
            ...(lang === undefined ? {} : { lang }),
            env: lang === undefined || lang === 'python' || lang === 'qsharp' ? { python: '3.12.3', os: 'macos', arch: 'arm64' } : { os: 'macos', arch: 'arm64' },
            ...patch,
          })
          x.end()
        },
        error: (reason, message = '') => {
          x.emit({ type: 'error', reason, message })
          x.end()
        },
        end: () => {
          x.ended = true
          resolve()
        },
        reject: (error = new Error('bridge failed')) => {
          x.ended = true
          reject(error)
        },
      }
      executions.push(x)
      runner.script?.(x)
    })
  }
  return runner satisfies InfallRunner
}

export type FakeRunner = ReturnType<typeof fakeRunner>

/**
 * Puts a bridge on `window.infallDesktop`, as the desktop app does, for code that reads it from the page (the
 * default of `ai` and `runs`). Returns the function that takes it away again: call it when the test ends.
 */
export function installDesktop(desk: unknown): () => void {
  const page = globalThis as { infallDesktop?: unknown }
  page.infallDesktop = desk
  return () => {
    if (page.infallDesktop === desk) delete page.infallDesktop
  }
}

/**
 * A fake `infallDesktop.fullscreen` (window chrome, 0.9): `current()` answers `on`; `set(on)` changes it and tells every
 * subscriber, as the app does when the window enters or leaves fullscreen. `listeners` is how many are subscribed.
 */
export function fakeFullscreen(on = false) {
  const fns = new Set<(on: boolean) => void>()
  const fs = {
    on,
    get listeners() {
      return fns.size
    },
    current: () => fs.on,
    subscribe(fn: (on: boolean) => void): () => void {
      fns.add(fn)
      return () => {
        fns.delete(fn)
      }
    },
    set(next: boolean) {
      fs.on = next
      for (const fn of [...fns]) fn(next)
    },
  }
  return fs
}

/**
 * A fake `infallDesktop.chromeScale` (window chrome, 0.9): every scale it is told goes into `said`, in order.
 */
export function fakeChromeScale() {
  const said: number[] = []
  const fn = async (scale: number): Promise<void> => {
    said.push(scale)
  }
  return Object.assign(fn, { said })
}

/**
 * A fake `window.infallDesktop` (desktop.md). Every `claude.send` becomes a run in `runs` that the test drives with
 * `emit` / `end` / `fail`; with `script` set, a run plays those events and ends by itself. `cancel` ends the run,
 * as the app does when it has terminated the process. It has a Runner (`runner`, a `fakeRunner()` unless one is
 * passed); `runner: false` plays an app from before M8.
 */
export function fakeDesktop(options: { installed?: boolean; claudeVersion?: string; runner?: FakeRunner | false } = {}) {
  const runs: FakeRun[] = []
  const cancelled: string[] = []
  const desk = {
    version: '0.7.0',
    installed: options.installed ?? true,
    claudeVersion: options.claudeVersion as string | undefined,
    /** When true, `claude.status()` rejects. */
    statusFails: false,
    statusCalls: 0,
    script: null as AiEvent[] | null,
    runs,
    cancelled,
    claude: {
      async status(): Promise<{ installed: boolean; version?: string }> {
        desk.statusCalls++
        if (desk.statusFails) throw new Error('bridge down')
        return desk.installed && desk.claudeVersion !== undefined ? { installed: true, version: desk.claudeVersion } : { installed: desk.installed }
      },
      send(request: FakeRun['request'], onEvent: (event: AiEvent) => void): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const run: FakeRun = {
            request,
            ended: false,
            emit: (event) => {
              if (!run.ended) onEvent(event as AiEvent)
            },
            end: () => {
              run.ended = true
              resolve()
            },
            fail: (error = new Error('run failed')) => {
              run.ended = true
              reject(error)
            },
          }
          runs.push(run)
          if (desk.script) {
            for (const event of desk.script) run.emit(event)
            run.end()
          }
        })
      },
      async cancel(id: string): Promise<void> {
        cancelled.push(id)
        runs.find((r) => r.request.id === id && !r.ended)?.end()
      },
    },
  }
  const out: typeof desk & { runner?: FakeRunner } = desk
  if (options.runner !== false) out.runner = options.runner ?? fakeRunner()
  return out satisfies InfallDesktop
}

/** One Branch inside the fake server. `base` is its Board at seq 0. */
export type FakeBranch = {
  info: BranchInfo
  base: Entities
  entities: Entities
  log: Change[]
  checkpoints: Checkpoint[]
}

function fail(status: number, code: string, message = 'nope', detail: unknown = null) {
  return { status, body: { error: { code, message, detail } } }
}

const WEEK = 7 * 24 * 60 * 60 * 1000
const MOVED_WORDS = 'This Workspace was moved to a Team server; open it there to make changes.'

// What a Guest's Board holds (api.md §13): live entities whose every reference is live too. No tombstones.
export function visibleEntities(entities: Entities): Entities {
  const live = (id: unknown, kind: string) => typeof id === 'string' && entities[id]?.kind === kind && !entities[id]!.deleted
  const refTo = (e: Entities[string], field: string) => {
    const v = e.fields[field]
    return typeof v === 'object' && 'Ref' in v ? v.Ref : undefined
  }
  const out: Entities = {}
  for (const [id, e] of Object.entries(entities)) {
    if (e.deleted) continue
    if (e.kind === 'Connection' && !(live(refTo(e, 'from'), 'Card') && live(refTo(e, 'to'), 'Card'))) continue
    if (e.kind === 'Block' && !live(refTo(e, 'card'), 'Card')) continue
    if (e.kind === 'Attachment' && !(live(refTo(e, 'card'), 'Card') && live(refTo(e, 'source'), 'Source'))) continue
    out[id] = e
  }
  return out
}

const sameField = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// The ops that turn `current` into `target` (core `restore`): later entities become deleted, not absent.
export function restoreOps(current: Entities, target: Entities): Op[] {
  const out: Op[] = []
  for (const id of Object.keys(current).sort()) {
    const cur = current[id]!
    const want = target[id]
    if (!want || want.deleted) {
      if (!cur.deleted) out.push({ Delete: { entity: id } })
      continue
    }
    if (cur.deleted) out.push({ Undelete: { entity: id } })
    const names = [...new Set([...Object.keys(cur.fields), ...Object.keys(want.fields)])].sort()
    for (const field of names) {
      if (!sameField(cur.fields[field], want.fields[field])) {
        out.push({ Set: { entity: id, field, value: want.fields[field] ?? 'Null' } })
      }
    }
  }
  return out
}

/**
 * A fake infall server: M1 (Board, Changes, ops), M2 (Branches, Checkpoints, Restore, Board at a moment) and
 * M3 (Merge), M4 (To-dos, and the frames about who edits a Page), M5 (access tokens, Suggestions — which only
 * `suggest` makes, as the tool layer would), M6 (a Guest gets the Board without deleted entities, 403 on Changes,
 * and `refreshFrame`), M7 (`/api/ai/*`: settings, and a chat whose event stream tests script with `aiScript`),
 * M8 (a `result` posted to `…/ops` is checked as api.md §15 says; a Merge refuses a hand-written `result`).
 * It does not compute a Merge: tests script what a
 * plan holds with `mergeScript`. It has no live connections either: tests hand the frames it builds to a FakeSocket.
 * `branch`, `entities`, `log`, `seq`, `commit`, `external` and `frameFor` speak about the first Branch (`main`)
 * unless told otherwise; `all` holds every Branch.
 */
export class FakeServer {
  all: FakeBranch[] = [
    { info: { id: 'main-id', name: 'main', seq: 0, checkpoints: 0 }, base: {}, entities: {}, log: [], checkpoints: [] },
  ]
  requests: Logged[] = []
  gate: Promise<void> | null = null // when set, POST /ops waits for it before applying
  responseGate: Promise<void> | null = null // when set, POST /ops waits for it after applying, before answering
  failNext: { status: number; code: string } | null = null
  /**
   * Plays a server from before M19/M19b: a Run's `lang` and `env` are unknown fields, and a result that names a
   * language, a runtime or an environment, or lists more than 8 packages, is refused (400 `bad_request`).
   */
  oldRuns = false
  failChanges = false
  /** When set, `GET …/board` (without `at`) waits for it before answering. */
  boardGate: Promise<void> | null = null
  /** How many of the next `GET …/board` requests (without `at`) fail with a 500. */
  failBoard = 0
  members: Member[] = [ME, OTHER]
  actor: Member = ME // who the requests come from
  now = 0 // the `at` given to new Changes, Checkpoints and Branches
  lastPostFrame: ServerFrame | null = null
  /** What the next plans hold. Moments come from the Branches' heads; `base` defaults to the fork moment. */
  mergeScript: { auto: Op[]; conflicts: Conflict[]; base?: Moment } = { auto: [], conflicts: [] }
  /** One scripted failure for the next `POST /api/merges`. */
  mergeFail: { status: number; code: string; detail?: unknown } | null = null
  /** When set, both Merge endpoints wait for it before answering. */
  mergeGate: Promise<void> | null = null
  /** Every body posted to `/api/merges`, accepted or not. */
  mergePosts: { plan: MergePlan; decisions: [ConflictKey, Decision][]; checkpoint?: string }[] = []
  /** To-dos, in the order the server lists them. */
  todos: Todo[] = []
  /** One scripted failure for the next To-do request that writes. */
  todoFail: { status: number; code: string } | null = null
  /** When set, To-do requests that write wait for it before answering. */
  todoGate: Promise<void> | null = null
  /** Claims on Pages in arrival order: `member` says it edits the Page of `card` on Branch `branch` (an id). */
  claims: { member: string; card: string; branch: string; since: number }[] = []
  /** Access tokens of every Member, oldest first. */
  tokens: (AccessToken & { member: string })[] = []
  /** The secrets handed out by `POST /api/tokens`, in order. */
  secrets: string[] = []
  /** One scripted failure for the next token request that writes. */
  tokenFail: { status: number; code: string } | null = null
  /** Suggestions of every Branch, in the order they were made. */
  suggestions: Suggestion[] = []
  /** One scripted failure for the next accept / reject / reopen: e.g. `{ status: 409, code: 'already_decided' }`, `{ status: 409, code: 'rejected' }`. */
  suggestionFail: { status: number; code: string } | null = null
  /** When set, accept / reject / reopen wait for it before doing anything. */
  suggestionGate: Promise<void> | null = null
  /** M7, the OpenRouter path: false plays a server without `INFALL_SECRET_KEY`. */
  aiEnabled = true
  /** Per Member id: the stored key (never sent back) and the model. */
  aiSettings: Record<string, { key?: string; added_at?: number; model?: string }> = {}
  aiModels: AiModel[] = [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context_length: 200000 },
    { id: 'openai/gpt-5', name: 'GPT-5' },
  ]
  /** One scripted failure for the next `/api/ai/*` request. */
  aiFail: { status: number; code: string } | null = null
  /** What the next `POST /api/ai/chat` streams. */
  aiScript: AiStep[] = [{ type: 'done' }]
  /** Bytes per chunk of the stream; 0 sends everything up to the next pause as one chunk. */
  aiChunk = 0
  /** When true, the stream breaks at the end of the script instead of closing. */
  aiDrop = false
  /** How many chat requests the client aborted. */
  aiAborted = 0
  /**
   * M12: what `GET /api/workspace` answers; null plays a server from before M12 (404). M18: `empty` (a Team server
   * with nothing in it: `POST /api/workspace/import` is allowed), `read_only` (a moved copy: every write is 403
   * `moved`), `moved_to` (not in Contract B; the UI reads it when present).
   */
  workspace: { kind: 'team' | 'local'; preset: string | null; empty?: boolean; read_only?: boolean; moved_to?: string } | null = { kind: 'team', preset: null }
  /** M18: the bodies `POST /api/workspace/import` received, in order. */
  imported: unknown[] = []
  /** M18: what the next successful import answers; by default the actor's own name, claimed. */
  importAnswer: ImportResult | null = null
  /** M18: one scripted failure for the next import, e.g. `{ status: 400, code: 'not_a_workspace_file', message: '…' }`. */
  importFail: { status: number; code: string; message: string } | null = null
  /** M18: the file `GET /api/workspace/export` answers, and the name in its Content-Disposition. */
  exportBytes = new Uint8Array([0x51, 0x4f, 0x4f, 0x50, 1, 2, 3])
  exportName = 'Physics group.infall'
  /** M18: invites (`/api/invites`), oldest first. */
  invitesList: Invite[] = []
  /** M18: every Comment, any Card, in the order written. */
  comments: (Comment & { card: string })[] = []
  /** M18: Cards whose thread is resolved. */
  resolved: Record<string, boolean> = {}
  /** M18: per Member id, the Comments they have seen in For you. */
  seenBy: Record<string, string[]> = {}
  /** M18: one scripted failure for the next Comment or For you request that writes. */
  commentFail: { status: number; code: string; message?: string } | null = null
  /** M18: when set, Comment requests that write wait for it. */
  commentGate: Promise<void> | null = null
  /** M18: when set, an upload through `xhr()` waits for it after its first progress event. */
  uploadGate: Promise<void> | null = null
  /** M12: the Tutorial's progress as last stored by `PUT /api/local/tutorial` (a Local Workspace only). */
  tutorialState: unknown = null
  /** One scripted failure for the next `/api/local/*` request. */
  localFail: { status: number; code: string } | null = null
  /**
   * M13: what `POST /api/sources/lookup` answers. By default a registry that knows nothing (404); set an answer per
   * DOI or arXiv id in `lookups`, or `lookupFail` for the next answer (502, 429, …). Guests get 403.
   */
  lookups: Record<string, { title: string; authors: string; year: string; doi: string | null; url: string | null }> = {}
  lookupFail: { status: number; code: string; message: string } | null = null
  lookupGate: Promise<void> | null = null
  /** M19: the stored PDFs, their text, arXiv downloads and PDF search (files.fake.ts). */
  pdf = new FakePdfStore()
  /** M15b: when set, `GET /api/graph` waits for it. */
  graphGate: Promise<void> | null = null
  /** M15b: how many of the next `GET /api/graph` requests fail with a 500. */
  failGraph = 0
  private n = 0

  private get main(): FakeBranch {
    return this.all[0]!
  }
  get branch(): BranchInfo {
    return this.main.info
  }
  set branch(info: BranchInfo) {
    this.main.info = info
  }
  get entities(): Entities {
    return this.main.entities
  }
  set entities(e: Entities) {
    this.main.entities = e
  }
  get log(): Change[] {
    return this.main.log
  }
  set log(l: Change[]) {
    this.main.log = l
  }
  get seq() {
    return this.main.log.length
  }

  /** Finds a Branch by id or name; throws when there is none. */
  find(key = this.main.info.id): FakeBranch {
    const b = this.all.find((x) => x.info.id === key) ?? this.all.find((x) => x.info.name === key)
    if (!b) throw new Error(`fake server: no Branch ${key}`)
    return b
  }

  info(b: FakeBranch): BranchInfo {
    return { ...b.info, seq: b.log.length, checkpoints: b.checkpoints.length }
  }

  boardAt(b: FakeBranch, seq: number): Entities {
    const r = applyOps(b.base, b.log.slice(0, seq).map((c) => c.op))
    if (!r.ok) throw new Error('fake server: ' + r.rejection.message)
    return r.entities
  }

  frameFor(changes: Change[], key?: string): ServerFrame {
    const b = this.find(key)
    return { type: 'changes', branch: b.info.id, seq: b.log.length, changes }
  }

  /** The frame a Guest gets when the Branch gained Changes: fetch the Board again. */
  refreshFrame(key?: string): ServerFrame {
    const b = this.find(key)
    return { type: 'refresh', branch: b.info.id, seq: b.log.length }
  }

  // A change made by someone else; returns the frame the server would broadcast.
  external(ops: Op[], author = OTHER.id, key?: string): ServerFrame {
    return this.frameFor(this.commit(ops, author, key), key)
  }

  commit(ops: Op[], author: string, key?: string, origin: Origin = 'Edit'): Change[] {
    const b = this.find(key)
    const r = applyOps(b.entities, ops)
    if (!r.ok) throw new Error('fake server: ' + r.rejection.message)
    b.entities = r.entities
    const changes = ops.map((op) => ({ id: `c${this.n++}`, author, at: this.now, op, origin }))
    b.log.push(...changes)
    return changes
  }

  /** Forks a Branch as the server would; returns it. Its id is `<name>-id`. */
  fork(name: string, from: Moment, author = this.actor.id): FakeBranch {
    const source = this.find(from.branch)
    const base = this.boardAt(source, from.seq)
    const b: FakeBranch = {
      info: {
        id: `${name}-id`,
        name,
        seq: 0,
        parent: { branch: source.info.id, seq: from.seq },
        created_by: author,
        created_at: this.now,
        checkpoints: 0,
      },
      base,
      entities: base,
      log: [],
      checkpoints: [],
    }
    this.all.push(b)
    return b
  }

  /** Names a moment as the server would; returns the Checkpoint. */
  checkpoint(name: string, seq?: number, author = this.actor.id, key?: string): Checkpoint {
    const b = this.find(key)
    const cp: Checkpoint = { name, moment: { branch: b.info.id, seq: seq ?? b.log.length }, author, at: this.now }
    b.checkpoints.push(cp)
    b.checkpoints.sort((x, y) => x.moment.seq - y.moment.seq || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    return cp
  }

  /** Restores as the server would; returns the new Changes (possibly none). */
  restore(toSeq: number, author = this.actor.id, key?: string): Change[] {
    const b = this.find(key)
    const ops = restoreOps(b.entities, this.boardAt(b, toSeq))
    return this.commit(ops, author, key, { Restore: { batch: `batch${this.n++}`, to_seq: toSeq } })
  }

  /** The plan `GET /api/merges/plan` gives now for these two Branches (ids or names), from `mergeScript`. */
  planFor(sourceKey: string, targetKey: string): MergePlan {
    const s = this.find(sourceKey)
    const t = this.find(targetKey)
    const child = s.info.parent?.branch === t.info.id ? s : t
    return {
      source: { branch: s.info.id, seq: s.log.length },
      target: { branch: t.info.id, seq: t.log.length },
      base: this.mergeScript.base ?? child.info.parent ?? { branch: t.info.id, seq: 0 },
      auto: this.mergeScript.auto,
      conflicts: this.mergeScript.conflicts,
    }
  }

  /**
   * Why the server refuses a batch for what it does to `result` (api.md §15), or null: the value must be the JSON
   * of a result, within the limits, recorded by the Member who sends it, on a Block that is a Run once the batch
   * is applied.
   */
  resultProblem(b: FakeBranch, ops: Op[]): string | null {
    const after = applyOps(b.entities, ops)
    if (!after.ok) return null // refused as any batch that does not apply
    // M19b: what a Run names, as the server is asked to check it (api.md §15 "Languages"; desktop.md M19).
    for (const op of ops) {
      const named: [string, Value][] =
        'Set' in op
          ? op.Set.field === 'lang' || op.Set.field === 'env'
            ? [[op.Set.field, op.Set.value]]
            : []
          : 'Create' in op
            ? (['lang', 'env'] as const).flatMap((f): [string, Value][] => (op.Create.fields[f] === undefined ? [] : [[f, op.Create.fields[f]!]]))
            : []
      for (const [field, value] of named) {
        if (this.oldRuns) return `unknown field \`${field}\` on Block`
        if (value === 'Null') continue
        if (!('Text' in value)) return `A Run's ${field} must be text.`
        if (field === 'lang' && !isLangId(value.Text)) return 'A language id is 1–24 characters: a lowercase letter, then lowercase letters, digits, - or _.'
        if (field === 'env' && !isEnvName(value.Text)) return 'An environment name is one line of 1–60 characters.'
      }
    }
    for (const op of ops) {
      const [entity, value] =
        'Set' in op && op.Set.field === 'result' ? [op.Set.entity, op.Set.value] : 'Create' in op ? [op.Create.entity, op.Create.fields.result] : []
      if (entity === undefined || value === undefined || value === 'Null') continue
      if (!('Text' in value)) return 'A result must be text.'
      if (value.Text.length > MAX_RESULT) return 'A result can hold at most 600000 characters.'
      let json: unknown
      try {
        json = JSON.parse(value.Text)
      } catch {
        return 'A result must be JSON.'
      }
      const result = checkRunResult(json)
      if (!result) return 'That is not the result of a Run.'
      if (
        this.oldRuns &&
        (result.lang !== undefined || result.env?.runtime !== undefined || result.env?.name !== undefined || Object.keys(result.env?.packages ?? {}).length > 8)
      )
        return 'That is not the result of a Run.'
      if (result.by !== this.actor.id) return 'A result is recorded by the Member who executed the Run.'
      const type = after.entities[entity]?.fields.type
      const isRun = after.entities[entity]?.kind === 'Block' && typeof type === 'object' && 'Text' in type && type.Text === 'run'
      if (!isRun) return 'Only a Run has a result.'
    }
    return null
  }

  private related(s: FakeBranch, t: FakeBranch): boolean {
    return s !== t && (s.info.parent?.branch === t.info.id || t.info.parent?.branch === s.info.id)
  }

  private async mergeRoute(path: string, method: string, body: unknown) {
    if (this.mergeGate) await this.mergeGate
    if (this.actor.role === 'guest') return fail(403, 'forbidden')
    const byId = (id: unknown) => this.all.find((b) => b.info.id === id)
    if (method === 'GET' && path.startsWith('/api/merges/plan')) {
      const query = new URLSearchParams(path.split('?')[1] ?? '')
      const s = byId(query.get('source'))
      const t = byId(query.get('target'))
      if (!s || !t) return fail(404, 'not_found')
      if (!this.related(s, t)) return fail(400, 'not_parent_and_child')
      return { status: 200, body: { plan: this.planFor(s.info.id, t.info.id) } }
    }
    if (method !== 'POST' || path !== '/api/merges') return fail(404, 'not_found', 'no route')
    const post = body as { plan: MergePlan; decisions: [ConflictKey, Decision][]; checkpoint?: string }
    this.mergePosts.push(post)
    if (this.mergeFail) {
      const f = this.mergeFail
      this.mergeFail = null
      return fail(f.status, f.code, 'nope', f.detail ?? null)
    }
    const s = byId(post.plan?.source?.branch)
    const t = byId(post.plan?.target?.branch)
    if (!s || !t) return fail(404, 'not_found')
    if (!this.related(s, t)) return fail(400, 'not_parent_and_child')
    const plan = this.planFor(s.info.id, t.info.id)
    if (!sameField(plan, post.plan)) return fail(409, 'stale')
    const keyOf = (c: Conflict): ConflictKey =>
      'Field' in c ? { entity: c.Field.entity, field: c.Field.field } : { entity: c.EditVsDelete.entity, field: null }
    const decisions = new Map((post.decisions ?? []).map(([k, d]) => [JSON.stringify([k.entity, k.field]), d]))
    const undecided = plan.conflicts.map(keyOf).filter((k) => !decisions.has(JSON.stringify([k.entity, k.field])))
    if (undecided.length > 0) return fail(400, 'undecided', 'nope', undecided)
    const name = post.checkpoint?.trim()
    if (post.checkpoint !== undefined && (name === '' || name!.length > 80)) return fail(400, 'bad_request')
    if (name !== undefined && t.checkpoints.some((c) => c.name === name)) return fail(409, 'name_taken')
    const ops = [...plan.auto]
    for (const c of plan.conflicts) {
      const k = keyOf(c)
      const d = decisions.get(JSON.stringify([k.entity, k.field]))!
      // A Run's result is taken from one side: a hand-written one is refused (api.md §15).
      if ('Field' in c && c.Field.field === 'result' && typeof d === 'object') return fail(400, 'bad_decision', 'nope', k)
      if (d === 'TakeTarget') continue
      if ('Field' in c) {
        ops.push({ Set: { entity: k.entity, field: c.Field.field, value: d === 'TakeSource' ? c.Field.source : d.Custom } })
      } else if (d !== 'TakeSource') {
        return fail(400, 'bad_decision', 'nope', k)
      } else {
        ops.push(c.EditVsDelete.deleted_on === 'Source' ? { Delete: { entity: k.entity } } : { Undelete: { entity: k.entity } })
      }
    }
    const applied = applyOps(t.entities, ops)
    if (!applied.ok) return fail(409, 'rejected', applied.rejection.message, applied.rejection)
    const checkpoint = name === undefined ? undefined : this.checkpoint(name, t.log.length, this.actor.id, t.info.id)
    const origin: Origin = { Merge: { batch: `batch${this.n++}`, source: plan.source } }
    const changes = this.commit(ops, this.actor.id, t.info.id, origin)
    this.lastPostFrame = this.frameFor(changes, t.info.id)
    return { status: 200, body: checkpoint ? { seq: t.log.length, changes, checkpoint } : { seq: t.log.length, changes } }
  }

  /** `member` claims the Page of `card` (null: lets go), as its `editing` frame would; returns the broadcast. */
  claim(member: string, card: string | null, key?: string): ServerFrame {
    const branch = this.find(key).info.id
    this.claims = this.claims.filter((c) => c.member !== member)
    if (card !== null) this.claims.push({ member, card, branch, since: this.now })
    return this.editingFrame(key)
  }

  /** Who holds which Page on a Branch: per Card, whoever claimed it first and still holds it. */
  editingFrame(key?: string): ServerFrame {
    const branch = this.find(key).info.id
    const editors: { card: string; member: string; since: number }[] = []
    for (const c of this.claims) {
      if (c.branch !== branch || editors.some((e) => e.card === c.card)) continue
      editors.push({ card: c.card, member: c.member, since: c.since })
    }
    return { type: 'editing', branch, editors }
  }

  todosFrame(): ServerFrame {
    return { type: 'todos', todos: this.todos.map((t) => ({ ...t })) }
  }

  /** Adds a To-do as the server would on someone's behalf; returns it. */
  addTodo(input: { owner: string; text: string; card?: Todo['card'] }, author = this.actor.id): Todo {
    const todo: Todo = { id: `t${this.n++}`, owner: input.owner, text: input.text.trim(), done: false, created_by: author, created_at: this.now }
    if (input.card) todo.card = input.card
    this.todos.push(todo)
    return todo
  }

  private async todoRoute(path: string, method: string, body: unknown) {
    if (this.actor.role === 'guest') return fail(403, 'forbidden')
    if (method === 'GET' && path === '/api/todos') return { status: 200, body: { todos: this.todos } }
    if (this.todoGate) await this.todoGate
    if (this.todoFail) {
      const f = this.todoFail
      this.todoFail = null
      return fail(f.status, f.code)
    }
    const input = (body ?? {}) as { owner?: unknown; text?: unknown; done?: unknown; card?: Todo['card'] | null }
    const goodText = (t: unknown): t is string => typeof t === 'string' && t.trim() !== '' && t.trim().length <= 500
    if (method === 'POST' && path === '/api/todos') {
      const owner = this.members.find((m) => m.id === input.owner)
      if (!owner || owner.role === 'guest' || !goodText(input.text)) return fail(400, 'bad_request')
      return { status: 200, body: { todo: this.addTodo({ owner: owner.id, text: input.text, card: input.card ?? undefined }) } }
    }
    const id = decodeURIComponent(path.slice('/api/todos/'.length))
    const at = this.todos.findIndex((t) => t.id === id)
    const todo = this.todos[at]
    if (!path.startsWith('/api/todos/') || !todo) return fail(404, 'not_found')
    const me = this.actor.id
    const mine = todo.owner === me || todo.created_by === me
    if (method === 'DELETE') {
      if (!mine) return fail(403, 'forbidden')
      this.todos.splice(at, 1)
      return { status: 200, body: {} }
    }
    if (method !== 'PATCH') return fail(404, 'not_found', 'no route')
    if (input.done !== undefined && todo.owner !== me) return fail(403, 'forbidden')
    if ((input.text !== undefined || input.card !== undefined) && !mine) return fail(403, 'forbidden')
    if (input.text !== undefined && !goodText(input.text)) return fail(400, 'bad_request')
    const next: Todo = { ...todo }
    if (typeof input.text === 'string') next.text = input.text.trim()
    if (input.card === null) delete next.card
    else if (input.card !== undefined) next.card = input.card
    if (input.done === true && !todo.done) {
      next.done = true
      next.done_at = this.now
    } else if (input.done === false) {
      next.done = false
      delete next.done_at
    }
    this.todos[at] = next
    return { status: 200, body: { todo: next } }
  }

  /** Adds a Suggestion as if a Member's AI had made it through the tool layer; returns it. */
  suggest(
    input:
      | { card: string; source: NonNullable<Suggestion['source']>; reason?: string; model?: string }
      | { connection: NonNullable<Suggestion['connection']>; reason?: string; model?: string },
    author = this.actor.id,
    key?: string,
  ): Suggestion {
    const s: Suggestion = {
      id: `s${this.n++}`,
      branch: this.find(key).info.id,
      kind: 'connection' in input ? 'connection' : 'source',
      reason: input.reason ?? 'Because.',
      created_by: author,
      created_at: this.now,
      state: 'pending',
    }
    if ('connection' in input) s.connection = { ...input.connection }
    else {
      s.card = input.card
      s.source = { ...input.source }
    }
    if (input.model !== undefined) s.model = input.model
    this.suggestions.push(s)
    return s
  }

  /** What `GET /api/suggestions` lists for a Branch: pending ones and those decided in the last 7 days, newest first. */
  suggestionsOf(key?: string): Suggestion[] {
    const branch = this.find(key).info.id
    return this.suggestions
      .filter((s) => s.branch === branch && (s.state === 'pending' || (s.decided_at ?? 0) > this.now - WEEK))
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s.created_at - a.s.created_at || b.i - a.i)
      .map(({ s }) => ({ ...s }))
  }

  suggestionsFrame(key?: string): ServerFrame {
    return { type: 'suggestions', branch: this.find(key).info.id, suggestions: this.suggestionsOf(key) }
  }

  private async suggestionRoute(path: string, method: string, body: unknown) {
    if (this.actor.role === 'guest') return fail(403, 'forbidden')
    if (method === 'GET') {
      const id = new URLSearchParams(path.split('?')[1] ?? '').get('branch')
      if (!path.startsWith('/api/suggestions?') || !this.all.some((b) => b.info.id === id)) return fail(404, 'not_found')
      return { status: 200, body: { suggestions: this.suggestionsOf(id!) } }
    }
    const m = /^\/api\/suggestions\/([^/?]+)\/(accept|reject|reopen)$/.exec(path)
    if (method !== 'POST' || !m) return fail(404, 'not_found', 'no route')
    if (this.suggestionGate) await this.suggestionGate
    if (this.suggestionFail) {
      const f = this.suggestionFail
      this.suggestionFail = null
      return fail(f.status, f.code)
    }
    const at = this.suggestions.findIndex((s) => s.id === decodeURIComponent(m[1]!))
    const was = this.suggestions[at]
    if (!was) return fail(404, 'not_found')
    const what = m[2]
    if (was.state !== (what === 'reopen' ? 'rejected' : 'pending')) return fail(409, 'already_decided')
    if (what === 'reopen') {
      const { decided_by: _by, decided_at: _at, ...rest } = was
      const suggestion: Suggestion = { ...rest, state: 'pending' }
      this.suggestions[at] = suggestion
      return { status: 200, body: { suggestion } }
    }
    const decided = { decided_by: this.actor.id, decided_at: this.now }
    if (what === 'reject') {
      const suggestion: Suggestion = { ...was, state: 'rejected', ...decided }
      this.suggestions[at] = suggestion
      return { status: 200, body: { suggestion } }
    }
    const ops = (body as { ops?: Op[] } | undefined)?.ops
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 20) return fail(400, 'bad_request')
    const b = this.find(was.branch)
    const r = applyOps(b.entities, ops)
    if (!r.ok) return fail(409, 'rejected', r.rejection.message, r.rejection)
    const changes = this.commit(ops, this.actor.id, was.branch)
    this.lastPostFrame = this.frameFor(changes, was.branch)
    const suggestion: Suggestion = { ...was, state: 'accepted', ...decided }
    this.suggestions[at] = suggestion
    return { status: 200, body: { suggestion, seq: b.log.length, changes } }
  }

  private tokenRoute(path: string, method: string, body: unknown) {
    if (this.actor.role === 'guest') return fail(403, 'forbidden')
    const me = this.actor.id
    const shown = ({ member: _member, ...token }: AccessToken & { member: string }): AccessToken => token
    if (method === 'GET' && path === '/api/tokens') {
      return { status: 200, body: { tokens: this.tokens.filter((t) => t.member === me).map(shown) } }
    }
    if (this.tokenFail) {
      const f = this.tokenFail
      this.tokenFail = null
      return fail(f.status, f.code)
    }
    if (method === 'POST' && path === '/api/tokens') {
      const raw = (body as { name?: unknown } | undefined)?.name
      const name = typeof raw === 'string' ? raw.trim() : ''
      const full = this.tokens.filter((t) => t.member === me).length >= 10
      if (name === '' || name.length > 60 || full) return fail(400, 'bad_request')
      const token = { id: `k${this.n++}`, name, created_at: this.now, member: me }
      const secret = 'infall_pat_' + String(this.secrets.length).padStart(43, 'A')
      this.tokens.push(token)
      this.secrets.push(secret)
      return { status: 200, body: { token: shown(token), secret } }
    }
    const id = decodeURIComponent(path.slice('/api/tokens/'.length))
    const at = this.tokens.findIndex((t) => t.id === id && t.member === me)
    if (method !== 'DELETE' || !path.startsWith('/api/tokens/') || at < 0) return fail(404, 'not_found')
    this.tokens.splice(at, 1)
    return { status: 200, body: {} }
  }

  /** What `GET /api/ai/status` says for a Member. */
  aiStatus(member = this.actor.id): { enabled: boolean; key?: { last4: string; added_at: number }; model?: string } {
    if (!this.aiEnabled) return { enabled: false }
    const mine = this.aiSettings[member] ?? {}
    const status: ReturnType<FakeServer['aiStatus']> = { enabled: true }
    if (mine.key !== undefined) status.key = { last4: mine.key.slice(-4), added_at: mine.added_at ?? 0 }
    if (mine.model !== undefined) status.model = mine.model
    return status
  }

  // The scripted answer as a byte stream, cut into chunks of `aiChunk` bytes whatever they split.
  private aiStream(signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
    const script = this.aiScript
    const size = this.aiChunk
    const drop = this.aiDrop
    const encoder = new TextEncoder()
    let gone = false
    let breaking = false
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        signal?.addEventListener('abort', () => {
          if (gone) return
          gone = true
          this.aiAborted++
          controller.error(new DOMException('The request was aborted.', 'AbortError'))
        })
        let text = ''
        const flush = () => {
          const bytes = encoder.encode(text)
          text = ''
          const step = size > 0 ? size : Math.max(bytes.length, 1)
          for (let i = 0; i < bytes.length && !gone; i += step) controller.enqueue(bytes.slice(i, i + step))
        }
        for (const item of script) {
          if (gone) return
          if ('wait' in item) {
            flush()
            await item.wait
          } else text += 'raw' in item ? item.raw : `data: ${JSON.stringify(item)}\n`
        }
        if (gone) return
        flush()
        if (drop) breaking = true
        else {
          gone = true
          controller.close()
        }
      },
      // The break comes once the reader has taken what was sent (an error would throw away the chunks in the queue).
      pull: (controller) => {
        if (!breaking || gone) return
        gone = true
        controller.error(new TypeError('network error'))
      },
    })
  }

  private aiRoute(path: string, method: string, body: unknown, signal: AbortSignal | undefined): { status: number; body: unknown } | Response {
    if (this.actor.role === 'guest') return fail(403, 'forbidden')
    if (this.aiFail) {
      const f = this.aiFail
      this.aiFail = null
      return fail(f.status, f.code)
    }
    const me = this.actor.id
    const input = (body ?? {}) as { key?: unknown; model?: unknown; messages?: unknown }
    const off = fail(503, 'ai_not_configured')
    if (method === 'GET' && path === '/api/ai/status') return { status: 200, body: this.aiStatus() }
    if (method === 'GET' && path === '/api/ai/models') return { status: 200, body: { models: this.aiModels } }
    if (path === '/api/ai/key' && (method === 'PUT' || method === 'DELETE')) {
      if (!this.aiEnabled) return off
      const { key: _key, added_at: _at, ...rest } = this.aiSettings[me] ?? {}
      if (method === 'DELETE') this.aiSettings[me] = rest
      else {
        if (typeof input.key !== 'string' || !/^[\x21-\x7e]{20,400}$/.test(input.key)) return fail(400, 'bad_request')
        this.aiSettings[me] = { ...rest, key: input.key, added_at: this.now }
      }
      return { status: 200, body: this.aiStatus() }
    }
    if (path === '/api/ai/model' && method === 'PUT') {
      if (!this.aiEnabled) return off
      if (typeof input.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(input.model)) return fail(400, 'bad_request')
      this.aiSettings[me] = { ...this.aiSettings[me], model: input.model }
      return { status: 200, body: this.aiStatus() }
    }
    if (path !== '/api/ai/chat' || method !== 'POST') return fail(404, 'not_found', 'no route')
    if (!this.aiEnabled) return off
    const messages = input.messages as { role?: unknown; content?: unknown }[] | undefined
    const good =
      Array.isArray(messages) &&
      messages.length >= 1 &&
      messages.length <= 60 &&
      messages.every((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 40000) &&
      messages[messages.length - 1]!.role === 'user'
    if (!good) return fail(400, 'bad_request')
    if (this.aiSettings[me]?.key === undefined) return fail(409, 'no_key')
    if (this.aiSettings[me]?.model === undefined) return fail(409, 'no_model')
    return { ok: true, status: 200, body: this.aiStream(signal), text: async () => '' } as unknown as Response
  }

  /** M12 (docs/specs/local.md, Contract B): the kind of Workspace, and the paths only a Local Workspace has. */
  private localRoute(path: string, method: string, body: unknown): { status: number; body: unknown } {
    if (path === '/api/workspace' && method === 'GET') return this.workspace ? { status: 200, body: this.workspace } : fail(404, 'not_found')
    if (this.workspace?.kind !== 'local') return fail(404, 'not_found')
    if (this.localFail) {
      const f = this.localFail
      this.localFail = null
      return fail(f.status, f.code, 'That did not work.')
    }
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    if (path === '/api/local/member' && method === 'PATCH') {
      const name = typeof b.name === 'string' ? b.name.trim() : ''
      if (name === '' || [...name].length > 100) return fail(400, 'bad_request', 'A name is 1 to 100 characters long.')
      this.members = this.members.map((m) => (m.id === this.actor.id ? { ...m, name } : m))
      this.actor = { ...this.actor, name }
      return { status: 200, body: { name } }
    }
    if (path === '/api/local/tutorial' && method === 'GET') return { status: 200, body: { state: this.tutorialState } }
    if (path === '/api/local/tutorial' && method === 'PUT') {
      if (JSON.stringify(body).length > 16 * 1024) return fail(400, 'bad_request', 'The progress is over 16 KiB.')
      this.tutorialState = b.state ?? null
      return { status: 204, body: undefined }
    }
    return fail(404, 'not_found')
  }

  // ---- M18 (docs/specs/team-move.md, Contract B) ----

  /** `POST /api/workspace/import` and `GET /api/workspace/export`. */
  private async moveRoute(path: string, method: string, body: unknown): Promise<{ status: number; body: unknown } | Response> {
    const team = this.workspace?.kind !== 'local'
    if (path === '/api/workspace/import' && method === 'POST') {
      if (this.actor.role !== 'admin' || !team) return fail(403, 'forbidden', 'Only an Admin can bring in a Workspace file.')
      if (this.importFail) {
        const f = this.importFail
        this.importFail = null
        return fail(f.status, f.code, f.message)
      }
      if (!this.workspace?.empty) return fail(409, 'not_empty', 'This server already holds work. A Workspace file can only go onto an empty one.')
      this.imported.push(body)
      const answer = this.importAnswer ?? { members: [{ id: this.actor.id, name: this.actor.name, claimed: true }], you_were: 'Me on my laptop' }
      for (const m of answer.members) {
        if (this.members.some((x) => x.id === m.id)) continue
        this.members.push({ id: m.id, name: m.name, role: 'member', color: '#777', claimed: m.claimed })
      }
      this.workspace = { ...this.workspace, empty: false }
      return { status: 200, body: answer }
    }
    if (path === '/api/workspace/export' && method === 'GET') {
      if (this.actor.role !== 'admin' || !team) return fail(403, 'forbidden', 'Only an Admin can export the Workspace.')
      const bytes = this.exportBytes
      const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${this.exportName}"` })
      return { ok: true, status: 200, headers, text: async () => '', arrayBuffer: async () => bytes.slice().buffer } as unknown as Response
    }
    return fail(404, 'not_found', 'no route')
  }

  /** `/api/invites` (M18: `claims`). */
  private inviteRoute(path: string, method: string, body: unknown): { status: number; body: unknown } {
    if (this.actor.role !== 'admin') return fail(403, 'forbidden')
    if (method === 'GET' && path === '/api/invites') return { status: 200, body: { invites: this.invitesList } }
    if (method === 'POST' && path === '/api/invites') {
      const b = (body ?? {}) as { email?: unknown; role?: unknown; access_until?: unknown; claims?: unknown }
      if (typeof b.email !== 'string' || !/^\S+@\S+$/.test(b.email) || (b.role !== 'member' && b.role !== 'guest')) return fail(400, 'bad_request')
      if (b.claims !== undefined) {
        const who = this.members.find((m) => m.id === b.claims)
        if (!who || who.claimed !== false) return fail(400, 'bad_request', 'That Member can already sign in.')
      }
      const invite: Invite = { id: `i${this.n++}`, email: b.email, role: b.role, expires_at: this.now + WEEK, created_by: this.actor.id }
      if (typeof b.access_until === 'number') invite.access_until = b.access_until
      if (typeof b.claims === 'string') invite.claims = b.claims
      this.invitesList.push(invite)
      return { status: 200, body: { invite, url: `http://fake/invite/${invite.id}` } }
    }
    const id = decodeURIComponent(path.slice('/api/invites/'.length))
    const at = this.invitesList.findIndex((i) => i.id === id)
    if (method !== 'DELETE' || at < 0) return fail(404, 'not_found')
    this.invitesList.splice(at, 1)
    return { status: 200, body: {} }
  }

  /** Writes a Comment as the server would on someone's behalf; returns it. */
  addComment(card: string, text: string, mentions: string[] = [], author = this.actor.id): Comment {
    const c = { id: `cm${this.n++}`, card, author, text, mentions: [...mentions], created_at: this.now, edited_at: null }
    this.comments.push(c)
    const { card: _card, ...comment } = c
    return comment
  }

  /** The thread of a Card as `GET /api/cards/{card}/comments` answers it. */
  threadOf(card: string): { resolved: boolean; comments: Comment[] } {
    return {
      resolved: this.resolved[card] === true,
      comments: this.comments.filter((c) => c.card === card).map(({ card: _card, ...c }) => ({ ...c, mentions: [...c.mentions] })),
    }
  }

  /** `GET /api/comments/counts`. The fake's reading of `open`: the number of Comments in the thread. */
  commentCounts(): Record<string, { open: number; resolved: boolean }> {
    const out: Record<string, { open: number; resolved: boolean }> = {}
    for (const c of this.comments) out[c.card] = { open: (out[c.card]?.open ?? 0) + 1, resolved: this.resolved[c.card] === true }
    return out
  }

  /** `GET /api/for-you` for a Member: the Comments mentioning them, newest first, at most 200. */
  forYouOf(member = this.actor.id): ForYouItem[] {
    const seen = new Set(this.seenBy[member] ?? [])
    return this.comments
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.mentions.includes(member))
      .sort((a, b) => b.c.created_at - a.c.created_at || b.i - a.i)
      .slice(0, 200)
      .map(({ c }) => ({ comment: c.id, card: c.card, author: c.author, at: c.created_at, seen: seen.has(c.id) }))
  }

  commentsFrame(card: string): ServerFrame {
    return { type: 'comments', card }
  }

  forYouFrame(member = this.actor.id): ServerFrame {
    return { type: 'for_you', count: this.forYouOf(member).filter((i) => !i.seen).length }
  }

  private async commentRoute(path: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
    if (this.actor.role === 'guest') return fail(403, 'forbidden')
    const me = this.actor.id
    if (method === 'GET' && path === '/api/comments/counts') return { status: 200, body: this.commentCounts() }
    if (method === 'GET' && path === '/api/for-you') return { status: 200, body: { items: this.forYouOf(me) } }
    const thread = /^\/api\/cards\/([^/?]+)\/comments(\/resolved)?$/.exec(path)
    if (method === 'GET' && thread && !thread[2]) return { status: 200, body: this.threadOf(decodeURIComponent(thread[1]!)) }
    if (this.commentGate) await this.commentGate
    if (this.commentFail) {
      const f = this.commentFail
      this.commentFail = null
      return fail(f.status, f.code, f.message)
    }
    const b = (body ?? {}) as { text?: unknown; mentions?: unknown; resolved?: unknown; up_to?: unknown }
    const goodText = typeof b.text === 'string' && b.text.trim() !== '' && [...b.text].length <= 10_000
    const mentions = Array.isArray(b.mentions) ? b.mentions : []
    const goodMentions = mentions.every((id) => this.members.some((m) => m.id === id))
    if (method === 'POST' && path === '/api/for-you/seen') {
      const upTo = this.comments.find((c) => c.id === b.up_to)
      if (!upTo) return fail(404, 'not_found')
      const items = this.forYouOf(me)
      const at = items.findIndex((i) => i.comment === upTo.id)
      this.seenBy[me] = [...new Set([...(this.seenBy[me] ?? []), ...items.slice(at < 0 ? items.length : at).map((i) => i.comment)])]
      return { status: 200, body: {} }
    }
    if (thread) {
      const card = decodeURIComponent(thread[1]!)
      if (thread[2] && method === 'PUT') {
        if (typeof b.resolved !== 'boolean') return fail(400, 'bad_request')
        this.resolved[card] = b.resolved
        return { status: 200, body: { resolved: b.resolved } }
      }
      if (!thread[2] && method === 'POST') {
        if (!goodText || !goodMentions) return fail(400, 'bad_request', 'Each mention must be a Member.')
        return { status: 201, body: this.addComment(card, (b.text as string).trim(), mentions as string[], me) }
      }
      return fail(404, 'not_found', 'no route')
    }
    const one = /^\/api\/comments\/([^/?]+)$/.exec(path)
    const at = one ? this.comments.findIndex((c) => c.id === decodeURIComponent(one[1]!)) : -1
    const c = this.comments[at]
    if (!c) return fail(404, 'not_found')
    if (method === 'DELETE') {
      if (c.author !== me && this.actor.role !== 'admin') return fail(403, 'forbidden', 'Only its author or an Admin can delete a Comment.')
      this.comments.splice(at, 1)
      return { status: 200, body: {} }
    }
    if (method === 'PATCH') {
      if (c.author !== me) return fail(403, 'forbidden', 'Only its author can edit a Comment.')
      if (!goodText || !goodMentions) return fail(400, 'bad_request')
      const next = { ...c, text: (b.text as string).trim(), mentions: [...(mentions as string[])], edited_at: this.now }
      this.comments[at] = next
      const { card: _card, ...comment } = next
      return { status: 200, body: comment }
    }
    return fail(404, 'not_found', 'no route')
  }

  /**
   * A fake `XMLHttpRequest` that sends to this server, for uploads with progress: `vi.stubGlobal('XMLHttpRequest',
   * server.xhr())`. It reports progress in four steps and, when `uploadGate` is set, waits for it after the first.
   */
  xhr(): typeof XMLHttpRequest {
    const serverFetch = (path: string, init: RequestInit) => this.fetch(path, init)
    const uploadGate = () => this.uploadGate
    class FakeXhr {
      status = 0
      responseText = ''
      withCredentials = false
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      headers: Record<string, string> = {}
      private method = 'GET'
      private path = ''
      private aborted = false
      open(method: string, path: string) {
        this.method = method
        this.path = path
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value
      }
      abort() {
        this.aborted = true
        this.onabort?.()
      }
      send(body: Blob) {
        const total = body.size
        void (async () => {
          for (let step = 1; step <= 4; step++) {
            await Promise.resolve()
            if (this.aborted) return
            this.upload.onprogress?.({ loaded: Math.round((total * step) / 4), total, lengthComputable: true } as ProgressEvent)
            const gate = uploadGate()
            if (step === 1 && gate) await gate
          }
          if (this.aborted) return
          const res = await serverFetch(this.path, { method: this.method, body })
          if (this.aborted) return
          this.status = res.status
          this.responseText = await res.text()
          this.onload?.()
        })()
      }
    }
    return FakeXhr as unknown as typeof XMLHttpRequest
  }

  checkpointFrame(checkpoint: Checkpoint): ServerFrame {
    return { type: 'checkpoint', branch: checkpoint.moment.branch, checkpoint }
  }

  branchesFrame(): ServerFrame {
    return { type: 'branches', branches: this.all.map((b) => this.info(b)) }
  }

  /** What `GET /api/graph` answers (api.md §18): every Branch in the order made, grouped by the shared rule. */
  graph(gapMs?: number): GraphResponse {
    return {
      branches: this.all.map((b) => {
        const shapes = groupShapes(
          b.log,
          b.checkpoints.map((c) => c.moment.seq),
          { gapMs },
        )
        const out: GraphBranch = {
          id: b.info.id,
          name: b.info.name,
          seq: b.log.length,
          checkpoints: b.checkpoints.map((c) => ({ name: c.name, seq: c.moment.seq, author: c.author, at: c.at })),
          activities: shapes.map((s) => {
            const a: GraphActivity = {
              kind: s.kind,
              author: s.author,
              from_seq: s.fromSeq,
              to_seq: s.toSeq,
              started_at: s.startedAt,
              ended_at: s.endedAt,
            }
            if (s.source) a.source = s.source
            if (s.to !== undefined) a.to = s.to
            return a
          }),
        }
        if (b.info.parent) out.parent = b.info.parent
        if (b.info.created_by !== undefined) out.created_by = b.info.created_by
        if (b.info.created_at !== undefined) out.created_at = b.info.created_at
        return out
      }),
    }
  }

  private json(status: number, body: unknown) {
    const text = body === undefined ? '' : JSON.stringify(body)
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response
  }

  private respond(r: { status: number; body: unknown }) {
    return this.json(r.status, r.body)
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // M19: pdf.js asks with an absolute URL object; the routes below read a same-origin path.
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : new URL(input.url).pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? undefined)
    this.requests.push({ method, path, body })
    const guest = this.actor.role === 'guest'
    const forbidden = fail(403, 'forbidden')
    // M18: a moved Local Workspace refuses every write (Contract A).
    if (this.workspace?.read_only && method !== 'GET' && method !== 'HEAD') return this.respond(fail(403, 'moved', MOVED_WORDS))
    if (path.startsWith('/api/workspace/')) {
      const answer = await this.moveRoute(path, method, body)
      return 'ok' in answer ? answer : this.respond(answer)
    }
    if (path.startsWith('/api/files/') || path === '/api/sources/fetch-pdf' || path.startsWith('/api/search/pdf')) {
      const answer = await this.pdf.route(path, init, body, { actor: this.actor, main: this.main.entities, readOnly: false })
      if (answer) return 'status' in answer && !('ok' in answer) ? this.respond(answer) : (answer as Response)
    }
    if (path === '/api/invites' || path.startsWith('/api/invites/')) return this.respond(this.inviteRoute(path, method, body))
    if (path.startsWith('/api/cards/') || path.startsWith('/api/comments') || path.startsWith('/api/for-you')) {
      return this.respond(await this.commentRoute(path, method, body))
    }
    if (path === '/api/workspace' || path.startsWith('/api/local/')) return this.respond(this.localRoute(path, method, body))
    if (path === '/api/sources/lookup' && method === 'POST') {
      if (guest) return this.respond(forbidden)
      if (this.lookupGate) await this.lookupGate
      if (this.lookupFail) {
        const f = this.lookupFail
        this.lookupFail = null
        return this.respond(fail(f.status, f.code, f.message))
      }
      const doi = typeof body?.doi === 'string' ? body.doi : undefined
      const arxiv = typeof body?.arxiv === 'string' ? body.arxiv : undefined
      if ((doi === undefined) === (arxiv === undefined)) return this.respond(fail(400, 'bad_request', 'Give one DOI or one arXiv id.'))
      const found = this.lookups[(doi ?? arxiv)!]
      return found ? this.json(200, found) : this.respond(fail(404, 'not_found', 'The registry does not know this one.'))
    }
    if (path === '/api/members') return this.json(200, { members: this.members })
    if (path === '/api/branches' && method === 'GET') {
      return this.json(200, { branches: this.all.map((b) => this.info(b)) })
    }
    if (path === '/api/branches' && method === 'POST') {
      if (guest) return this.respond(forbidden)
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      const from = body?.from as Moment | undefined
      const source = this.all.find((b) => b.info.id === from?.branch || b.info.name === from?.branch)
      if (name === '' || name.length > 60 || !from || !source || !(from.seq >= 0 && from.seq <= source.log.length)) {
        return this.respond(fail(400, 'bad_request'))
      }
      if (this.all.some((b) => b.info.name === name)) return this.respond(fail(409, 'name_taken'))
      return this.json(200, { branch: this.info(this.fork(name, from)) })
    }
    if (path === '/api/graph' || path.startsWith('/api/graph?')) {
      if (guest) return this.respond(forbidden)
      if (this.graphGate) await this.graphGate
      if (this.failGraph > 0) {
        this.failGraph--
        return this.respond(fail(500, 'internal', 'x'))
      }
      const gap = new URLSearchParams(path.split('?')[1] ?? '').get('gap_ms')
      return this.json(200, this.graph(gap === null ? undefined : Number(gap)))
    }
    if (path.startsWith('/api/merges')) return this.respond(await this.mergeRoute(path, method, body))
    if (path === '/api/todos' || path.startsWith('/api/todos/')) return this.respond(await this.todoRoute(path, method, body))
    if (path.startsWith('/api/suggestions')) return this.respond(await this.suggestionRoute(path, method, body))
    if (path === '/api/tokens' || path.startsWith('/api/tokens/')) return this.respond(this.tokenRoute(path, method, body))
    if (path.startsWith('/api/ai/')) {
      const signal = init?.signal ?? undefined
      if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError')
      const answer = this.aiRoute(path, method, body, signal)
      return 'ok' in answer ? answer : this.respond(answer)
    }
    const m = /^\/api\/branches\/([^/?]+)\/(board|changes|ops|checkpoints|restore)(?:\?(.*))?$/.exec(path)
    const b = m ? this.all.find((x) => x.info.id === decodeURIComponent(m[1]!)) : undefined
    if (!m || !b) return this.respond(fail(404, 'not_found', 'no route'))
    const what = m[2]
    const query = new URLSearchParams(m[3] ?? '')
    const id = b.info.id
    if (guest && b.info.name !== 'main') return this.respond(forbidden)
    if (what === 'board' && method === 'GET') {
      if (!query.has('at')) {
        if (this.boardGate) await this.boardGate
        if (this.failBoard > 0) {
          this.failBoard--
          return this.respond(fail(500, 'internal', 'x'))
        }
        return this.json(200, { branch: id, seq: b.log.length, entities: guest ? visibleEntities(b.entities) : b.entities })
      }
      if (guest) return this.respond(forbidden)
      const at = Number(query.get('at'))
      if (!(at >= 0 && at <= b.log.length)) return this.respond(fail(400, 'bad_request'))
      return this.json(200, { branch: id, seq: at, entities: this.boardAt(b, at) })
    }
    if (what === 'changes' && method === 'GET') {
      if (guest) return this.respond(forbidden)
      if (this.failChanges) return this.respond(fail(500, 'internal', 'x'))
      const after = Number(query.get('after') ?? 0)
      const before = query.has('before') ? Number(query.get('before')) : b.log.length
      if (!(after >= 0 && after <= b.log.length && before >= after && before <= b.log.length)) {
        return this.respond(fail(400, 'bad_request'))
      }
      return this.json(200, { seq: b.log.length, changes: b.log.slice(after, before) })
    }
    if (what === 'ops' && method === 'POST') {
      if (this.gate) await this.gate
      if (this.failNext) {
        const f = this.failNext
        this.failNext = null
        return this.respond(fail(f.status, f.code))
      }
      if (guest) return this.respond(forbidden)
      const problem = this.resultProblem(b, body.ops)
      if (problem !== null) return this.respond(fail(400, 'bad_request', problem))
      const r = applyOps(b.entities, body.ops)
      if (!r.ok) return this.respond(fail(409, 'rejected', r.rejection.message, r.rejection))
      const changes = this.commit(body.ops, this.actor.id, id)
      this.lastPostFrame = this.frameFor(changes, id)
      if (this.responseGate) await this.responseGate
      return this.json(200, { seq: b.log.length, changes })
    }
    if (guest) return this.respond(forbidden)
    if (what === 'checkpoints' && method === 'GET') return this.json(200, { checkpoints: b.checkpoints })
    if (what === 'checkpoints' && method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      const seq = body?.seq === undefined ? b.log.length : Number(body.seq)
      if (name === '' || name.length > 80 || !(seq >= 0 && seq <= b.log.length)) {
        return this.respond(fail(400, 'bad_request'))
      }
      if (b.checkpoints.some((c) => c.name === name)) return this.respond(fail(409, 'name_taken'))
      return this.json(200, { checkpoint: this.checkpoint(name, seq, this.actor.id, id) })
    }
    if (what === 'restore' && method === 'POST') {
      const to = Number(body?.to_seq)
      if (!(to >= 0 && to <= b.log.length)) return this.respond(fail(400, 'bad_request'))
      const changes = this.restore(to, this.actor.id, id)
      this.lastPostFrame = this.frameFor(changes, id)
      return this.json(200, { seq: b.log.length, changes })
    }
    return this.respond(fail(404, 'not_found', 'no route'))
  }
}
