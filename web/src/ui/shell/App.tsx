import { useEffect, useRef } from 'react'
import { session, useSession } from '../../lib'
import { AcceptInvite } from './AcceptInvite'
import { Login } from './Login'
import { Shell } from './Shell'
import { useDelayedFlag } from './useDelayedFlag'
import { useRoute } from './useRoute'
import { useThemeEffect } from './useTheme'
import './shell.css'
import './access.css'

export function App() {
  useThemeEffect()
  const state = useSession()
  const route = useRoute()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void session.refresh()
  }, [])

  const showLoading = useDelayedFlag(state.status === 'loading', 150)

  if (state.status === 'loading') {
    return showLoading ? (
      <div className="q-boot" role="status">
        Loading…
      </div>
    ) : null
  }
  if (state.status === 'signed_out') {
    return route.name === 'invite' ? <AcceptInvite key={route.token} token={route.token} /> : <Login />
  }
  return <Shell member={state.member} route={route} />
}
