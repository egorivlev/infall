// "Preview the Board" from the Branch Graph (docs/specs/branch-graph.md §1): open that Branch's Board with History
// showing the moment right after the chosen Activity, exactly as History's own preview does; leaving the preview
// goes back to the graph. The graph asks here; the History panel (HistoryPanel.tsx) carries it out, because it is
// what opens History for the Branch the Board has open.
import { create } from 'zustand'
import { historyPanel, useHistoryPanel } from '../bridge'
import { branchPath, navigate } from '../shell/router'

/**
 * `opening`: the Board and History of that Branch are on their way; `asked`: `history.preview(seq)` was called;
 * `shown`: the preview is on the Board — from now on, its end is the way back.
 */
export type GraphPreviewPhase = 'opening' | 'asked' | 'shown'

export type GraphPreview = {
  branch: string // name, for the route
  branchId: string
  seq: number
  back: string // where leaving the preview goes
  hadPanel: boolean // the History panel was open before: it stays open on the way back
  phase: GraphPreviewPhase
}

export const useGraphPreview = create<{ current: GraphPreview | null }>(() => ({ current: null }))

function set(patch: Partial<GraphPreview>) {
  const c = useGraphPreview.getState().current
  if (c) useGraphPreview.setState({ current: { ...c, ...patch } })
}

export const graphPreview = {
  /** Opens the Board of `branch` with the History panel, which then previews `seq`. */
  start(p: { branch: string; branchId: string; seq: number; back: string }) {
    const hadPanel = useHistoryPanel.getState().open
    useGraphPreview.setState({ current: { ...p, hadPanel, phase: 'opening' } })
    useHistoryPanel.setState({ open: true })
    navigate(branchPath(p.branch))
  },
  asked() {
    set({ phase: 'asked' })
  },
  shown() {
    set({ phase: 'shown' })
  },
  /** The preview has ended: back to where it was asked for (closing the History panel if it was opened for it). */
  finish() {
    const c = useGraphPreview.getState().current
    if (!c) return
    useGraphPreview.setState({ current: null })
    if (!c.hadPanel) historyPanel.close()
    navigate(c.back)
  },
  /** Forget it without going anywhere: the Member went elsewhere by hand, or Restored. */
  drop() {
    if (useGraphPreview.getState().current) useGraphPreview.setState({ current: null })
  },
  /**
   * History of a Branch was closed (the Board left, or switched Branch). While the preview is still on its way that
   * is part of getting there; once asked for or shown, the Member went elsewhere by hand: forget it.
   */
  left() {
    if (useGraphPreview.getState().current?.phase !== 'opening') graphPreview.drop()
  },
}
