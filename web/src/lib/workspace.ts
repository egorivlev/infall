// M12: what kind of Workspace this is (docs/specs/local.md, Contract B), and what only a Local Workspace has:
// changing the one Member's name, and a place on the server for the Tutorial's progress.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { ApiError, request } from './http'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import type { Member, WorkspaceInfo, WorkspaceSnapshot } from './types'

const UNKNOWN: WorkspaceSnapshot = { status: 'idle', kind: 'team', preset: null }
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
  if (workspaceStore.getState() !== UNKNOWN) workspaceStore.setState(UNKNOWN, true)
})

/** Until `GET /api/workspace` has answered, this reads as a Team Workspace (`status` says whether it is known). */
export function useWorkspace(): WorkspaceSnapshot {
  return useStore(workspaceStore)
}

function readInfo(body: unknown): WorkspaceInfo {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const kind = b.kind === 'local' ? 'local' : 'team'
  return { kind, preset: kind === 'local' && typeof b.preset === 'string' && b.preset !== '' ? b.preset : null }
}

const MAX_NAME = 100

function signedIn(): Member | null {
  const s = sessionStore.getState()
  return s.status === 'signed_in' ? s.member : null
}

export const workspace = {
  /** What is known right now, for code outside React. */
  current(): WorkspaceSnapshot {
    return workspaceStore.getState()
  },

  /**
   * Asks the server once per session (again only after the session changes). Never throws: a server from before
   * M12 answers 404, which means a Team Workspace; any other failure reads as a Team Workspace too, so nothing a
   * team needs is ever hidden by mistake.
   */
  async load(): Promise<void> {
    const me = signedIn()
    if (me === null || workspaceStore.getState().status !== 'idle') return
    const ticket = ++asking
    workspaceStore.setState({ ...UNKNOWN, status: 'loading' }, true)
    let info: WorkspaceInfo = { kind: 'team', preset: null }
    try {
      info = readInfo(await request<unknown>('GET', '/api/workspace'))
    } catch {
      // 404 (an older server), a network failure, anything: a Team Workspace.
    }
    if (ticket !== asking) return
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
}
