import { useUndo } from '../../lib'
import { ariaKeys, runUndo, undoKeys } from './undoActions'
import type { UndoDirection } from './undoActions'

type Props = {
  /** Class of each button (the Board toolbar's or the Page header's look). */
  buttonClass: string
  /** Which side the tooltips line up with: the Board toolbar sits at the left, the Page header's buttons at the right. */
  align?: 'start' | 'end'
}

function Arrow({ direction }: { direction: UndoDirection }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={direction === 'redo' ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M4.8 2.6 L2 5.4 L4.8 8.2" />
      <path d="M2.3 5.4 H8.4 A3.1 3.1 0 0 1 8.4 11.6 H6" />
    </svg>
  )
}

function UndoButton({ direction, step, buttonClass }: { direction: UndoDirection; step: string | null; buttonClass: string }) {
  const verb = direction === 'undo' ? 'Undo' : 'Redo'
  const name = step ? `${verb} ${step}` : direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo'
  return (
    <span className="q-undo">
      {/* aria-disabled, not disabled: focus stays on the button when the last step is undone. */}
      <button
        type="button"
        className={buttonClass}
        data-testid={`${direction}-button`}
        aria-label={name}
        aria-disabled={step ? undefined : true}
        aria-keyshortcuts={ariaKeys(direction)}
        onClick={() => {
          if (step) void runUndo(direction)
        }}
      >
        <Arrow direction={direction} />
      </button>
      <span className="q-undo__tip" aria-hidden="true">
        {name}
        <kbd className="q-undo__keys">{undoKeys(direction)}</kbd>
      </span>
    </span>
  )
}

/** Undo and Redo of the open Branch's steps (docs/specs/undo.md decision 11): icon buttons naming the step. */
export function UndoButtons({ buttonClass, align = 'start' }: Props) {
  const s = useUndo()
  return (
    <span className={`q-undo-pair q-undo-pair--${align}`}>
      <UndoButton direction="undo" step={s.undo} buttonClass={buttonClass} />
      <UndoButton direction="redo" step={s.redo} buttonClass={buttonClass} />
    </span>
  )
}
