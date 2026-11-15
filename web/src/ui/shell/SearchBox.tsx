import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { boardBridge, pagePanel, searchUse } from '../bridge'
import { pdfFiles, useBoard, useSources } from '../../lib'
import type { PdfHit } from '../../lib'
import { pdfReader } from '../pdf/readerStore'
import { Icon } from './Icon'
import { searchCards } from './searchCards'
import { markedParts, pdfResultText, pdfResults } from './searchPdf'
import type { PdfResult } from './searchPdf'
import { useDismiss } from './useDismiss'
import { useOnBoard } from './useOnBoard'

const HINT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

export function SearchBox() {
  const { cards } = useBoard()
  const sources = useSources()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const onBoard = useOnBoard()

  const results = useMemo(() => searchCards(cards, query), [cards, query])
  // M19: words in the PDFs of Sources (the server's stored text), asked for a moment after typing stops.
  const [pdfHits, setPdfHits] = useState<{ q: string; hits: PdfHit[] }>({ q: '', hits: [] })
  const q = query.trim()
  useEffect(() => {
    if ([...q].length < 2) return
    let live = true
    const t = window.setTimeout(() => {
      pdfFiles.search(q).then(
        (hits) => live && setPdfHits({ q, hits }),
        () => live && setPdfHits({ q, hits: [] }),
      )
    }, 200)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [q])
  const inPdfs = useMemo(() => (pdfHits.q === q && q !== '' ? pdfResults(pdfHits.hits, sources, cards) : []), [pdfHits, q, sources, cards])
  const total = results.length + inPdfs.length
  const showList = open && query.trim() !== ''
  const close = useCallback(() => setOpen(false), [])
  useDismiss(showList, close, boxRef, inputRef)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const choose = (id: string) => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    searchUse.chose(id)
    onBoard(() => boardBridge.focus('card', id))
  }

  /** A place in a PDF: the Card's Page, and the reader at that page with the words found. */
  const choosePdf = (r: PdfResult) => {
    const words = query.trim()
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    searchUse.chose(r.cardId)
    onBoard(() => {
      boardBridge.focus('card', r.cardId)
      pagePanel.open(r.cardId)
      pdfReader.open({ cardId: r.cardId, sourceId: r.sourceId, hash: r.hash, name: r.fileName, title: r.sourceTitle, page: r.page, find: words })
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!total) return
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + step + total) % total)
    } else if (e.key === 'Enter') {
      const hit = results[active]
      const pdf = inPdfs[active - results.length]
      if (showList && (hit || pdf)) {
        e.preventDefault()
        if (hit) choose(hit.id)
        else if (pdf) choosePdf(pdf)
      }
    } else if (e.key === 'Escape' && !showList && query) {
      setQuery('')
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`

  return (
    <div className="q-search" ref={boxRef}>
      <label className="q-sr" htmlFor={`${listId}-input`}>
        Search Cards
      </label>
      <span className="q-search__icon">
        <Icon name="search" size={13} />
      </span>
      <input
        id={`${listId}-input`}
        ref={inputRef}
        className="q-search__input"
        type="search"
        role="combobox"
        placeholder="Search Cards"
        autoComplete="off"
        spellCheck={false}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active < total ? optionId(active) : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <kbd className="q-search__kbd" aria-hidden="true">
        {HINT}
      </kbd>
      {showList && (
        <div className="q-search__pop">
          {total > 0 ? (
            <ul id={listId} role="listbox" aria-label="Matching Cards" className="q-search__list">
              {results.map((c, i) => (
                <li
                  key={c.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className="q-search__opt"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(c.id)}
                >
                  <span className={`q-search__title${c.title ? '' : ' q-search__title--empty'}`}>{c.title || 'Untitled'}</span>
                  {c.summary && <span className="q-search__sum">{c.summary}</span>}
                </li>
              ))}
              {inPdfs.length > 0 && (
                <li role="presentation" className="q-search__group">
                  In PDFs
                </li>
              )}
              {inPdfs.map((r, j) => {
                const i = results.length + j
                return (
                  <li
                    key={r.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    aria-label={`${pdfResultText(r)}: ${r.snippet}`}
                    className="q-search__opt q-search__opt--pdf"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choosePdf(r)}
                  >
                    <span className="q-search__where">
                      in the PDF of <b>{r.sourceTitle}</b>, page {r.page}
                    </span>
                    {r.snippet && (
                      <span className="q-search__sum">
                        {markedParts(r.snippet, query).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="q-search__none" id={listId}>
              No Cards match.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
