// The PDF reader (decision 7): in the Page panel's place, with page navigation, zoom, fit width, text selection and
// copy, Find in the document, and Open in the system viewer / Save a copy. Only the pages near the view are drawn.
import './reader.css'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { pdfFiles, useBoard, useSession } from '../../lib'
import { pagePanel } from '../bridge'
import { toasts } from '../board/toastStore'
import { saveBytesFile } from '../page/files'
import { desktopOpenExternally } from './desktop'
import { hasNoText, openPdf } from './engine'
import type { PageSize, PdfDoc } from './engine'
import { firstMatchFrom, findMatches, matchLabel, ordinalOnPage, stepMatch } from './find'
import type { Match } from './find'
import {
  anchorAt,
  canvasRatio,
  clampZoom,
  currentPage,
  fitWidthZoom,
  layoutPages,
  pagesToDraw,
  revealTop,
  scrollTopFor,
  scrollTopForAnchor,
  stepZoom,
  zoomLabel,
  ZOOMS,
  CSS_PER_POINT,
} from './layout'
import type { Anchor } from './layout'
import { PdfPage } from './PdfPage'
import type { ReaderTarget } from './readerStore'
import { rememberedPage, rememberPage } from './remember'
import { pdfText } from './text'

export const NO_TEXT = 'This PDF has no text to search or select.'
/** `404 file_missing` (api.md §20): the Source names a file this Workspace does not have, as after an import of a
 * Workspace file exported without its PDFs. */
export const PDF_NOT_INCLUDED = 'This PDF was not included in the Workspace file.'
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const FIND_KEY = MAC ? '⌘F' : 'Ctrl+F'

/** Until the first page says otherwise. */
const LETTER: PageSize = { width: 612, height: 792 }

type Load = { kind: 'loading' } | { kind: 'ready'; doc: PdfDoc } | { kind: 'failed'; text: string }
type TextState = { kind: 'idle' } | { kind: 'reading' } | { kind: 'ready'; pages: string[]; empty: boolean } | { kind: 'missing' }

function openFailure(e: unknown): string {
  const status = (e as { status?: number })?.status
  if (status === 403) return 'This PDF is not available to you.'
  if (status === 404) return PDF_NOT_INCLUDED
  const name = (e as { name?: string })?.name
  if (name === 'InvalidPDFException') return 'The file is damaged or is not a PDF.'
  if (name === 'PasswordException') return 'This PDF is protected by a password, which Infall cannot open.'
  return 'Check the connection, then try again.'
}

function uiZoom(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--q-ui-zoom'))
  return Number.isFinite(v) && v > 0 ? v : 1
}

type Props = {
  target: ReaderTarget
  full: boolean
  /** Back to the Page. */
  onClose: () => void
}

export function PdfReader({ target, full, onClose }: Props) {
  const { hash, name, title } = target
  const session = useSession()
  const board = useBoard()
  const canStore = session.status === 'signed_in' && session.member.role !== 'guest' && !board.readOnly
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [sizes, setSizes] = useState<(PageSize | undefined)[]>([])
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(true)
  const [view, setView] = useState({ top: 0, height: 600, width: 700 })
  const [text, setText] = useState<TextState>({ kind: 'idle' })
  const [findOpen, setFindOpen] = useState(Boolean(target.find))
  const [query, setQuery] = useState(target.find ?? '')
  const [found, setFound] = useState<{ matches: Match[]; current: number }>({ matches: [], current: -1 })
  const [reveal, setReveal] = useState(0)
  const [pageField, setPageField] = useState<string | null>(null)
  const [late, setLate] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const anchor = useRef<Anchor>({ page: target.page ?? rememberedPage(hash) ?? 1, fraction: 0 })
  const headingId = useId()
  const findId = useId()
  const doc = load.kind === 'ready' ? load.doc : null
  const count = doc?.numPages ?? 0

  // ---- opening ----
  useEffect(() => {
    let live = true
    let cancel = () => {}
    let opened: PdfDoc | null = null
    const lateTimer = window.setTimeout(() => live && setLate(true), 150)
    openPdf({ url: pdfFiles.url(hash) }).then(
      async (r) => {
        opened = r.doc
        cancel = r.cancel
        if (!live) return r.doc.destroy()
        const first = await r.doc.pageSize(1).catch(() => ({ width: 612, height: 792 }))
        if (!live) return
        setSizes([first])
        setLoad({ kind: 'ready', doc: r.doc })
        // The other pages' sizes, a few at a time, so the scroll has its true length without holding up the first page.
        const all: (PageSize | undefined)[] = [first]
        for (let n = 2; n <= r.doc.numPages && live; n++) {
          all[n - 1] = await r.doc.pageSize(n).catch(() => undefined)
          if (n % 40 === 0 || n === r.doc.numPages) {
            if (live) setSizes(all.slice())
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        }
      },
      (e: unknown) => {
        if (live) setLoad({ kind: 'failed', text: openFailure(e) })
      },
    )
    return () => {
      live = false
      window.clearTimeout(lateTimer)
      cancel()
      opened?.destroy()
    }
  }, [hash, attempt])

  // ---- layout ----
  const fallback = useMemo(() => sizes[0] ?? LETTER, [sizes])
  const widest = useMemo(() => sizes.reduce((w, s) => Math.max(w, s?.width ?? 0), fallback.width), [sizes, fallback.width])
  const effective = fit ? fitWidthZoom(widest, view.width) : zoom
  const layout = useMemo(() => layoutPages(sizes, count, fallback, effective), [sizes, count, fallback, effective])
  const scale = effective * CSS_PER_POINT
  const page = count ? currentPage(layout, view.top, view.height) : 1
  const draw = pagesToDraw(layout, view.top, view.height)

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight && v.width === el.clientWidth ? v : { top: el.scrollTop, height: el.clientHeight, width: el.clientWidth }))
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, load.kind])

  // Keep the reader on the same line when the zoom or the page sizes change (and go to the opening page).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || count === 0) return
    el.scrollTop = scrollTopForAnchor(layout, anchor.current)
    measure()
  }, [layout, count, measure])

  const frame = useRef(0)
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = scrollRef.current
      if (!el) return
      anchor.current = anchorAt(layout, el.scrollTop)
      measure()
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Remembered per PDF on this device.
  useEffect(() => {
    if (!count) return
    const t = window.setTimeout(() => rememberPage(hash, page), 400)
    return () => window.clearTimeout(t)
  }, [hash, page, count])

  const goTo = useCallback(
    (n: number) => {
      const el = scrollRef.current
      if (!el || !count) return
      const to = Math.min(count, Math.max(1, Math.round(n)))
      el.scrollTop = scrollTopFor(layout, to)
      anchor.current = anchorAt(layout, el.scrollTop)
      measure()
    },
    [layout, count, measure],
  )

  const onReveal = useCallback(
    (n: number, fraction: number) => {
      const el = scrollRef.current
      if (!el) return
      const i = n - 1
      const y = (layout.tops[i] ?? 0) + fraction * (layout.heights[i] ?? 0)
      const to = revealTop(layout, n, y, el.clientHeight)
      if (Math.abs(to - el.scrollTop) < 4) return
      // A jump, never a smooth scroll: nothing in the reader moves by itself.
      el.scrollTop = to
      anchor.current = anchorAt(layout, to)
      measure()
    },
    [layout, measure],
  )

  // ---- zoom ----
  const setZoomTo = (z: number) => {
    setFit(false)
    setZoom(clampZoom(z))
  }
  const zoomBy = (dir: 1 | -1) => setZoomTo(stepZoom(effective, dir))

  // ---- find ----
  const pages = text.kind === 'ready' ? text.pages : null
  const startPage = useRef(target.page ?? null)
  // Read by the handlers below as they are at that moment.
  const now = useRef({ page, goTo, pages, query, findOpen })
  useEffect(() => {
    now.current = { page, goTo, pages, query, findOpen }
  })
  /**
   * Finds `q` in `list` and chooses the first match from where the reader is — or, the first time, from the page a
   * search result named — scrolling there. Called where the query, the text or Find's being open change.
   */
  const research = useCallback((list: string[] | null, q: string, open: boolean) => {
    const matches = list && open ? findMatches(list, q) : []
    const from = startPage.current ?? now.current.page
    if (matches.length > 0) startPage.current = null
    const i = firstMatchFrom(matches, from)
    setFound({ matches, current: i })
    if (i < 0) return
    setReveal((r) => r + 1)
    const m = matches[i]!
    if (m.page !== now.current.page) now.current.goTo(m.page)
  }, [])
  const { matches, current } = found

  // The text (for Find, for search, and to say when there is none): read once, sent once (decision 8).
  useEffect(() => {
    if (!doc) return
    let live = true
    pdfText(hash, doc, canStore).then(
      (pages) => {
        if (!live) return
        setText(pages ? { kind: 'ready', pages, empty: hasNoText(pages) } : { kind: 'missing' })
        if (pages) research(pages, now.current.query, now.current.findOpen)
      },
      () => live && setText({ kind: 'missing' }),
    )
    return () => {
      live = false
    }
  }, [doc, hash, canStore, research])


  const step = (dir: 1 | -1) => {
    const i = stepMatch(matches.length, current, dir)
    if (i < 0) return
    setFound({ matches, current: i })
    setReveal((r) => r + 1)
    const m = matches[i]!
    if (m.page !== page) goTo(m.page)
  }
  const activeMatch = current >= 0 ? matches[current] : undefined
  const activeOrdinal = current >= 0 ? ordinalOnPage(matches, current) : -1

  const openFind = () => {
    if (!findOpen) research(pages, query, true)
    setFindOpen(true)
    requestAnimationFrame(() => {
      findRef.current?.focus()
      findRef.current?.select()
    })
  }
  const closeFind = () => {
    setFindOpen(false)
    setFound({ matches: [], current: -1 })
    scrollRef.current?.focus({ preventScroll: true })
  }

  // ---- the file ----
  const openOutside = desktopOpenExternally()
  const [busyFile, setBusyFile] = useState(false)
  const handOver = async () => {
    if (!doc || busyFile) return
    setBusyFile(true)
    try {
      const bytes = await doc.data()
      if (openOutside) await openOutside({ suggestedName: name, bytes })
      else {
        const saved = await saveBytesFile(name, bytes, 'application/pdf')
        if (saved === 'saved') toasts.show({ message: `Saved a copy of “${name}”.` })
        else if (saved === 'downloaded') toasts.show({ message: `Downloaded “${name}”.` })
      }
    } catch (e) {
      const why = e instanceof Error && e.message ? ` ${e.message}` : ''
      toasts.show({ message: openOutside ? `The system viewer could not be opened.${why}` : `The PDF could not be saved.${why}` })
    } finally {
      setBusyFile(false)
    }
  }

  // ---- keys ----
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const inField = e.target instanceof HTMLElement && e.target.closest('input, textarea, select') !== null
    const mod = (MAC ? e.metaKey : e.ctrlKey) && !e.altKey
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      e.stopPropagation()
      openFind()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (findOpen && e.target instanceof Node && rootRef.current?.querySelector('.qr-find')?.contains(e.target)) closeFind()
      else if (inField && e.target !== findRef.current) (e.target as HTMLElement).blur()
      else onClose()
      return
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return
    const el = scrollRef.current
    switch (e.key) {
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault()
        goTo(page - 1)
        break
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault()
        goTo(page + 1)
        break
      case 'Home':
        e.preventDefault()
        goTo(1)
        break
      case 'End':
        e.preventDefault()
        goTo(count)
        break
      case 'ArrowDown':
      case 'ArrowUp':
        if (el && e.target !== el) {
          e.preventDefault()
          el.scrollTop += e.key === 'ArrowDown' ? 48 : -48
        }
        break
      case '+':
      case '=':
        e.preventDefault()
        zoomBy(1)
        break
      case '-':
        e.preventDefault()
        zoomBy(-1)
        break
      case '0':
        e.preventDefault()
        setFit(true)
        break
    }
  }

  // ⌘F with nothing focused (the body) while the reader shows: the reader's Find, not the browser's.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = (MAC ? e.metaKey : e.ctrlKey) && !e.altKey
      if (!mod || e.key.toLowerCase() !== 'f') return
      const at = document.activeElement
      if (at && at !== document.body && !rootRef.current?.contains(at)) return
      e.preventDefault()
      if (!now.current.findOpen) research(now.current.pages, now.current.query, true)
      setFindOpen(true)
      requestAnimationFrame(() => {
        findRef.current?.focus()
        findRef.current?.select()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [research])

  // Focus goes into the reader when it opens, so the keys work at once.
  // (Find starts open when a search result opened the reader.)
  const findFirst = Boolean(target.find)
  useEffect(() => {
    if (!findFirst) return scrollRef.current?.focus({ preventScroll: true })
    const raf = requestAnimationFrame(() => findRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [findFirst])

  const ratio = canvasRatio(window.devicePixelRatio || 1, uiZoom(), layout.width, layout.heights[0] ?? 1)
  const pageList: number[] = []
  for (let n = draw.first; n <= draw.last; n++) pageList.push(n)

  const findStatus =
    text.kind === 'reading' || text.kind === 'idle'
      ? 'Reading the text…'
      : text.kind === 'missing'
        ? 'The text of this PDF could not be read.'
        : text.empty
          ? NO_TEXT
          : query.trim() === ''
            ? ''
            : matchLabel(matches.length, current)

  return (
    <section
      ref={rootRef}
      className={`qp-panel qr${full ? ' is-full' : ''}`}
      aria-labelledby={headingId}
      data-testid="pdf-reader"
      onKeyDown={onKeyDown}
    >
      <header className="qr-head">
        <button type="button" className="qr-back" aria-label="Back to the Page" title="Back to the Page (Esc)" onClick={onClose}>
          <span aria-hidden="true">‹</span> Page
        </button>
        <h2 className="qr-title" id={headingId}>
          <span className="qr-title__name">{title}</span>
          <span className="qr-title__file">{name}</span>
        </h2>
        <span className="qp-spacer" />
        <button type="button" className="qr-tool" aria-disabled={!doc || busyFile ? true : undefined} onClick={() => void handOver()}>
          {openOutside ? 'Open in the system viewer' : 'Save a copy'}
        </button>
        <button
          type="button"
          className="qp-head__btn"
          aria-pressed={full}
          aria-label="Open full width"
          title={full ? 'Back to the side panel' : 'Open full width'}
          onClick={() => pagePanel.toggleFull()}
        >
          ⤢
        </button>
        <button type="button" className="qp-head__btn" aria-label="Close the PDF" title="Close the PDF" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="qr-bar" role="toolbar" aria-label="PDF">
        <span className="qr-group">
          <button type="button" className="qr-icon" aria-label="Previous page" title="Previous page (←, PageUp)" aria-disabled={page <= 1 ? true : undefined} onClick={() => goTo(page - 1)}>
            ‹
          </button>
          <label className="qr-pagefield">
            <span className="q-sr">Page</span>
            <input
              className="qr-pagefield__input"
              inputMode="numeric"
              value={pageField ?? String(count ? page : 0)}
              aria-label={`Page, of ${count}`}
              onFocus={(e) => {
                setPageField(String(page))
                e.target.select()
              }}
              onChange={(e) => setPageField(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => setPageField(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (pageField) goTo(Number(pageField))
                  setPageField(null)
                  scrollRef.current?.focus({ preventScroll: true })
                }
              }}
            />
            <span className="qr-pagefield__of" aria-hidden="true">
              of {count}
            </span>
          </label>
          <button type="button" className="qr-icon" aria-label="Next page" title="Next page (→, PageDown)" aria-disabled={page >= count ? true : undefined} onClick={() => goTo(page + 1)}>
            ›
          </button>
        </span>
        <span className="qr-group">
          <button type="button" className="qr-icon" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(-1)}>
            −
          </button>
          <label className="qr-zoom">
            <span className="q-sr">Zoom</span>
            <select
              className="qr-zoom__select"
              value={fit ? 'fit' : String(zoom)}
              onChange={(e) => (e.target.value === 'fit' ? setFit(true) : setZoomTo(Number(e.target.value)))}
            >
              <option value="fit">Fit width ({zoomLabel(fit ? effective : fitWidthZoom(widest, view.width))})</option>
              {!fit && !ZOOMS.includes(zoom as (typeof ZOOMS)[number]) && <option value={String(zoom)}>{zoomLabel(zoom)}</option>}
              {ZOOMS.map((z) => (
                <option key={z} value={String(z)}>
                  {zoomLabel(z)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="qr-icon" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1)}>
            +
          </button>
          <button type="button" className="qr-tool" aria-pressed={fit} title="Fit the page to the width (0)" onClick={() => setFit(true)}>
            Fit width
          </button>
        </span>
        <span className="qp-spacer" />
        <button type="button" className="qr-tool" aria-pressed={findOpen} aria-controls={findOpen ? findId : undefined} title={`Find in this PDF (${FIND_KEY})`} onClick={() => (findOpen ? closeFind() : openFind())}>
          Find
        </button>
      </div>

      {findOpen && (
        <div className="qr-find" id={findId} role="search" aria-label="Find in this PDF">
          <label className="qr-find__label">
            <span className="q-sr">Find in this PDF</span>
            <input
              ref={findRef}
              type="search"
              className="q-input qr-find__input"
              placeholder="Find in this PDF"
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value)
                research(pages, e.target.value, true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? -1 : 1)
                }
              }}
            />
          </label>
          <span className="qr-find__status" role="status" aria-live="polite">
            {findStatus}
          </span>
          <button type="button" className="qr-icon" aria-label="Previous match" title="Previous match (⇧Enter)" aria-disabled={matches.length === 0 ? true : undefined} onClick={() => step(-1)}>
            ↑
          </button>
          <button type="button" className="qr-icon" aria-label="Next match" title="Next match (Enter)" aria-disabled={matches.length === 0 ? true : undefined} onClick={() => step(1)}>
            ↓
          </button>
          <button type="button" className="qr-icon" aria-label="Close Find" title="Close Find (Esc)" onClick={closeFind}>
            ✕
          </button>
        </div>
      )}

      {text.kind === 'ready' && text.empty && !findOpen && (
        <p className="qr-note" role="status">
          {NO_TEXT}
        </p>
      )}

      <div className="qr-scroll" ref={scrollRef} tabIndex={0} aria-label={`${title}, page ${page} of ${count}`} onScroll={onScroll} data-testid="pdf-scroll">
        {load.kind === 'loading' && late && <p className="qr-state">Opening the PDF…</p>}
        {load.kind === 'failed' && (
          <div className="qr-state" role="alert">
            {/* A file left out of the Workspace file is not there to try again: the sentence says why, alone. */}
            <p>{load.text === PDF_NOT_INCLUDED ? load.text : `The PDF could not be opened. ${load.text}`}</p>
            {load.text !== PDF_NOT_INCLUDED && (
              <button
                type="button"
                className="q-btn"
                onClick={() => {
                  setLoad({ kind: 'loading' })
                  setLate(false)
                  setAttempt((a) => a + 1)
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {doc && (
          <div className="qr-pages" style={{ height: layout.total, minWidth: layout.width + 32 }}>
            {pageList.map((n) => (
              <PdfPage
                key={n}
                doc={doc}
                n={n}
                count={count}
                top={layout.tops[n - 1]!}
                width={layout.widths[n - 1]!}
                height={layout.heights[n - 1]!}
                scale={scale}
                ratio={ratio}
                query={findOpen ? query : ''}
                active={activeMatch?.page === n ? activeOrdinal : -1}
                reveal={reveal}
                onReveal={onReveal}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
