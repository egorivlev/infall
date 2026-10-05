// Words of the Merge review that more than one part of the screen needs.
import type { Choice, ConflictSide, ConflictVM, Member } from '../../lib'
import { formatShortDate } from '../shell/dates'
import { GENERIC_ERROR, NETWORK_ERROR } from '../shell/errorMessages'

export const EDIT_BY_HAND = 'Edit by hand'

/** "01", "02", … */
export const conflictNumber = (index: number) => String(index + 1).padStart(2, '0')

/** DOM ids of a Conflict block and its heading (Conflict ids hold ":" and entity ids, so the position is used). */
export const conflictAnchor = (index: number) => `q-merge-c${index + 1}`
export const conflictHeadingId = (index: number) => `${conflictAnchor(index)}-h`

/** "Card: Threshold ≈ 1%" */
export const conflictTitle = (c: ConflictVM) => `${c.entityKind}: ${c.entityTitle}`

/** The side list's shorter name: "Threshold ≈ 1% · Title"; just the title when a whole Card is in question. */
export function conflictShort(c: ConflictVM): string {
  if (c.field === null || c.field === '') return c.entityTitle
  return `${c.entityTitle} · ${c.field.charAt(0).toUpperCase()}${c.field.slice(1)}`
}

export const typeLabel = (c: ConflictVM) => (c.type === 'field' ? 'Same field' : 'Edited · deleted')

/** Which side a choice takes, in the words the options use: a Branch name, or "Edit by hand". */
export function choiceLabel(choice: Choice, source: string, target: string): string {
  if (choice === 'source') return source
  if (choice === 'target') return target
  return EDIT_BY_HAND
}

/** "Elena Varga · 15 Nov", with whatever is known; someone no longer in the team reads "Former Member". */
export function whoWhen(side: ConflictSide, people: Member[], now: Date = new Date()): string {
  const name = side.author === undefined ? '' : (people.find((m) => m.id === side.author)?.name ?? 'Former Member')
  const date = side.at === undefined ? '' : formatShortDate(side.at, now)
  return [name, date].filter(Boolean).join(' · ')
}

/** What "Edit by hand" starts from: the source text. The data layer writes an empty value as "(empty)". */
export function startingText(c: ConflictVM): string {
  return c.source.text === '(empty)' ? '' : c.source.text
}

/** The line under "Edit by hand". */
export function editHint(c: ConflictVM): string {
  return c.field === 'title' || c.field === 'summary' || c.field === 'label' ? `Write a combined ${c.field}` : 'Write your own value'
}

/** Plain sentence for an apply failure that has no place of its own on the screen. */
export function applyFailure(code: string): string {
  if (code === 'network') return NETWORK_ERROR
  if (code === 'undecided') return 'Decide all Conflicts first.'
  if (code === 'forbidden') return 'You do not have access to merge Branches.'
  if (code === '') return GENERIC_ERROR
  return 'The Merge could not be applied. Try again.'
}
