import { useBoard } from '../../lib'
import { initials } from './initials'

const MAX = 6

export function Presence({ branch }: { branch: string }) {
  const { presence } = useBoard()
  const shown = presence.slice(0, MAX)
  const more = presence.length - shown.length
  return (
    <div className="q-presence">
      <span className="q-caps" id="q-presence-label">
        On {branch}
      </span>
      <ul className="q-presence__list" aria-labelledby="q-presence-label">
        {shown.map((m) => (
          <li key={m.id} className="q-avatar q-presence__avatar" title={m.name} style={{ background: m.color }}>
            <span aria-hidden="true">{initials(m.name)}</span>
            <span className="q-sr">{m.name}</span>
          </li>
        ))}
        {more > 0 && (
          <li className="q-avatar q-presence__avatar q-presence__more" title={`${more} more`}>
            <span aria-hidden="true">+{more}</span>
            <span className="q-sr">{more} more</span>
          </li>
        )}
      </ul>
    </div>
  )
}
