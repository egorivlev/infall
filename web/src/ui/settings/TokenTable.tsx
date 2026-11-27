import type { ReactNode } from 'react'
import type { AccessToken } from '../../lib'
import { formatDateTime, formatShortDate } from '../shell/dates'

type Props = {
  tokens: AccessToken[]
  onRevoke: (token: AccessToken) => void
  /** M17 (B3): Revoke asks inside the token's own row; this is that question for the token being asked about. */
  asking?: { id: string; node: ReactNode } | null
}

export function TokenTable({ tokens, onRevoke, asking = null }: Props) {
  return (
    <div className="q-tablebox">
      <table className="q-table q-tokens">
        <caption className="q-sr">Your access tokens</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Created</th>
            <th scope="col">Last used</th>
            <th scope="col">
              <span className="q-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) =>
            asking?.id === t.id ? (
              <tr key={t.id} className="q-table__asking">
                <td colSpan={4}>{asking.node}</td>
              </tr>
            ) : (
              <tr key={t.id}>
                {/* A row header, but the name is the Member's own text: never upper-cased like the column heads. */}
                <th scope="row" className="q-tokens__name">
                  {t.name}
                </th>
                <td className="q-table__note">{formatShortDate(t.created_at)}</td>
                <td className="q-table__note">{t.last_used_at == null ? 'never' : formatDateTime(t.last_used_at)}</td>
                <td className="q-table__act">
                  <button
                    type="button"
                    className="q-btn q-btn--sm q-btn--danger q-btn--ghost"
                    data-revoke={t.id}
                    aria-label={`Revoke access token ${t.name}`}
                    onClick={() => onRevoke(t)}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}
