import { useMemo } from 'react'
import { useBoard } from '../../lib'
import type { AiScope } from '../../lib'
import { useBoardFocus } from '../bridge'
import { useSidebarState } from './state'

export type Scope = {
  /** What a question would be about; null while the Branch is not loaded (nothing can be sent yet). */
  scope: AiScope | null
  /** The Card in scope, if any. */
  card: { id: string; title: string } | null
  /** The Branch name to show, known from the route even before the Board has loaded. */
  branchName: string
  /** A Card is selected but the Member chose the Board scope with ✕. */
  boardByChoice: boolean
}

/** The scope follows the Board's selection: the Card in focus, else the Board of the open Branch. */
export function useScope(shownBranch: string): Scope {
  const branch = useBoard().branch
  const focus = useBoardFocus((s) => s.card)
  const dismissed = useSidebarState((s) => s.dismissed)
  const branchId = branch?.id
  const branchName = branch?.name ?? shownBranch
  const boardByChoice = focus !== null && focus.id === dismissed
  const cardId = focus && !boardByChoice ? focus.id : null
  const cardTitle = focus?.title ?? ''

  return useMemo(() => {
    const card = cardId === null ? null : { id: cardId, title: cardTitle }
    const scope: AiScope | null =
      branchId === undefined ? null : card ? { branch: branchId, branchName, card } : { branch: branchId, branchName }
    return { scope, card, branchName, boardByChoice }
  }, [branchId, branchName, cardId, cardTitle, boardByChoice])
}
