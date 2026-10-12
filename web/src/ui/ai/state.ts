// What the sidebar remembers while it is closed: the unsent draft and "ask about the whole Board
// instead of this Card". Memory only — a draft is never written to storage.
import { create } from 'zustand'
import { useBoardFocus } from '../bridge'

type SidebarState = {
  draft: string
  /** The Card the Member turned away from with ✕; the scope is the Board until the selection changes. */
  dismissed: string | null
  /** Why the last question could not be sent, in words; '' when there is nothing to say. */
  error: string
}

export const useSidebarState = create<SidebarState>(() => ({ draft: '', dismissed: null, error: '' }))

export const sidebarState = {
  setDraft(draft: string) {
    useSidebarState.setState({ draft })
  },
  dismiss(cardId: string) {
    useSidebarState.setState({ dismissed: cardId })
  },
  setError(error: string) {
    useSidebarState.setState({ error })
  },
  reset() {
    useSidebarState.setState({ draft: '', dismissed: null, error: '' })
  },
}

// The selection changed (another Card, or none): follow it again.
useBoardFocus.subscribe((s) => {
  const { dismissed } = useSidebarState.getState()
  if (dismissed !== null && s.card?.id !== dismissed) useSidebarState.setState({ dismissed: null })
})
