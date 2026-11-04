import './export.css'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { count } from '../../history/format'
import { fitBounds } from '../geometry'
import { MARGIN } from './look'
import { currentTheme } from './palette'
import { DEFAULT_PNG_SCALE, PNG_SCALES, pngSize } from './png'
import type { PngScale } from './png'
import { makeExport } from './run'
import type { ExportFormat } from './run'
import { boardFileName, inDesktopApp, momentWords, savePng, saveSvg } from './save'
import type { Area, BoardContent } from './svg'

type Props = {
  format: ExportFormat
  content: BoardContent
  branch: string
  /** The moment a History preview shows (null: the start); undefined for the Board as it is now. */
  at?: number | null
  /** What the Board shows on screen, in Board units; null when it is not known (then only the whole Board). */
  visibleArea: Area | null
  onClose: () => void
}

type Choice = { visibleOnly: boolean; light: boolean; scale: PngScale }
/** The last choices, for the next export in this window. */
let remembered: Choice = { visibleOnly: false, light: false, scale: DEFAULT_PNG_SCALE }

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
const px = (v: number) => v.toLocaleString('en-GB').replace(/,/g, ' ')

function overlaps(r: { x: number; y: number; w: number; h: number }, a: Area): boolean {
  return r.x + r.w >= a.x && r.x <= a.x + a.w && r.y + r.h >= a.y && r.y <= a.y + a.h
}

/** "Board as SVG…" / "Board as PNG…": what to include and how, then the file. A modal, like Import BibTeX. */
export function ExportDialog({ format, content, branch, at, visibleArea, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const introId = useId()
  const sizeId = useId()
  const [choice, setChoice] = useState<Choice>(() => ({ ...remembered, visibleOnly: remembered.visibleOnly && visibleArea !== null }))
  const [stage, setStage] = useState<{ kind: 'choose' } | { kind: 'working'; words: string } | { kind: 'failed'; words: string }>({ kind: 'choose' })
  const busy = stage.kind === 'working'
  const cancelled = useRef(false)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    primaryRef.current?.focus()
    cancelled.current = false
    return () => {
      cancelled.current = true // closing stops an export in progress
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  const set = (c: Partial<Choice>) =>
    setChoice((was) => {
      const next = { ...was, ...c }
      remembered = next
      return next
    })

  const area = useMemo<Area | null>(() => {
    if (choice.visibleOnly && visibleArea) return visibleArea
    const b = fitBounds(content.cards, content.frames)
    return b ? { x: b.x - MARGIN, y: b.y - MARGIN, w: b.width + 2 * MARGIN, h: b.height + 2 * MARGIN } : null
  }, [choice.visibleOnly, visibleArea, content])

  const shown = useMemo(() => {
    const a = choice.visibleOnly ? visibleArea : null
    const cards = a ? content.cards.filter((c) => overlaps(c, a)) : content.cards
    const frames = a ? content.frames.filter((f) => overlaps(f, a)) : content.frames
    const ids = new Set(content.cards.map((c) => c.id))
    const conns = content.connections.filter((c) => ids.has(c.from) && ids.has(c.to) && c.from !== c.to).length
    return { cards: cards.length, frames: frames.length, connections: conns }
  }, [choice.visibleOnly, visibleArea, content])

  const size = format === 'png' && area ? pngSize(area, choice.scale) : null
  const name = boardFileName({ branch, at, visibleOnly: choice.visibleOnly, extension: format })
  const theme = currentTheme()

  const start = async () => {
    if (busy) return
    setStage({ kind: 'working', words: 'Preparing…' })
    try {
      const result = await makeExport(
        { format, content, branch, at, visibleArea: choice.visibleOnly ? visibleArea : null, light: choice.light, scale: choice.scale },
        (words) => !cancelled.current && setStage({ kind: 'working', words }),
        () => cancelled.current,
      )
      if (cancelled.current) return
      if (result.format === 'svg') {
        // The save dialog of the desktop app comes next: this one makes way for it.
        closeRef.current()
        await saveSvg(name, result.svg)
      } else {
        closeRef.current()
        savePng(name, result.png)
      }
    } catch (e) {
      if (cancelled.current || (e instanceof DOMException && e.name === 'AbortError')) return
      const why = e instanceof Error && e.message ? e.message : 'Something unexpected went wrong.'
      setStage({ kind: 'failed', words: `The Board could not be exported. ${why}` })
    }
  }

  const close = () => {
    cancelled.current = true
    closeRef.current()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'Tab') return
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (!first || !last) return
    const at = document.activeElement
    if (!ref.current?.contains(at)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && at === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const label = format === 'svg' ? 'SVG' : 'PNG'
  const moment = at === undefined ? 'as it is now' : `at ${momentWords(at)}, the moment History shows`
  const what = `${count(shown.cards, 'Card')}, ${count(shown.frames, 'Frame')}`
  const intro = choice.visibleOnly
    ? `The part of the Board of ${branch} on screen, ${moment}: ${what}, and the Connections that cross it.`
    : `The whole Board of ${branch}, ${moment}: ${what}, ${count(shown.connections, 'Connection')}.`

  return createPortal(
    <div className="q-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="q-dialog qb-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        data-testid="board-export"
      >
        <h2 className="q-dialog__title" id={titleId}>
          Export the Board as {label}
        </h2>
        <p className="q-dialog__body" id={introId}>
          {intro}
        </p>

        <fieldset className="qb-export__options" disabled={busy}>
          <legend className="q-label">Include</legend>
          <label className="qb-export__check">
            <input
              type="checkbox"
              checked={choice.visibleOnly}
              disabled={visibleArea === null}
              onChange={(e) => set({ visibleOnly: e.target.checked })}
            />
            <span>
              Visible area only
              <span className="q-hint">What the Board shows on screen now, cut at its edges.</span>
            </span>
          </label>
          <label className="qb-export__check">
            <input type="checkbox" checked={choice.light} onChange={(e) => set({ light: e.target.checked })} />
            <span>
              Light background
              <span className="q-hint">
                {theme === 'dark' ? 'Light colours on white, for printing and papers.' : 'On white rather than the Board’s tint, for printing and papers.'}{' '}
                Otherwise the {theme} theme, as on screen.
              </span>
            </span>
          </label>
        </fieldset>

        {format === 'png' && (
          <fieldset className="qb-export__options" disabled={busy}>
            <legend className="q-label">Size</legend>
            <div className="qb-export__seg" role="radiogroup" aria-label="Pixels per Board point" aria-describedby={sizeId}>
              {PNG_SCALES.map((s) => (
                <label key={s} className="qb-export__opt">
                  <input type="radio" name="board-export-scale" value={s} checked={choice.scale === s} onChange={() => set({ scale: s })} />
                  <span>{s}×</span>
                </label>
              ))}
            </div>
            <p className="qb-export__size" id={sizeId} aria-live="polite">
              {size && !size.wanted && `${px(size.width)} × ${px(size.height)} px`}
              {size?.wanted &&
                `At ${choice.scale}× it would be ${px(size.wanted.width)} × ${px(size.wanted.height)} px. It will be ${px(size.width)} × ${px(size.height)} px, the largest PNG Infall makes; for every detail, export SVG.`}
            </p>
          </fieldset>
        )}

        {format === 'png' && inDesktopApp() && (
          <p className="qb-export__note" role="note">
            This version of the desktop app saves text files only, so the PNG is offered as a download, which the app may not keep. Board as SVG… is saved where you choose.
          </p>
        )}

        <p className="qb-export__file">
          <span className="q-label">File</span> <span className="qb-export__name">{name}</span>
        </p>

        {stage.kind === 'working' && (
          <p className="qb-export__status" role="status">
            {stage.words}
          </p>
        )}
        {stage.kind === 'failed' && (
          <p className="q-error" role="alert">
            {stage.words}
          </p>
        )}

        <div className="q-dialog__actions">
          <button type="button" className="q-btn" onClick={close}>
            Cancel
          </button>
          {/* aria-disabled while working, so that focus stays on it rather than falling to the page. */}
          <button
            ref={primaryRef}
            type="button"
            className="q-btn q-btn--primary"
            disabled={!area}
            aria-disabled={busy || undefined}
            onClick={() => void start()}
          >
            {busy ? 'Exporting…' : `Export ${label}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
