import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { session } from '../../lib'
import { AccessCard } from './AccessCard'
import { describeError } from './errorMessages'
import { Field } from './Field'

type Errors = { email?: string; password?: string }

function checkEmail(v: string): string | undefined {
  if (!v.trim()) return 'Enter your email address.'
  if (!/^\S+@\S+$/.test(v.trim())) return 'Enter a valid email address.'
  return undefined
}
function checkPassword(v: string): string | undefined {
  return v ? undefined : 'Enter your password.'
}

/** `notice` explains why the person is here again (a Guest whose access ended). */
export function Login({ notice }: { notice?: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Clear a field's error as soon as the value is acceptable again.
  const edit = (field: keyof Errors, check: (v: string) => string | undefined, set: (v: string) => void) => (v: string) => {
    set(v)
    setFormError('')
    if (errors[field] && !check(v)) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const next: Errors = { email: checkEmail(email), password: checkPassword(password) }
    setErrors(next)
    if (next.email) return void emailRef.current?.focus()
    if (next.password) return void passwordRef.current?.focus()
    busyRef.current = true
    setBusy(true)
    setFormError('')
    try {
      await session.login(email.trim(), password)
    } catch (err) {
      setFormError(describeError(err))
      passwordRef.current?.focus()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <AccessCard title="Sign in to Sheaf" subtitle={window.location.host}>
      {notice && (
        <p className="q-access__notice" role="status">
          {notice}
        </p>
      )}
      <form className="q-access__form" onSubmit={submit} noValidate>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          inputRef={emailRef}
          error={errors.email}
          onChange={edit('email', checkEmail, setEmail)}
          onBlur={() => setErrors((x) => ({ ...x, email: checkEmail(email) }))}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          inputRef={passwordRef}
          error={errors.password}
          onChange={edit('password', checkPassword, setPassword)}
          onBlur={() => setErrors((x) => ({ ...x, password: checkPassword(password) }))}
        />
        <button type="submit" className="q-btn q-btn--primary q-btn--lg q-access__submit" aria-disabled={busy} aria-busy={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {formError && (
          <p className="q-error q-access__error" role="alert">
            {formError}
          </p>
        )}
      </form>
      <div className="q-access__foot">
        <p>Forgot your password? Ask your Admin.</p>
        <p>Got an invite? Open the link you were sent.</p>
      </div>
    </AccessCard>
  )
}
