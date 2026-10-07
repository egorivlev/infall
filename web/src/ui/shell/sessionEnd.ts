// Why a session ended, as far as the shell can tell. Kept in memory only: a reload starts clean.
//
// The data layer flips the session to signed out on any 401 and does not say why. The shell knows two
// things itself: who was signed in just before, and whether they pressed "Sign out". A Guest who did not
// press it and is signed out anyway has run out of access (or was removed) — a Member in the same
// position has an expired session, which needs no explanation beyond the login screen.
import type { Role } from '../../lib'

export const GUEST_ACCESS_ENDED = "Your Guest access has ended. Ask the team's Admin if you need more time."

let leaving = false

/** Call just before asking the server to sign out, so the sign-out that follows is not read as "access ended". */
export function noteSigningOut(): void {
  leaving = true
}

/** The sign-out did not happen (the request failed), or someone is signed in again. */
export function clearSigningOut(): void {
  leaving = false
}

/** True when the session of someone with `role` has just ended without them asking for it, and they were a Guest. */
export function endedAsGuest(role: Role | null): boolean {
  return role === 'guest' && !leaving
}
