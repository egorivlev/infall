import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { session } from '../../lib'
import type { Member } from '../../lib'
import { describeError } from './errorMessages'
import { Icon } from './Icon'
import { initials } from './initials'
import { Link } from './Link'
import { AI_ACCESS_PATH } from './router'
import { clearSigningOut, noteSigningOut } from './sessionEnd'
import { useDismiss } from './useDismiss'

const ROLE_LABEL = { admin: 'Admin', member: 'Member', guest: 'Guest' } as const

export function AccountMenu({ member }: { member: Member }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
          {member.role !== 'guest' && (
            <Link href={AI_ACCESS_PATH} role="menuitem" className="q-menu__item" onClick={() => setOpen(false)}>
              AI access
            </Link>
          )}
          {member.role === 'admin' && (
            <Link href="/members" role="menuitem" className="q-menu__item" onClick={() => setOpen(false)}>
              Members
            </Link>
          )}
          <button type="button" role="menuitem" className="q-menu__item" aria-disabled={busy} onClick={signOut}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
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
