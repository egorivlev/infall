import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { merge } from '../../lib'
import type { Choice, ConflictSide, ConflictVM, Member } from '../../lib'
import { STATUS_TOKEN } from '../board/status'
import { StatusGlyph } from '../board/StatusGlyph'
import { MAIN } from '../shell/router'
import {
  choiceLabel,
  conflictAnchor,
  conflictHeadingId,
  conflictNumber,
  conflictTitle,
  EDIT_BY_HAND,
  editHint,
  startingText,
  typeLabel,
  whoWhen,
} from './copy'

type Slot = 'target' | 'source' | 'custom'

const pickOf = (choice: Choice | null): Slot | null => (choice === null ? null : typeof choice === 'string' ? choice : 'custom')

type Props = {
  conflict: ConflictVM
  index: number
  source: string
  target: string
  people: Member[]
  /** After merging (and while applying) the decisions can be read but not changed. */
  readOnly: boolean
}

/** One Conflict: what disagrees, and the choice between the two Branches (or a value written by hand). */
export function ConflictBlock({ conflict: c, index, source, target, people, readOnly }: Props) {
  const fieldId = useId()
  const group = useRef<HTMLDivElement>(null)
  const picked = pickOf(c.choice)
  const picks: Slot[] = c.canEdit ? ['target', 'source', 'custom'] : ['target', 'source']
  // One tab stop for the group: the chosen option, or the first while nothing is chosen.
  const tabStop = picked ?? 'target'

  const choose = (pick: Slot) => {
    if (readOnly || pick === picked) return // choosing "Edit by hand" again keeps what was typed
    merge.decide(c.id, pick === 'custom' ? { custom: startingText(c) } : pick)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const radios = Array.from(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])
    const at = radios.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const next = (at + step + picks.length) % picks.length
    radios[next]?.focus()
    const pick = picks[next]
    if (pick) choose(pick) // as with native radios, moving also chooses
  }

  const option = (pick: Slot, name: string, branch: string | null, side: ConflictSide | null, value: ReactNode) => (
    <button
      key={pick}
      type="button"
      role="radio"
      aria-checked={picked === pick}
      aria-disabled={readOnly || undefined}
      tabIndex={tabStop === pick ? 0 : -1}
      className="q-merge-opt"
      data-pick={pick}
      onClick={() => choose(pick)}
    >
      <span className="q-merge-opt__top">
        <span className="q-merge-opt__dot" aria-hidden="true" />
        <span className={`q-merge-opt__side${branch === null ? ' q-merge-opt__side--plain' : branch === MAIN ? '' : ' q-merge-opt__side--branch'}`}>
          {name}
        </span>
        {side && <span className="q-merge-opt__who">{whoWhen(side, people)}</span>}
      </span>
      {value}
    </button>
  )

  const sideValue = (side: ConflictSide) =>
    side.status ? (
      <span className="q-merge-opt__value q-merge-opt__value--status" style={{ color: `var(--q-st-${STATUS_TOKEN[side.status]})` }}>
        <StatusGlyph status={side.status} size={11} label={null} />
        {side.text}
      </span>
    ) : (
      <span className={`q-merge-opt__value${c.type === 'field' ? ' q-merge-opt__value--text' : ''}`}>{side.text}</span>
    )

  return (
    <section id={conflictAnchor(index)} className="q-merge-conflict" data-decided={picked !== null} aria-labelledby={conflictHeadingId(index)}>
      <div className="q-merge-conflict__head">
        <span className="q-merge-conflict__num">{conflictNumber(index)}</span>
        <span className="q-merge-conflict__type">{typeLabel(c)}</span>
        <h2 id={conflictHeadingId(index)} className="q-merge-conflict__title" tabIndex={-1}>
          {conflictTitle(c)}
        </h2>
        <span className="q-merge-conflict__headline">{c.headline}</span>
        <span className={`q-merge-conflict__state${c.choice === null ? '' : ' q-merge-conflict__state--done'}`}>
          {c.choice === null ? 'Needs a decision' : `✓ Decided: ${choiceLabel(c.choice, source, target)}`}
        </span>
      </div>
      <div className="q-merge-conflict__body">
        <div
          ref={group}
          role="radiogroup"
          aria-labelledby={conflictHeadingId(index)}
          aria-readonly={readOnly || undefined}
          className="q-merge-opts"
          data-cols={picks.length}
          onKeyDown={onKeyDown}
        >
          {option('target', target, target, c.target, sideValue(c.target))}
          {option('source', source, source, c.source, sideValue(c.source))}
          {c.canEdit && option('custom', EDIT_BY_HAND, null, null, <span className="q-merge-opt__value q-merge-opt__value--hint">{editHint(c)}</span>)}
        </div>
        {c.choice !== null && typeof c.choice === 'object' && (
          <div className="q-merge-edit">
            <label className="q-label" htmlFor={fieldId}>
              Your value — this is what <span className="q-merge-name">{target}</span> will get
            </label>
            <textarea
              id={fieldId}
              className={`q-merge-edit__text${c.field === 'title' || c.field === 'label' ? '' : ' q-merge-edit__text--long'}`}
              value={c.choice.custom}
              readOnly={readOnly}
              spellCheck={false}
              onChange={(e) => merge.decide(c.id, { custom: e.target.value })}
            />
          </div>
        )}
      </div>
    </section>
  )
}
