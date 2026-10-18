import type { Member } from '../../lib'
import { AccountMenu } from './AccountMenu'
import { AiButton } from './AiButton'
import { BranchSwitcher } from './BranchSwitcher'
import { CheckpointButton } from './CheckpointButton'
import { GuestBadge } from './GuestBadge'
import { HistoryButton } from './HistoryButton'
import { Logo } from './Logo'
import { RunMonitor } from './monitor/RunMonitor'
import { Presence } from './Presence'
import { SearchBox } from './SearchBox'
import { ThemeToggle } from './ThemeToggle'
import { macDesktopWindow } from './windowChrome'

/**
 * Two rows (design: QTopBar). The first is the window's title bar — in the macOS desktop app the traffic lights sit in
 * its left corner and empty parts of it drag the window — with the name, search, who is here and the account. The
 * second is the toolbar of the Branch that is open.
 *
 * `available` is false while the Branch in the URL does not exist: there is nothing to name or to read History of.
 */
export function TopBar({ member, branch, available }: { member: Member; branch: string; available: boolean }) {
  const guest = member.role === 'guest'
  return (
    <header className="q-topbar">
      <div className={macDesktopWindow() ? 'q-titlebar is-mac-window' : 'q-titlebar'} data-tauri-drag-region="deep">
        <div className="q-topbar__brand">
          <Logo size={18} />
          <span className="q-topbar__name">Infall</span>
        </div>
        <div className="q-topbar__search" data-tour="search">
          <SearchBox />
        </div>
        <div className="q-topbar__people">
          {/* A Guest is told nothing about who else is here. */}
          {!guest && (
            <>
              <Presence branch={branch} />
              <span className="q-topbar__sep" aria-hidden="true" />
            </>
          )}
          <ThemeToggle />
          <AccountMenu member={member} />
        </div>
      </div>
      <div className="q-toolbar">
        {guest ? (
          <div className="q-branch q-branch--plain">
            <span className="q-branch__name">{branch}</span>{' '}
            <span className="q-branch__note" aria-hidden="true">
              ·
            </span>{' '}
            <span className="q-branch__note">read-only</span>
          </div>
        ) : (
          <div className="q-topbar__branch">
            <BranchSwitcher branch={branch} />
            {available && (
              <>
                <span className="q-topbar__sep" aria-hidden="true" />
                <CheckpointButton key={branch} />
                <HistoryButton />
              </>
            )}
          </div>
        )}
        <div className="q-toolbar__fill" />
        {/* There only while a Run is in flight on this computer — never for a Guest, who has no Runner. */}
        {!guest && <RunMonitor />}
        {guest ? (
          <GuestBadge member={member} />
        ) : (
          <>
            <span className="q-topbar__sep" aria-hidden="true" />
            {/* A Conversation is a Member's: Guests have no AI. */}
            <AiButton />
          </>
        )}
      </div>
    </header>
  )
}
