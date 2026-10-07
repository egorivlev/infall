import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { request } from './http'
import { sessionStore } from './session-store'
import type { Invite, Member, Role } from './types'

type MembersState = { members: Member[] }

const EMPTY: Member[] = []
export const membersStore = createStore<MembersState>(() => ({ members: EMPTY }))

// Forget the cached people when the session ends.
sessionStore.subscribe((s) => {
  if (s.status === 'signed_out' && membersStore.getState().members.length > 0) {
    membersStore.setState({ members: EMPTY })
  }
})

export function useMembers(): Member[] {
  return useStore(membersStore, (s) => s.members)
}

export const members = {
  async reload(): Promise<void> {
    const { members: next } = await request<{ members: Member[] }>('GET', '/api/members')
    // Keep the old array (and its identity) when nothing changed.
    if (JSON.stringify(next) !== JSON.stringify(membersStore.getState().members)) {
      membersStore.setState({ members: next })
    }
  },
  async remove(id: string): Promise<void> {
    await request('DELETE', `/api/members/${encodeURIComponent(id)}`)
    membersStore.setState((s) => ({ members: s.members.filter((m) => m.id !== id) }))
  },
}

export const invites = {
  async list(): Promise<Invite[]> {
    const { invites: list } = await request<{ invites: Invite[] }>('GET', '/api/invites')
    return list
  },
  create(input: {
    email: string
    role: 'member' | 'guest'
    access_until?: number
  }): Promise<{ invite: Invite; url: string }> {
    return request('POST', '/api/invites', input)
  },
  async remove(id: string): Promise<void> {
    await request('DELETE', `/api/invites/${encodeURIComponent(id)}`)
  },
  lookup(token: string): Promise<{ email: string; role: Role; access_until?: number }> {
    return request('GET', `/api/invites/lookup?token=${encodeURIComponent(token)}`)
  },
}
