import { useEffect, useRef, useState } from 'react'

type Copy = 'idle' | 'copied' | 'failed'

/** The one-time invite link. Shown once: it is gone when the next invite is sent or the screen is left. */
export function InviteResult({ url, email }: { url: string; email: string }) {
  const [copy, setCopy] = useState<Copy>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copyUrl() {
    inputRef.current?.select()
    try {
      await navigator.clipboard.writeText(url)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopy('idle'), 2500)
  }

  return (
    <div className="q-result" role="group" aria-label="Invite link">
      <label className="q-label" htmlFor="q-invite-url">
        Invite link for {email}
      </label>
      <div className="q-result__row">
        <input id="q-invite-url" ref={inputRef} className="q-input q-mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="q-btn" onClick={copyUrl}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="q-hint" role="status">
        {copy === 'failed' ? "Couldn't copy automatically. The link is selected — copy it with your keyboard." : 'This is shown once. It expires in 7 days.'}
      </p>
    </div>
  )
}
