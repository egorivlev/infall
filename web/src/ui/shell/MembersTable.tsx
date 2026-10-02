import type { Member } from '../../lib'
import { formatShortDate } from './dates'
import { initials } from './initials'

const ROLE_LABEL = { admin: 'Admin', member: 'Member', guest: 'Guest' } as const

export function MembersTable({ people, meId, onRemove }: { people: Member[]; meId: string; onRemove: (m: Member, trigger: HTMLElement) => void }) {
  return (
    <div className="q-tablebox">
      <table className="q-table">
        <caption className="q-sr">Members</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Role</th>
            <th scope="col">Access</th>
            <th scope="col">
              <span className="q-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map((m) => (
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
                    </span>
                    {m.email && <span className="q-person__email">{m.email}</span>}
                  </span>
                </div>
              </td>
              <td>
                <span className={`q-role q-role--${m.role}`}>{ROLE_LABEL[m.role]}</span>
              </td>
              <td className="q-table__note">{m.role === 'guest' && m.access_until != null ? `until ${formatShortDate(m.access_until)}` : ''}</td>
              <td className="q-table__act">
                {m.id !== meId && (
                  <button
                    type="button"
                    className="q-btn q-btn--sm q-btn--danger q-btn--quiet"
                    aria-label={`Remove ${m.name}`}
                    onClick={(e) => onRemove(m, e.currentTarget)}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
