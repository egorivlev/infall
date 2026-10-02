// Test helpers: a fake qoop server (fetch + WebSocket) and a manual timer. Not exported from index.ts.
import { applyOps } from './board-state'
import type { Entities } from './board-state'
import type { SocketLike } from './board-sync'
import type { BranchInfo, Change, ClientFrame, Member, Op, ServerFrame } from './types'

export const ME: Member = { id: 'me', name: 'Me', role: 'member', color: '#111' }
export const OTHER: Member = { id: 'other', name: 'Other', role: 'member', color: '#222' }

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

export class FakeServer {
  entities: Entities = {}
  log: Change[] = []
  requests: Logged[] = []
  branch: BranchInfo = { id: 'main-id', name: 'main', seq: 0 }
  gate: Promise<void> | null = null // when set, POST /ops waits for it before applying
  responseGate: Promise<void> | null = null // when set, POST /ops waits for it after applying, before answering
  failNext: { status: number; code: string } | null = null
  failChanges = false
  members: Member[] = [ME, OTHER]
  private n = 0

  get seq() {
    return this.log.length
  }

  frameFor(changes: Change[]): ServerFrame {
    return { type: 'changes', branch: this.branch.id, seq: this.seq, changes }
  }

  // A change made by someone else; returns the frame the server would broadcast.
  external(ops: Op[], author = OTHER.id): ServerFrame {
    return this.frameFor(this.commit(ops, author))
  }

  commit(ops: Op[], author: string): Change[] {
    const r = applyOps(this.entities, ops)
    if (!r.ok) throw new Error('fake server: ' + r.rejection.message)
    this.entities = r.entities
    const changes = ops.map((op) => ({ id: `c${this.n++}`, author, at: 0, op, origin: 'Edit' as const }))
    this.log.push(...changes)
    return changes
  }

  private json(status: number, body: unknown) {
    const text = JSON.stringify(body)
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response
  }

  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    this.requests.push({ method, path, body })
    const base = `/api/branches/${this.branch.id}`
    if (path === '/api/branches') return this.json(200, { branches: [{ ...this.branch, seq: this.seq }] })
    if (path === '/api/members') return this.json(200, { members: this.members })
    if (path === `${base}/board`) {
      return this.json(200, { branch: this.branch.id, seq: this.seq, entities: this.entities })
    }
    if (path.startsWith(`${base}/changes?after=`)) {
      if (this.failChanges) return this.json(500, { error: { code: 'internal', message: 'x', detail: null } })
      const after = Number(path.split('=')[1])
      return this.json(200, { seq: this.seq, changes: this.log.slice(after) })
    }
    if (path === `${base}/ops` && method === 'POST') {
      if (this.gate) await this.gate
      if (this.failNext) {
        const f = this.failNext
        this.failNext = null
        return this.json(f.status, { error: { code: f.code, message: 'nope', detail: null } })
      }
      const r = applyOps(this.entities, body.ops)
      if (!r.ok) {
        return this.json(409, { error: { code: 'rejected', message: r.rejection.message, detail: r.rejection } })
      }
      const changes = this.commit(body.ops, ME.id)
      this.lastPostFrame = this.frameFor(changes)
      if (this.responseGate) await this.responseGate
      return this.json(200, { seq: this.seq, changes })
    }
    return this.json(404, { error: { code: 'not_found', message: 'no route', detail: null } })
  }
  lastPostFrame: ServerFrame | null = null
}
