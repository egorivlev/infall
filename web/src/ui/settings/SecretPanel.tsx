import { useEffect, useId, useRef } from 'react'
import { useCopy } from './useCopy'

/**
 * The secret of an access token that was just created. Shown once: it lives in the screen's state only
 * and is gone on "Done", when the screen is left, and on sign-out.
 */
export function SecretPanel({ name, secret, onDone }: { name: string; secret: string; onDone: () => void }) {
  const { state, copy } = useCopy()
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()

  // Land on the secret (selected, ready to copy) when it appears.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const onCopy = () => {
    inputRef.current?.select()
    void copy(secret)
  }

  return (
    <div className="q-secret" role="group" aria-label="New access token">
      <label className="q-label" htmlFor={id}>
        Access token “<span className="q-secret__name">{name}</span>”
      </label>
      <div className="q-secret__row">
        <input
          id={id}
          ref={inputRef}
          className="q-input q-mono"
          readOnly
          value={secret}
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="q-btn q-btn--lg q-btn--soft" onClick={onCopy}>
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="q-secret__done">
        <p className="q-hint" role="status">
          {state === 'failed'
            ? "Couldn't copy automatically. The access token is selected — copy it with your keyboard."
            : 'This is shown once. Store it in your AI app now.'}
        </p>
        <button type="button" className="q-btn q-btn--sm q-btn--soft" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}
