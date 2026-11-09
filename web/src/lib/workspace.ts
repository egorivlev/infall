// M12: what kind of Workspace this is (docs/specs/local.md, Contract B), and what only a Local Workspace has:
// changing the one Member's name, and a place on the server for the Tutorial's progress.
// M18 (docs/specs/team-move.md, Contract B): whether a Team server is still empty, whether this copy was moved and
// is read-only, and bringing in / taking out a Workspace file.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { ApiError, movedRefusals, request, requestBytes, uploadBytes } from './http'
import type { UploadProgress } from './http'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import type { ExportedFile, ImportResult, Member, WorkspaceInfo, WorkspaceSnapshot } from './types'

const UNKNOWN: WorkspaceSnapshot = { status: 'idle', kind: 'team', preset: null, empty: false, readOnly: false, movedTo: null }
export const workspaceStore = createStore<WorkspaceSnapshot>(() => UNKNOWN)

// The answer that is still wanted: a newer load, or the session ending, makes an older answer harmless.
let asking = 0

// A Workspace is known per session: signing out (or another Member signing in) forgets it.
let owner: string | null = null
sessionStore.subscribe((s) => {
  const id = s.status === 'signed_in' ? s.member.id : null
  if (id === owner) return
  owner = id
  asking++
  movedRefusals.reset()
  if (workspaceStore.getState() !== UNKNOWN) workspaceStore.setState(UNKNOWN, true)
})

// A write refused with 403 `moved` says this copy is read-only, whatever `GET /api/workspace` said before.
movedRefusals.subscribe(() => {
  const now = workspaceStore.getState()
  if (!now.readOnly && movedRefusals.current().refusals > 0 && signedIn()) workspaceStore.setState({ ...now, readOnly: true }, true)
})

/** Until `GET /api/workspace` has answered, this reads as a Team Workspace (`status` says whether it is known). */
export function useWorkspace(): WorkspaceSnapshot {
  return useStore(workspaceStore)
}

/** The server's sentence for the last write a moved Workspace refused, and how many there were; null sentence until one. */
export function useMovedRefusal(): { sentence: string | null; refusals: number } {
  return useStore(movedStore)
}
const movedStore = createStore(() => movedRefusals.current())
movedRefusals.subscribe(() => movedStore.setState(movedRefusals.current(), true))

function readInfo(body: unknown): WorkspaceInfo {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const kind = b.kind === 'local' ? 'local' : 'team'
  const readOnly = b.read_only === true
  return {
    kind,
    preset: kind === 'local' && typeof b.preset === 'string' && b.preset !== '' ? b.preset : null,
    // Contract B: always false in a Local Workspace.
    empty: kind === 'team' && b.empty === true,
    readOnly,
    // Not in Contract B: read when a server sends it, so the bar can name the place.
    movedTo: readOnly && typeof b.moved_to === 'string' && b.moved_to.trim() !== '' ? b.moved_to.trim() : null,
  }
}

const MAX_NAME = 100

function signedIn(): Member | null {
  const s = sessionStore.getState()
  return s.status === 'signed_in' ? s.member : null
}

function admin(what: string): Member {
  const me = signedIn()
  if (me === null || me.role !== 'admin') throw new ApiError(403, 'forbidden', `Only an Admin can ${what}.`)
  return me
}

/** Reads a member list item of the import answer; odd items are dropped. */
function readImport(body: unknown): ImportResult {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const list = Array.isArray(b.members) ? b.members : []
  const members: ImportResult['members'] = []
  for (const m of list) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue
    members.push({ id: r.id, name: r.name, claimed: r.claimed !== false })
  }
  return { members, you_were: typeof b.you_were === 'string' ? b.you_were : '' }
}

export const workspace = {
  /** What is known right now, for code outside React. */
  current(): WorkspaceSnapshot {
    return workspaceStore.getState()
  },

  /**
   * Asks the server once per session (again only after the session changes). Never throws: a server from before
   * M12 answers 404, which means a Team Workspace; any other failure reads as a Team Workspace too, so nothing a
   * team needs is ever hidden by mistake. M18: `empty` and `readOnly` are false unless the server says true.
   */
  async load(): Promise<void> {
    const me = signedIn()
    if (me === null || workspaceStore.getState().status !== 'idle') return
    const ticket = ++asking
    workspaceStore.setState({ ...UNKNOWN, status: 'loading' }, true)
    let info: WorkspaceInfo = { kind: 'team', preset: null, empty: false, readOnly: false, movedTo: null }
    try {
      info = readInfo(await request<unknown>('GET', '/api/workspace'))
    } catch {
      // 404 (an older server), a network failure, anything: a Team Workspace.
    }
    if (ticket !== asking) return
    // A `moved` refusal that came in while asking wins.
    if (movedRefusals.current().refusals > 0) info.readOnly = true
    workspaceStore.setState({ status: 'ready', ...info }, true)
  },

  /**
   * A Local Workspace only: renames its one Member (`PATCH /api/local/member`). The new name shows everywhere at
   * once — the account menu, presence, History, To-dos. Resolves with the name the server kept. Rejects with an
   * ApiError: locally 400 `bad_request` for a name that is empty or over 100 characters after trimming, 403
   * `forbidden` when not signed in; otherwise whatever the server says (404 on a Team Workspace).
   */
  async rename(name: string): Promise<string> {
    const me = signedIn()
    if (me === null) throw new ApiError(403, 'forbidden', 'Not signed in.')
    const text = name.trim()
    if (text === '' || [...text].length > MAX_NAME) throw new ApiError(400, 'bad_request', 'A name is 1 to 100 characters long.')
    const answer = await request<{ name?: unknown }>('PATCH', '/api/local/member', { name: text })
    const kept = typeof answer.name === 'string' && answer.name !== '' ? answer.name : text
    const now = signedIn()
    if (now?.id === me.id) sessionStore.setState({ status: 'signed_in', member: { ...now, name: kept } }, true)
    const list = membersStore.getState().members
    if (list.some((m) => m.id === me.id)) membersStore.setState({ members: list.map((m) => (m.id === me.id ? { ...m, name: kept } : m)) })
    return kept
  },

  /** A Local Workspace only: the Tutorial's progress as the web UI last stored it, or null. Rejects with the ApiError. */
  async loadTutorial(): Promise<unknown> {
    const { state } = await request<{ state?: unknown }>('GET', '/api/local/tutorial')
    return state ?? null
  },

  /** A Local Workspace only: stores the Tutorial's progress as it is (the server never reads it; at most 16 KiB). */
  async saveTutorial(state: unknown): Promise<void> {
    await request('PUT', '/api/local/tutorial', { state })
  },

  /**
   * M18: "Start empty" on an empty Team server. Nothing is sent (there is nothing to do on the server): the first
   * screen simply steps aside for this session, and the Admin gets the ordinary empty Board.
   */
  startEmpty(): void {
    const now = workspaceStore.getState()
    if (now.empty) workspaceStore.setState({ ...now, empty: false }, true)
  },

  /**
   * M18: brings a Workspace file into this empty Team server (`POST /api/workspace/import`, the bytes as
   * `application/octet-stream`). `onProgress(sent, total)` follows the upload. Resolves with the answer; afterwards
   * the Workspace reads as not empty and the Member list is fetched again (the file brought names). Rejects with an
   * ApiError — the server's sentence in `message`: 409 `not_empty`, 400 `not_a_workspace_file`, 413, 422
   * `newer_version`; locally 403 `forbidden` for anyone but an Admin, 400 `bad_request` for an empty file.
   */
  async importFile(file: Blob | Uint8Array, options: { onProgress?: UploadProgress; signal?: AbortSignal } = {}): Promise<ImportResult> {
    const me = admin('bring in a Workspace file')
    const size = file instanceof Uint8Array ? file.byteLength : file.size
    if (size === 0) throw new ApiError(400, 'bad_request', 'That file is empty. Choose a Workspace file (.infall).')
    const answer = readImport(await uploadBytes<unknown>('/api/workspace/import', file, options))
    if (signedIn()?.id === me.id) {
      const now = workspaceStore.getState()
      if (now.empty) workspaceStore.setState({ ...now, empty: false }, true)
      const list = await request<{ members: Member[] }>('GET', '/api/members').catch(() => null)
      if (list && signedIn()?.id === me.id) membersStore.setState({ members: list.members })
    }
    return answer
  },

  /**
   * M18: the Team Workspace as a Workspace file (`GET /api/workspace/export`), for an Admin. `name` is the server's
   * (`Content-Disposition`), else "Workspace.infall". Rejects with the ApiError; locally 403 `forbidden`.
   */
  async exportFile(): Promise<ExportedFile> {
    admin('export the Workspace')
    const { bytes, filename } = await requestBytes('/api/workspace/export')
    return { name: filename ?? 'Workspace.infall', bytes }
  },
}
