import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Member } from '../../lib'
import { formatShortDate } from './dates'
import { initials } from './initials'

const ROLE_LABEL = { admin: 'Admin', member: 'Member', guest: 'Guest' } as const

/** Members and Admins in the order given, then Guests: those who still have access first, then by when it ends. */
function ordered(people: Member[], now: number): Member[] {
  const team = people.filter((m) => m.role !== 'guest')
  const guests = people.filter((m) => m.role === 'guest')
  const ended = (m: Member) => (m.access_until != null && m.access_until <= now ? 1 : 0)
  guests.sort((a, b) => ended(a) - ended(b) || (a.access_until ?? Infinity) - (b.access_until ?? Infinity))
  return [...team, ...guests]
}

/** "Guest · until 30 Nov" while access lasts, "Guest · ended 30 Nov" after (dimmed, and the word says it). Neutral chips:
 *  amber now only means that something did not work (M17, B4). */
function RoleChip({ member, now }: { member: Member; now: number }) {
  if (member.role !== 'guest' || member.access_until == null) {
    return <span className={`q-chip q-role q-role--${member.role}`}>{ROLE_LABEL[member.role]}</span>
  }
  const over = member.access_until <= now
  return (
    <span className={`q-chip q-role q-role--guest${over ? ' q-role--ended is-dim' : ''}`}>
      Guest · {over ? 'ended' : 'until'} {formatShortDate(member.access_until)}
    </span>
  )
}

type TableProps = {
  people: Member[]
  meId: string
  onRemove: (m: Member) => void
  /** M18: a Member who came as a name in a Workspace file (`claimed: false`): invite the person to take it over. */
  onInvite?: (m: Member) => void
  /** M17 (B4): Remove asks inside the Member's row; this is that question for the one being asked about. */
  asking?: { id: string; node: ReactNode } | null
}

export function MembersTable({ people, meId, onRemove, onInvite, asking = null }: TableProps) {
  const [now] = useState(() => Date.now())
  return (
    <div className="q-tablebox q-members__table">
      <table className="q-table">
        <caption className="q-sr">Members</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Role</th>
            <th scope="col">
              <span className="q-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered(people, now).map((m) =>
            asking?.id === m.id ? (
              <tr key={m.id} className="q-table__asking">
                <td colSpan={3}>{asking.node}</td>
              </tr>
            ) : (
            <tr key={m.id}>
              <td>
                <div className="q-person">
                  <span className="q-avatar q-avatar--md" style={{ background: m.color }} aria-hidden="true">
                    {initials(m.name)}
                  </span>
                  <span className="q-person__text">
                    <span className="q-person__name">
                      {m.name}
                      {m.id === meId && <span className="q-person__you"> (you)</span>}
                      {m.claimed === false && <span className="q-person__unclaimed"> · not signed in yet</span>}
                    </span>
                    {m.email && <span className="q-person__email">{m.email}</span>}
                  </span>
                </div>
              </td>
              <td>
                <RoleChip member={m} now={now} />
              </td>
              <td className="q-table__act">
                {m.claimed === false && onInvite && (
                  <button type="button" className="q-btn q-btn--sm q-btn--soft" aria-label={`Invite someone to take over ${m.name}`} onClick={() => onInvite(m)}>
                    Invite
                  </button>
                )}
                {m.id !== meId && (
                  <button
                    type="button"
                    className="q-btn q-btn--sm q-btn--danger q-btn--ghost"
                    data-remove={m.id}
                    aria-label={`Remove ${m.name}`}
                    onClick={() => onRemove(m)}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}
