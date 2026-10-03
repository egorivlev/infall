// Internal: the zustand store behind `useBranches()`. Separate so board-sync.ts can feed it without a cycle.
import { createStore } from 'zustand/vanilla'
import { sessionStore } from './session-store'
import type { BranchInfo } from './types'

const EMPTY: BranchInfo[] = []
export const branchesStore = createStore<{ branches: BranchInfo[] }>(() => ({ branches: EMPTY }))

export function isGuest(): boolean {
  const s = sessionStore.getState()
  return s.status === 'signed_in' && s.member.role === 'guest'
}

// Replaces the cached list. Keeps the old array (and its identity) when nothing changed. Guests never get a list.
export function setBranches(next: BranchInfo[]): void {
  if (isGuest()) return
  if (JSON.stringify(next) !== JSON.stringify(branchesStore.getState().branches)) {
    branchesStore.setState({ branches: next })
  }
}

// Forget the cached Branches when the session ends or belongs to a Guest.
sessionStore.subscribe((s) => {
  const hide = s.status === 'signed_out' || (s.status === 'signed_in' && s.member.role === 'guest')
  if (hide && branchesStore.getState().branches.length > 0) branchesStore.setState({ branches: EMPTY })
})
