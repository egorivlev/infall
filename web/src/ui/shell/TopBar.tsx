import type { Member } from '../../lib'
import { AccountMenu } from './AccountMenu'
import { BranchSwitcher } from './BranchSwitcher'
import { CheckpointButton } from './CheckpointButton'
import { GuestBadge } from './GuestBadge'
import { HistoryButton } from './HistoryButton'
import { Logo } from './Logo'
import { Presence } from './Presence'
import { SearchBox } from './SearchBox'
import { ThemeToggle } from './ThemeToggle'

/** `available` is false while the Branch in the URL does not exist: there is nothing to name or to read History of. */
export function TopBar({ member, branch, available }: { member: Member; branch: string; available: boolean }) {
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
        <div className="q-topbar__branch">
          <BranchSwitcher branch={branch} />
          {available && (
            <>
              <CheckpointButton key={branch} />
              <HistoryButton />
            </>
          )}
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
