import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { invites } from '../../lib'
import type { Member } from '../../lib'
import { endOfLocalDay, formatShortDate, todayYmd } from './dates'
import { describeError } from './errorMessages'
import { Field } from './Field'
import { InviteResult } from './InviteResult'

type InviteRole = 'member' | 'guest'
type Errors = { email?: string; until?: string }

const ROLE_NOTE: Record<InviteRole, string> = {
  member: 'Full access: edit, Branch, Merge, To-dos and their own AI.',
  guest: 'Read-only Board and Pages on main. No editing, To-dos, AI or History.',
}

function checkEmail(v: string): string | undefined {
  if (!v.trim()) return 'Enter an email address.'
  return /^\S+@\S+$/.test(v.trim()) ? undefined : 'Enter a valid email address.'
}
function checkUntil(role: InviteRole, v: string): string | undefined {
  if (role !== 'guest') return undefined
  if (!v) return 'Choose the date their access ends.'
  const end = endOfLocalDay(v)
  if (end === null) return 'Enter a valid date.'
  return end > Date.now() ? undefined : 'Choose a date in the future.'
}

type Props = {
  onCreated: () => void
  /** M18: the unclaimed Member this invite is for: whoever accepts takes over that name and everything under it. */
  claim?: Member | null
  onClearClaim?: () => void
}

export function InviteForm({ onCreated, claim = null, onClearClaim }: Props) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('member')
  const [until, setUntil] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ url: string; email: string } | null>(null)
  const busyRef = useRef(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const untilRef = useRef<HTMLInputElement>(null)

  // Choosing a name to invite brings the keyboard to the email: the Admin types it (emails never travel in a file).
  const claimFor = claim?.id ?? null
  useEffect(() => {
    if (claimFor !== null) emailRef.current?.focus()
  }, [claimFor])

  const onEmail = (v: string) => {
    setEmail(v)
    setFormError('')
    if (errors.email && !checkEmail(v)) setErrors((e) => ({ ...e, email: undefined }))
  }
  const onUntil = (v: string) => {
    setUntil(v)
    // a picked date is either fine now or wrong in a new way: show the current verdict
    if (errors.until) setErrors((e) => ({ ...e, until: checkUntil(role, v) }))
  }
  const pickRole = (r: InviteRole) => {
    setRole(r)
    if (r === 'member') setErrors((e) => ({ ...e, until: undefined }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const next: Errors = { email: checkEmail(email), until: checkUntil(role, until) }
    setErrors(next)
    if (next.email) return void emailRef.current?.focus()
    if (next.until) return void untilRef.current?.focus()
    busyRef.current = true
    setBusy(true)
    setFormError('')
    setResult(null)
    try {
      const sent = email.trim()
      const base = role === 'guest' ? { email: sent, role, access_until: endOfLocalDay(until) ?? undefined } : { email: sent, role }
      const { url } = await invites.create(claim ? { ...base, claims: claim.id } : base)
      setResult({ url, email: sent })
      setEmail('')
      setUntil('')
      setErrors({})
      onCreated()
    } catch (err) {
      const msg = describeError(err)
      if ((err as { code?: unknown } | null)?.code === 'email_taken') {
        setErrors((x) => ({ ...x, email: msg }))
        emailRef.current?.focus()
      } else setFormError(msg)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const untilDate = endOfLocalDay(until)

  return (
    <section className="q-invite" aria-labelledby="q-invite-h">
      <div className="q-invite__head">
        <h2 className="q-panel-title" id="q-invite-h">
          {claim ? `Invite ${claim.name}` : 'Invite someone'}
        </h2>
        <span className="q-tag">Admin only</span>
      </div>
      {claim && (
        <p className="q-invite__claim">
          <span>Whoever accepts takes over the name {claim.name} — their Changes, Checkpoints, To-dos and Comments.</span>
          <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={() => onClearClaim?.()}>
            Invite someone new instead
          </button>
        </p>
      )}
      <form className="q-access__form" onSubmit={submit} noValidate>
        <Field
          label="Email"
          name="invite-email"
          type="email"
          autoComplete="off"
          value={email}
          inputRef={emailRef}
          error={errors.email}
          onChange={onEmail}
          onBlur={() => setErrors((x) => ({ ...x, email: checkEmail(email) }))}
        />
        <fieldset className="q-roles">
          <legend className="q-label">Role</legend>
          <div className="q-roles__seg">
            {(['member', 'guest'] as const).map((r) => (
              <label key={r} className="q-roles__opt">
                <input type="radio" name="invite-role" value={r} checked={role === r} onChange={() => pickRole(r)} />
                <span>{r === 'member' ? 'Member' : 'Guest'}</span>
              </label>
            ))}
          </div>
          <p className="q-hint">{ROLE_NOTE[role]}</p>
        </fieldset>
        {role === 'guest' && (
          <Field
            label="Access until"
            name="access-until"
            type="date"
            min={todayYmd()}
            mono
            value={until}
            inputRef={untilRef}
            error={errors.until}
            hint={untilDate ? `Shown to them as “Guest — access until ${formatShortDate(untilDate)}”. Access ends automatically.` : 'Access ends automatically on this date.'}
            onChange={onUntil}
            onBlur={() => setErrors((x) => ({ ...x, until: checkUntil(role, until) }))}
          />
        )}
        <button type="submit" className="q-btn q-btn--primary q-btn--lg q-access__submit" aria-disabled={busy} aria-busy={busy}>
          {busy ? 'Creating invite…' : claim ? `Create invite for ${claim.name}` : 'Create invite'}
        </button>
        {formError && (
          <p className="q-error" role="alert">
            {formError}
          </p>
        )}
      </form>
      {result && <InviteResult url={result.url} email={result.email} />}
    </section>
  )
}
