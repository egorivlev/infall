import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { invites, session } from '../../lib'
import type { Role } from '../../lib'
import { AccessCard } from './AccessCard'
import { formatShortDate } from './dates'
import { describeError, describeLookupError, INVALID_INVITE, isInviteGone } from './errorMessages'
import { Field } from './Field'
import { useDelayedFlag } from './useDelayedFlag'

type Lookup =
  | { status: 'loading' }
  | { status: 'invalid' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; email: string; role: Role; accessUntil?: number }

// api.md §13: the lookup of a Guest invite also says until when. Optional here until the data layer's type has it.
type InviteLookup = { email: string; role: Role; access_until?: number }

const ROLE_WORD: Record<Role, string> = { admin: 'an Admin', member: 'a Member', guest: 'a Guest' }
const PASSWORD_RULE = 'At least 12 characters'

type Errors = { name?: string; password?: string }
const checkName = (v: string) => (v.trim() ? undefined : 'Enter your name.')
const checkPassword = (v: string) => (v.length >= 12 ? undefined : 'Use at least 12 characters.')

export function AcceptInvite({ token }: { token: string }) {
  const [lookup, setLookup] = useState<Lookup>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    invites
      .lookup(token)
      .then((r: InviteLookup) => !cancelled && setLookup({ status: 'ready', email: r.email, role: r.role, accessUntil: r.access_until }))
      .catch((e: unknown) => {
        if (cancelled) return
        setLookup(isInviteGone(e) ? { status: 'invalid' } : { status: 'failed', message: describeLookupError(e) })
      })
    return () => {
      cancelled = true
    }
  }, [token, attempt])

  const showWait = useDelayedFlag(lookup.status === 'loading', 150)

  if (lookup.status === 'loading') {
    return showWait ? (
      <AccessCard>
        <p className="q-hint" role="status">
          Checking your invite…
        </p>
      </AccessCard>
    ) : null
  }
  if (lookup.status === 'invalid') {
    return (
      <AccessCard>
        <p className="q-access__message" role="alert">
          {INVALID_INVITE}
        </p>
      </AccessCard>
    )
  }
  if (lookup.status === 'failed') {
    return (
      <AccessCard>
        <p className="q-access__message" role="alert">
          {lookup.message}
        </p>
        <button type="button" className="q-btn q-btn--lg" onClick={() => {
            setLookup({ status: 'loading' })
            setAttempt((n) => n + 1)
          }}>
          Try again
        </button>
      </AccessCard>
    )
  }
  return (
    <InviteForm
      token={token}
      email={lookup.email}
      role={lookup.role}
      accessUntil={lookup.accessUntil}
      onGone={() => setLookup({ status: 'invalid' })}
    />
  )
}

type FormProps = { token: string; email: string; role: Role; accessUntil?: number; onGone: () => void }

function InviteForm({ token, email, role, accessUntil, onGone }: FormProps) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const edit = (field: keyof Errors, check: (v: string) => string | undefined, set: (v: string) => void) => (v: string) => {
    set(v)
    setFormError('')
    if (errors[field] && !check(v)) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const next: Errors = { name: checkName(name), password: checkPassword(password) }
    setErrors(next)
    if (next.name) return void nameRef.current?.focus()
    if (next.password) return void passwordRef.current?.focus()
    busyRef.current = true
    setBusy(true)
    setFormError('')
    try {
      await session.acceptInvite(token, name.trim(), password)
    } catch (err) {
      if (isInviteGone(err)) onGone()
      else setFormError(describeError(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <AccessCard title={`You're invited as ${ROLE_WORD[role]}`} subtitle={email}>
      {role === 'guest' && (
        <p className="q-access__lead">
          {accessUntil != null ? `Read-only access to the team's Board until ${formatShortDate(accessUntil)}.` : "Read-only access to the team's Board."}
        </p>
      )}
      <form className="q-access__form" onSubmit={submit} noValidate>
        <Field
          label="Name"
          name="name"
          autoComplete="name"
          value={name}
          inputRef={nameRef}
          error={errors.name}
          onChange={edit('name', checkName, setName)}
          onBlur={() => setErrors((x) => ({ ...x, name: checkName(name) }))}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint={PASSWORD_RULE}
          value={password}
          inputRef={passwordRef}
          error={errors.password}
          onChange={edit('password', checkPassword, setPassword)}
          onBlur={() => setErrors((x) => ({ ...x, password: checkPassword(password) }))}
        />
        <button type="submit" className="q-btn q-btn--primary q-btn--lg q-access__submit" aria-disabled={busy} aria-busy={busy}>
          {busy ? 'Joining…' : 'Join Infall'}
        </button>
        {formError && (
          <p className="q-error q-access__error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </AccessCard>
  )
}
