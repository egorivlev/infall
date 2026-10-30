// "New Branch…" in the switcher asks the Branch Graph to select the newest dot of the open Branch and to put the
// cursor in its name field.
import { create } from 'zustand'

export const useNewBranchIntent = create<{ pending: boolean }>(() => ({ pending: false }))

export const newBranchIntent = {
  request() {
    useNewBranchIntent.setState({ pending: true })
  },
  clear() {
    useNewBranchIntent.setState({ pending: false })
  },
}
