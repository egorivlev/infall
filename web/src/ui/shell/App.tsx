import { useEffect, useRef, useState } from 'react'
import { session, useSession, useWorkspace } from '../../lib'
import type { Role } from '../../lib'
import { desktopSwitchWorkspace } from '../bridge'
import { useAppliedPrefs } from '../settings/apply'
import { AcceptInvite } from './AcceptInvite'
import { AccessCard } from './AccessCard'
import { Login } from './Login'
import { clearSigningOut, endedAsGuest, GUEST_ACCESS_ENDED } from './sessionEnd'
import { Shell } from './Shell'
import { useDelayedFlag } from './useDelayedFlag'
import { useRoute } from './useRoute'
import { useThemeEffect } from './useTheme'
import './shell.css'
import './access.css'

export function App() {
  useThemeEffect()
  useAppliedPrefs()
  const state = useSession()
  const route = useRoute()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void session.refresh()
  }, [])

  // Who was signed in last, and whether a Guest's session then ended by itself (their access ran out: any
  // request answers 401 and the data layer signs them out). Memory only — after a reload it is a plain login screen.
  const role: Role | null = state.status === 'signed_in' ? state.member.role : null
  const [last, setLast] = useState<{ role: Role | null; guestEnded: boolean }>({ role: null, guestEnded: false })
  if (state.status === 'signed_in' && (last.role !== role || last.guestEnded)) {
    setLast({ role, guestEnded: false })
  } else if (state.status === 'signed_out' && last.role !== null) {
    setLast({ role: null, guestEnded: endedAsGuest(last.role) })
  }
  useEffect(() => {
    if (state.status === 'signed_in') clearSigningOut()
  }, [state.status])

  // A Local Workspace signs its one Member in by itself, through the desktop app: if that session ends there is no
  // password to sign in with, so the login screen would lead nowhere. Memory only, like `last`.
  const kind = useWorkspace().kind
  const [wasLocal, setWasLocal] = useState(false)
  if (state.status === 'signed_in' && kind === 'local' && !wasLocal) setWasLocal(true)

  const showLoading = useDelayedFlag(state.status === 'loading', 150)

  if (state.status === 'loading') {
    return showLoading ? (
      <div className="q-boot" role="status">
        Loading…
      </div>
    ) : null
  }
  if (state.status === 'signed_out' && wasLocal) return <LocalEnded />
  if (state.status === 'signed_out') {
    return route.name === 'invite' ? <AcceptInvite key={route.token} token={route.token} /> : <Login notice={last.guestEnded ? GUEST_ACCESS_ENDED : undefined} />
  }
  return <Shell member={state.member} route={route} />
}

/** The session of a Local Workspace ended (the app stopped its server, say): it is opened again from the start screen. */
function LocalEnded() {
  const back = desktopSwitchWorkspace()
  return (
    <AccessCard title="This Workspace is closed" subtitle="It is kept on this computer and opens from the start screen of the Infall app.">
      {back ? (
        <button type="button" className="q-btn q-btn--lg q-btn--primary" onClick={() => void back().catch(() => {})}>
          Back to workspaces
        </button>
      ) : (
        <p className="q-hint">Open it again from the Infall app.</p>
      )}
    </AccessCard>
  )
}
