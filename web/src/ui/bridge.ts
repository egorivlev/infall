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
