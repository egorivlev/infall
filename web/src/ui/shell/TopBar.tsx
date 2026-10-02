import type { Member } from '../../lib'
import { AccountMenu } from './AccountMenu'
import { GuestBadge } from './GuestBadge'
import { Icon } from './Icon'
import { Logo } from './Logo'
import { Presence } from './Presence'
import { SearchBox } from './SearchBox'
import { ThemeToggle } from './ThemeToggle'

export function TopBar({ member, branch }: { member: Member; branch: string }) {
  const guest = member.role === 'guest'
  return (
    <header className="q-topbar">
      <div className="q-topbar__brand">
        <Logo />
        <span className="q-topbar__name">Qoop</span>
      </div>
      {guest ? (
        <div className="q-branch q-branch--plain">
          <span className="q-branch__name">{branch}</span>
          <span className="q-branch__note">read-only</span>
        </div>
      ) : (
        <div className="q-branch">
          <Icon name="branch" />
          <span className="q-caps">Branch</span>
          <span className="q-branch__name">{branch}</span>
        </div>
      )}
      <div className="q-topbar__search">
        <SearchBox />
      </div>
      {guest && <GuestBadge member={member} />}
      <Presence branch={branch} />
      <ThemeToggle />
      <AccountMenu member={member} />
    </header>
  )
}
