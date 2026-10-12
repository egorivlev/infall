import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { VisualResult } from '../BlockTools'
import { indentSelection } from './indent'

type Props = {
  /** 1-based place in the Page, for labels. */
  n: number
  title: string
  code: string
  onFinish: (result: VisualResult) => void
}

/**
 * The editor of a Run: its name and its code. Both fields are uncontrolled, so typing re-renders
 * nothing and remote updates never overwrite the draft. Nothing is submitted until "Done"
 * (⌘/Ctrl+Enter); leaving a field does not finish. Esc discards the draft. The captured output is
 * not touched: after a change of code its record line reads "code changed since".
 */
export function RunEditor({ n, title, code, onFinish }: Props) {
  const [initial] = useState({ title, code }) // what the editor opened with: only real changes are reported
  const nameRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)
  const nameId = useId()
  const codeId = useId()
  const hintId = useId()

  useLayoutEffect(() => {
    // StrictMode runs this twice (mount, simulated unmount, mount): the cleanup's "finished" must
    // be undone by the second run, or Done and Cancel would never work. Same pattern as DraftArea.
    finished.current = false
    nameRef.current?.focus({ preventScroll: true })
    return () => {
      finished.current = true
    }
  }, [])

  const finish = (commit: boolean, keyboard: boolean) => {
    if (finished.current) return
    finished.current = true
    const result: VisualResult = { commit, keyboard }
    const nextTitle = (nameRef.current?.value ?? initial.title).replace(/\s+/g, ' ').trim()
    const nextCode = codeRef.current?.value ?? initial.code
    if (nextTitle !== initial.title) result.title = nextTitle
    if (nextCode !== initial.code) result.source = nextCode
    onFinish(result)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // the panel's own Esc must not see it
      finish(false, true)
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      finish(true, true)
    }
  }
  const onCodeKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    indentSelection(e.currentTarget, e.shiftKey)
  }

  return (
    <div className="qp-run-edit" role="group" aria-label={`Block ${n}, Run editor`} onKeyDown={onKeyDown}>
      <div className="q-field">
        <label className="q-label" htmlFor={nameId}>
          Name
        </label>
        <input ref={nameRef} id={nameId} className="q-input qp-run-edit__name" type="text" defaultValue={title} placeholder="Untitled Run" maxLength={200} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      <div className="q-field">
        <label className="q-label" htmlFor={codeId}>
          Code
        </label>
        <textarea
          ref={codeRef}
          id={codeId}
          className="qp-run-edit__code"
          defaultValue={code}
          rows={14}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-describedby={hintId}
          onKeyDown={onCodeKeyDown}
        />
      </div>
      <div className="qp-run-edit__hints" id={hintId}>
        <p className="qp-block__hint">
          Python. Runs on the computer of whoever presses Run, in the desktop app, after they have seen the code. Figures drawn with matplotlib are captured.
        </p>
        <p className="qp-block__hint">Tab indents · ⇧Tab takes it back · ⌘Enter to finish · Esc to cancel</p>
      </div>
      <div className="qp-run-edit__buttons">
        <span className="qp-spacer" />
        <button type="button" className="q-btn q-btn--sm" title="Discard the draft (Esc)" onClick={() => finish(false, false)}>
          Cancel
        </button>
        <button type="button" className="q-btn q-btn--sm q-btn--primary" title="Finish (⌘Enter)" onClick={() => finish(true, false)}>
          Done
        </button>
      </div>
    </div>
  )
}
