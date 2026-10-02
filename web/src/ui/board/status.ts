import type { ConnectionKind, Status } from '../../lib'

export const STATUS_LABEL: Record<Status, string> = {
  idea: 'Idea',
  reading: 'Reading',
  understood: 'Understood',
  open_question: 'Open question',
  dead_end: 'Dead end · kept',
}

/** The shorter word used on compact Cards. */
export const STATUS_SHORT: Record<Status, string> = {
  idea: 'Idea',
  reading: 'Reading',
  understood: 'Understood',
  open_question: 'Question',
  dead_end: 'Dead end',
}

export const KIND_LABEL: Record<ConnectionKind, string> = {
  related: 'Related',
  directed: 'Directed',
  contradicts: 'Contradicts',
}

/** The suffix of the status colour token: `var(--q-st-${STATUS_TOKEN[s]})`. */
export const STATUS_TOKEN: Record<Status, string> = {
  idea: 'idea',
  reading: 'reading',
  understood: 'understood',
  open_question: 'question',
  dead_end: 'dead',
}
