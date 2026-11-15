// The PDF renderer, seen from the reader: a small interface over pdf.js. pdf.js itself (and its worker) is loaded
// only when a PDF is opened, attached or counted — a dynamic import, so it stays out of the first load.
//
// Everything that touches pdf.js is in engineImpl.ts; tests replace this module.

/** A page's size at scale 1, in PDF points (1/72 in). */
export type PageSize = { width: number; height: number }

/** Something running that can be stopped (a render, a text layer, a load). */
export type Task<T> = { promise: Promise<T>; cancel(): void }

export type PdfDoc = {
  numPages: number
  /** Page `n` (from 1): its size at scale 1. */
  pageSize(n: number): Promise<PageSize>
  /** Draws page `n` into `canvas`: `scale` CSS pixels per point, `pixelRatio` device pixels per CSS pixel. */
  render(n: number, canvas: HTMLCanvasElement, scale: number, pixelRatio: number): Task<void>
  /** Lays the text of page `n` over it as transparent spans in `container` (selection, copy, find); resolves with them. */
  textLayer(n: number, container: HTMLElement, scale: number): Task<HTMLElement[]>
  /** The text of page `n`, for search: runs joined, a line break where the PDF ends a line. */
  pageText(n: number): Promise<string>
  /** The whole file. */
  data(): Promise<Uint8Array>
  destroy(): void
}

export type PdfSource = { url: string } | { data: Uint8Array }

export type Engine = {
  open(source: PdfSource): Task<PdfDoc>
}

let loading: Promise<Engine> | null = null

/** pdf.js, loaded once; a failed load is tried again next time. */
export function loadEngine(): Promise<Engine> {
  loading ??= import('./engineImpl').then(
    (m) => m.engine,
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

/** Opens a PDF from its bytes or its URL. */
export async function openPdf(source: PdfSource): Promise<{ doc: PdfDoc; cancel(): void }> {
  const engine = await loadEngine()
  const task = engine.open(source)
  return { doc: await task.promise, cancel: task.cancel }
}

/** The page count of a PDF given as bytes; null when pdf.js cannot read it. */
export async function countPages(bytes: Uint8Array): Promise<number | null> {
  try {
    const { doc } = await openPdf({ data: bytes })
    const n = doc.numPages
    doc.destroy()
    return n > 0 ? n : null
  } catch {
    return null
  }
}

/** The text of every page (page 1 first), read one page at a time so a long PDF does not hold up the page. */
export async function extractText(doc: PdfDoc, isCancelled: () => boolean = () => false): Promise<string[] | null> {
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    if (isCancelled()) return null
    try {
      pages.push(await doc.pageText(n))
    } catch {
      pages.push('')
    }
    // A breath now and then: the reader stays responsive while a 300-page PDF is read.
    if (n % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return pages
}

/** Whether extracted text has nothing to search or select (a scanned PDF). */
export function hasNoText(pages: readonly string[]): boolean {
  return pages.every((p) => p.trim() === '')
}
