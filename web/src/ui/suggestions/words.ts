// Words for the Suggestions panel.
import type { Member, Suggestion } from '../../lib'
import { formatDay } from '../history/format'
import { firstName } from '../page/people'

export type People = ReadonlyMap<string, Member>

/** "Ana", or "a former Member" for someone who is no longer on the team. */
export function who(people: People, id: string): string {
  const m = people.get(id)
  return m ? firstName(m.name) : 'a former Member'
}

/** "via Ana's AI · claude-opus · 14 Nov" — the model only when the AI named one. */
export function viaLine(s: Suggestion, people: People, now: Date = new Date()): string {
  const model = s.model?.trim()
  return [`via ${who(people, s.created_by)}'s AI`, model, formatDay(s.created_at, now)].filter(Boolean).join(' · ')
}

/** "Accepted by Mei · 14 Nov" / "Rejected by you · 14 Nov" — a decision that was not made here just now. */
export function decidedLine(s: Suggestion, people: People, me: string | undefined, now: Date = new Date()): string {
  const verb = s.state === 'rejected' ? 'Rejected' : 'Accepted'
  const by = s.decided_by === undefined ? '' : ` by ${s.decided_by === me ? 'you' : who(people, s.decided_by)}`
  const when = s.decided_at === undefined ? '' : ` · ${formatDay(s.decided_at, now)}`
  return `${verb}${by}${when}`
}

/** A plain sentence for a decision that did not go through. */
export function failureSentence(e: unknown, action: 'accept' | 'reject' | 'reopen'): string {
  const code = codeOf(e)
  if (code === 'already_decided') return 'Someone else already decided this one.'
  if (action === 'accept' && (code === 'rejected' || code === 'stale')) return 'The Card this was for is no longer on this Branch.'
  if (code === 'network') return 'Cannot reach the server. Try again in a moment.'
  if (action === 'accept') return 'This Suggestion could not be accepted. Try again in a moment.'
  if (action === 'reject') return 'This Suggestion could not be rejected. Try again in a moment.'
  return 'That could not be undone. Try again in a moment.'
}

export function codeOf(e: unknown): string | undefined {
  const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}
