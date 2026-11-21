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
  /** M18: `claims` names an unclaimed Member (`claimed: false`); whoever accepts takes over that name and its work. */
  create(input: {
    email: string
    role: 'member' | 'guest'
    access_until?: number
    claims?: string
  }): Promise<{ invite: Invite; url: string }> {
    const body: typeof input = { email: input.email, role: input.role }
    if (input.access_until !== undefined) body.access_until = input.access_until
    if (input.claims !== undefined && input.claims !== '') body.claims = input.claims
    return request('POST', '/api/invites', body)
  },
  async remove(id: string): Promise<void> {
    await request('DELETE', `/api/invites/${encodeURIComponent(id)}`)
  },
  /** M18: `claims` when the invite takes over an unclaimed Member's name (api.md §19). */
  lookup(token: string): Promise<{ email: string; role: Role; access_until?: number; claims?: { id: string; name: string } }> {
    return request('GET', `/api/invites/lookup?token=${encodeURIComponent(token)}`)
  },
}
