import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { session, useWorkspace } from '../../lib'
import type { Member } from '../../lib'
import { handsOn, tutorialHoldsTour, TUTORIAL_PRESET, useHandsOn } from '../tutorial'
import { desktopSwitchWorkspace } from '../bridge'
import { describeError } from './errorMessages'
import { Icon } from './Icon'
import { initials } from './initials'
import { Link } from './Link'
import { SETTINGS_PATH } from './router'
import { clearSigningOut, noteSigningOut } from './sessionEnd'
import { startTour, tourBlock } from '../tutorial/start'

import { useDismiss } from './useDismiss'

const ROLE_LABEL = { admin: 'Admin', member: 'Member', guest: 'Guest' } as const

export function AccountMenu({ member }: { member: Member }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ws = useWorkspace()
  const local = ws.kind === 'local' // one Member, no sign-in: nothing to sign out of, nobody to invite
  const tutorialWorkspace = local && ws.preset === TUTORIAL_PRESET
  const lesson = useHandsOn((s) => s.phase)
  // In a Tutorial Workspace the Tour waits until the Tutorial has been left or finished.
  const showTour = !tutorialWorkspace || !tutorialHoldsTour(lesson)
  const boxRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, boxRef, triggerRef)

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  const focusItem = (i: number) => {
    const list = items()
    list[(i + list.length) % list.length]?.focus()
  }

  const toggle = () => {
    setError('')
    setOpen((o) => !o)
    // focus the first item once it has rendered
    if (!open) window.setTimeout(() => focusItem(0), 0)
  }

  const onMenuKey = (e: KeyboardEvent) => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null
    if (to !== null) {
      e.preventDefault()
      focusItem(to)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  // Why the tour cannot be taken right now, if it cannot; looked at each time the menu opens.
  const tourBlocked = open ? tourBlock() : null
  const takeTour = () => {
    if (tourBlocked !== null) return
    setOpen(false)
    // The menu goes away: focus waits on its button, and comes back to it when the tour ends.
    triggerRef.current?.focus()
    startTour(member, triggerRef.current)
  }

  // A Local Workspace has no sign-out; the desktop app's way back to its start screen takes that place.
  const switchWorkspace = local ? desktopSwitchWorkspace() : null

  const takeTutorial = () => {
    if (lesson === 'off' || lesson === 'loading') return
    setOpen(false)
    triggerRef.current?.focus()
    handsOn.resume()
  }

  async function signOut() {
    if (busy) return
    setBusy(true)
    setError('')
    noteSigningOut() // so the login screen does not tell a Guest their access ended
    try {
      await session.logout()
    } catch (e) {
      clearSigningOut()
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="q-account" ref={boxRef}>
      <button
        type="button"
        ref={triggerRef}
        className="q-account__trigger"
        data-tour="account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      >
        <span className="q-avatar" style={{ background: member.color }} aria-hidden="true">
          {initials(member.name)}
        </span>
        <span className="q-account__name">{member.name}</span>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <div className="q-menu" id={menuId} role="menu" aria-label="Account" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="q-menu__head" role="presentation">
            <span className="q-menu__name">{member.name}</span>
            <span className="q-caps">{ROLE_LABEL[member.role]}</span>
          </div>
          {/* Everything else about the account and this device (AI access, Members, the name) is in Settings. */}
          <Link href={SETTINGS_PATH} role="menuitem" className="q-menu__item" onClick={() => setOpen(false)}>
            Settings
          </Link>
          {tutorialWorkspace && (
            <button type="button" role="menuitem" className="q-menu__item" aria-disabled={lesson === 'off' || lesson === 'loading'} onClick={takeTutorial}>
              Tutorial
            </button>
          )}
          {showTour && (
          <button
            type="button"
            role="menuitem"
            className="q-menu__item"
            aria-disabled={tourBlocked !== null}
            title={tourBlocked === 'merge' ? 'Finish or leave the Merge first' : tourBlocked === 'narrow' ? 'Make the window wider to take the tour' : undefined}
            onClick={takeTour}
          >
            Tour of Infall
          </button>
          )}
          {/* A Local Workspace signs its one Member in by itself: signing out would leave no way back in. */}
          {switchWorkspace && (
            <button
              type="button"
              role="menuitem"
              className="q-menu__item"
              onClick={() => {
                setOpen(false)
                void switchWorkspace().catch(() => {})
              }}
            >
              Switch workspace…
            </button>
          )}
          {!local && (
            <button type="button" role="menuitem" className="q-menu__item" aria-disabled={busy} onClick={signOut}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          )}
          {error && (
            <p className="q-error q-menu__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
