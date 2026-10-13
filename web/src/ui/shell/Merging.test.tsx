// M3 in the shell: the Merge route, who may use it, and the entry points on the Branches screen.
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, BranchInfo, HistorySnapshot, Member, SessionSnapshot } from '../../lib'

type Options = { intoParent?: BranchInfo; fromParent?: BranchInfo }
const h = vi.hoisted(() => ({
  session: { status: 'signed_out' } as unknown as SessionSnapshot,
  board: {} as unknown as BoardSnapshot,
  list: [] as BranchInfo[],
  options: ((): Options => ({})) as (b: BranchInfo, all: BranchInfo[]) => Options,
  opened: [] as string[],
  mounts: [] as string[],
}))

// M7: no AI set up. The sidebar and the AI settings card have their own tests.
const noAi = vi.hoisted(() => ({
  snapshot: { setup: { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }, conversations: [], current: null, busy: false },
}))

vi.mock('../../lib', () => ({
  useAi: () => noAi.snapshot,
  ai: { refresh: async () => {}, models: async () => [] },
  useSession: () => h.session,
  useBoard: () => h.board,
  useSuggestions: () => [],
  useRuns: () => ({ runner: { available: false, reason: 'browser' }, live: null, last: null }), // nothing runs: the top bar has no Runner monitor
  useMembers: () => [],
  useBranches: () => h.list,
  useHistory: (): HistorySnapshot => ({ status: 'idle', head: 0, activities: [], checkpoints: [], preview: null }),
  mergeOptions: (b: BranchInfo, all: BranchInfo[]) => h.options(b, all),
  session: { refresh: async () => {}, logout: async () => {} },
  board: {
    open: async (name: string) => void h.opened.push(name),
    close: () => {},
  },
  members: { reload: async () => {} },
  branches: { reload: async () => {}, create: async () => ({}) },
  history: { open: async () => {}, close: () => {}, preview: () => {}, restore: async () => {}, createCheckpoint: async () => ({}) },
}))
vi.mock('../board', () => ({ BoardView: () => <div data-testid="board" /> }))
vi.mock('../merge', async () => {
  const { useEffect } = await import('react')
  return {
    MergeReview: ({ from, into }: { from: string; into: string }) => {
      useEffect(() => {
        h.mounts.push(`${from} → ${into}`)
      }, [from, into])
      return <div data-testid="merge-review" data-from={from} data-into={into} />
    },
  }
})

import { App } from './App'
import { rememberBranch } from './router'
import { resetThemeCache } from './theme'

const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const GUEST: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }

const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }
const QEC: BranchInfo = { id: 'b-qec', name: 'try-QEC', seq: 14, checkpoints: 0, parent: { branch: 'b-main', seq: 30 }, created_by: 'm' }
const CART: BranchInfo = { id: 'b-cart', name: 'ana/Cartpole & lr', seq: 3, checkpoints: 0, parent: { branch: 'b-qec', seq: 12 }, created_by: 'm' }
const LOST: BranchInfo = { id: 'b-lost', name: 'orphan', seq: 1, checkpoints: 0, parent: { branch: 'b-gone', seq: 1 } }

/** What the data layer does in v1: a Branch merges only with the Branch it was started from. */
const withParent = (b: BranchInfo, all: BranchInfo[]): Options => {
  const parent = all.find((x) => x.id === b.parent?.branch)
  return parent ? { intoParent: parent, fromParent: parent } : {}
}

const go = (path: string) => window.history.replaceState(null, '', path)
const signedIn = (member: Member) => (h.session = { status: 'signed_in', member })
const here = () => window.location.pathname + window.location.search
const row = (name: string) => screen.getByRole('rowheader', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).closest('tr') as HTMLElement

beforeEach(() => {
  go('/')
  window.localStorage.clear()
  resetThemeCache()
  rememberBranch('main')
  h.board = { status: 'live', seq: 40, branch: MAIN, cards: [], frames: [], connections: [], presence: [MEI], pending: 0, readOnly: false }
  h.list = [MAIN, QEC, CART, LOST]
  h.options = withParent
  h.opened = []
  h.mounts = []
  signedIn(MEI)
})
afterEach(() => {
  cleanup()
})

describe('Merge route', () => {
  it('mounts the review with both Branch names decoded, and keeps the last Branch in the top bar', () => {
    go('/merge?from=ana%2FCartpole%20%26%20lr&into=try-QEC')
    const { container } = render(<App />)
    const review = screen.getByTestId('merge-review')
    expect(review).toHaveAttribute('data-from', 'ana/Cartpole & lr')
    expect(review).toHaveAttribute('data-into', 'try-QEC')
    expect(here()).toBe('/merge?from=ana%2FCartpole%20%26%20lr&into=try-QEC')
    // Neither Branch of the Merge is opened on the Board; the top bar stays on the last one.
    expect(h.opened).toEqual(['main'])
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'main')
    expect(screen.getByRole('button', { name: 'Branch main' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Branches' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('board')).toBeNull()
  })

  it('keeps the Branch that was open before, coming from its Board', async () => {
    go('/b/try-QEC')
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    await user.click(screen.getByRole('link', { name: 'Merge try-QEC into main…' }))
    expect(here()).toBe('/merge?from=try-QEC&into=main')
    expect(screen.getByTestId('merge-review')).toHaveAttribute('data-from', 'try-QEC')
    expect(container.querySelector('.q-shell')).toHaveAttribute('data-branch', 'try-QEC')
    expect(h.opened).toEqual(['try-QEC'])
  })

  it('starts a fresh review when the two Branches change', async () => {
    go('/merge?from=try-QEC&into=main')
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('link', { name: 'Branches' }))
    await user.click(screen.getByRole('link', { name: 'Update try-QEC from main…' }))
    expect(here()).toBe('/merge?from=main&into=try-QEC')
    expect(h.mounts).toEqual(['try-QEC → main', 'main → try-QEC'])
  })

  it('redirects a Guest to the Board of main', () => {
    signedIn(GUEST)
    h.board = { ...h.board, readOnly: true }
    go('/merge?from=try-QEC&into=main')
    render(<App />)
    expect(here()).toBe('/')
    expect(screen.queryByTestId('merge-review')).toBeNull()
    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(h.opened).toEqual(['main'])
  })

  it('shows the Branches screen when a name is missing from the URL', () => {
    go('/merge?from=try-QEC')
    render(<App />)
    expect(screen.queryByTestId('merge-review')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Branches', level: 1 })).toBeInTheDocument()
  })
})

describe('Merge entry points on the Branches screen', () => {
  beforeEach(() => go('/branches'))

  it('offers both directions on each Branch that can merge with the Branch it was started from', () => {
    render(<App />)
    const qec = within(row('try-QEC'))
    expect(qec.getByRole('link', { name: 'Merge try-QEC into main…' })).toHaveAttribute('href', '/merge?from=try-QEC&into=main')
    expect(qec.getByRole('link', { name: 'Merge try-QEC into main…' })).toHaveTextContent('Merge into main…')
    expect(qec.getByRole('link', { name: 'Update try-QEC from main…' })).toHaveAttribute('href', '/merge?from=main&into=try-QEC')
    expect(qec.getByRole('link', { name: 'Update try-QEC from main…' })).toHaveTextContent('Update from main…')
    expect(qec.getByRole('link', { name: 'Open try-QEC' })).toBeInTheDocument()

    // A Branch started from another Branch merges with that one; awkward names are encoded.
    const cart = within(row('ana/Cartpole & lr'))
    expect(cart.getByRole('link', { name: 'Merge ana/Cartpole & lr into try-QEC…' })).toHaveAttribute('href', '/merge?from=ana%2FCartpole%20%26%20lr&into=try-QEC')
    expect(cart.getByRole('link', { name: 'Update ana/Cartpole & lr from try-QEC…' })).toHaveAttribute('href', '/merge?from=try-QEC&into=ana%2FCartpole%20%26%20lr')
  })

  it('offers nothing on main or on a Branch whose parent is gone', () => {
    render(<App />)
    expect(within(row('main')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Open'])
    expect(within(row('orphan')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Open'])
    expect(screen.getAllByRole('link', { name: /^Merge / })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: /^Update / })).toHaveLength(2)
  })

  it('shows only the direction mergeOptions allows', () => {
    h.options = (b) => (b.id === 'b-qec' ? { intoParent: MAIN } : b.id === 'b-cart' ? { fromParent: QEC } : {})
    render(<App />)
    expect(within(row('try-QEC')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Merge into main…', 'Open'])
    expect(within(row('ana/Cartpole & lr')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Update from try-QEC…', 'Open'])
  })

  it('opens the review from a row', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('link', { name: 'Update ana/Cartpole & lr from try-QEC…' }))
    expect(here()).toBe('/merge?from=try-QEC&into=ana%2FCartpole%20%26%20lr')
    const review = screen.getByTestId('merge-review')
    expect(review).toHaveAttribute('data-from', 'try-QEC')
    expect(review).toHaveAttribute('data-into', 'ana/Cartpole & lr')
  })
})
