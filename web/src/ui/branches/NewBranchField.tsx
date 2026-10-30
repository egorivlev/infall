// The one way to start a Branch (branch-graph.md §2): a name, and the start chosen on the graph. The line under the
// field says where it will start; Enter starts it there and opens it. Errors stay at the field.
import { useId, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import type { BranchInfo } from '../../lib'
import { describeError, errorCode } from '../shell/errorMessages'
import { branchPath, navigate } from '../shell/router'

const MAX = 60
export const NAME_TAKEN = 'A Branch with that name already exists.'

function checkName(v: string): string | undefined {
  const name = v.trim()
  if (!name) return 'Give the Branch a name.'
  return name.length > MAX ? `Use ${MAX} characters or fewer.` : undefined
}

type Props = {
  inputRef: RefObject<HTMLInputElement | null>
  /** Where it will start, in `startLabel`'s words: "from now on main". */
  from: string
  create: (name: string) => Promise<BranchInfo>
  /** Esc: leave the field (back to the graph). */
  onLeave: () => void
}

export function NewBranchField({ inputRef, from, create, onLeave }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const id = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const problem = checkName(name)
    setError(problem)
    if (problem) return void inputRef.current?.focus()
    busyRef.current = true
    setBusy(true)
    try {
      const made = await create(name.trim())
      navigate(branchPath(made.name))
    } catch (err) {
      setError(errorCode(err) === 'name_taken' ? NAME_TAKEN : describeError(err))
      inputRef.current?.focus()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <form className="qg-new" onSubmit={submit} noValidate>
      <label className="qg-new__label" htmlFor={`${id}-name`}>
        New Branch
      </label>
      <div className="qg-new__field">
        <input
          id={`${id}-name`}
          ref={inputRef}
          className={`q-input q-mono${error ? ' q-input--invalid' : ''}`}
          name="branch-name"
          value={name}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. decoder-rewrite"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-from ${id}-err` : `${id}-from`}
          data-tour="new-branch"
          onChange={(e) => {
            setName(e.target.value)
            if (error && !checkName(e.target.value)) setError(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            onLeave()
          }}
        />
        <p className="qg-new__from" id={`${id}-from`} aria-live="polite">
          Starts {from}
        </p>
        {error && (
          <p className="q-error" id={`${id}-err`}>
            {error}
          </p>
        )}
      </div>
      <button type="submit" className="q-btn q-btn--primary" aria-disabled={busy} aria-busy={busy}>
        {busy ? 'Creating Branch…' : 'Create Branch and switch to it'}
      </button>
    </form>
  )
}
