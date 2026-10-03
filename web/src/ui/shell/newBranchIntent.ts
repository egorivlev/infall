// "New Branch from now…" in the switcher asks the Branches screen to put the cursor in its Name field.
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
