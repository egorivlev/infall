// The reader's logic that needs no canvas: which pages are drawn, where the view is, find, the remembered page.
import { afterEach, describe, expect, it } from 'vitest'
import { ACTIVE_CLASS, findMatches, firstMatchFrom, markSpans, matchLabel, ordinalOnPage, snippetAt, stepMatch } from './find'
import {
  anchorAt,
  canvasRatio,
  CSS_PER_POINT,
  currentPage,
  fitWidthZoom,
  GAP,
  layoutPages,
  MAX_ZOOM,
  MIN_ZOOM,
  PAD,
  pagesToDraw,
  scrollTopFor,
  scrollTopForAnchor,
  stepZoom,
  zoomLabel,
} from './layout'
import { PAGES_KEY, rememberedPage, rememberPage } from './remember'
import { attachFailure, pdfFacts, pdfStep, sizeText } from './attach'
import { ApiError } from '../../lib'

const LETTER = { width: 612, height: 792 }

describe('page windowing', () => {
  const big = layoutPages([], 300, LETTER, 1)

  it('stacks pages with gaps; an unknown size takes the first page’s', () => {
    const h = Math.round(792 * CSS_PER_POINT)
    expect(big.tops[0]).toBe(PAD)
    expect(big.tops[1]).toBe(PAD + h + GAP)
    expect(big.heights).toHaveLength(300)
    expect(big.total).toBe(PAD + 300 * h + 299 * GAP + PAD)
    const mixed = layoutPages([LETTER, { width: 842, height: 595 }], 3, LETTER, 1)
    expect(mixed.heights[1]).toBe(Math.round(595 * CSS_PER_POINT))
    expect(mixed.width).toBe(Math.round(842 * CSS_PER_POINT))
  })

  it('a 300-page PDF draws only the pages in view and two either side', () => {
    const page = big.heights[0]! + GAP
    const at = (n: number) => big.tops[n - 1]!
    expect(pagesToDraw(big, 0, 800)).toEqual({ first: 1, last: 3 })
    const mid = pagesToDraw(big, at(150) + 10, 800)
    expect(mid.first).toBe(148)
    expect(mid.last - mid.first + 1).toBeLessThanOrEqual(7)
    expect(pagesToDraw(big, big.total - 800, 800).last).toBe(300)
    expect(page).toBeGreaterThan(0)
  })

  it('the current page is the one under a third of the view', () => {
    expect(currentPage(big, 0, 900)).toBe(1)
    expect(currentPage(big, big.tops[9]!, 900)).toBe(10)
    expect(currentPage(big, big.tops[9]! - 400, 900)).toBe(9)
    expect(currentPage(big, big.tops[9]! - 400, 1500)).toBe(10)
  })

  it('goes to a page; an anchor keeps the line across a zoom', () => {
    expect(scrollTopFor(big, 1)).toBe(PAD - GAP)
    expect(scrollTopFor(big, 999)).toBe(big.tops[299]! - GAP)
    const y = big.tops[41]! + big.heights[41]! / 2
    const a = anchorAt(big, y)
    expect(a.page).toBe(42)
    const zoomed = layoutPages([], 300, LETTER, 2)
    const y2 = scrollTopForAnchor(zoomed, a)
    expect(anchorAt(zoomed, y2).page).toBe(42)
    expect(y2).toBeCloseTo(zoomed.tops[41]! - GAP + a.fraction * (zoomed.heights[41]! + GAP), 5)
    expect(scrollTopForAnchor(big, anchorAt(big, scrollTopFor(big, 7)))).toBeCloseTo(scrollTopFor(big, 7), 5)
  })

  it('fit width, zoom steps and their words', () => {
    const z = fitWidthZoom(612, 700)
    expect(Math.round(612 * CSS_PER_POINT * z)).toBe(700 - 2 * PAD)
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(1.03, 1)).toBe(1.1)
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
    expect(zoomLabel(1.25)).toBe('125 %')
  })

  it('HiDPI: device pixels times the interface scale, capped for huge pages', () => {
    expect(canvasRatio(2, 1, 800, 1000)).toBe(2)
    expect(canvasRatio(2, 1.5, 800, 1000)).toBe(3)
    expect(canvasRatio(2, 1, 4000, 5000)).toBeLessThan(2)
    expect(canvasRatio(0, 0, 10, 10)).toBe(1)
  })
})

describe('find in document', () => {
  const pages = ['The surface code has a threshold.', 'No match here.', 'Threshold\nvalues: the THRESHOLD is near 1%. threshold']

  it('finds every match, case ignored, across line breaks', () => {
    const m = findMatches(pages, 'threshold')
    expect(m.map((x) => x.page)).toEqual([1, 3, 3, 3])
    expect(findMatches(pages, 'threshold values')).toEqual([{ page: 3, index: 0, length: 'Threshold\nvalues'.length }])
    expect(findMatches(pages, '   ')).toEqual([])
    expect(findMatches(pages, '1%.')).toHaveLength(1)
  })

  it('steps round the ends, starts from the reader’s page, counts per page', () => {
    const m = findMatches(pages, 'threshold')
    expect(stepMatch(4, 3, 1)).toBe(0)
    expect(stepMatch(4, 0, -1)).toBe(3)
    expect(stepMatch(0, -1, 1)).toBe(-1)
    expect(firstMatchFrom(m, 2)).toBe(1)
    expect(firstMatchFrom(m, 9)).toBe(0)
    expect(ordinalOnPage(m, 3)).toBe(2)
    expect(matchLabel(4, 1)).toBe('2 of 4')
    expect(matchLabel(0, -1)).toBe('No matches')
    expect(matchLabel(1000, 0)).toBe('1 of 1000+')
  })

  it('a snippet around a match', () => {
    expect(snippetAt('a'.repeat(100) + ' threshold ' + 'b'.repeat(100), 101, 9, 10)).toBe('…aaaaaaaaa threshold bbbbbbbbb…')
  })

  it('marks the matches inside the text layer’s spans, and takes old marks out', () => {
    const spans = ['The threshold', 'is', 'Threshold and threshold'].map((t) => {
      const s = document.createElement('span')
      s.textContent = t
      return s
    })
    const marks = markSpans(spans, 'threshold')
    expect(marks).toHaveLength(3)
    expect(spans[0]!.innerHTML).toBe('The <mark class="qr-hit">threshold</mark>')
    expect(spans[2]!.textContent).toBe('Threshold and threshold')
    marks[1]!.classList.add(ACTIVE_CLASS)
    expect(markSpans(spans, 'is')).toHaveLength(1)
    expect(spans[0]!.querySelector('mark')).toBeNull()
    expect(markSpans(spans, '')).toEqual([])
  })
})

describe('the remembered page', () => {
  afterEach(() => localStorage.clear())

  it('per PDF, on this device', () => {
    expect(rememberedPage('h1')).toBeNull()
    rememberPage('h1', 12)
    rememberPage('h2', 3)
    rememberPage('h1', 14)
    expect(rememberedPage('h1')).toBe(14)
    expect(rememberedPage('h2')).toBe(3)
    rememberPage('h3', 0)
    expect(rememberedPage('h3')).toBeNull()
  })

  it('keeps the newest 200; unreadable storage reads as nothing', () => {
    for (let i = 0; i < 205; i++) rememberPage(`h${i}`, i + 1)
    expect(rememberedPage('h0')).toBeNull()
    expect(rememberedPage('h204')).toBe(205)
    localStorage.setItem(PAGES_KEY, '{not json')
    expect(rememberedPage('h204')).toBeNull()
  })

  it('a storage that refuses is not an error', () => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(() => rememberPage('h', 2)).not.toThrow()
    } finally {
      Storage.prototype.setItem = set
    }
  })
})

describe('words', () => {
  it('the Undo steps', () => {
    expect(pdfStep.attach('Parametrized quantum policies')).toBe('Attach a PDF to Parametrized quantum policies')
    expect(pdfStep.replace('')).toBe('Replace the PDF of Untitled Source')
    expect(pdfStep.remove('X')).toBe('Remove the PDF from X')
  })

  it('sizes and pages', () => {
    expect(sizeText(512)).toBe('512 bytes')
    expect(sizeText(820_000)).toBe('820 KB')
    expect(sizeText(1_430_000)).toBe('1.4 MB')
    expect(sizeText(42_000_000)).toBe('42 MB')
    expect(pdfFacts({ size: 1_430_000, pages: 12 })).toBe('12 pages · 1.4 MB')
    expect(pdfFacts({ size: 2000, pages: null })).toBe('2 KB')
  })

  it('failures: the server’s sentence first', () => {
    expect(attachFailure(new ApiError(413, 'too_large', 'This PDF is larger than 100 MB, the most this server takes.'))).toMatch(/100 MB/)
    expect(attachFailure(new ApiError(413, 'http_413', 'Request failed (413).'))).toBe('This PDF is larger than this server takes.')
    expect(attachFailure(new ApiError(0, 'network', 'x'))).toMatch(/cannot be reached/)
    expect(attachFailure(new ApiError(0, 'aborted', 'x'))).toBe('Stopped. Nothing was attached.')
  })
})
