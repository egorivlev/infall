import { useId } from 'react'
import type { Ref } from 'react'

type Props = {
  label: string
  name: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  type?: string
  autoComplete?: string
  hint?: string
  error?: string
  min?: string
  mono?: boolean
  disabled?: boolean
  inputRef?: Ref<HTMLInputElement>
}

/** Visible label, input, optional hint (always shown), then the error. */
export function Field({ label, name, value, onChange, onBlur, type = 'text', autoComplete, hint, error, min, mono, disabled, inputRef }: Props) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const described = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className="q-field">
      <label className="q-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        className={`q-input${error ? ' q-input--invalid' : ''}${mono ? ' q-mono' : ''}`}
        name={name}
        type={type}
        value={value}
        min={min}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        spellCheck={false}
      />
      {hint && (
        <p className="q-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="q-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  )
}
