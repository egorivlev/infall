// One page of the reader: its canvas and, over it, the transparent text layer (selection, copy, find's marks).
// Mounted only while the page is near the view (layout.ts `pagesToDraw`), so a long PDF keeps a handful of canvases.
import { memo, useEffect, useRef, useState } from 'react'
import type { PdfDoc } from './engine'
import { ACTIVE_CLASS, markSpans } from './find'

type Props = {
  doc: PdfDoc
  n: number
  count: number
  top: number
  width: number
  height: number
  /** CSS pixels per PDF point. */
  scale: number
  /** Device pixels per CSS pixel for the canvas. */
  ratio: number
  query: string
  /** Which of this page's marks is the current match; -1 for none. */
  active: number
  /** Changes when the current match should be scrolled to (a step in Find). */
  reveal: number
  /** Scrolls the reader so that a point `fraction` of the way down this page is in the middle of the view. */
  onReveal: (n: number, fraction: number) => void
}

const NONE: HTMLElement[] = []

export const PdfPage = memo(function PdfPage({ doc, n, count, top, width, height, scale, ratio, query, active, reveal, onReveal }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState(false)
  const [failed, setFailed] = useState(false)
  const [spans, setSpans] = useState<HTMLElement[] | null>(null)
  const [marked, setMarked] = useState<{ query: string; marks: HTMLElement[] }>({ query: '', marks: [] })
  // Marks made for another query (the effect below has not run yet) are not this query's.
  const marks = marked.query === query ? marked.marks : NONE

  // The picture: drawn into a fresh canvas, which replaces the old one only once it is ready (no blank flash on zoom).
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.className = 'qr-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    let live = true
    const task = doc.render(n, canvas, scale, ratio)
    task.promise.then(
      () => {
        if (!live || !holder.current) return
        holder.current.querySelector('canvas.qr-canvas')?.remove()
        holder.current.prepend(canvas)
        setDrawn(true)
        setFailed(false)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
      task.cancel()
    }
  }, [doc, n, scale, ratio])

  // Free the old canvas's memory when the page leaves the view.
  useEffect(() => {
    const el = holder.current
    return () => {
      const c = el?.querySelector<HTMLCanvasElement>('canvas.qr-canvas')
      if (c) {
        c.width = 0
        c.height = 0
      }
    }
  }, [])

  // The text, laid over the picture.
  useEffect(() => {
    const container = textRef.current
    if (!container) return
    let live = true
    const task = doc.textLayer(n, container, scale)
    task.promise.then(
      (divs) => {
        if (live) setSpans(divs)
      },
      () => {},
    )
    return () => {
      live = false
      task.cancel()
    }
  }, [doc, n, scale])

  useEffect(() => {
    setMarked({ query, marks: spans ? markSpans(spans, query) : [] })
  }, [spans, query])

  useEffect(() => {
    marks.forEach((m, i) => m.classList.toggle(ACTIVE_CLASS, i === active))
  }, [marks, active])

  // Bring the current match into the middle of the view once its mark exists.
  const revealed = useRef(-1)
  useEffect(() => {
    if (active < 0 || revealed.current === reveal) return
    const mark = marks[active]
    const page = holder.current
    if (!mark || !page) return
    revealed.current = reveal
    const p = page.getBoundingClientRect()
    const r = mark.getBoundingClientRect()
    if (p.height > 0) onReveal(n, (r.top + r.height / 2 - p.top) / p.height)
  }, [marks, active, reveal, n, onReveal])

  return (
    <div
      className={`qr-page${drawn ? '' : ' is-drawing'}`}
      ref={holder}
      role="group"
      aria-label={`Page ${n} of ${count}`}
      data-page={n}
      style={{ top, width, height, left: `max(16px, calc(50% - ${width / 2}px))` }}
    >
      <div className="textLayer qr-text" ref={textRef} />
      {failed && <p className="qr-page__failed">Page {n} could not be drawn.</p>}
    </div>
  )
})
