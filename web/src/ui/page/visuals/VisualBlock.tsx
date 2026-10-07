import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { BlockVM } from '../../../lib'
import { BlockTools } from '../BlockTools'
import type { BlockHandlers, VisualResult } from '../BlockTools'
import { VisualFrame } from './VisualFrame'

const INDENT = '  '

type EditorProps = {
  /** 1-based place in the Page, for labels. */
  n: number
  title: string
  source: string
  onFinish: (result: VisualResult) => void
}

/**
 * The editor of a Visual: title, source, and a preview frame that "Run" loads from the draft.
 * Both fields are uncontrolled, so typing re-renders nothing — not the preview, not the other
 * Blocks, not the Board — and remote updates never overwrite the draft. Nothing is submitted
 * until "Done"; leaving a field does not finish (there are two fields and a Run button to go to).
 */
function VisualEditor({ n, title, source, onFinish }: EditorProps) {
  const [initial] = useState({ title, source }) // what the editor opened with: only real changes are reported
  const [preview, setPreview] = useState({ source, run: 0 })
  const titleRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)
  const titleId = useId()
  const sourceId = useId()
  const hintId = useId()

  useLayoutEffect(() => {
    // StrictMode runs this twice (mount, simulated unmount, mount): the cleanup's "finished" must
    // be undone by the second run, or Done and Cancel would never work. Same pattern as DraftArea.
    finished.current = false
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      finished.current = true
    }
  }, [])

  const finish = (commit: boolean, keyboard: boolean) => {
    if (finished.current) return
    finished.current = true
    const result: VisualResult = { commit, keyboard }
    const nextTitle = (titleRef.current?.value ?? initial.title).replace(/\s+/g, ' ').trim()
    const nextSource = sourceRef.current?.value ?? initial.source
    if (nextTitle !== initial.title) result.title = nextTitle
    if (nextSource !== initial.source) result.source = nextSource
    onFinish(result)
  }
  const run = () => setPreview((p) => ({ source: sourceRef.current?.value ?? p.source, run: p.run + 1 }))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // the panel's own Esc must not see it
      finish(false, true)
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      run()
    }
  }
  // Tab indents. Shift+Tab still leaves the field, so the keyboard is not trapped in it.
  const onSourceKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    const el = e.currentTarget
    el.setRangeText(INDENT, el.selectionStart, el.selectionEnd, 'end')
  }

  return (
    <div className="qp-visual-edit" role="group" aria-label={`Block ${n}, Visual editor`} onKeyDown={onKeyDown}>
      <div className="q-field">
        <label className="q-label" htmlFor={titleId}>
          Title
        </label>
        <input ref={titleRef} id={titleId} className="q-input" type="text" defaultValue={title} placeholder="Untitled Visual" maxLength={200} autoComplete="off" />
      </div>
      <div className="q-field">
        <label className="q-label" htmlFor={sourceId}>
          Source
        </label>
        <textarea
          ref={sourceRef}
          id={sourceId}
          className="qp-visual-edit__source"
          defaultValue={source}
          rows={14}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby={hintId}
          onKeyDown={onSourceKeyDown}
        />
      </div>
      <p className="qp-block__hint" id={hintId}>
        HTML, CSS and JavaScript. Runs in a sandbox: no network, no access to Qoop. Use the --q-* colour variables to follow the theme.
      </p>
      <div className="qp-visual-edit__buttons">
        <button type="button" className="q-btn q-btn--sm" title="Run the draft below (⌘Enter)" onClick={run}>
          Run
        </button>
        <span className="qp-spacer" />
        <button type="button" className="q-btn q-btn--sm" title="Discard the draft (Esc)" onClick={() => finish(false, false)}>
          Cancel
        </button>
        <button type="button" className="q-btn q-btn--sm q-btn--primary" onClick={() => finish(true, false)}>
          Done
        </button>
      </div>
      <div className="qp-visual qp-visual--preview">
        <div className="qp-visual__head">
          <span className="qp-visual__kind">Preview</span>
          <span className="qp-spacer" />
          <span className="qp-visual__note">as of the last Run</span>
        </div>
        <VisualFrame source={preview.source} title={`${initial.title || 'Untitled'}, preview`} run={preview.run} eager />
      </div>
    </div>
  )
}

type Props = {
  block: BlockVM
  /** 0-based place in the Page. */
  index: number
  last: boolean
  editing: boolean
  canEdit: boolean
  handlers: BlockHandlers
}

/**
 * A Visual in the Page. Reading: a framed block with a header strip and the sandboxed frame —
 * interactive for everyone, Guests included. Members also get "Edit" (or Enter on the block) and
 * the move / delete controls. Memoised like a text Block.
 */
export const VisualBlock = memo(function VisualBlock({ block, index, last, editing, canEdit, handlers }: Props) {
  const { id, title, text } = block
  const viewRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const n = index + 1

  // After Esc, focus returns to the Block so the keyboard keeps working.
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    viewRef.current?.focus({ preventScroll: true })
  }, [editing])

  if (editing) {
    return (
      <div className="qp-block is-editing" data-block={id} data-testid={`block-${id}`}>
        <VisualEditor
          n={n}
          title={title}
          source={text}
          onFinish={(result) => {
            refocus.current = true
            handlers.finishVisual(id, result)
          }}
        />
      </div>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return
    e.preventDefault()
    handlers.edit(id)
  }

  return (
    <div className="qp-block" data-block={id} data-testid={`block-${id}`}>
      {canEdit && <BlockTools id={id} index={index} last={last} handlers={handlers} />}
      <div
        ref={viewRef}
        className="qp-visual"
        role="group"
        tabIndex={canEdit ? 0 : undefined}
        aria-label={canEdit ? `Block ${n}, Visual. Press Enter to edit.` : `Block ${n}, Visual`}
        onKeyDown={canEdit ? onKeyDown : undefined}
      >
        <div className="qp-visual__head">
          <svg className="qp-visual__glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
            <circle cx="6" cy="6" r="4.6" />
            <ellipse cx="6" cy="6" rx="4.6" ry="1.7" />
          </svg>
          <span className="qp-visual__kind">Visual</span>
          <span className={`qp-visual__title${title ? '' : ' is-empty'}`}>{title || 'Untitled Visual'}</span>
          <span className="qp-spacer" />
          <span className="qp-visual__note">interactive · runs everywhere</span>
          {canEdit && (
            <button type="button" className="q-btn q-btn--sm qp-visual__edit" title="Edit this Visual" onClick={() => handlers.edit(id)}>
              Edit
            </button>
          )}
        </div>
        {text.trim() ? <VisualFrame source={text} title={title} /> : <p className="qp-visual__blank">This Visual has no source yet.</p>}
      </div>
    </div>
  )
})
