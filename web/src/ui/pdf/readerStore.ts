// Which PDF the reader shows, if any. The reader opens in the Page panel's place (decision 7): anything may ask —
// a Source row's Open PDF, a search result — and the Page panel of that Card shows it.
import { create } from 'zustand'

export type ReaderTarget = {
  /** The Card whose Page panel shows the reader. */
  cardId: string
  sourceId: string
  hash: string
  /** The file name, for Save a copy. */
  name: string
  /** The Source's title, for the reader's heading. */
  title: string
  /** Open at this page (from 1); otherwise where it was left on this device. */
  page?: number
  /** Open with Find showing this, the match on `page` (or after it) chosen. */
  find?: string
  /** A new ask for the same PDF still re-opens it at its page. */
  nonce: number
}

type State = { target: ReaderTarget | null }
export const usePdfReader = create<State>(() => ({ target: null }))

let nonce = 0
export const pdfReader = {
  open(target: Omit<ReaderTarget, 'nonce'>) {
    usePdfReader.setState({ target: { ...target, nonce: ++nonce } })
  },
  close() {
    if (usePdfReader.getState().target) usePdfReader.setState({ target: null })
  },
  /** Closes it when it is showing on `cardId`'s Page (that Page panel went away). */
  closeFor(cardId: string) {
    if (usePdfReader.getState().target?.cardId === cardId) usePdfReader.setState({ target: null })
  },
}
