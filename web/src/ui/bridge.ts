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
// M18: `comment` asks the Page to scroll to that Comment (For you); `nonce` repeats the ask for the same one.
type PagePanelState = { cardId: string | null; full: boolean; comment: { id: string; nonce: number } | null }
export const usePagePanel = create<PagePanelState>(() => ({ cardId: null, full: false, comment: null }))
let commentNonce = 0
export const pagePanel = {
  open(cardId: string, options: { comment?: string } = {}) {
    usePagePanel.setState({ cardId, comment: options.comment ? { id: options.comment, nonce: ++commentNonce } : null })
  },
  close() {
    usePagePanel.setState({ cardId: null, full: false, comment: null })
  },
  toggleFull() {
    usePagePanel.setState((s) => ({ full: !s.full }))
  },
}


// ---- M5: the Suggestions panel (rail toggles it; the Board area shows it) and the Connection it previews. ----
export type SuggestionPreview = { id: string; from: string; to: string; kind: 'related' | 'directed' | 'contradicts'; label: string }
type SuggestionsPanelState = { open: boolean; preview: SuggestionPreview | null }
export const useSuggestionsPanel = create<SuggestionsPanelState>(() => ({ open: false, preview: null }))
export const suggestionsPanel = {
  toggle() {
    useSuggestionsPanel.setState((s) => ({ open: !s.open, preview: null }))
  },
  open() {
    useSuggestionsPanel.setState({ open: true })
  },
  close() {
    useSuggestionsPanel.setState({ open: false, preview: null })
  },
  preview(p: SuggestionPreview | null) {
    useSuggestionsPanel.setState({ preview: p })
  },
}


// ---- M7: the AI sidebar (the top bar toggles it; the shell shows it at the right edge). ----
type AiPanelState = { open: boolean }
export const useAiPanel = create<AiPanelState>(() => ({ open: false }))
export const aiPanel = {
  toggle() {
    useAiPanel.setState((s) => ({ open: !s.open }))
  },
  close() {
    useAiPanel.setState({ open: false })
  },
}

/** What the Member is looking at on the Board, published by the Board so the sidebar can follow it. */
type BoardFocusState = { card: { id: string; title: string } | null }
export const useBoardFocus = create<BoardFocusState>(() => ({ card: null }))
export const boardFocus = {
  set(card: { id: string; title: string } | null) {
    useBoardFocus.setState({ card })
  },
}


// ---- M12: what the Tutorial watches, and the desktop app's way back to the start screen. ----

/** A Card chosen from Search (the search box publishes it; the Tutorial's Search step watches the count). */
type SearchUseState = { chosen: number; card: string | null }
export const useSearchUse = create<SearchUseState>(() => ({ chosen: 0, card: null }))
export const searchUse = {
  chose(card: string) {
    useSearchUse.setState((s) => ({ chosen: s.chosen + 1, card }))
  },
}

/**
 * `window.qoopDesktop.switchWorkspace` (docs/specs/local.md, Contract C): the same as the app's menu item
 * "Switch Workspace…". An older app, and every browser, has none — so this is null and nothing may offer it.
 */
export function desktopSwitchWorkspace(): (() => Promise<void>) | null {
  const desktop = (globalThis as { qoopDesktop?: { switchWorkspace?: unknown } }).qoopDesktop
  if (typeof desktop !== 'object' || desktop === null) return null
  const fn = desktop.switchWorkspace
  return typeof fn === 'function' ? () => Promise.resolve((fn as () => Promise<void>).call(desktop)) : null
}


// ---- M13: saving a file through the desktop app (docs/specs/portability.md, Contract D). ----

type SaveFile = (file: { suggestedName: string; text: string }) => Promise<boolean>

/**
 * `window.qoopDesktop.saveFile`: the system's save dialog, then the text written as UTF-8. Resolves false when the
 * person cancelled. A browser, and an app from before M13, has none — so this is null and the caller downloads.
 */
export function desktopSaveFile(): SaveFile | null {
  const desktop = (globalThis as { qoopDesktop?: { saveFile?: unknown } }).qoopDesktop
  if (typeof desktop !== 'object' || desktop === null) return null
  const fn = desktop.saveFile
  return typeof fn === 'function' ? (file) => Promise.resolve((fn as SaveFile).call(desktop, file)).then((ok) => ok !== false) : null
}


// ---- M18: saving bytes, and the move of a Local Workspace from this computer (team-move.md, Contract C). ----

type SaveBinaryFile = (file: { suggestedName: string; bytes: Uint8Array }) => Promise<boolean>

/** `window.qoopDesktop.saveBinaryFile`: the save dialog, then the bytes as they are; false when cancelled. Null in a browser and an older app. */
export function desktopSaveBinaryFile(): SaveBinaryFile | null {
  const desktop = (globalThis as { qoopDesktop?: { saveBinaryFile?: unknown } }).qoopDesktop
  if (typeof desktop !== 'object' || desktop === null) return null
  const fn = desktop.saveBinaryFile
  return typeof fn === 'function' ? (file) => Promise.resolve((fn as SaveBinaryFile).call(desktop, file)).then((ok) => ok !== false) : null
}

/** The three calls of a move handed over by the desktop app; null unless all three are there (only on the origin of a pending move). */
export type DesktopMove = {
  handover(): Promise<{ name: string; size: number } | null>
  file(): Promise<Uint8Array>
  done(result: { ok: boolean }): Promise<void>
}

export function desktopMove(): DesktopMove | null {
  const d = (globalThis as { qoopDesktop?: Record<string, unknown> }).qoopDesktop
  if (typeof d !== 'object' || d === null) return null
  const { moveHandover, moveFile, moveDone } = d
  if (typeof moveHandover !== 'function' || typeof moveFile !== 'function' || typeof moveDone !== 'function') return null
  return {
    handover: () => Promise.resolve(moveHandover.call(d) as Promise<{ name: string; size: number } | null>),
    file: () => Promise.resolve(moveFile.call(d) as Promise<Uint8Array>),
    done: (result) => Promise.resolve(moveDone.call(d, result) as Promise<void>),
  }
}
