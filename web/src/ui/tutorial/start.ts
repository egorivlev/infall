// Starting the tour: from the offer and from the account menu.
import { workspace } from '../../lib'
import type { Member } from '../../lib'
import { desktopSwitchWorkspace } from '../bridge'
import { boardPath, currentPath, navigate, parseRoute } from '../shell/router'
import { writeAnswer } from './memory'
import { availableSteps, inDesktopApp, stepsFor } from './steps'
import { tour } from './store'

/** The narrowest window the tour is shown in: the smallest the desktop app's window can be made. Every control it points at is there from this width on. */
export const MIN_WIDTH = 900

export function wideEnough(): boolean {
  return window.innerWidth >= MIN_WIDTH
}

/** Why the tour cannot be taken right now: a Merge is open, or the window is narrower than the layout supports. */
export function tourBlock(): 'merge' | 'narrow' | null {
  if (parseRoute(currentPath()).name === 'merge') return 'merge'
  return wideEnough() ? null : 'narrow'
}

// Long enough for the Board to be on screen after coming from another screen.
const BOARD_SETTLE_MS = 120

/**
 * Starts the tour from its first step, on the Board (going there first from another screen). Focus returns to
 * `returnTo` — by default to where it is now — when the tour ends. Starting counts as the answer to the offer.
 */
export function startTour(member: Member, returnTo?: HTMLElement | null): void {
  if (tourBlock() !== null) return
  const active = document.activeElement
  const focus = returnTo ?? (active instanceof HTMLElement && active !== document.body ? active : null)
  const begin = () => {
    if (tourBlock() !== null || parseRoute(currentPath()).name !== 'board') return
    const local = workspace.current().kind === 'local'
    const steps = availableSteps(stepsFor({ role: member.role, desktop: inDesktopApp(), local, startScreen: desktopSwitchWorkspace() !== null }))
    if (tour.start(steps, focus)) writeAnswer(member.id, 'started')
  }
  if (parseRoute(currentPath()).name === 'board') return begin()
  navigate(boardPath())
  window.setTimeout(begin, BOARD_SETTLE_MS)
}
