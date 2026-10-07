// Pure helpers for the To-dos screen: who gets a column, and what a To-do's Card pointer means right now.
import type { BoardSnapshot, BranchInfo, Member, Todo } from '../../lib'

/** The data layer takes 1 to 500 characters. */
export const MAX_TEXT = 500

export type Filter = 'open' | 'done' | 'all'
export const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
]

export type Column = {
  member: Member
  mine: boolean
  items: Todo[] // every To-do of this Member, oldest first
  open: number
}

/** "Ana Ruiz" -> "Ana". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

/** One column per Member or Admin: you first, then by name. Guests have none. */
export function columnsOf(me: Member, people: Member[], list: Todo[]): Column[] {
  const team = people.filter((m) => m.role !== 'guest' && m.id !== me.id)
  team.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
  const self = people.find((m) => m.id === me.id) ?? me
  const ordered = self.role === 'guest' ? team : [self, ...team]
  return ordered.map((member) => {
    const items = list.filter((t) => t.owner === member.id)
    items.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { member, mine: member.id === me.id, items, open: items.filter((t) => !t.done).length }
  })
}

export function matches(filter: Filter, todo: Todo): boolean {
  return filter === 'all' || (filter === 'done') === todo.done
}

export type CardRef =
  | { kind: 'live'; id: string; title: string } // on the open Branch: go to the Board and select it
  | { kind: 'branch'; id: string; title: string; branch: string } // made on another Branch that still exists
  | { kind: 'removed'; title: string }
  | { kind: 'pending'; title: string } // the Board has not loaded yet: nothing can be said about the Card

const titleOf = (text: string) => text.trim() || 'Untitled'

/** What the Card pointer of a To-do leads to, given the Board that is open and the Branches that exist. */
export function cardRefOf(
  card: NonNullable<Todo['card']>,
  board: Pick<BoardSnapshot, 'status' | 'branch' | 'cards'>,
  branches: BranchInfo[],
): CardRef {
  const live = board.cards.find((c) => c.id === card.id)
  if (live) return { kind: 'live', id: live.id, title: titleOf(live.title) }
  const title = titleOf(card.title)
  const other = branches.find((b) => b.id === card.branch)
  if (other && other.id !== board.branch?.id) return { kind: 'branch', id: card.id, title, branch: other.name }
  if (!board.branch || board.status === 'idle' || board.status === 'loading') return { kind: 'pending', title }
  return { kind: 'removed', title }
}

/** A plain sentence for a failed call. Never a code. */
export function failure(what: 'added' | 'updated' | 'changed' | 'deleted' | 'brought back' | 'loaded', e: unknown): string {
  const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code?: unknown }).code : undefined
  // Loading has its own "Try again" button next to the sentence.
  if (what === 'loaded') return code === 'network' ? 'To-dos could not be loaded. Check your connection.' : 'To-dos could not be loaded.'
  const advice = code === 'network' ? 'Check your connection and try again.' : 'Try again.'
  return `That To-do could not be ${what}. ${advice}`
}
