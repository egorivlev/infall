import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { isEnvName, isLangId, KNOWN_LANGUAGES, PYTHON, takesEnv } from '../../../lib'
import type { VisualResult } from '../BlockTools'
import { editorHint } from './format'
import { indentSelection } from './indent'

type Props = {
  /** 1-based place in the Page, for labels. */
  n: number
  title: string
  code: string
  /** The language id as stored ('' is Python). */
  lang: string
  /** The environment the Run asks for as stored ('' none). */
  env: string
  /** The environments this device's Runner knows by name: offered, never required. */
  environments: readonly string[]
  onFinish: (result: VisualResult) => void
}

const OTHER = 'other'
export const LANG_ID_ERROR = 'A language id is 1–24 characters: a lowercase letter, then lowercase letters, digits, - or _.'
export const ENV_NAME_ERROR = 'An environment name is one line of at most 60 characters, without invisible characters.'

/**
 * The editor of a Run: its name, its language, the environment it asks for (Python and Q#), and its code. The name
 * and the code are uncontrolled, so typing re-renders nothing and remote updates never overwrite the draft. Nothing
 * is submitted until "Done" (⌘/Ctrl+Enter); leaving a field does not finish. Esc discards the draft. The captured
 * output is not touched: after a change its record line says the result is of other code.
 */
export function RunEditor({ n, title, code, lang, env, environments, onFinish }: Props) {
  const startLang = lang === '' ? PYTHON : lang
  const known = KNOWN_LANGUAGES.some((l) => l.id === startLang)
  const [initial] = useState({ title, code, lang: startLang, env })
  const [choice, setChoice] = useState(known ? startLang : OTHER)
  const [otherText, setOtherText] = useState(known ? '' : startLang)
  const [envText, setEnvText] = useState(env)
  const [errors, setErrors] = useState<{ lang?: string; env?: string }>({})
  const nameRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLTextAreaElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const envRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  const nameId = useId()
  const codeId = useId()
  const hintId = useId()
  const langId = useId()
  const otherFieldId = useId()
  const otherErrId = useId()
  const envId = useId()
  const envHintId = useId()
  const envErrId = useId()
  const listId = useId()

  useLayoutEffect(() => {
    // StrictMode runs this twice (mount, simulated unmount, mount): the cleanup's "finished" must
    // be undone by the second run, or Done and Cancel would never work. Same pattern as DraftArea.
    finished.current = false
    nameRef.current?.focus({ preventScroll: true })
    return () => {
      finished.current = true
    }
  }, [])

  const nextLang = choice === OTHER ? otherText.trim() : choice
  const asksEnv = takesEnv(nextLang)
  const langError = (id: string) => (isLangId(id) ? undefined : LANG_ID_ERROR)
  const envError = (text: string) => (text.trim() === '' || isEnvName(text.trim()) ? undefined : ENV_NAME_ERROR)

  const finish = (commit: boolean, keyboard: boolean) => {
    if (finished.current) return
    if (commit) {
      const found = { lang: langError(nextLang), env: asksEnv ? envError(envText) : undefined }
      if (found.lang || found.env) {
        setErrors(found)
        ;(found.lang ? otherRef : envRef).current?.focus()
        return
      }
    }
    finished.current = true
    const result: VisualResult = { commit, keyboard }
    const nextTitle = (nameRef.current?.value ?? initial.title).replace(/\s+/g, ' ').trim()
    const nextCode = codeRef.current?.value ?? initial.code
    // A language that takes no environment drops the one asked for before: it would mean nothing.
    const nextEnv = asksEnv ? envText.trim() : ''
    if (nextTitle !== initial.title) result.title = nextTitle
    if (nextCode !== initial.code) result.source = nextCode
    if (nextLang !== initial.lang) result.lang = nextLang
    if (nextEnv !== initial.env) result.env = nextEnv
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
      <div className="qp-run-edit__row">
        <div className="q-field qp-run-edit__lang">
          <label className="q-label" htmlFor={langId}>
            Language
          </label>
          <select
            id={langId}
            className="q-input"
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value)
              setErrors({})
              if (e.target.value === OTHER) queueMicrotask(() => otherRef.current?.focus())
            }}
          >
            {KNOWN_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
        </div>
        {choice === OTHER && (
          <div className="q-field qp-run-edit__other">
            <label className="q-label" htmlFor={otherFieldId}>
              Language id
            </label>
            <input
              ref={otherRef}
              id={otherFieldId}
              className="q-input qp-run-edit__mono"
              type="text"
              value={otherText}
              placeholder="e.g. haskell"
              maxLength={24}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={errors.lang ? true : undefined}
              aria-describedby={errors.lang ? otherErrId : undefined}
              onChange={(e) => {
                setOtherText(e.target.value)
                if (errors.lang) setErrors((s) => ({ ...s, lang: undefined }))
              }}
              onBlur={() => otherText.trim() !== '' && setErrors((s) => ({ ...s, lang: langError(otherText.trim()) }))}
            />
            {errors.lang && (
              <p className="q-error" id={otherErrId}>
                {errors.lang}
              </p>
            )}
          </div>
        )}
        {asksEnv && (
          <div className="q-field qp-run-edit__env">
            <label className="q-label" htmlFor={envId}>
              Environment this Run asks for
            </label>
            <input
              ref={envRef}
              id={envId}
              className="q-input qp-run-edit__mono"
              type="text"
              list={environments.length > 0 ? listId : undefined}
              value={envText}
              placeholder="The default environment"
              maxLength={60}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={errors.env ? true : undefined}
              aria-describedby={errors.env ? `${envErrId} ${envHintId}` : envHintId}
              onChange={(e) => {
                setEnvText(e.target.value)
                if (errors.env) setErrors((s) => ({ ...s, env: undefined }))
              }}
              onBlur={() => setErrors((s) => ({ ...s, env: envError(envText) }))}
            />
            {environments.length > 0 && (
              <datalist id={listId}>
                {environments.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
            {errors.env && (
              <p className="q-error" id={envErrId}>
                {errors.env}
              </p>
            )}
            <p className="q-hint qp-run-edit__envhint" id={envHintId}>
              A name only: each computer decides which of its environments it means, and asks once when it does not know.
            </p>
          </div>
        )}
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
        <p className="qp-block__hint">{editorHint(nextLang)}</p>
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
