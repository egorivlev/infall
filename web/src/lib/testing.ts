// Test helpers: a fake qoop server (fetch + WebSocket) and a manual timer. Not exported from index.ts.
import { applyOps } from './board-state'
import type { Entities } from './board-state'
import type { SocketLike } from './board-sync'
import type { BranchInfo, Change, Checkpoint, ClientFrame, Member, Moment, Op, Origin, ServerFrame } from './types'

export const ME: Member = { id: 'me', name: 'Me', role: 'member', color: '#111' }
export const OTHER: Member = { id: 'other', name: 'Other', role: 'member', color: '#222' }
export const GUEST: Member = { id: 'guest', name: 'Guest', role: 'guest', color: '#333' }

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
 * A fake qoop server: M1 (Board, Changes, ops) and M2 (Branches, Checkpoints, Restore, Board at a moment).
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
  failChanges = false
  members: Member[] = [ME, OTHER]
  actor: Member = ME // who the requests come from
  now = 0 // the `at` given to new Changes, Checkpoints and Branches
  lastPostFrame: ServerFrame | null = null
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

  checkpointFrame(checkpoint: Checkpoint): ServerFrame {
    return { type: 'checkpoint', branch: checkpoint.moment.branch, checkpoint }
  }

  branchesFrame(): ServerFrame {
    return { type: 'branches', branches: this.all.map((b) => this.info(b)) }
  }

  private json(status: number, body: unknown) {
    const text = JSON.stringify(body)
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response
  }

  private respond(r: { status: number; body: unknown }) {
    return this.json(r.status, r.body)
  }

  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    this.requests.push({ method, path, body })
    const guest = this.actor.role === 'guest'
    const forbidden = fail(403, 'forbidden')
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
    const m = /^\/api\/branches\/([^/?]+)\/(board|changes|ops|checkpoints|restore)(?:\?(.*))?$/.exec(path)
    const b = m ? this.all.find((x) => x.info.id === decodeURIComponent(m[1]!)) : undefined
    if (!m || !b) return this.respond(fail(404, 'not_found', 'no route'))
    const what = m[2]
    const query = new URLSearchParams(m[3] ?? '')
    const id = b.info.id
    if (guest && b.info.name !== 'main') return this.respond(forbidden)
    if (what === 'board' && method === 'GET') {
      if (!query.has('at')) return this.json(200, { branch: id, seq: b.log.length, entities: b.entities })
      if (guest) return this.respond(forbidden)
      const at = Number(query.get('at'))
      if (!(at >= 0 && at <= b.log.length)) return this.respond(fail(400, 'bad_request'))
      return this.json(200, { branch: id, seq: at, entities: this.boardAt(b, at) })
    }
    if (what === 'changes' && method === 'GET') {
      if (this.failChanges) return this.respond(fail(500, 'internal', 'x'))
      return this.json(200, { seq: b.log.length, changes: b.log.slice(Number(query.get('after') ?? 0)) })
    }
    if (what === 'ops' && method === 'POST') {
      if (this.gate) await this.gate
      if (this.failNext) {
        const f = this.failNext
        this.failNext = null
        return this.respond(fail(f.status, f.code))
      }
      if (guest) return this.respond(forbidden)
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
