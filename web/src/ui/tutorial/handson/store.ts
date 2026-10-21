// The Tutorial's state: which step is showing, how the others ended, and what the showing step's watcher sees.
// Progress is kept on the server only (`/api/local/tutorial`), never in localStorage: a Local Workspace's origin
// changes port at every start. Writes are debounced; leaving and finishing are written at once.
import { create } from 'zustand'
import { workspace } from '../../../lib'
import { freshProgress, PROGRESS_VERSION, readProgress } from './progress'
import type { Progress, ProgressStatus, StepResult } from './progress'
import { STEP_IDS, stepById, stepIndex } from './steps'
import type { StepId } from './steps'

/** `off`: not in a Tutorial Workspace. `loading`: asking the server where the person was. */
export type HandsOnPhase = 'off' | 'loading' | ProgressStatus

/** Something the step needs on this computer (decision 6): being looked for, there, or missing. */
export type ToolCheck = {
  state: 'checking' | 'ready' | 'missing'
  /** What is missing and what to install, in one to three sentences. */
  lines: string[]
  /** What the step would have shown, said instead. */
  instead?: string
  /** Something the person can do about it (open the Runner settings, AI access). */
  action?: { label: string; run: () => void }
  /** Look again ("Check again"). */
  recheck: () => void
}

/** What the watcher of the showing step reports, besides having been done. */
export type StepCheck = {
  /** The seeded thing the step needs is gone: one sentence saying so. The step can still be skipped. */
  missing: string | null
  tool: ToolCheck | null
  /** Card ids for the step's special anchors ('welcome', 'made', 'visual-card', 'run-card'). */
  cards: Record<string, string>
}

const NO_CHECK: StepCheck = { missing: null, tool: null, cards: {} }

type HandsOnState = {
  phase: HandsOnPhase
  step: StepId
  results: Partial<Record<StepId, StepResult>>
  card: string | null
  /** The popover is put away; only the progress in the rail shows. */
  hidden: boolean
  /** Goes up when the popover should take focus (a step the person chose, not one reached by doing). */
  focus: number
  /** Goes up when the rail's "Show step" should take focus (the popover was put away from inside it). */
  focusShow: number
  /** The last thing said to screen readers. */
  said: string
  check: StepCheck
}

const START: HandsOnState = { phase: 'off', step: 'look', results: {}, card: null, hidden: false, focus: 0, focusShow: 0, said: '', check: NO_CHECK }

export const useHandsOn = create<HandsOnState>(() => START)

/** How long after the last change the progress is written. */
export const SAVE_MS = 400

let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0 // a reset makes answers and writes of an earlier Workspace harmless

function snapshot(): Progress | null {
  const s = useHandsOn.getState()
  if (s.phase === 'off' || s.phase === 'loading') return null
  const progress: Progress = { v: PROGRESS_VERSION, status: s.phase, step: s.step, results: s.results }
  if (s.card !== null) progress.card = s.card
  return progress
}

function write(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  const progress = snapshot()
  if (progress === null) return
  // A write that fails is tried again with the next change; the progress on screen is not affected.
  void Promise.resolve(workspace.saveTutorial(progress)).catch(() => {})
}

function save(now = false): void {
  if (now) return write()
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(write, SAVE_MS)
}

const titleOf = (id: StepId) => stepById(id).title
const countOf = (id: StepId) => `Step ${stepIndex(id) + 1} of ${STEP_IDS.length}`

function nextOf(id: StepId): StepId {
  return STEP_IDS[Math.min(stepIndex(id) + 1, STEP_IDS.length - 1)]!
}

function show(progress: Progress, focus: boolean): void {
  const s = useHandsOn.getState()
  useHandsOn.setState({
    phase: progress.status,
    step: progress.step,
    results: progress.results,
    card: progress.card ?? null,
    hidden: false,
    focus: focus ? s.focus + 1 : s.focus,
    check: NO_CHECK,
  })
}

export const handsOn = {
  /**
   * In a Tutorial Workspace, once signed in: asks the server where the person was. Never stored before → starts at
   * step 1 by itself; `running` → carries on there; `left` or `finished` → stays put until the account menu asks.
   * If the server cannot be asked, nothing starts; the account menu can still start it.
   */
  async init(): Promise<void> {
    if (useHandsOn.getState().phase !== 'off') return
    const ticket = ++generation
    useHandsOn.setState({ ...START, phase: 'loading' })
    let stored: Progress | null
    try {
      stored = readProgress(await workspace.loadTutorial())
    } catch {
      if (ticket === generation) useHandsOn.setState({ ...START, phase: 'left' })
      return
    }
    if (ticket !== generation) return
    if (stored === null) {
      show(freshProgress(), true)
      save(true)
    } else {
      show(stored, stored.status === 'running')
    }
  },

  /** The showing step has been done: it is ticked and the next one shows, without taking focus from the person. */
  done(id: StepId, made?: { card?: string }): void {
    const s = useHandsOn.getState()
    if (s.phase !== 'running' || s.step !== id || id === 'end') return
    const next = nextOf(id)
    useHandsOn.setState({
      step: next,
      results: { ...s.results, [id]: 'done' },
      card: made?.card ?? s.card,
      check: NO_CHECK,
      said: `Done: ${titleOf(id)}. ${countOf(next)}: ${titleOf(next)}.`,
    })
    save()
  },

  /** "Skip this step": passed as skipped, or as not tried when what it needs is missing on this computer. */
  skip(): void {
    const s = useHandsOn.getState()
    if (s.phase !== 'running' || s.step === 'end') return
    const result: StepResult = s.check.tool?.state === 'missing' ? 'not_tried' : 'skipped'
    const next = nextOf(s.step)
    useHandsOn.setState({
      step: next,
      results: { ...s.results, [s.step]: result },
      check: NO_CHECK,
      hidden: false,
      focus: s.focus + 1,
      said: `${countOf(next)}: ${titleOf(next)}.`,
    })
    save()
  },

  /** Shows any step, from the list of steps. Results are kept. */
  goTo(id: StepId): void {
    const s = useHandsOn.getState()
    if (s.phase === 'off' || s.phase === 'loading') return
    useHandsOn.setState({ phase: 'running', step: id, hidden: false, check: NO_CHECK, focus: s.focus + 1, said: `${countOf(id)}: ${titleOf(id)}.` })
    save()
  },

  /** "Leave the tutorial": it goes away and stays away until the account menu brings it back. */
  leave(): void {
    const s = useHandsOn.getState()
    if (s.phase !== 'running') return
    useHandsOn.setState({ phase: s.step === 'end' ? 'finished' : 'left', check: NO_CHECK, said: 'You left the tutorial. It is in the account menu, as “Tutorial”.' })
    save(true)
  },

  /** The last step's "Finish". */
  finish(): void {
    const s = useHandsOn.getState()
    if (s.phase !== 'running') return
    useHandsOn.setState({ phase: 'finished', check: NO_CHECK, said: 'The tutorial is finished. It is in the account menu, as “Tutorial”.' })
    save(true)
  },

  /**
   * The account menu's "Tutorial": shows a running one, resumes a left one where it was, and starts a finished
   * one again from step 1.
   */
  resume(): void {
    const s = useHandsOn.getState()
    if (s.phase === 'off' || s.phase === 'loading') return
    if (s.phase === 'finished') show(freshProgress(), true)
    else show({ v: PROGRESS_VERSION, status: 'running', step: s.step, results: s.results, ...(s.card ? { card: s.card } : {}) }, true)
    useHandsOn.setState({ said: `${countOf(useHandsOn.getState().step)}: ${titleOf(useHandsOn.getState().step)}.` })
    save()
  },

  /** Puts the popover away; `focus`: it had focus, which goes to the rail's "Show step". */
  hide(focus = false): void {
    const s = useHandsOn.getState()
    if (s.phase === 'running') useHandsOn.setState({ hidden: true, focusShow: focus ? s.focusShow + 1 : s.focusShow })
  },

  show(): void {
    const s = useHandsOn.getState()
    if (s.phase === 'running') useHandsOn.setState({ hidden: false, focus: s.focus + 1 })
  },

  /** What the showing step's watcher sees. Ignored when it is about a step that is no longer showing. */
  report(id: StepId, check: StepCheck): void {
    const s = useHandsOn.getState()
    if (s.step !== id || s.phase !== 'running') return
    const was = s.check
    const same =
      was.missing === check.missing &&
      JSON.stringify(was.cards) === JSON.stringify(check.cards) &&
      (was.tool === check.tool ||
        (was.tool !== null &&
          check.tool !== null &&
          was.tool.state === check.tool.state &&
          was.tool.instead === check.tool.instead &&
          was.tool.action?.label === check.tool.action?.label &&
          was.tool.lines.join('\n') === check.tool.lines.join('\n')))
    if (!same) useHandsOn.setState({ check })
  },

  /** Leaving the Workspace (or the session ending): the last change is written, and everything is forgotten. */
  reset(): void {
    if (timer !== null) write()
    generation++
    useHandsOn.setState(START, true)
  },
}

/** True while the Tutorial is in the way of the Tour: in a Tutorial Workspace, until it was left or finished. */
export function tutorialHoldsTour(phase: HandsOnPhase): boolean {
  return phase === 'loading' || phase === 'running'
}
