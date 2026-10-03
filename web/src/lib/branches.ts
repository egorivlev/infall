// Branches: the cached list and forking. The list is also fed by the socket's `branches` frame (see board-sync.ts).
import { useStore } from 'zustand'
import type { BoardSync } from './board-sync'
import { sync } from './board-sync'
import { branchesStore, isGuest, setBranches } from './branches-store'
import { ApiError, request } from './http'
import type { BranchInfo, Moment } from './types'

export function createBranches(boardSync: BoardSync) {
  return {
    // A Guest has no other Branches: resolves without a request and the list stays empty.
    async reload(): Promise<void> {
      if (isGuest()) return
      const { branches: next } = await request<{ branches: BranchInfo[] }>('GET', '/api/branches')
      setBranches(next)
    },
    async create(input: { name: string; from?: Moment }): Promise<BranchInfo> {
      if (isGuest()) throw new ApiError(403, 'forbidden', 'Guests cannot create Branches.')
      let from = input.from
      if (!from) {
        const open = boardSync.internal.target()
        if (!open) throw new ApiError(400, 'board_not_open', 'The Board is not open.')
        from = { branch: open.id, seq: open.seq }
      }
      const { branch } = await request<{ branch: BranchInfo }>('POST', '/api/branches', { name: input.name, from })
      // The `branches` frame brings the full list; until then make sure the new one is there.
      const list = branchesStore.getState().branches
      if (!list.some((b) => b.id === branch.id)) setBranches([...list, branch])
      return branch
    },
  }
}

export const branches = createBranches(sync)

export function useBranches(): BranchInfo[] {
  return useStore(branchesStore, (s) => s.branches)
}
