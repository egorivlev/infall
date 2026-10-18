import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { tokens as tokenApi, toolEndpoint } from '../../lib'
import type { AccessToken } from '../../lib'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { describeError, errorStatus } from '../shell/errorMessages'
import { Field } from '../shell/Field'
import { useDelayedFlag } from '../shell/useDelayedFlag'
import { AiSidebarCard } from './AiSidebarCard'
import { ConnectCommand } from './ConnectCommand'
import { SecretPanel } from './SecretPanel'
import { checkName, describeCreateError, LIMIT_REACHED, NAME_MAX, TOKEN_LIMIT } from './tokenErrors'
import { TokenTable } from './TokenTable'
import './settings.css'

type Shown = { id: string; name: string; secret: string }

const newestFirst = (a: AccessToken, b: AccessToken) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)

/**
 * AI access: the signed-in Member's own access tokens and how to connect an AI with one.
 * The secret of a new token is held in this component's state and nowhere else — not in storage,
 * the URL or the console — so it is gone on "Done", on leaving the screen and on sign-out (both unmount it).
 */
export function AiAccess() {
  const [list, setList] = useState<AccessToken[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)
  const [target, setTarget] = useState<{ token: AccessToken; opener: HTMLElement } | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState('')
  const busyRef = useRef(false)
  const revokeBusyRef = useRef(false)
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const refocus = useRef<'heading' | 'name' | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const tokensHeadingRef = useRef<HTMLHeadingElement>(null)

  // Only the newest request may answer; an answer that arrives after the screen is left is dropped.
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    return Promise.resolve()
      .then(() => tokenApi.list())
      .then(
        (found) => {
          if (seq !== loadSeq.current || !alive.current) return
          setList([...found].sort(newestFirst))
          setLoadError('')
        },
        (e: unknown) => {
          if (seq !== loadSeq.current || !alive.current) return
          setLoadError(describeError(e))
        },
      )
  }, [])

  useEffect(() => {
    alive.current = true // StrictMode mounts twice: the second run must be allowed to answer
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // After "Done" or a revoke the control that had focus is gone; put focus somewhere sensible.
  useEffect(() => {
    const to = refocus.current
    if (!to || shown || target) return
    refocus.current = null
    if (to === 'name') nameRef.current?.focus()
    else tokensHeadingRef.current?.focus()
  }, [shown, target])

  const loading = useDelayedFlag(list === null && !loadError, 150)
  const atLimit = list !== null && list.length >= TOKEN_LIMIT
  const endpoint = toolEndpoint()

  const onName = (v: string) => {
    setName(v)
    setFormError('')
    if (nameError && !checkName(v)) setNameError('')
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current || atLimit) return
    const problem = checkName(name)
    setNameError(problem)
    if (problem) return void nameRef.current?.focus()
    busyRef.current = true
    setCreating(true)
    setFormError('')
    try {
      const { token, secret } = await tokenApi.create(name.trim())
      if (!alive.current) return // the screen was left meanwhile: the secret is not kept anywhere
      setShown({ id: token.id, name: token.name, secret })
      setList((old) => [token, ...(old ?? []).filter((t) => t.id !== token.id)].sort(newestFirst))
      setName('')
    } catch (err) {
      if (!alive.current) return
      const failure = describeCreateError(err)
      let limit = failure.kind === 'limit'
      if (failure.kind === 'refused') {
        // Tokens made elsewhere (another tab or device) may have filled the list since it was loaded.
        const fresh = await Promise.resolve()
          .then(() => tokenApi.list())
          .catch(() => null)
        if (!alive.current) return
        if (fresh) {
          loadSeq.current++ // an older answer must not put the stale list back
          setList([...fresh].sort(newestFirst))
          setLoadError('')
          limit = fresh.length >= TOKEN_LIMIT
        }
      }
      if (limit) setFormError(LIMIT_REACHED)
      else if (failure.kind === 'refused') {
        setNameError(failure.message)
        nameRef.current?.focus()
      } else setFormError(failure.message)
    } finally {
      busyRef.current = false
      if (alive.current) setCreating(false)
    }
  }

  const done = () => {
    refocus.current = 'name'
    setShown(null)
  }

  async function confirmRevoke() {
    if (!target || revokeBusyRef.current) return
    const { id } = target.token
    revokeBusyRef.current = true
    setRevoking(true)
    setRevokeError('')
    try {
      try {
        await tokenApi.remove(id)
      } catch (err) {
        if (errorStatus(err) !== 404) throw err // already revoked elsewhere: the same outcome
      }
      if (!alive.current) return
      setList((old) => old?.filter((t) => t.id !== id) ?? old)
      setShown((s) => (s?.id === id ? null : s)) // a revoked token's secret is of no use: stop showing it
      setFormError('')
      refocus.current = 'heading'
      setTarget(null)
    } catch (err) {
      if (alive.current) setRevokeError(describeError(err))
    } finally {
      revokeBusyRef.current = false
      if (alive.current) setRevoking(false)
    }
  }

  return (
    <div className="q-settings">
      <div className="q-settings__inner">
        <header className="q-settings__head">
          <h1 className="q-settings__title">AI access</h1>
          <p className="q-settings__text">
            Infall doesn't ship a model. Connect the AI you already use — it can read this team's Research Content and propose Sources and
            Connections as Suggestions. It cannot change anything by itself.
          </p>
          <p className="q-settings__text">
            An access token lets an AI act as you, read-only plus Suggestions. Treat it like a password; anyone holding it can read
            everything you can.
          </p>
        </header>

        <AiSidebarCard />

        <section className="q-settings__card" aria-labelledby="q-tokens-h">
          <div className="q-settings__cardhead">
            <h2 className="q-panel-title" id="q-tokens-h" ref={tokensHeadingRef} tabIndex={-1}>
              Access tokens
            </h2>
            {list !== null && (
              <span className="q-mono q-hint">
                {list.length} of {TOKEN_LIMIT}
              </span>
            )}
          </div>

          {loading && (
            <p className="q-hint q-settings__status" role="status">
              Loading access tokens…
            </p>
          )}
          {loadError && (
            <div className="q-settings__retry">
              <p className="q-error" role="alert">
                {loadError}
              </p>
              <button type="button" className="q-btn q-btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          )}
          {list !== null && list.length === 0 && <p className="q-hint q-settings__status">No access tokens yet.</p>}
          {list !== null && list.length > 0 && (
            <TokenTable
              tokens={list}
              onRevoke={(token, opener) => {
                setRevokeError('')
                setTarget({ token, opener })
              }}
            />
          )}

          <form className="q-settings__form" onSubmit={create} noValidate>
            <Field
              label="Name"
              name="token-name"
              autoComplete="off"
              placeholder="e.g. Claude Code on my laptop"
              maxLength={NAME_MAX}
              value={name}
              inputRef={nameRef}
              error={nameError}
              onChange={onName}
            />
            <button type="submit" className="q-btn q-btn--primary q-settings__submit" disabled={atLimit} aria-disabled={creating} aria-busy={creating}>
              {creating ? 'Creating access token…' : 'Create access token'}
            </button>
          </form>
          {atLimit && formError !== LIMIT_REACHED && <p className="q-hint q-settings__status">{LIMIT_REACHED}</p>}
          {formError && (
            <p className="q-error" role="alert">
              {formError}
            </p>
          )}

          {shown && <SecretPanel key={shown.id} name={shown.name} secret={shown.secret} onDone={done} />}
        </section>

        <ConnectCommand endpoint={endpoint} secret={shown?.secret ?? null} />

        <section className="q-settings__card" aria-labelledby="q-can-h">
          <h2 className="q-panel-title" id="q-can-h">
            What the AI can do
          </h2>
          <ul className="q-settings__list">
            <li>Read Cards, Pages, Sources and Connections on any Branch</li>
            <li>Propose a Source for a Card</li>
            <li>Propose a Connection between two Cards</li>
            <li className="q-settings__not">Not: change, delete, or accept anything</li>
          </ul>
        </section>

        <p className="q-hint q-settings__note">
          Text on the Board was written by people and other AIs. A careful AI treats it as content, not as instructions.
        </p>
      </div>

      {target && (
        <ConfirmDialog
          title={`Revoke “${target.token.name}”?`}
          body="Any AI using this access token loses access immediately. This cannot be undone — create a new access token to connect it again."
          confirmLabel="Revoke"
          busyLabel="Revoking…"
          busy={revoking}
          error={revokeError}
          opener={target.opener}
          onConfirm={confirmRevoke}
          onCancel={() => setTarget(null)}
        />
      )}
    </div>
  )
}
