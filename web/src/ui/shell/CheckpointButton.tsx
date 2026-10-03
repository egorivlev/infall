import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { history as boardHistory } from '../../lib'
import { describeError, errorCode } from './errorMessages'
import { Icon } from './Icon'
import { useDismiss } from './useDismiss'

const MAX = 80
const NAME_TAKEN = 'This Branch already has a Checkpoint with that name.'

/** Names the present moment of the open Branch so it can be found again. */
export function CheckpointButton() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(false)
  const busyRef = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, boxRef, triggerRef)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // "◆ Created" for two seconds, then the usual label again.
  useEffect(() => {
    if (!created) return
    const t = window.setTimeout(() => setCreated(false), 2000)
    return () => window.clearTimeout(t)
  }, [created])

  const toggle = () => {
    setError('')
    setOpen((o) => !o)
  }
  const cancel = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const wanted = name.trim()
    if (!wanted) {
      setError('Give the Checkpoint a name.')
      inputRef.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await boardHistory.createCheckpoint(wanted)
      setName('')
      setOpen(false)
      setCreated(true)
      triggerRef.current?.focus()
    } catch (err) {
      setError(errorCode(err) === 'name_taken' ? NAME_TAKEN : describeError(err))
      inputRef.current?.focus()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="q-cp" ref={boxRef}>
      <button
        type="button"
        ref={triggerRef}
        className="q-btn q-topbtn"
        title="Name this moment of the Branch"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
      >
        {!created && <Icon name="checkpoint" size={12} />}
        <span aria-live="polite">{created ? '◆ Created' : 'Checkpoint'}</span>
      </button>
      {open && (
        <form className="q-pop q-cp__pop" id={id} role="dialog" aria-label="Create Checkpoint" onSubmit={submit} noValidate>
          <div className="q-field">
            <label className="q-label" htmlFor={`${id}-name`}>
              Checkpoint name
            </label>
            <input
              id={`${id}-name`}
              ref={inputRef}
              className={`q-input${error ? ' q-input--invalid' : ''}`}
              name="checkpoint-name"
              type="text"
              placeholder="e.g. Before decoder rewrite"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX}
              value={name}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
            />
            {error && (
              <p className="q-error q-cp__error" id={`${id}-error`} role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="q-cp__actions">
            <button type="button" className="q-btn" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="q-btn q-btn--primary" aria-disabled={busy} aria-busy={busy}>
              {busy ? 'Creating…' : 'Create Checkpoint'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
