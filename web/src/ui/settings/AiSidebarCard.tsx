import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ai, useAi } from '../../lib'
import type { AiSetup } from '../../lib'
import { ConfirmRow } from '../kit'
import { formatShortDate } from '../shell/dates'
import { errorStatus } from '../shell/errorMessages'
import { describeKeyError, describeRemoveError, KEY_REQUIRED, SERVER_OFF } from './aiErrors'
import { ModelPicker } from './ModelPicker'

type StoredKey = { last4: string; added_at: number }
/** What the card shows. Every shape of `AiSetup` says whether this is the desktop app and what is known about OpenRouter. */
type View = {
  desktop: boolean
  claude: { found: boolean; version?: string }
  openrouter: { enabled: boolean; key: StoredKey | null; model: string }
}

const isLoading = (s: AiSetup) => s.provider === 'none' && s.reason === 'loading'

function toView(s: AiSetup): View | null {
  if (s.provider === 'none' && (s.reason === 'loading' || s.reason === 'guest')) return null
  const { enabled, key, model } = s.openrouter
  return {
    desktop: s.desktop,
    claude: s.provider === 'claude-code' ? { found: true, version: s.version } : { found: false },
    openrouter: { enabled, key: key ?? null, model: model ?? '' },
  }
}

/**
 * The key field. The typed key lives in this component's state only while it is being typed: it is
 * taken out of the state before the request starts, so it is gone whether the request succeeds or fails,
 * and it is never written to storage, the URL or the console.
 */
function KeyForm({ replacing, onStored, onCancel }: { replacing: boolean; onStored: () => void; onCancel?: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const errorId = `${id}-error`

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // "Replace" opened the field: land in it.
  useEffect(() => {
    if (replacing) inputRef.current?.focus()
  }, [replacing])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const key = value.trim()
    setValue('')
    if (!key) {
      setError(KEY_REQUIRED)
      return void inputRef.current?.focus()
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await ai.setKey(key)
      if (alive.current) onStored()
    } catch (err) {
      if (!alive.current) return
      setError(describeKeyError(err))
      inputRef.current?.focus()
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  const verb = replacing ? 'Replace key' : 'Add key'
  return (
    <form className="q-ai__keyform" onSubmit={submit} noValidate>
      <div className="q-field">
        <label className="q-label" htmlFor={id}>
          {replacing ? 'New OpenRouter key' : 'OpenRouter key'}
        </label>
        <input
          id={id}
          ref={inputRef}
          className={`q-input q-mono${error ? ' q-input--invalid' : ''}`}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError('')
          }}
        />
        {error && (
          <p className="q-error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="q-ai__keybuttons">
        <button type="submit" className="q-btn q-btn--soft q-settings__submit" aria-disabled={busy} aria-busy={busy}>
          {busy ? (replacing ? 'Replacing key…' : 'Adding key…') : verb}
        </button>
        {onCancel && (
          <button type="button" className="q-btn q-btn--ghost q-settings__submit q-ai__cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * "AI sidebar": what answers in the sidebar on this device, and the Member's own OpenRouter key and model.
 * `ai.setKey` / `removeKey` / `setModel` update `useAi().setup` themselves; the card only reads it.
 * Rendered for Members only (the route sends Guests away).
 */
export function AiSidebarCard() {
  const live = useAi().setup
  // While the setup is being read again the card keeps showing what it knew, so an open form is not torn down.
  const [settled, setSettled] = useState(live)
  if (live !== settled && !isLoading(live)) setSettled(live)
  const setup = isLoading(live) ? settled : live
  const view = toView(setup)

  const [replacing, setReplacing] = useState(false)
  const [note, setNote] = useState('')
  const [checking, setChecking] = useState(false)
  // M17 (B3): Remove asks inside the key's row; `asking` is that question being shown.
  const [asking, setAsking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const busyRef = useRef(false)
  const alive = useRef(true)
  const refocus = useRef<'heading' | 'remove' | false>(false)
  const removeRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // After a key was stored or removed the control that had focus is gone: go to the section's heading.
  useEffect(() => {
    if (!refocus.current || asking) return
    const to = refocus.current
    refocus.current = false
    if (to === 'remove') removeRef.current?.focus()
    else headingRef.current?.focus()
  })

  async function checkAgain() {
    if (busyRef.current) return
    busyRef.current = true
    setChecking(true)
    // Never throws by contract; the catch keeps the button usable even if it did.
    await Promise.resolve()
      .then(() => ai.refresh())
      .catch(() => {})
    busyRef.current = false
    if (alive.current) setChecking(false)
  }

  const stored = () => {
    setNote(replacing ? 'Key replaced.' : 'Key added.')
    setReplacing(false)
    refocus.current = 'heading'
  }

  async function confirmRemove() {
    if (busyRef.current) return
    busyRef.current = true
    setRemoving(true)
    setRemoveError('')
    try {
      try {
        await ai.removeKey()
      } catch (err) {
        if (errorStatus(err) !== 404) throw err // already removed elsewhere: the same outcome
      }
      if (!alive.current) return
      setNote('Key removed.')
      setReplacing(false)
      refocus.current = 'heading'
      setAsking(false)
    } catch (err) {
      if (alive.current) setRemoveError(describeRemoveError(err))
    } finally {
      busyRef.current = false
      if (alive.current) setRemoving(false)
    }
  }

  const or = view?.openrouter ?? null
  const host = window.location.host

  return (
    <section className="q-settings__card q-ai" aria-labelledby="q-aiside-h">
      <h2 className="q-subtitle" id="q-aiside-h">
        AI sidebar
      </h2>

      {!view && (
        <p className="q-hint" role="status">
          Checking how AI is set up…
        </p>
      )}

      {view?.desktop && (
        <>
          <p className="q-settings__text">
            This app runs the sidebar on your own Claude subscription through Claude Code. There is nothing to set here.
          </p>
          <div className="q-ai__status">
            <p className={`q-ai__found${view.claude.found ? ' is-found' : ''}`} role="status">
              <span aria-hidden="true">{view.claude.found ? '✓' : '○'}</span>{' '}
              {view.claude.found ? (
                <>
                  Claude Code{view.claude.version ? <span className="q-mono"> {view.claude.version}</span> : null} found
                </>
              ) : (
                'Claude Code not found on this computer'
              )}
            </p>
            {!view.claude.found && (
              <button type="button" className="q-btn q-btn--sm q-btn--soft" aria-disabled={checking} aria-busy={checking} onClick={() => void checkAgain()}>
                {checking ? 'Checking…' : 'Check again'}
              </button>
            )}
          </div>
        </>
      )}
      {view && !view.desktop && (
        <p className="q-settings__text">
          In the desktop app the sidebar runs on your own Claude subscription. In the browser it needs an OpenRouter key.
        </p>
      )}

      {or && (
        <div className="q-ai__or">
          <h3 className="q-ai__sub" ref={headingRef} tabIndex={-1}>
            OpenRouter <span className="q-ai__optional">(optional)</span>
          </h3>
          {!or.enabled ? (
            <p className="q-settings__text">{SERVER_OFF}</p>
          ) : (
            <>
              {or.key && asking && (
                <ConfirmRow
                  question="Remove your OpenRouter key?"
                  detail={`The key is deleted from ${host}. In the browser the AI sidebar stops answering until you add a key again.`}
                  confirmLabel="Remove"
                  busyLabel="Removing…"
                  busy={removing}
                  error={removeError}
                  onConfirm={() => void confirmRemove()}
                  onKeep={() => {
                    refocus.current = 'remove'
                    setAsking(false)
                  }}
                />
              )}
              {or.key && !asking && (
                <div className="q-ai__keyrow">
                  <span className="q-ai__keylabel">Key</span>
                  <span className="q-ai__mask">
                    <span aria-hidden="true">••••</span>
                    <span className="q-sr">Key ending in </span>
                    <span className="q-mono">{or.key.last4}</span> · added {formatShortDate(or.key.added_at)}
                  </span>
                  {!replacing && (
                    <button
                      type="button"
                      className="q-btn q-btn--sm q-btn--soft"
                      aria-label="Replace OpenRouter key"
                      onClick={() => {
                        setNote('')
                        setReplacing(true)
                      }}
                    >
                      Replace
                    </button>
                  )}
                  <button
                    type="button"
                    ref={removeRef}
                    className="q-btn q-btn--sm q-btn--ghost q-btn--danger"
                    aria-label="Remove OpenRouter key"
                    onClick={() => {
                      setRemoveError('')
                      setNote('')
                      setAsking(true)
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
              {(!or.key || replacing) && (
                <KeyForm key={replacing ? 'replace' : 'add'} replacing={replacing} onStored={stored} onCancel={replacing ? () => setReplacing(false) : undefined} />
              )}
              <p className="q-hint q-settings__status" role="status">
                {note}
              </p>
              {or.key && <ModelPicker current={or.model} />}
              <p className="q-hint q-ai__small">
                Your key is stored encrypted on <span className="q-ai__host">{host}</span> and is never shown again. The server sends your
                question, and what the AI reads through Infall's tools, to OpenRouter. Conversations are kept only on this device.
              </p>
            </>
          )}
        </div>
      )}

    </section>
  )
}
