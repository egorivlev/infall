// Test helpers: a stand-in for the parts of `../../lib` the Suggestions panel uses. Only imported by tests.
// Built on the Page test kit (Board, Members, session, To-dos); adds a list of Suggestions that
// `suggestions.accept / reject / reopen` change when they resolve.
import { vi } from 'vitest'
import { create } from 'zustand'
import type { Suggestion, SuggestionVM } from '../../lib'
import { at } from '../history/testkit'
import { ANA, MEI, createFakePageLib } from '../page/testkit'

export { ANA, MEI, at }
export { GUEST, card } from '../page/testkit'

/** A Source Suggestion for Card `c1` ("Noise-induced plateaus"), made by Mei's AI on 14 Nov. */
export const sourceSuggestion = (id: string, extra: Partial<Suggestion> = {}, vm: Partial<SuggestionVM> = {}): SuggestionVM => ({
  suggestion: {
    id,
    branch: 'main-id',
    kind: 'source',
    card: 'c1',
    source: { url: 'https://arxiv.org/abs/2007.14384', title: 'Noise-induced barren plateaus', authors: 'Wang et al.', year: '2021' },
    reason: 'The Page states this result but has no Source attached.',
    created_by: MEI.id,
    model: 'claude-opus-4',
    created_at: at(14, 9),
    state: 'pending',
    ...extra,
  },
  title: 'Noise-induced barren plateaus',
  meta: 'Wang et al. · 2021 · arXiv:2007.14384',
  target: 'for Card: Noise-induced plateaus',
  cards: ['c1'],
  stale: false,
  ...vm,
})

/** A Connection Suggestion `c1` → `c2`, labelled "may explain", made by Mei's AI on 14 Nov. */
export const connectionSuggestion = (id: string, extra: Partial<Suggestion> = {}, vm: Partial<SuggestionVM> = {}): SuggestionVM => ({
  suggestion: {
    id,
    branch: 'main-id',
    kind: 'connection',
    connection: { from: 'c1', to: 'c2', kind: 'directed', label: 'may explain' },
    reason: 'Both Pages describe gradients shrinking with depth.',
    created_by: MEI.id,
    created_at: at(14, 9),
    state: 'pending',
    ...extra,
  },
  title: 'Noise-induced plateaus → Reward plateaus',
  meta: 'may explain',
  target: 'Board: main',
  cards: ['c1', 'c2'],
  stale: false,
  ...vm,
})

export function createFakeSuggestionsLib() {
  const base = createFakePageLib()
  const store = create<{ list: SuggestionVM[] }>(() => ({ list: [] }))

  const patch = (id: string, change: (s: Suggestion) => Suggestion) =>
    store.setState((st) => ({ list: st.list.map((vm) => (vm.suggestion.id === id ? { ...vm, suggestion: change(vm.suggestion) } : vm)) }))
  const meId = () => {
    const s = base.sessionStore.getState()
    return s.status === 'signed_in' ? s.member.id : undefined
  }

  const accept = async (id: string): Promise<{ sourceId?: string; cardId?: string }> => {
    const found = store.getState().list.find((vm) => vm.suggestion.id === id)
    patch(id, (s) => ({ ...s, state: 'accepted', decided_by: meId(), decided_at: Date.now() }))
    return found?.suggestion.kind === 'source' ? { sourceId: 'src-new', cardId: found.suggestion.card } : {}
  }
  const reject = async (id: string): Promise<void> => {
    patch(id, (s) => ({ ...s, state: 'rejected', decided_by: meId(), decided_at: Date.now() }))
  }
  const reopen = async (id: string): Promise<void> => {
    patch(id, ({ decided_by: _by, decided_at: _at, ...s }) => ({ ...s, state: 'pending' }))
  }
  const suggestions = {
    reload: vi.fn(async (): Promise<void> => {}),
    accept: vi.fn(accept),
    reject: vi.fn(reject),
    reopen: vi.fn(reopen),
  }

  return {
    ...base,
    suggestionStore: store,
    suggestions,
    /** Put these Suggestions in the list. */
    show(...list: SuggestionVM[]) {
      store.setState({ list })
    },
    reset() {
      base.reset()
      store.setState({ list: [] }, true)
      suggestions.reload.mockReset().mockImplementation(async () => {})
      suggestions.accept.mockReset().mockImplementation(accept)
      suggestions.reject.mockReset().mockImplementation(reject)
      suggestions.reopen.mockReset().mockImplementation(reopen)
    },
    /** `vi.mock('../../lib', async (orig) => fake.module(await orig()))`. */
    module<T extends { ops: object }>(real: T) {
      return {
        ...base.module(real),
        useSuggestions: () => store((s) => s.list),
        suggestions,
      }
    },
  }
}
