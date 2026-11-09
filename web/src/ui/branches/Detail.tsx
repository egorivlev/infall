// Beside the graph: what the selected dot is — all its lines, its Branch, who, when, how many Changes — and what can
// be done from it: New Branch from here, Preview the Board, Add Checkpoint here, Show every Change.
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { formatWhen, graph as graphStore, useGraphLines } from '../../lib'
import type { GraphBranch, GraphChangeLine, GraphCheckpoint, GraphLayout, Member } from '../../lib'
import { Avatar } from '../history/Timeline'
import { FORMER_MEMBER, count, formatSpan, personOf } from '../history/format'
import { describeError, errorCode } from '../shell/errorMessages'
import { firstName } from './model'
import type { Placed } from './model'

export const CHECKPOINT_TAKEN = 'This Branch already has a Checkpoint with that name.'
const CHANGES_PAGE = 200

type Props = {
  layout: GraphLayout
  branches: readonly GraphBranch[]
  placed: Placed | null
  colour: number
  people: ReadonlyMap<string, Member>
  actionsRef: RefObject<HTMLDivElement | null>
  onNewBranch: () => void
  onPreview: () => void
  /** Choose (a name) or let go of (undefined) one of the ◆ on this dot as the start. */
  onCheckpoint: (name: string | undefined) => void
  /** Select the row holding a moment (a Merge's source). */
  onShowRow: (row: number) => void
  /** Esc in here: back to the graph, the selection kept. */
  onLeave: () => void
  /** M18: a moved copy — reading only: no New Branch, no Checkpoint. */
  readOnly?: boolean
}

const nameOf = (people: ReadonlyMap<string, Member>, id: string) => personOf(people, id).name

export function Detail(props: Props) {
  const { placed } = props
  if (!placed) {
    return (
      <aside className="qg-detail" aria-label="Selected moment" data-testid="graph-detail">
        <p className="qg-detail__note">Select a dot to see what was done there, or to start a Branch from it.</p>
        <p className="qg-detail__keys">
          <kbd>↑</kbd> <kbd>↓</kbd> rows · <kbd>←</kbd> <kbd>→</kbd> neighbouring line · <kbd>Enter</kbd> actions · <kbd>N</kbd> new Branch ·{' '}
          <kbd>Esc</kbd> back
        </p>
      </aside>
    )
  }
  // Keyed by what is selected: an open form or list belongs to that dot.
  const key = placed.fork !== undefined ? `fork:${placed.fork}` : (props.layout.rows[placed.row]?.key ?? '')
  return <Selected key={key} {...props} placed={placed} />
}

function Selected({ layout, branches, placed, colour, people, actionsRef, onNewBranch, onPreview, onCheckpoint, onShowRow, onLeave, readOnly = false }: Props & { placed: Placed }) {
  const row = placed.fork === undefined ? layout.rows[placed.row]! : null
  const lane = layout.lanes.find((l) => l.branch === placed.moment.branch)!
  const branch = branches.find((b) => b.id === placed.moment.branch)
  const lines = useGraphLines(row?.key ?? '')
  const a = row?.activity ?? null
  const [adding, setAdding] = useState(false)
  const [showChanges, setShowChanges] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)
  const doneAdding = () => {
    setAdding(false)
    addRef.current?.focus() // the keyboard stays where it was
  }
  const start = a === null
  const checkpoints: GraphCheckpoint[] = row ? row.checkpoints : lane.startCheckpoints
  const parent = branch?.parent ? branches.find((b) => b.id === branch.parent!.branch) : undefined

  const source = row?.source ? branches.find((b) => b.id === row.source!.branch) : undefined
  const sourceRow = row?.source?.row

  return (
    <aside
      className="qg-detail"
      aria-label="Selected moment"
      data-testid="graph-detail"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        onLeave()
      }}
    >
      <div className="qg-detail__scroll">
        <div className="qg-detail__branch">
          <span className={`qg-label__swatch qg-c${colour}`} aria-hidden="true" />
          <span className="qg-detail__bname">{lane.name}</span>
          {a?.kind === 'merge' && <span className="q-tag">Merge</span>}
          {a?.kind === 'restore' && <span className="q-tag">Restore</span>}
        </div>
        {a ? (
          <>
            <div className="qg-detail__who">
              <Avatar person={personOf(people, a.author)} size={22} />
              <span className="qg-detail__name">{nameOf(people, a.author)}</span>
              <span className="qg-detail__when">{formatSpan(a.started_at, a.ended_at)}</span>
            </div>
            <div className="qg-detail__count">{count(a.to_seq - a.from_seq, 'Change')} in this Activity</div>
            {lines ? (
              <ul className="qg-detail__lines">
                {lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="qg-detail__hint">Working out what was done…</p>
            )}
            {source && sourceRow !== undefined && (
              <p className="qg-detail__source">
                Brought in <span className="q-mono">{source.name}</span>
                {layout.rows[sourceRow]?.activity ? ` as it was at ${formatWhen(layout.rows[sourceRow]!.activity!.ended_at)}` : ' from its start'}.{' '}
                <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={() => onShowRow(sourceRow)}>
                  Show that moment
                </button>
              </p>
            )}
          </>
        ) : row ? (
          <>
            <div className="qg-detail__name">The start of {lane.name}</div>
            <p className="qg-detail__hint">The Board before the first Change of the Workspace.</p>
          </>
        ) : (
          <>
            <div className="qg-detail__name">The start of {lane.name}</div>
            <p className="qg-detail__hint">
              {lane.rows.length === 0 ? 'No Changes yet. ' : ''}
              Started{parent ? ` from ${parent.name}` : ''}
              {branch?.created_by ? ` by ${nameOf(people, branch.created_by)}` : ''}
              {branch?.created_at !== undefined ? `, ${formatWhen(branch.created_at)}` : ''}.
            </p>
          </>
        )}
        {checkpoints.length > 0 && (
          <ul className="qg-detail__cps" aria-label="Checkpoints here">
            {checkpoints.map((c) => {
              const chosen = placed.checkpoint === c.name
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    className={`qg-detail__cp${chosen ? ' is-chosen' : ''}`}
                    aria-label={`Checkpoint ${c.name}`}
                    aria-pressed={chosen}
                    title={chosen ? 'The new Branch starts from this Checkpoint' : 'Start the new Branch from this Checkpoint'}
                    onClick={() => onCheckpoint(chosen ? undefined : c.name)}
                  >
                    <span aria-hidden="true">◆</span> {c.name}
                  </button>
                  <span className="qg-detail__cpmeta">
                    named by {nameOf(people, c.author)}, {formatWhen(c.at)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <div className="qg-detail__acts" ref={actionsRef} role="group" aria-label="Actions">
          {!readOnly && (
            <button type="button" className="q-btn q-btn--sm q-btn--primary" onClick={onNewBranch}>
              New Branch from here
            </button>
          )}
          <button type="button" className="q-btn q-btn--sm" onClick={onPreview}>
            Preview the Board
          </button>
          {!readOnly && (
            <button type="button" ref={addRef} className="q-btn q-btn--sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
              Add Checkpoint here
            </button>
          )}
          {!start && row && (
            <button type="button" className="q-btn q-btn--sm" aria-expanded={showChanges} onClick={() => setShowChanges((v) => !v)}>
              Show every Change
            </button>
          )}
        </div>
        {adding && <AddCheckpoint branchId={placed.moment.branch} seq={placed.moment.seq} onDone={doneAdding} />}
        {showChanges && row && a && <EveryChange row={placed.row} expected={a.to_seq - a.from_seq} people={people} />}
      </div>
    </aside>
  )
}

function checkName(v: string): string | undefined {
  const name = v.trim()
  if (!name) return 'Give the Checkpoint a name.'
  return name.length > 60 ? 'Use 60 characters or fewer.' : undefined
}

/** "Add Checkpoint here": one field; the dot gets its ◆ as soon as the server has it. */
function AddCheckpoint({ branchId, seq, onDone }: { branchId: string; seq: number; onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => inputRef.current?.focus(), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busyRef.current) return
    const problem = checkName(name)
    setError(problem)
    if (problem) return void inputRef.current?.focus()
    busyRef.current = true
    setBusy(true)
    try {
      await graphStore.addCheckpoint(branchId, name.trim(), seq)
      onDone()
    } catch (err) {
      setError(errorCode(err) === 'name_taken' ? CHECKPOINT_TAKEN : describeError(err))
      inputRef.current?.focus()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <form className="qg-detail__form" onSubmit={submit} noValidate>
      <label className="q-label" htmlFor={`${id}-cp`}>
        Checkpoint name
      </label>
      <input
        id={`${id}-cp`}
        ref={inputRef}
        className={`q-input${error ? ' q-input--invalid' : ''}`}
        value={name}
        autoComplete="off"
        spellCheck={false}
        placeholder="e.g. Before decoder rewrite"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => {
          setName(e.target.value)
          if (error && !checkName(e.target.value)) setError(undefined)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone()
          }
        }}
      />
      {error && (
        <p className="q-error" id={`${id}-err`}>
          {error}
        </p>
      )}
      <div className="qg-detail__formacts">
        <button type="submit" className="q-btn q-btn--sm q-btn--primary" aria-disabled={busy} aria-busy={busy}>
          {busy ? 'Adding Checkpoint…' : 'Add Checkpoint'}
        </button>
        <button type="button" className="q-btn q-btn--sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type ChangesState = { status: 'loading' } | { status: 'ready'; list: GraphChangeLine[] } | { status: 'error'; message: string }

/** "Show every Change": each Change of the Activity in one line of plain words, with its time. */
function EveryChange({ row, expected, people }: { row: number; expected: number; people: ReadonlyMap<string, Member> }) {
  const [state, setState] = useState<ChangesState>({ status: 'loading' })
  const [shown, setShown] = useState(CHANGES_PAGE)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    graphStore.changesOf(row).then(
      (list) => live && setState({ status: 'ready', list }),
      (e: unknown) => live && setState({ status: 'error', message: describeError(e) }),
    )
    return () => {
      live = false
    }
    // `row` is fixed for this list: it is keyed by the selected dot.
  }, [row, attempt])

  return (
    <section className="qg-changes" aria-label="Every Change">
      <h3 className="qg-changes__h">
        Every Change <span className="q-mono">{count(expected, 'Change')}</span>
      </h3>
      {state.status === 'loading' ? (
        <p className="qg-detail__hint">Loading the Changes…</p>
      ) : state.status === 'error' ? (
        <p className="qg-detail__hint" role="alert">
          The Changes could not be loaded.{' '}
          <button
            type="button"
            className="q-btn q-btn--sm"
            onClick={() => {
              setState({ status: 'loading' })
              setAttempt((n) => n + 1)
            }}
          >
            Try again
          </button>
        </p>
      ) : (
        <>
          <ol className="qg-changes__list">
            {state.list.slice(0, shown).map((c) => (
              <li key={c.id}>
                <span className="qg-changes__when">{formatWhen(c.at)}</span>
                <span className="qg-changes__who">{people.has(c.author) ? firstName(nameOf(people, c.author)) : FORMER_MEMBER.name}</span>
                <span className="qg-changes__line">{c.line}</span>
              </li>
            ))}
          </ol>
          {state.list.length > shown && (
            <button type="button" className="q-btn q-btn--sm" onClick={() => setShown((n) => n + CHANGES_PAGE)}>
              Show {Math.min(CHANGES_PAGE, state.list.length - shown)} more
            </button>
          )}
        </>
      )}
    </section>
  )
}
