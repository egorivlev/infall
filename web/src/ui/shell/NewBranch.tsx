import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { branches } from '../../lib'
import type { Checkpoint } from '../../lib'
import { formatDateTime, formatShortDate } from './dates'
import { describeError, errorCode } from './errorMessages'
import { Field } from './Field'
import { newBranchIntent, useNewBranchIntent } from './newBranchIntent'
import { branchPath, navigate } from './router'

const MAX = 60
const NAME_TAKEN = 'A Branch with that name already exists.'

function checkName(v: string): string | undefined {
  const name = v.trim()
  if (!name) return 'Give the Branch a name.'
  return name.length > MAX ? `Use ${MAX} characters or fewer.` : undefined
}

/** Newest moment first; the later-made one first when two name the same moment. */
function newestFirst(list: Checkpoint[]): Checkpoint[] {
  return [...list].sort((a, b) => b.moment.seq - a.moment.seq || b.at - a.at)
}

/** `current` is the open Branch's name; `checkpoints` are that Branch's. */
export function NewBranch({ current, checkpoints }: { current: string; checkpoints: Checkpoint[] }) {
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | undefined>()
  const [formError, setFormError] = useState('')
  const [source, setSource] = useState<'now' | 'checkpoint'>('now')
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [asOf] = useState(() => Date.now())
  const busyRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const id = useId()

  const wantsFocus = useNewBranchIntent((s) => s.pending)
  useEffect(() => {
    if (!wantsFocus) return
    nameRef.current?.focus()
    newBranchIntent.clear()
  }, [wantsFocus])

  const options = newestFirst(checkpoints)
  const none = options.length === 0
  // Checkpoint names are unique within a Branch, so the name identifies the choice.
  const chosen = options.find((c) => c.name === picked) ?? options[0]
  const fromCheckpoint = source === 'checkpoint' && !none

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const problem = checkName(name)
    setNameError(problem)
    if (problem) return void nameRef.current?.focus()
    busyRef.current = true
    setBusy(true)
    setFormError('')
    try {
      const wanted = name.trim()
      // "Now" leaves the moment to the data layer: the head of the open Branch when the request is made.
      const made = await branches.create(fromCheckpoint && chosen ? { name: wanted, from: chosen.moment } : { name: wanted })
      navigate(branchPath(made.name))
    } catch (err) {
      if (errorCode(err) === 'name_taken') {
        setNameError(NAME_TAKEN)
        nameRef.current?.focus()
      } else setFormError(describeError(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="q-newbranch" aria-labelledby={`${id}-h`}>
      <h2 className="q-panel-title" id={`${id}-h`}>
        New Branch
      </h2>
      <p className="q-newbranch__lead">A Branch is a full copy of the Board. Work on it stays there until you Merge.</p>
      <form className="q-newbranch__form" onSubmit={submit} noValidate>
        <Field
          label="Name"
          name="branch-name"
          autoComplete="off"
          mono
          value={name}
          inputRef={nameRef}
          error={nameError}
          onChange={(v) => {
            setName(v)
            setFormError('')
            if (nameError && !checkName(v)) setNameError(undefined)
          }}
        />
        <fieldset className="q-from">
          <legend className="q-label">Start from</legend>
          <label className="q-from__opt">
            <input type="radio" name="branch-from" value="now" checked={!fromCheckpoint} onChange={() => setSource('now')} />
            <span className="q-from__text">
              <span>Now</span>
              <span className="q-from__note">
                <span className="q-mono">{current}</span> as of {formatDateTime(asOf)}
              </span>
            </span>
          </label>
          <div className={`q-from__opt${none ? ' q-from__opt--off' : ''}`}>
            <input
              type="radio"
              id={`${id}-cp`}
              name="branch-from"
              value="checkpoint"
              checked={fromCheckpoint}
              disabled={none}
              aria-describedby={none ? `${id}-none` : undefined}
              onChange={() => setSource('checkpoint')}
            />
            <span className="q-from__text">
              <label htmlFor={`${id}-cp`}>A Checkpoint</label>
              {none ? (
                <span className="q-from__note" id={`${id}-none`}>
                  This Branch has no Checkpoints yet.
                </span>
              ) : (
                <select
                  className="q-input q-from__select"
                  aria-label="Checkpoint"
                  value={chosen?.name ?? ''}
                  onChange={(e) => {
                    setPicked(e.target.value)
                    setSource('checkpoint')
                  }}
                >
                  {options.map((c) => (
                    <option key={c.name} value={c.name}>
                      ◆ {c.name} · {formatShortDate(c.at)}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </div>
        </fieldset>
        <button type="submit" className="q-btn q-btn--primary q-btn--lg" aria-disabled={busy} aria-busy={busy}>
          {busy ? 'Creating Branch…' : 'Create Branch and switch to it'}
        </button>
        {formError && (
          <p className="q-error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </section>
  )
}
