import { useStore } from 'zustand'
import { ApiError, request } from './http'
import { sessionStore } from './session-store'
import type { Member, SessionSnapshot } from './types'

export function useSession(): SessionSnapshot {
  return useStore(sessionStore)
}

function signIn(member: Member) {
  sessionStore.setState({ status: 'signed_in', member }, true)
}

function signOutIfLoading() {
  if (sessionStore.getState().status === 'loading') sessionStore.setState({ status: 'signed_out' }, true)
}

export const session = {
  // Never throws: a 401 means signed out; any other failure while still loading also ends in signed_out
  // so the UI shows the login screen instead of an endless spinner.
  async refresh(): Promise<void> {
    try {
      const { member } = await request<{ member: Member }>('GET', '/api/me')
      signIn(member)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        sessionStore.setState({ status: 'signed_out' }, true)
      } else {
        signOutIfLoading()
      }
    }
  },
  async login(email: string, password: string): Promise<void> {
    try {
      const { member } = await request<{ member: Member }>('POST', '/api/auth/login', { email, password })
      signIn(member)
    } catch (e) {
      signOutIfLoading()
      throw e
    }
  },
  async logout(): Promise<void> {
    await request('POST', '/api/auth/logout')
    sessionStore.setState({ status: 'signed_out' }, true)
  },
  async acceptInvite(token: string, name: string, password: string): Promise<void> {
    const { member } = await request<{ member: Member }>('POST', '/api/auth/accept-invite', {
      token,
      name,
      password,
    })
    signIn(member)
  },
}
