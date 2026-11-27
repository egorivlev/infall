import type { Member } from '../../lib'
import { formatShortDate } from './dates'
import { Icon } from './Icon'

/** A neutral chip (M17, B1): amber now only means that something did not work. */
export function GuestBadge({ member }: { member: Member }) {
  return (
    <div className="q-chip q-chip--lg q-guest-badge" data-tour="guest" title="Read-only access to the main Branch. It ends automatically.">
      <Icon name="user" size={12} />
      <span>
        Guest{member.access_until != null && <> · access until {formatShortDate(member.access_until)}</>}
      </span>
    </div>
  )
}
