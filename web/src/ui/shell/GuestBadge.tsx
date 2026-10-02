import type { Member } from '../../lib'
import { formatShortDate } from './dates'
import { Icon } from './Icon'

export function GuestBadge({ member }: { member: Member }) {
  return (
    <div className="q-guest-badge">
      <Icon name="user" size={12} />
      <strong>Guest</strong>
      {member.access_until != null && <span>— access until {formatShortDate(member.access_until)}</span>}
    </div>
  )
}
