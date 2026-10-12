import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { ai } from '../../lib'
import { CrossIcon } from './icons'
import { sidebarState, useSidebarState } from './state'
import type { Scope } from './useScope'
import { scopeLabel, sendError, titleOf } from './words'

type Props = {
  scope: Scope
  busy: boolean
  /** False when no AI is set up: the composer is shown, but nothing can be asked. */
  ready: boolean
}

/** Asks about what the Member is looking at. The draft lives outside the component, so it survives closing the sidebar. */
export function Composer({ scope, busy, ready }: Props) {
  const id = useId()
  const draft = useSidebarState((s) => s.draft)
  const area = useRef<HTMLTextAreaElement>(null)
  const stop = useRef<HTMLButtonElement>(null)
  const error = useSidebarState((s) => s.error)
  const about = scopeLabel({ branchName: scope.branchName, card: scope.card ?? undefined })

  // Opening the sidebar puts the caret in the composer.
  useEffect(() => {
    area.current?.focus({ preventScroll: true })
  }, [])

  // A disabled field drops focus: hand it to "Stop" while the answer is written, and take it back afterwards.
  const handBack = useRef(false)
  useEffect(() => {
    if (busy) {
      if (handBack.current) stop.current?.focus({ preventScroll: true })
      return
    }
    const lost = document.activeElement === null || document.activeElement === document.body
    if (handBack.current && lost) area.current?.focus({ preventScroll: true })
    handBack.current = false
  }, [busy])

  const send = () => {
    const text = draft.trim()
    if (text === '' || busy || !ready || scope.scope === null) return
    sidebarState.setError('')
    handBack.current = document.activeElement === area.current
    sidebarState.setDraft('')
    Promise.resolve(ai.send(text, scope.scope)).catch((e: unknown) => {
      // It never started: the words go back into the composer unless the Member has typed something since.
      if (useSidebarState.getState().draft === '') sidebarState.setDraft(text)
      handBack.current = false
      sidebarState.setError(sendError(e))
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; an Enter that confirms an IME composition is neither.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    send()
  }

  return (
    <div className={`qa-composer${ready ? '' : ' is-off'}`}>
      <div className="qa-composer__scope">
        {scope.card ? (
          <>
            <span className="qa-chip qa-chip--card">
              <span className="qa-chip__kind">Card:</span>
              <span className="qa-chip__name">{titleOf(scope.card)}</span>
              <button
                type="button"
                className="qa-chip__x"
                aria-label="Ask about the whole Board instead"
                title="Ask about the whole Board instead"
                onClick={() => {
                  if (scope.card) sidebarState.dismiss(scope.card.id)
                  area.current?.focus({ preventScroll: true })
                }}
              >
                <CrossIcon />
              </button>
            </span>
            <span className="qa-composer__note">follows your selection</span>
          </>
        ) : (
          <>
            <span className="qa-chip">
              <span className="qa-chip__kind">Board:</span>
              <span className="qa-chip__name">{scope.branchName}</span>
            </span>
            {scope.boardByChoice && <span className="qa-composer__note">until your selection changes</span>}
          </>
        )}
      </div>
      <label htmlFor={id} className="q-sr">
        Ask the AI
      </label>
      <div className="qa-field">
        <textarea
          id={id}
          ref={area}
          className="qa-field__input"
          rows={2}
          value={draft}
          placeholder={ready ? `Ask about ${about}…` : `Set up AI to ask about ${about}`}
          disabled={!ready || busy}
          aria-describedby={ready && !busy ? `${id}-hint` : undefined}
          onChange={(e) => {
            sidebarState.setDraft(e.target.value)
            if (error) sidebarState.setError('')
          }}
          onKeyDown={onKeyDown}
        />
        {ready && (
          <div className="qa-field__foot">
            {busy ? (
              <button ref={stop} type="button" className="q-btn q-btn--sm" onClick={() => ai.stop()}>
                Stop
              </button>
            ) : (
              <span id={`${id}-hint`} className="qa-field__hint">
                <span aria-hidden="true">⏎ send · ⇧⏎ new line</span>
                <span className="q-sr">Enter sends. Shift and Enter make a new line.</span>
              </span>
            )}
          </div>
        )}
      </div>
      <p className="qa-composer__error" role="alert">
        {error}
      </p>
    </div>
  )
}
