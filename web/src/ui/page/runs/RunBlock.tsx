import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ops, runs, useMembers, useRunStale, useRuns, useSession } from '../../../lib'
import type { BlockVM, RunResult } from '../../../lib'
import { useBoardActions } from '../../board/useBoardActions'
import { ConfirmDialog } from '../../shell/ConfirmDialog'
import { formatDateTime } from '../../shell/dates'
import { errorCode } from '../../shell/errorMessages'
import { initials } from '../../shell/initials'
import { BlockTools } from '../BlockTools'
import type { BlockHandlers } from '../BlockTools'
import { memberName } from '../people'
import { codeLines, envLine, figureSrc, formatDuration, formatElapsed } from './format'
import { RunEditor } from './RunEditor'

/** Code longer than this is folded to its first lines until asked for. */
export const COLLAPSED_LINES = 24
const MAX_FIGURES = 24
/** How close to the end of the output still counts as "at the end" (px). */
const END_SLACK = 16

const APPROVAL_LINE = 'Check the Sheaf window that just opened: it shows this code and asks before running it.'
const BROWSER_LINE = "Code can only run in the Sheaf desktop app. You're in the browser — "
const OLD_APP_LINE = 'This version of the desktop app cannot run code. Update the app.'

/** Why `runs.run` could not start, in plain words. */
function startSentence(e: unknown): string {
  switch (errorCode(e)) {
    case 'busy':
      return 'Another Run is in progress.'
    case 'no_runner':
      return 'Running code needs the Sheaf desktop app.'
    case 'not_found':
      return 'This Run is no longer on the Page.'
    case 'read_only':
      return 'This Page is read-only here, so the code was not run.'
    case 'bad_request':
      return 'This Run has no code yet.'
    default:
      return 'The Run could not be started. Try again.'
  }
}

// ---- code ----

/**
 * The code, read-only: line numbers in a gutter that stays put while long lines scroll sideways.
 * Two text nodes whatever the length — the code is never parsed, coloured or turned into markup.
 */
const RunCode = memo(function RunCode({ code, label }: { code: string; label: string }) {
  const [all, setAll] = useState(false)
  const lines = useMemo(() => codeLines(code), [code])
  if (lines.length === 0) return <p className="qp-run__quiet qp-run__nocode">This Run has no code yet.</p>
  const long = lines.length > COLLAPSED_LINES
  const shown = long && !all ? lines.slice(0, COLLAPSED_LINES) : lines
  return (
    <div className="qp-run__codewrap">
      <div className="qp-run__code" role="group" aria-label={`Code of ${label}`} tabIndex={0}>
        <pre className="qp-run__gutter" aria-hidden="true">
          {shown.map((_, i) => i + 1).join('\n')}
        </pre>
        <pre className="qp-run__lines">
          <code>{shown.join('\n')}</code>
        </pre>
      </div>
      {long && (
        <button type="button" className="qp-run__more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
})

// ---- output ----

/**
 * The text output: one text node in a `<pre>` with its own scroll. While the Run is live it stays
 * scrolled to the end — unless the Member scrolled up to read, then it stays where they left it.
 * Not a live region: output can arrive many times a second.
 */
const OutputText = memo(function OutputText({ text, follow, label }: { text: string; follow: boolean; label: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    if (follow) atEnd.current = true // a new execution starts at the end again
  }, [follow])
  useLayoutEffect(() => {
    const el = ref.current
    if (follow && el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [text, follow])
  return (
    <pre
      ref={ref}
      className="qp-run__text"
      role="group"
      aria-label={`Output of ${label}`}
      aria-live="off"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < END_SLACK
      }}
    >
      {text}
    </pre>
  )
})

const NO_FAILURES: ReadonlySet<number> = new Set()

/** Captured figures, each on a white plate (plots are drawn for white). Data that is not base64 is not rendered. */
const Figures = memo(function Figures({ figures, label }: { figures: RunResult['figures']; label: string }) {
  const [failed, setFailed] = useState(NO_FAILURES)
  const sources = useMemo(
    () => (Array.isArray(figures) ? figures.slice(0, MAX_FIGURES).map((f) => figureSrc((f as { png?: unknown } | null)?.png)) : []),
    [figures],
  )
  if (sources.length === 0) return null
  const missing = sources.filter((src, i) => src === null || failed.has(i)).length + (Array.isArray(figures) ? Math.max(0, figures.length - MAX_FIGURES) : 0)
  return (
    <>
      {missing < sources.length && (
        <div className="qp-run__figs">
          {sources.map((src, i) =>
            src === null || failed.has(i) ? null : (
              <img
                key={i}
                className="qp-run__fig"
                src={src}
                alt={`Figure ${i + 1} of ${label}`}
                decoding="async"
                draggable={false}
                onError={() => setFailed((s) => new Set(s).add(i))}
              />
            ),
          )}
        </div>
      )}
      {missing > 0 && <p className="qp-run__quiet">{missing === 1 ? 'One figure could not be shown.' : `${missing} figures could not be shown.`}</p>}
    </>
  )
})

/** Who executed it, when, against which code; how long it took and how it ended. */
const RecordLine = memo(function RecordLine({ block, result }: { block: BlockVM; result: RunResult }) {
  const members = useMembers()
  const session = useSession()
  const stale = useRunStale(block)
  const me = session.status === 'signed_in' ? session.member : null
  const by = me && me.id === result.by ? me : members.find((m) => m.id === result.by)
  const who = me && me.id === result.by ? 'you' : memberName(members, result.by).name
  const when = typeof result.at === 'number' && Number.isFinite(result.at) && Math.abs(result.at) < 8.64e15 ? result.at : null
  const duration = formatDuration(result.duration_ms)
  const stopped = result.stopped === true || result.exit === null
  const failed = !stopped && result.exit !== 0
  return (
    <div className="qp-run__record">
      <span className="q-avatar qp-run__avatar" aria-hidden="true" style={{ ['--who' as string]: by?.color ?? 'var(--q-ink-3)' }}>
        {by ? initials(by.name) : '?'}
      </span>
      <span className="qp-run__by">
        Last run by {who}
        {when !== null && (
          <>
            , <time dateTime={new Date(when).toISOString()}>{formatDateTime(when)}</time>
          </>
        )}
        {stale === false && <span> · current code</span>}
        {stale === true && <span className="qp-run__stale"> · code changed since</span>}
      </span>
      <span className="qp-spacer" />
      <span className="qp-run__stats">
        {duration}
        {(stopped || failed) && duration && ' · '}
        {stopped && <span className="qp-run__stopped">stopped</span>}
        {failed && <span className="qp-run__exit">exit {String(result.exit)}</span>}
      </span>
    </div>
  )
})

// ---- header pieces ----

/** The running clock. Ticks by itself: nothing outside this element re-renders each second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return (
    <span className="qp-run__elapsed" role="timer" aria-label="Running for">
      {formatElapsed(now - since)}
    </span>
  )
}

type MenuItem = { label: string; onPick: () => void }

/** The "⋯" menu of a Run. Arrow keys move, Esc closes and gives focus back to the button. */
function MoreMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    wrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const shut = () => {
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step) {
      e.preventDefault()
      list[(i + step + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // closes the menu, not the panel
      shut()
    }
  }

  return (
    <span
      className="qp-run__more-wrap"
      ref={wrapRef}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="q-btn q-btn--sm q-btn--quiet qp-run__more-btn"
        aria-label={`More for ${label}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div className="qp-menu qp-run__menu" role="menu" aria-label={`More for ${label}`} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="qp-menu__item"
              onClick={() => {
                shut() // focus is back on "⋯" before anything opens, so a dialog returns it there
                item.onPick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

// ---- the block ----

type Props = {
  block: BlockVM
  /** 0-based place in the Page. */
  index: number
  last: boolean
  editing: boolean
  /** Members, when nobody else is editing the Page: Edit, move, delete, clear the output. */
  canEdit: boolean
  /** A Guest, or a moment in History: the code and the captured output only — nothing to press. */
  readOnly: boolean
  /** The open Branch: an execution belongs to the Branch it was started on. */
  branchId: string | undefined
  handlers: BlockHandlers
}

/**
 * A Run in the Page: experiment code with the output captured the last time someone executed it.
 * Everyone reads the code and the captured output; a Member in the desktop app can execute it on
 * their own computer (the app shows the code and asks first), and the new result is recorded for all.
 *
 * Everything here that was written by a person or printed by a program — name, code, output,
 * environment, messages — is rendered as text nodes; figures only as PNG data URLs.
 *
 * Memoised like the other Blocks. `useRuns()` changes with every chunk of live output, so the
 * parts that are costly to render (code, figures, the stored output) are memoised below it.
 */
export const RunBlock = memo(function RunBlock({ block, index, last, editing, canEdit, readOnly, branchId, handlers }: Props) {
  const { id, title, text } = block
  const { runner, live, last: lastOutcome } = useRuns()
  const actions = useBoardActions()
  const viewRef = useRef<HTMLDivElement>(null)
  const goRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const [startError, setStartError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [againState, setAgainState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const hintId = useId()
  const n = index + 1

  // After the editor closes, focus returns to the Block so the keyboard keeps working.
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    viewRef.current?.focus({ preventScroll: true })
  }, [editing])

  if (editing) {
    return (
      <div className="qp-block is-editing" data-block={id} data-testid={`block-${id}`}>
        <RunEditor
          n={n}
          title={title}
          code={text}
          onFinish={(result) => {
            refocus.current = true
            handlers.finishVisual(id, result) // a name and a text, like a Visual: one batch
          }}
        />
      </div>
    )
  }

  const name = title || 'Untitled Run'
  const label = title ? `Run ${title}` : 'Untitled Run'
  const result = block.run?.result ?? null
  const broken = block.run?.broken === true
  const hasCode = text.trim() !== ''

  const mine = live !== null && live.block === id && live.branch === branchId
  const phase = mine ? live.state : 'idle'
  const isLive = phase !== 'idle'
  const otherLive = live !== null && !mine
  const outcome = !readOnly && lastOutcome !== null && lastOutcome.block === id && lastOutcome.branch === branchId ? lastOutcome : null
  const executable = !readOnly && runner.available
  const env = envLine(result?.env)

  /** A strip is about to go away with the button that was pressed: focus moves to the Run's main control instead of being lost. */
  const keepFocus = () => (goRef.current ?? viewRef.current)?.focus({ preventScroll: true })

  const start = () => {
    setStartError('')
    setAgainState('idle')
    runs.run(id).catch((e: unknown) => setStartError(startSentence(e)))
  }
  const configure = () => void runs.configure()
  const recordAgain = () => {
    if (againState === 'busy') return
    setAgainState('busy')
    runs.saveAgain().then(
      () => setAgainState('idle'),
      () => setAgainState('failed'),
    )
  }
  const clearOutput = async () => {
    if (clearing) return
    setClearing(true)
    await actions.submit([ops.setRunResult(id, null)])
    setClearing(false)
    setConfirming(false)
  }

  // ---- the action at the right of the header ----
  let note: string | null = null
  let action: ReactNode = null
  if (readOnly || (!runner.available && runner.reason === 'guest')) {
    // A Guest, or a moment in History: nothing to press.
  } else if (!runner.available) {
    note = runner.reason === 'browser' ? 'Desktop app only' : runner.reason === 'old_app' ? 'App update needed' : null
    const why = runner.reason === 'browser' ? 'Running code needs the desktop app' : runner.reason === 'old_app' ? 'Update the desktop app to run code' : 'Checking the Runner…'
    action = (
      <button type="button" className="q-btn q-btn--sm qp-run__go" disabled title={why}>
        <PlayGlyph />
        Run
      </button>
    )
  } else if (!runner.python && !isLive) {
    action = (
      <button ref={goRef} type="button" className="q-btn q-btn--sm qp-run__go" title="Choose the Python this computer runs code with" onClick={configure}>
        Set up the Runner…
      </button>
    )
  } else {
    // One button for Run → Waiting → Stop → Recording → Run: the element stays, so focus stays on it.
    const blocked = phase === 'idle' ? (otherLive ? 'Another Run is in progress' : !hasCode ? 'This Run has no code yet' : '') : ''
    const inert = phase === 'approval' || phase === 'saving' || blocked !== ''
    action = (
      <button
        ref={goRef}
        type="button"
        className={`q-btn q-btn--sm qp-run__go${phase === 'running' ? ' qp-run__go--stop' : ' q-btn--primary'}`}
        aria-disabled={inert || undefined}
        title={phase === 'idle' ? blocked || 'Run on this computer' : phase === 'running' ? 'Stop this Run' : undefined}
        onClick={() => {
          if (inert) return
          if (phase === 'running') runs.stop()
          else start()
        }}
      >
        {phase === 'idle' && <PlayGlyph />}
        {phase === 'running' && <span className="qp-run__square" aria-hidden="true" />}
        {phase === 'idle' ? 'Run' : phase === 'approval' ? 'Waiting for you…' : phase === 'running' ? 'Stop' : 'Recording…'}
      </button>
    )
  }

  // ---- "⋯" ----
  const menu: MenuItem[] = []
  if (executable) {
    menu.push({ label: 'Runner settings…', onPick: configure })
    if (canEdit && !isLive && (result !== null || broken)) menu.push({ label: 'Clear output', onPick: () => setConfirming(true) })
  }

  // ---- what a screen reader is told when the state changes (one polite element) ----
  let announce = ''
  if (phase === 'approval') announce = 'Waiting for you in the Sheaf window'
  else if (isLive) announce = 'Run started'
  else if (startError) announce = `Run failed: ${startError}`
  else if (outcome?.status === 'recorded') announce = result?.stopped === true || result?.exit === null ? 'Run stopped' : 'Run finished'
  else if (outcome?.status === 'failed') announce = `Run failed: ${outcome.message ?? 'The Run could not be started.'}`
  else if (outcome?.status === 'unsaved') announce = `Run finished. The output was captured but could not be recorded: ${outcome.message ?? ''}`.trim()

  // ---- the outcome strip ----
  let strip: ReactNode = null
  if (isLive) {
    // The header says what is happening.
  } else if (startError) {
    strip = (
      <div className="qp-run__strip qp-run__strip--warn" data-testid={`run-outcome-${id}`}>
        <WarnGlyph />
        <span className="qp-run__strip-text">{startError}</span>
        <button
          type="button"
          className="q-btn q-btn--sm"
          onClick={() => {
            keepFocus()
            setStartError('')
          }}
        >
          Dismiss
        </button>
      </div>
    )
  } else if (outcome?.status === 'failed') {
    const message = outcome.message || 'The Run could not be started.'
    const aboutPython = (runner.available && !runner.python) || /python/i.test(message)
    strip = (
      <div className="qp-run__strip qp-run__strip--warn" data-testid={`run-outcome-${id}`}>
        <WarnGlyph />
        <span className="qp-run__strip-text">{message}</span>
        {aboutPython && executable && (
          <button type="button" className="q-btn q-btn--sm" onClick={configure}>
            Runner settings…
          </button>
        )}
        <button
          type="button"
          className="q-btn q-btn--sm"
          onClick={() => {
            keepFocus()
            runs.dismiss()
          }}
        >
          Dismiss
        </button>
      </div>
    )
  } else if (outcome?.status === 'unsaved') {
    strip = (
      <div className="qp-run__strip qp-run__strip--warn" data-testid={`run-outcome-${id}`}>
        <WarnGlyph />
        <span className="qp-run__strip-text">
          The output was captured but could not be recorded: {outcome.message || 'the Page could not be reached.'}
          {againState === 'failed' && ' It could not be recorded this time either.'}
        </span>
        <button type="button" className="q-btn q-btn--sm" aria-disabled={againState === 'busy' || undefined} onClick={recordAgain}>
          {againState === 'busy' ? 'Recording…' : 'Record again'}
        </button>
        <button
          type="button"
          className="q-btn q-btn--sm"
          title="Drop the captured output"
          onClick={() => {
            keepFocus()
            setAgainState('idle')
            runs.dismiss()
          }}
        >
          Discard
        </button>
      </div>
    )
  }

  // ---- the output ----
  const out: ReactNode[] = []
  if (mine) {
    // While live, the live output stands in for the stored one; stored figures stay out of sight.
    if (live.output) out.push(<OutputText key="text" text={live.output} follow label={label} />)
    else
      out.push(
        <p key="none" className="qp-run__quiet">
          {phase === 'approval' ? 'Nothing has run yet.' : 'No output yet.'}
        </p>,
      )
  } else if (broken) {
    out.push(
      <p key="none" className="qp-run__quiet">
        This result cannot be shown.
      </p>,
    )
  } else if (result === null) {
    out.push(
      <p key="none" className="qp-run__quiet">
        Not executed yet.
      </p>,
    )
  } else {
    const output = typeof result.output === 'string' ? result.output : ''
    const figures = Array.isArray(result.figures) ? result.figures : []
    if (figures.length > 0) out.push(<Figures key={`figs-${result.at}`} figures={figures} label={label} />)
    if (output) out.push(<OutputText key="text" text={output} follow={false} label={label} />)
    else if (figures.length === 0)
      out.push(
        <p key="none" className="qp-run__quiet">
          No output.
        </p>,
      )
    if (result.output_truncated === true)
      out.push(
        <p key="cut" className="qp-run__quiet">
          Part of the output was left out.
        </p>,
      )
    out.push(<RecordLine key="record" block={block} result={result} />)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget || isLive) return
    e.preventDefault()
    handlers.edit(id)
  }

  return (
    <div className="qp-block" data-block={id} data-testid={`block-${id}`}>
      {canEdit && <BlockTools id={id} index={index} last={last} handlers={handlers} locked={isLive ? 'This Run is in progress' : undefined} />}
      <div
        ref={viewRef}
        className={`qp-run${isLive ? ' is-live' : ''}`}
        role="group"
        tabIndex={canEdit ? 0 : -1}
        aria-label={label}
        aria-describedby={canEdit && !isLive ? hintId : undefined}
        onKeyDown={canEdit ? onKeyDown : undefined}
      >
        {canEdit && (
          <span id={hintId} className="q-sr">
            Press Enter to edit.
          </span>
        )}
        <div className="qp-run__head">
          <svg className="qp-run__glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 2.3 L9.6 6 L3.5 9.7 Z" />
          </svg>
          <span className="qp-run__kind">Run</span>
          <span className={`qp-run__title${title ? '' : ' is-empty'}`} title={name}>
            {name}
          </span>
          {env.text && (
            <span className="qp-run__env" title={env.full}>
              {env.text}
            </span>
          )}
          <span className="qp-spacer" />
          {note && <span className="qp-run__note">{note}</span>}
          {phase === 'running' && live?.startedAt !== undefined && <Elapsed key={live.startedAt} since={live.startedAt} />}
          {canEdit && (
            <button type="button" className="q-btn q-btn--sm qp-run__edit" disabled={isLive} title={isLive ? 'This Run is in progress' : 'Edit this Run'} onClick={() => handlers.edit(id)}>
              Edit
            </button>
          )}
          {menu.length > 0 && <MoreMenu label={label} items={menu} />}
          {action}
        </div>
        {phase === 'approval' && <p className="qp-run__strip qp-run__strip--wait">{APPROVAL_LINE}</p>}
        {note !== null && (
          <div className="qp-run__strip qp-run__strip--info">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <rect x="1.5" y="2" width="11" height="8" rx="1" />
              <path d="M4.5 12.5 H9.5 M7 10 V12.5" />
            </svg>
            <span className="qp-run__strip-text">
              {!runner.available && runner.reason === 'old_app'
                ? OLD_APP_LINE
                : `${BROWSER_LINE}${result !== null ? 'the captured output from the last Run is shown below.' : 'this Run has not been executed yet.'}`}
            </span>
          </div>
        )}
        {strip}
        <RunCode code={text} label={label} />
        <div className="qp-run__out">
          <div className="qp-run__out-head">
            <span className="qp-run__label">Output</span>
            {phase === 'running' && <span className="qp-run__live">live</span>}
          </div>
          {out}
        </div>
        <span className="q-sr" role="status" aria-live="polite" data-testid={`run-status-${id}`}>
          {announce}
        </span>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Clear the output of this Run?"
          body={`The captured output and figures of ${name} are removed from the Page for everyone. The code stays, and History still shows who ran it.`}
          confirmLabel="Clear output"
          busyLabel="Clearing…"
          busy={clearing}
          error=""
          onConfirm={() => void clearOutput()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
})

function PlayGlyph() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" fill="currentColor" aria-hidden="true">
      <path d="M1 0.8 L8.4 5 L1 9.2 Z" />
    </svg>
  )
}

function WarnGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M7.5 1.5 L14 13 H1 Z" />
      <path d="M7.5 6 V9" />
      <circle cx="7.5" cy="11" r="0.5" fill="currentColor" />
    </svg>
  )
}
