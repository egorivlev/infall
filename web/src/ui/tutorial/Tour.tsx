import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Member } from '../../lib'
import { readAnswer, writeAnswer } from './memory'
import { useFollow } from './follow'
import { placePopover, ringBox } from './position'
import { startTour, wideEnough } from './start'
import { anchorsOf } from './steps'
import type { TourStep } from './steps'
import { tour, useTour } from './store'
import './tutorial.css'

export { GONE_AFTER_MS } from './follow'

/** Esc is somebody else's while they type, or while another popup is open around the focus. */
function escapeIsTaken(popover: HTMLElement | null): boolean {
  const at = document.activeElement
  if (!(at instanceof HTMLElement) || at === document.body || popover?.contains(at)) return false
  if (at.isContentEditable || at.matches('input, textarea, select')) return true
  return at.closest('[role="menu"], [role="dialog"], [role="listbox"]') !== null
}

const skipStep = () => tour.skip()

/** One step: the ring around the control and the popover beside it. Not a modal — the app stays usable around it. */
function StepPopover({ step, index, count }: { step: TourStep; index: number; count: number }) {
  const id = useId()
  const pop = useRef<HTMLDivElement>(null)
  const seen = useFollow(useCallback(() => anchorsOf(step), [step]), skipStep)
  const last = index === count - 1

  // The popover is placed by hand: its own size decides which side of the control it fits on.
  useLayoutEffect(() => {
    const el = pop.current
    if (!el || !seen) return
    const at = placePopover(seen.target, { width: el.offsetWidth, height: el.offsetHeight }, seen.view)
    el.style.left = `${Math.round(at.left)}px`
    el.style.top = `${Math.round(at.top)}px`
  }, [seen])

  // A step opens: focus goes to the popover, so its title and the step count are read.
  useEffect(() => {
    pop.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || escapeIsTaken(pop.current)) return
      tour.end()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key === 'ArrowRight' && !last) {
      e.preventDefault()
      tour.next()
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault()
      tour.back()
    }
  }

  const ring = seen ? ringBox(seen.target, seen.view) : null
  return (
    <>
      {ring && <div className="q-tour-ring" aria-hidden="true" style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }} />}
      <div
        ref={pop}
        className={seen ? 'q-tour' : 'q-tour is-unplaced'}
        role="dialog"
        aria-modal="false"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-count ${id}-body`}
        tabIndex={-1}
        data-step={step.id}
        onKeyDown={onKeyDown}
      >
        <p className="q-caps q-tour__count" id={`${id}-count`}>
          Step {index + 1} of {count}
        </p>
        <h2 className="q-tour__title" id={`${id}-title`}>
          {step.title}
        </h2>
        <div className="q-tour__body" id={`${id}-body`}>
          {step.body.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
        <div className="q-tour__actions">
          <button type="button" className="q-btn q-btn--sm q-btn--quiet q-tour__skip" onClick={() => tour.end()}>
            Skip the tour
          </button>
          {step.action && (
            <button type="button" className="q-btn q-btn--sm" onClick={step.action.run}>
              {step.action.label}
            </button>
          )}
          {index > 0 && (
            <button type="button" className="q-btn q-btn--sm" onClick={() => tour.back()}>
              Back
            </button>
          )}
          <button type="button" className="q-btn q-btn--sm q-btn--primary" onClick={() => (last ? tour.end() : tour.next())}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>
  )
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

/** Focus goes back to where it was when the tour started — unless the Member has put it somewhere since. */
function returnFocus(): void {
  const at = document.activeElement
  if (at !== null && at !== document.body && at.isConnected) return
  const { returnTo } = useTour.getState()
  // Where it was may be gone (the offer's own button): the account menu is where the tour lives.
  const to = returnTo?.isConnected ? returnTo : document.querySelector<HTMLElement>('[data-tour="account"]')
  to?.focus({ preventScroll: true })
}

/**
 * The tour of Infall, mounted once in the shell for whoever is signed in: the open step, and — the first time a
 * Member is signed in on this device — the card that offers it. `view` is the screen the shell is showing: the tour
 * lives on the Board, ends quietly when the Member goes elsewhere, and is never offered over a Merge. `offer: false`
 * (a Tutorial Workspace, which has the Tutorial instead) leaves out the offer; the menu can still start the tour.
 */
export function Tour({ member, view, offer = true }: { member: Member; view: string; offer?: boolean }) {
  const steps = useTour((s) => s.steps)
  const index = useTour((s) => s.index)
  const step = steps[index]
  const active = step !== undefined
  const wide = useSyncExternalStore(subscribeResize, wideEnough)

  // `undefined`: this device keeps nothing, so nothing is offered. A tour started from the menu is an answer too.
  const [answer, setAnswer] = useState(() => readAnswer(member.id))
  if (active && answer === null) setAnswer('started')

  const allowed = view === 'board' && wide
  useEffect(() => {
    if (active && !allowed) tour.end()
  }, [active, allowed])

  useEffect(() => {
    if (!active) return
    return returnFocus // runs once the popover is gone
  }, [active])

  // Signing out, or another Member signing in, takes the tour with it.
  useEffect(() => () => tour.end(), [])

  const decide = (to: 'started' | 'declined') => {
    writeAnswer(member.id, to)
    setAnswer(to) // asked once, even if the answer could not be kept
    if (to === 'started') startTour(member)
  }

  if (step) return <StepPopover key={step.id} step={step} index={index} count={steps.length} />
  if (!offer || answer !== null || !wide || view === 'merge') return null
  return (
    <section className="q-tour-offer" aria-label="Tour of Infall">
      <p className="q-tour-offer__text">New here? Take a two-minute tour of Infall.</p>
      <div className="q-tour-offer__actions">
        <button type="button" className="q-btn q-btn--sm" onClick={() => decide('declined')}>
          Not now
        </button>
        <button type="button" className="q-btn q-btn--sm q-btn--primary" onClick={() => decide('started')}>
          Start the tour
        </button>
      </div>
    </section>
  )
}
