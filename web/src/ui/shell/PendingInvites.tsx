import { useState } from 'react'
import { invites, useMembers } from '../../lib'
import type { Invite } from '../../lib'
import { formatShortDate } from './dates'
import { describeError } from './errorMessages'

const ROLE_LABEL = { admin: 'Admin', member: 'Member', guest: 'Guest' } as const

type Props = { pending: Invite[] | null; loadError: string; onChanged: () => void }

export function PendingInvites({ pending, loadError, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const people = useMembers()

  async function revoke(inv: Invite) {
    if (busyId) return
    setBusyId(inv.id)
    setError('')
    try {
      await invites.remove(inv.id)
      onChanged()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="q-pending" aria-labelledby="q-pending-h">
      <h2 className="q-section-title" id="q-pending-h">
        Pending invites
      </h2>
      {loadError && (
        <p className="q-error" role="alert">
          {loadError}
        </p>
      )}
      {error && (
        <p className="q-error" role="alert">
          {error}
        </p>
      )}
      {pending && pending.length === 0 && !loadError && <p className="q-hint">No pending invites.</p>}
      {pending && pending.length > 0 && (
        <ul className="q-pending__list">
          {pending.map((inv) => (
            <li key={inv.id} className="q-pending__row">
              <span className="q-pending__email">{inv.email}</span>
              <span className={`q-role q-role--${inv.role}`}>
                {ROLE_LABEL[inv.role]}
                {inv.role === 'guest' && inv.access_until != null ? ` · until ${formatShortDate(inv.access_until)}` : ''}
              </span>
              {inv.claims && (
                <span className="q-pending__meta">takes over {people.find((m) => m.id === inv.claims)?.name ?? 'a name from a Workspace file'}</span>
              )}
              <span className="q-pending__meta">expires {formatShortDate(inv.expires_at)}</span>
              <button
                type="button"
                className="q-btn q-btn--sm q-btn--danger q-btn--quiet"
                aria-label={`Revoke invite for ${inv.email}`}
                aria-disabled={busyId === inv.id}
                onClick={() => revoke(inv)}
              >
                {busyId === inv.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
