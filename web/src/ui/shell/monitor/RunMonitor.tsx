import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { runs, useBlock, useBoard, useRuns } from '../../../lib'
import type { RunLive, RunStats } from '../../../lib'
import { pagePanel } from '../../bridge'
import { formatElapsed } from '../../page/runs/format'
import { useDismiss } from '../useDismiss'
import { useOnBoard } from '../useOnBoard'
import { formatBytes, formatCount, formatEstimate, formatLeft, formatPercent, formatProcessor, fraction } from './format'
import './monitor.css'

/** How long a running Run may go without a usage sample before the app is taken for one that reports none. */
export const NO_USAGE_AFTER_MS = 3000
/** Memory use from which its meter turns to the warning colour. */
const MEMORY_WARNING = 0.9

const NOW: Record<RunLive['state'], string> = {
  approval: "Waiting for you in the Runner's window",
  running: 'Running',
  saving: 'Recording the result…',
}
const NO_USAGE = 'This version of the app does not report usage.'
const NO_ESTIMATE = 'No estimate — the code reports no progress'
const NO_GRAPHICS = 'Not reported on this computer'

/** The running clock. Ticks by itself, and stands still once the Run has ended and its result is being recorded. */
function Elapsed({ since, frozen, timer }: { since: number; frozen: boolean; timer?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (frozen) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since, frozen])
  // Not a live region: `timer` is silent unless asked, and the closed button has a name of its own.
  return (
    <span className="q-mon__time" role={timer ? 'timer' : undefined} aria-label={timer ? 'Running for' : undefined}>
      {formatElapsed(now - since)}
    </span>
  )
}

/** A horizontal meter with its value said in words: the bar alone tells a screen reader nothing. */
function Meter({ label, value, text, warn }: { label: string; value: number; text: string; warn?: boolean }) {
  return (
    <span
      className={`q-mon__meter${warn ? ' is-warn' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={text}
    >
      <span className="q-mon__fill" style={{ transform: `scaleX(${value})` }} />
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="q-mon__row">
      <dt className="q-caps q-mon__label">{label}</dt>
      <dd className="q-mon__value">{children}</dd>
    </div>
  )
}

/** Brings a Run into view in the Page panel once it is there, and puts focus on it. */
function revealRun(block: string, tries = 20): void {
  const row = document.querySelector(`[data-block="${CSS.escape(block)}"]`)
  if (row) {
    row.scrollIntoView?.({ block: 'center' })
    row.querySelector<HTMLElement>('.qp-run')?.focus({ preventScroll: true })
  } else if (tries > 0) window.setTimeout(() => revealRun(block, tries - 1), 50)
}

/** The usage rows: what the Run takes of this computer right now. */
function Usage({ stats }: { stats: RunStats }) {
  const processor = formatProcessor(stats.cpu_percent, stats.cores)
  const memory = `${formatBytes(stats.memory_bytes)} of ${formatBytes(stats.memory_total_bytes)}`
  const memoryShare = fraction(stats.memory_bytes, stats.memory_total_bytes)
  const full = memoryShare >= MEMORY_WARNING
  return (
    <>
      <Row label="Processor">
        <span className="q-mon__text">{processor}</span>
        <Meter label="Processor" value={fraction(stats.cpu_percent, stats.cores * 100)} text={processor} />
      </Row>
      <Row label="Memory">
        <span className="q-mon__text">
          {memory}
          <span className="q-mon__quiet"> · peak {formatBytes(stats.peak_memory_bytes)}</span>
        </span>
        <Meter label="Memory" value={memoryShare} text={full ? `${memory}, nearly full` : memory} warn={full} />
      </Row>
      <Row label="Graphics">
        {stats.gpu ? (
          <>
            <span className="q-mon__text" title={stats.gpu.name}>
              {formatPercent(stats.gpu.percent)} · whole computer
              {stats.gpu.name && <span className="q-mon__quiet"> · {stats.gpu.name}</span>}
            </span>
            <Meter label="Graphics" value={fraction(stats.gpu.percent, 100)} text={`${formatPercent(stats.gpu.percent)}, whole computer`} />
          </>
        ) : (
          <span className="q-mon__text q-mon__quiet">{NO_GRAPHICS}</span>
        )}
      </Row>
    </>
  )
}

function Monitor({ live }: { live: RunLive }) {
  const { state, stats, startedAt } = live
  const [open, setOpen] = useState(false)
  // True once a running Run has gone `NO_USAGE_AFTER_MS` without a sample: an app from before M9.
  const [silent, setSilent] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const onBoard = useOnBoard()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, boxRef, triggerRef)

  // The Run and its Card, from the open Board. The name last seen is kept, so the monitor still has one when the
  // Board has moved to another Branch while the Run goes on.
  const board = useBoard()
  const found = useBlock(live.block)
  const here = board.branch?.id === live.branch
  const card = here && found ? board.cards.find((c) => c.id === found.card) : undefined
  const [seen, setSeen] = useState('')
  const known = here && found ? found.title.trim() : null
  if (known !== null && known !== seen) setSeen(known)
  const title = (known ?? seen) || 'Untitled Run'

  const hasStats = stats !== undefined
  useEffect(() => {
    if (startedAt === undefined || hasStats) return
    const t = window.setTimeout(() => setSilent(true), Math.max(0, startedAt + NO_USAGE_AFTER_MS - Date.now()))
    return () => window.clearTimeout(t)
  }, [startedAt, hasStats])

  // Opened: focus goes to the popover, so its label is read and Tab continues inside it.
  useEffect(() => {
    if (open) popRef.current?.focus({ preventScroll: true })
  }, [open])

  const openCard = () => {
    if (!card) return
    const cardId = card.id
    setOpen(false)
    onBoard(() => {
      pagePanel.open(cardId)
      revealRun(live.block)
    })
  }

  const progress = stats?.progress
  const share = progress ? fraction(progress.done, progress.total) : 0
  const counted = progress ? `${formatCount(progress.done)} of ${formatCount(progress.total)}` : ''
  // The estimate, in words; while the code counts but the rate is not known yet, that is said instead.
  const finishing = progress !== undefined && progress.done >= progress.total
  const estimate = stats?.eta_ms !== undefined ? formatEstimate(stats.eta_ms) : ''
  const left = !progress ? '' : finishing ? 'finishing…' : estimate === '' ? 'estimating…' : formatLeft(stats?.eta_ms ?? NaN)
  const started = startedAt !== undefined
  const phase = state === 'approval' ? 'waiting for you' : state === 'saving' ? 'recording the result' : 'running'

  return (
    <div className="q-mon" ref={boxRef}>
      <button
        type="button"
        ref={triggerRef}
        className="q-btn q-topbtn q-mon__btn"
        title="What this Run is doing on this computer"
        aria-label={`Run ${title}: ${phase}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`q-mon__dot${state === 'approval' ? ' is-waiting' : ''}`} aria-hidden="true" />
        <span className="q-mon__title">{title}</span>
        {started ? <Elapsed since={startedAt} frozen={state === 'saving'} /> : <span className="q-mon__wait">Waiting for you…</span>}
        {progress && (
          <span className="q-mon__line" aria-hidden="true">
            <span className="q-mon__fill" style={{ transform: `scaleX(${share})` }} />
          </span>
        )}
      </button>
      {open && (
        <div className="q-pop q-mon__pop" id={id} ref={popRef} role="dialog" aria-label="Runner monitor" tabIndex={-1}>
          <div className="q-mon__head">
            <span className="q-mon__name" title={title}>
              {title}
            </span>
            {card ? (
              <button type="button" className="q-mon__card" title="Open the Page of this Card and show the Run" onClick={openCard}>
                <span className="q-caps">Card</span>
                <span className="q-mon__card-title">{card.title.trim() || 'Untitled'}</span>
              </button>
            ) : (
              <span className="q-mon__quiet q-mon__elsewhere">{here ? 'No longer on its Page' : 'On another Branch than the one shown'}</span>
            )}
          </div>
          <dl className="q-mon__rows">
            <Row label="Now">
              <span className="q-mon__text" title={stats?.step}>
                {state === 'running' && stats?.step ? stats.step : NOW[state]}
              </span>
            </Row>
            {progress && (
              <Row label="Progress">
                <span className="q-mon__text">
                  {counted}
                  <span className="q-mon__quiet"> · {left}</span>
                </span>
                <span
                  className="q-mon__meter"
                  role="progressbar"
                  aria-label="Progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(share * 100)}
                  aria-valuetext={`${counted}, ${left}`}
                >
                  <span className="q-mon__fill" style={{ transform: `scaleX(${share})` }} />
                </span>
              </Row>
            )}
            {stats ? (
              <Usage stats={stats} />
            ) : (
              started &&
              !silent && (
                // The first sample is on its way: the rows are there already, so nothing moves when it arrives.
                <>
                  <Row label="Processor">
                    <span className="q-mon__text q-mon__quiet">Measuring…</span>
                    <span className="q-mon__meter" aria-hidden="true" />
                  </Row>
                  <Row label="Memory">
                    <span className="q-mon__text q-mon__quiet">Measuring…</span>
                    <span className="q-mon__meter" aria-hidden="true" />
                  </Row>
                  <Row label="Graphics">
                    <span className="q-mon__text q-mon__quiet">Measuring…</span>
                    <span className="q-mon__meter" aria-hidden="true" />
                  </Row>
                </>
              )
            )}
            {started && (
              <Row label="Running">
                <Elapsed since={startedAt} frozen={state === 'saving'} timer />
              </Row>
            )}
            {stats && (
              <Row label="Left">
                {progress ? (
                  <span className="q-mon__text">{finishing ? 'finishing…' : estimate === '' ? 'estimating…' : estimate}</span>
                ) : (
                  <>
                    <span className="q-mon__text q-mon__text--wrap">{NO_ESTIMATE}</span>
                    <span className="q-mon__hint">
                      To get one, the code can call <code>qoop.progress(done, total)</code>
                    </span>
                  </>
                )}
              </Row>
            )}
          </dl>
          {started && !stats && silent && <p className="q-mon__note">{NO_USAGE}</p>}
          {started && (
            <div className="q-mon__actions">
              {/* The same action as the Run block's Stop; nothing to stop once the result is being recorded. */}
              <button type="button" className="q-btn q-btn--sm" disabled={state !== 'running'} title="Stop this Run" onClick={() => runs.stop()}>
                Stop
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * What the Run in flight is doing to this computer: a top-bar control that exists only while a Run is waiting
 * for approval, executing or being recorded in this window — so never for a Guest, in a browser, or at rest.
 * One Run at a time, so one monitor. Nothing here is announced as it changes: the numbers move every second.
 *
 * The Run's name, its step and the graphics processor's name are text written by a person or a program:
 * rendered as text nodes only.
 */
export function RunMonitor() {
  const { live } = useRuns()
  if (!live) return null
  // Keyed by the Run: the next execution starts with the popover closed and nothing remembered.
  return <Monitor key={`${live.block}:${live.branch}`} live={live} />
}
