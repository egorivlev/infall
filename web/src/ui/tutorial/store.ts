// The tour's state: which steps, and which one is showing. Nothing here is kept anywhere but memory.
import { create } from 'zustand'
import type { TourStep } from './steps'

/** A tour of fewer steps than this is not worth starting. */
export const MIN_STEPS = 3

type TourState = {
  /** Empty when no tour is open. */
  steps: TourStep[]
  index: number
  /** Where focus was when the tour started; it goes back there when the tour ends. */
  returnTo: HTMLElement | null
}

export const useTour = create<TourState>(() => ({ steps: [], index: 0, returnTo: null }))

// How to put back what the showing step opened (the AI sidebar), if it opened anything.
let leave: (() => void) | void

function show(steps: TourStep[], index: number): void {
  if (leave) leave()
  leave = undefined
  const step = steps[index]
  if (!step) {
    useTour.setState({ steps: [], index: 0 })
    return
  }
  leave = step.enter?.()
  useTour.setState({ steps, index })
}

export const tour = {
  /** Opens the tour on its first step. False, and nothing happens, when there are too few steps. */
  start(steps: TourStep[], returnTo: HTMLElement | null = null): boolean {
    if (steps.length < MIN_STEPS) return false
    useTour.setState({ returnTo })
    show(steps, 0)
    return true
  },
  /** The following step; after the last one the tour ends. */
  next(): void {
    const { steps, index } = useTour.getState()
    if (steps.length > 0) show(steps, index + 1)
  },
  back(): void {
    const { steps, index } = useTour.getState()
    if (index > 0) show(steps, index - 1)
  },
  /** The showing step's control went away: the step is dropped and the tour moves on. */
  skip(): void {
    const { steps, index } = useTour.getState()
    if (steps.length > 0) show(steps.filter((_, i) => i !== index), index)
  },
  end(): void {
    if (useTour.getState().steps.length > 0) show([], 0)
  },
}
