// The one place where the shell (top bar, rail) and the Board talk to each other.
// The shell asks; the Board listens and acts. Each request carries a nonce so repeating it re-triggers.
import { create } from 'zustand'

export type BoardRequest =
  | { type: 'focus'; target: 'card' | 'frame'; id: string; nonce: number }
  | { type: 'create-frame'; nonce: number }
  | { type: 'create-card'; nonce: number }

type BridgeState = { request: BoardRequest | null }

let nonce = 0
export const useBoardRequest = create<BridgeState>(() => ({ request: null }))

export const boardBridge = {
  /** Centre the Board on a Card or Frame and select it. */
  focus(target: 'card' | 'frame', id: string) {
    useBoardRequest.setState({ request: { type: 'focus', target, id, nonce: ++nonce } })
  },
  /** Add a Frame at the centre of what is currently visible. */
  createFrame() {
    useBoardRequest.setState({ request: { type: 'create-frame', nonce: ++nonce } })
  },
  /** Add a Card at the centre of what is currently visible. */
  createCard() {
    useBoardRequest.setState({ request: { type: 'create-card', nonce: ++nonce } })
  },
}


// ---- M2: the History panel. The top bar toggles it; the Board area shows it. ----
type HistoryPanelState = { open: boolean }
export const useHistoryPanel = create<HistoryPanelState>(() => ({ open: false }))
export const historyPanel = {
  toggle() {
    useHistoryPanel.setState((s) => ({ open: !s.open }))
  },
  close() {
    useHistoryPanel.setState({ open: false })
  },
}


// ---- M4: the Page panel. Anything may ask to open a Card's Page; the Board area shows it. ----
type PagePanelState = { cardId: string | null; full: boolean }
export const usePagePanel = create<PagePanelState>(() => ({ cardId: null, full: false }))
export const pagePanel = {
  open(cardId: string) {
    usePagePanel.setState({ cardId })
  },
  close() {
    usePagePanel.setState({ cardId: null, full: false })
  },
  toggleFull() {
    usePagePanel.setState((s) => ({ full: !s.full }))
  },
}
