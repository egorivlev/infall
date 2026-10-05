import { useEffect, useId, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { merge, useBranches, useMembers, useMerge } from '../../lib'
import type { MergeSnapshot } from '../../lib'
import { errorCode } from '../shell/errorMessages'
import { Field } from '../shell/Field'
import { Link } from '../shell/Link'
import { branchPath, MAIN } from '../shell/router'
import { useDelayedFlag } from '../shell/useDelayedFlag'
import { ConflictBlock } from './ConflictBlock'
import { applyFailure, choiceLabel, conflictAnchor, conflictHeadingId, conflictShort } from './copy'
import './merge.css'

const BRANCHES = '/branches'

/** A Branch name as written everywhere in the review: mono, never upper-cased, in the Branch colour unless it is main. */
function Name({ name, chip }: { name: string; chip?: boolean }) {
  return <span className={`q-merge-name${name === MAIN ? '' : ' q-merge-name--branch'}${chip ? ' q-merge-name--chip' : ''}`}>{name}</span>
}

/** A quiet message filling the work area: nothing to review, or the review could not be prepared. */
function Message({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="q-merge-message" role="status">
      <p className="q-merge-message__text">{children}</p>
      <div className="q-merge-message__links">
        {action}
        <Link href={BRANCHES}>Back to Branches</Link>
      </div>
    </div>
  )
}

function AutoList({ snap }: { snap: MergeSnapshot }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const summary = (
    <>
      <span className="q-merge-auto__check" aria-hidden="true">
        ✓
      </span>
      <span className="q-merge-auto__title">Merges automatically</span>
      <span className="q-merge-auto__summary">{snap.autoSummary}</span>
    </>
  )
  // Nothing to list (for example only moved Cards): the summary alone, with nothing to open.
  if (snap.auto.length === 0) {
    return (
      <div className="q-merge-auto">
        <div className="q-merge-auto__toggle q-merge-auto__toggle--static">
          <span className="q-merge-auto__caret" />
          {summary}
        </div>
      </div>
    )
  }
  return (
    <div className="q-merge-auto">
      <button type="button" className="q-merge-auto__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        <span className="q-merge-auto__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {summary}
      </button>
      {open && (
        <ul id={listId} className="q-merge-auto__list">
          {snap.auto.map((line, i) => (
            <li key={i} className="q-merge-auto__row">
              <span className="q-merge-auto__kind">{line.kind}</span>
              <span className="q-merge-auto__what">{line.what}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Moves to a Conflict from the side list: scroll it into view and put focus on its heading. */
function jumpTo(e: MouseEvent<HTMLAnchorElement>, index: number) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault() // keep the URL (and so the route) as it is
  const heading = document.getElementById(conflictHeadingId(index))
  if (!heading) return
  document.getElementById(conflictAnchor(index))?.scrollIntoView?.({ block: 'start' })
  heading.focus({ preventScroll: true })
}

/** Screen 9a: review what a Merge of `from` into `into` would do, decide each Conflict, then merge. */
export function MergeReview({ from, into }: { from: string; into: string }) {
  const snap = useMerge()
  const people = useMembers()
  const known = useBranches()

  // Plan on mount and whenever the pair changes; let go on leaving. Under StrictMode this runs open → close → open,
  // which ends open, and nothing here remembers having run.
  useEffect(() => {
    void merge.open(from, into)
    return () => merge.close()
  }, [from, into])

  // A Checkpoint name the server refused, and any other reason the Merge did not go through.
  const [takenName, setTakenName] = useState<string | null>(null)
  const [nameMissing, setNameMissing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // The snapshot belongs to this review only once it names the same two Branches (a stale one may still be around for a moment).
  const mine = snap.source?.name === from && snap.target?.name === into
  const loading = snap.status === 'idle' || snap.status === 'loading' || (snap.status !== 'error' && !mine)
  const showLoading = useDelayedFlag(loading, 150)

  if (loading) {
    return showLoading ? (
      <div className="q-merge-message" role="status">
        <p className="q-merge-message__text q-merge-message__text--quiet">Preparing the Merge…</p>
      </div>
    ) : null
  }

  if (snap.status === 'error') {
    if (snap.errorCode === 'not_parent_and_child') {
      return <Message>A Branch can only be merged with the Branch it was started from.</Message>
    }
    if (snap.errorCode === 'not_found') {
      const missing = known.length === 0 ? [] : [from, into].filter((n) => !known.some((b) => b.name === n))
      return (
        <Message>
          {missing.length === 1
            ? `There is no Branch called “${missing[0]}”.`
            : `There is no Branch called “${from}”, or none called “${into}”.`}
        </Message>
      )
    }
    return (
      <Message
        action={
          <button type="button" className="q-btn" onClick={() => void merge.open(from, into)}>
            Try again
          </button>
        }
      >
        {snap.error ?? applyFailure(snap.errorCode ?? '')}
      </Message>
    )
  }

  const merged = snap.status === 'merged'
  const applying = snap.status === 'applying'

  if (snap.nothingToMerge && !merged) {
    return (
      <Message>
        <Name name={into} /> already has everything from <Name name={from} />.
      </Message>
    )
  }

  const total = snap.conflicts.length
  const left = total - snap.decided
  const readOnly = merged || applying

  const onMerge = async () => {
    setFailure(null)
    setTakenName(null)
    if (snap.checkpointName.trim() === '') {
      setNameMissing(true)
      return
    }
    const name = snap.checkpointName
    try {
      await merge.apply()
    } catch (e) {
      const code = errorCode(e)
      if (code === 'stale') return // the snapshot says `replanned`; the notice explains
      if (code === 'name_taken') setTakenName(name)
      else setFailure(applyFailure(code))
    }
  }

  const checkpointError =
    takenName !== null && takenName === snap.checkpointName
      ? `${into} already has a Checkpoint with that name.`
      : nameMissing && snap.checkpointName.trim() === ''
        ? 'Give the Checkpoint a name.'
        : undefined

  const created = snap.result?.checkpoint?.name

  return (
    <div className="q-merge">
      <header className="q-merge__head">
        <div className="q-merge__intro">
          <h1 className="q-merge__h">
            Merge <Name name={from} chip /> into <Name name={into} chip />
          </h1>
          <p className="q-merge__lead">
            <Name name={into} /> doesn’t change until you press Merge. A Checkpoint is created on <Name name={into} /> first.
          </p>
        </div>
        <div className="q-merge__side">
          {failure !== null && (
            <p className="q-error q-merge__failure" role="alert">
              {failure}
            </p>
          )}
          <div className="q-merge__actions">
            <div className="q-merge__progress">
              {total === 0 ? (
                <span>No Conflicts</span>
              ) : (
                <>
                  <span>
                    <b>
                      {snap.decided} of {total}
                    </b>{' '}
                    Conflicts decided
                  </span>
                  <span className="q-merge__segments" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }}>
                    {snap.conflicts.map((c) => (
                      <span key={c.id} className="q-merge__segment" data-decided={c.choice !== null} />
                    ))}
                  </span>
                </>
              )}
            </div>
            <Link href={BRANCHES} className="q-btn q-btn--lg q-merge__cancel">
              {merged ? 'Close' : 'Cancel'}
            </Link>
            <button
              type="button"
              className="q-btn q-btn--lg q-btn--primary q-merge__go"
              disabled={merged || applying || left > 0}
              title={merged || applying ? undefined : left > 0 ? 'Decide all Conflicts first' : `Merge ${from} into ${into}`}
              onClick={() => void onMerge()}
            >
              {merged ? 'Merged ✓' : applying ? 'Merging…' : left > 0 ? `Merge · ${left} left` : <>Merge into {into}</>}
            </button>
          </div>
        </div>
      </header>
      <div className="q-merge__cols">
        <nav className="q-merge-nav" aria-label="Review">
          <div className="q-caps q-merge-nav__label">Review</div>
          <div className="q-merge-nav__auto">
            <span className="q-merge-auto__check" aria-hidden="true">
              ✓
            </span>
            <span className="q-merge-nav__grow">Merges automatically</span>
            <span className="q-merge-nav__count">{snap.auto.length}</span>
          </div>
          <div className="q-caps q-merge-nav__label q-merge-nav__label--next">Conflicts</div>
          {total === 0 ? (
            <p className="q-hint q-merge-nav__none">No Conflicts.</p>
          ) : (
            <ol className="q-merge-nav__list">
              {snap.conflicts.map((c, i) => (
                <li key={c.id}>
                  <a href={`#${conflictAnchor(i)}`} className="q-merge-nav__item" data-decided={c.choice !== null} onClick={(e) => jumpTo(e, i)}>
                    <span className="q-merge-nav__dot" aria-hidden="true">
                      {c.choice !== null && '✓'}
                    </span>
                    <span className="q-merge-nav__title">{conflictShort(c)}</span>
                    <span className="q-merge-nav__state">
                      {c.choice === null ? 'Needs a decision' : `Decided · ${choiceLabel(c.choice, from, into)}`}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </nav>
        <div className="q-merge__scroll">
          <div className="q-merge__main">
            {merged ? (
              <div className="q-merge-banner" role="status">
                <p className="q-merge-banner__text">
                  ✓ Merged into <Name name={into} />.
                  {created !== undefined && <> Checkpoint “{created}” was created — Restore to it from History to undo.</>}
                </p>
                <div className="q-merge-banner__links">
                  <Link href={branchPath(into)}>Open {into}</Link>
                  <Link href={BRANCHES}>Back to Branches</Link>
                </div>
              </div>
            ) : (
              snap.replanned && (
                <p className="q-merge-notice" role="status">
                  A Branch changed while you were reviewing. The review was updated — check your decisions and Merge again.
                </p>
              )
            )}
            <AutoList snap={snap} />
            {snap.layoutKept > 0 && (
              <p className="q-merge-layout">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" focusable="false">
                  <rect x="1.5" y="1.5" width="4.5" height="4.5" />
                  <rect x="8" y="8" width="4.5" height="4.5" />
                  <path d="M6 3.75 H10.25 V8 M10.25 8 L8.8 6.6 M10.25 8 L11.7 6.6" />
                </svg>
                <span>
                  <b>
                    Card positions follow <Name name={into} />.
                  </b>{' '}
                  {snap.layoutKept === 1 ? (
                    <>
                      1 Card or Frame that was moved on <Name name={from} /> keeps its <Name name={into} /> position and is not listed as a Conflict.
                    </>
                  ) : (
                    <>
                      {snap.layoutKept} Cards and Frames that were moved on <Name name={from} /> keep their <Name name={into} /> position and are not
                      listed as Conflicts.
                    </>
                  )}
                </span>
              </p>
            )}
            {snap.conflicts.map((c, i) => (
              <ConflictBlock key={c.id} conflict={c} index={i} source={from} target={into} people={people} readOnly={readOnly} />
            ))}
            <div className="q-merge-checkpoint">
              <Field
                label={`Checkpoint on ${into} before merging`}
                name="merge-checkpoint"
                value={merged && created !== undefined ? created : snap.checkpointName}
                onChange={(v) => merge.setCheckpointName(v)}
                error={checkpointError}
                disabled={readOnly}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
