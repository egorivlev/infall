// Words, dates and people for the History panel. Local time; 24-hour clock.
import type { Activity, Checkpoint, Member } from '../../lib'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** "1 Change", "3 Changes", "1 Activity", "2 Activities". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "14 Nov", with the year when it is not the current one. */
export function formatDay(ms: number, now: Date = new Date()): string {
  const d = new Date(ms)
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "14 Nov, 14:05" */
export function formatWhen(ms: number, now: Date = new Date()): string {
  return `${formatDay(ms, now)}, ${formatTime(ms)}`
}

/** "14 Nov, 14:05" · "14 Nov, 14:05–14:32" when it spans minutes · both dates when it crosses midnight. */
export function formatSpan(from: number, to: number, now: Date = new Date()): string {
  const start = formatWhen(from, now)
  if (formatDay(from, now) !== formatDay(to, now)) return `${start} – ${formatWhen(to, now)}`
  const end = formatTime(to)
  return end === formatTime(from) ? start : `${start}–${end}`
}

/** A moment in a Branch's History, in words: a time, or the very beginning. */
export function momentLabel(at: number | null, now: Date = new Date()): string {
  return at === null ? 'the start' : formatWhen(at, now)
}

/** Local calendar day, for grouping. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** "Ana Ruiz" -> "AR"; "Cher" -> "CH". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]
  if (!first) return '?'
  const last = words[words.length - 1] ?? first
  const chars = words.length > 1 ? [Array.from(first)[0], Array.from(last)[0]] : Array.from(first).slice(0, 2)
  return chars.join('').toUpperCase()
}

export type Person = { name: string; initials: string; color: string | null } // color null: no longer a Member

export const FORMER_MEMBER: Person = { name: 'Former Member', initials: '–', color: null }

export function personOf(byId: ReadonlyMap<string, Member>, id: string): Person {
  const m = byId.get(id)
  return m ? { name: m.name, initials: initials(m.name), color: m.color } : FORMER_MEMBER
}

/** "Ana Ruiz · 14 Nov, 14:05–14:32 · 3 Changes" */
export function activityLabel(a: Activity, who: string): string {
  const kind = a.kind === 'restore' ? ' · Restore' : a.kind === 'merge' ? ' · Merge' : ''
  return `${who} · ${formatSpan(a.startedAt, a.endedAt)}${kind} · ${count(a.count, 'Change')}`
}

export function checkpointLabel(c: Checkpoint, who: string): string {
  return `Checkpoint ${c.name} · named by ${who}, ${formatWhen(c.at)}`
}
