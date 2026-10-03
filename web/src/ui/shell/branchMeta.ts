import type { BranchInfo, Member } from '../../lib'
import { formatShortDate } from './dates'
import { MAIN } from './router'

/** main first, the rest in the order the server gave them. */
export function orderBranches(list: BranchInfo[]): BranchInfo[] {
  return [...list.filter((b) => b.name === MAIN), ...list.filter((b) => b.name !== MAIN)]
}

/** Name of the Branch this one was started from; '' when it has none or it is not in the list. */
export function parentName(b: BranchInfo, all: BranchInfo[]): string {
  if (!b.parent) return ''
  const id = b.parent.branch
  return all.find((x) => x.id === id)?.name ?? ''
}

/** The switcher's second line: "default Branch", or "from main · Mei · 14 Nov" with whatever parts are known. */
export function branchMeta(b: BranchInfo, all: BranchInfo[], people: Member[], now: Date = new Date()): string {
  if (!b.parent) return b.name === MAIN ? 'default Branch' : ''
  const parent = parentName(b, all)
  const creator = people.find((m) => m.id === b.created_by)?.name.trim().split(/\s+/)[0] ?? ''
  const date = b.created_at === undefined ? '' : formatShortDate(b.created_at, now)
  return [parent && `from ${parent}`, creator, date].filter(Boolean).join(' · ')
}
