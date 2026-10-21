// What the Tutorial keeps on the server (`PUT /api/local/tutorial`; the server stores it as it is and never reads
// it). Small and versioned: the step showing, how each step ended, and the Card made in step 2. Read defensively —
// anything unreadable, or another version, is a Tutorial that never started.
import { isStepId } from './steps'
import type { StepId } from './steps'

export const PROGRESS_VERSION = 1

/** How a step ended: done; skipped; or passed because something it needs is not on this computer. */
export type StepResult = 'done' | 'skipped' | 'not_tried'

/** `running`: shown, and resumed by itself on the next open. `left`: the person left it; `finished`: they reached the end. */
export type ProgressStatus = 'running' | 'left' | 'finished'

export type Progress = {
  v: typeof PROGRESS_VERSION
  status: ProgressStatus
  step: StepId
  results: Partial<Record<StepId, StepResult>>
  /** The Card made in step 2, which step 3 writes on. */
  card?: string
}

const RESULTS: readonly string[] = ['done', 'skipped', 'not_tried']
const STATUSES: readonly string[] = ['running', 'left', 'finished']

/** The stored value, or null when there is none or it cannot be read. */
export function readProgress(value: unknown): Progress | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.v !== PROGRESS_VERSION || typeof v.status !== 'string' || !STATUSES.includes(v.status) || !isStepId(v.step)) return null
  const results: Partial<Record<StepId, StepResult>> = {}
  if (typeof v.results === 'object' && v.results !== null && !Array.isArray(v.results)) {
    for (const [id, result] of Object.entries(v.results as Record<string, unknown>)) {
      if (isStepId(id) && typeof result === 'string' && RESULTS.includes(result)) results[id] = result as StepResult
    }
  }
  const progress: Progress = { v: PROGRESS_VERSION, status: v.status as ProgressStatus, step: v.step, results }
  if (typeof v.card === 'string' && v.card !== '' && v.card.length <= 100) progress.card = v.card
  return progress
}

/** A fresh start: step 1, nothing done. */
export function freshProgress(): Progress {
  return { v: PROGRESS_VERSION, status: 'running', step: 'look', results: {} }
}
