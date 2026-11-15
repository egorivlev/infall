// pdf.js behind the reader's small interface (engine.ts). Loaded only through `loadEngine()`'s dynamic import.
//
// Under the server's CSP (`default-src 'self'`, no `blob:`, no `'unsafe-eval'`, no `'wasm-unsafe-eval'`):
// - the worker is a same-origin file emitted by Vite (`?url`), so pdf.js starts it directly — no blob: wrapper;
// - pdf.js 6 has no eval path left (fonts are drawn from paths, PostScript functions are interpreted);
// - WebAssembly is switched off (`useWasm: false`): the JPEG 2000 and JBIG2 decoders use pdf.js's JS fallbacks,
//   loaded with import() from `wasmUrl` on this origin;
// - standard fonts and CMaps come from this origin too (`/pdfjs/…`, copied there at build time: vite.config.ts).
import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Engine, PdfDoc, PdfSource, Task } from './engine'

GlobalWorkerOptions.workerSrc = workerSrc

/** Where the files pdf.js fetches on demand are served from (see vite.config.ts). */
export const ASSET_BASE = '/pdfjs/'

function wrap(doc: PDFDocumentProxy): PdfDoc {
  const pages = new Map<number, Promise<PDFPageProxy>>()
  const page = (n: number) => {
    let p = pages.get(n)
    if (!p) pages.set(n, (p = doc.getPage(n)))
    return p
  }
  return {
    numPages: doc.numPages,
    async pageSize(n) {
      const vp = (await page(n)).getViewport({ scale: 1 })
      return { width: vp.width, height: vp.height }
    },
    render(n, canvas, scale, pixelRatio): Task<void> {
      let task: { cancel(): void } | null = null
      let cancelled = false
      const promise = page(n).then(async (p) => {
        if (cancelled) return
        const viewport = p.getViewport({ scale })
        // Whole device pixels, and the CSS size set from them, so the page is crisp on HiDPI screens.
        const width = Math.floor(viewport.width * pixelRatio)
        const height = Math.floor(viewport.height * pixelRatio)
        canvas.width = width
        canvas.height = height
        const run = p.render({
          canvas,
          viewport,
          transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
          background: '#ffffff',
        })
        task = run
        try {
          await run.promise
        } catch (e) {
          if ((e as { name?: string })?.name === 'RenderingCancelledException') return
          throw e
        }
      })
      return {
        promise,
        cancel() {
          cancelled = true
          task?.cancel()
        },
      }
    },
    textLayer(n, container, scale): Task<HTMLElement[]> {
      let layer: TextLayer | null = null
      let cancelled = false
      const promise = page(n).then(async (p) => {
        if (cancelled) return []
        const viewport = p.getViewport({ scale })
        container.replaceChildren()
        container.style.setProperty('--total-scale-factor', String(scale))
        layer = new TextLayer({ textContentSource: p.streamTextContent(), container, viewport })
        await layer.render()
        return layer.textDivs as HTMLElement[]
      })
      return {
        promise,
        cancel() {
          cancelled = true
          layer?.cancel()
        },
      }
    },
    async pageText(n) {
      const content = await (await page(n)).getTextContent()
      let out = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        out += item.str
        if (item.hasEOL) out += '\n'
      }
      return out
    },
    data: () => doc.getData(),
    destroy() {
      pages.clear()
      void doc.loadingTask.destroy()
    },
  }
}

export const engine: Engine = {
  open(source: PdfSource): Task<PdfDoc> {
    const task = getDocument({
      ...('url' in source ? { url: source.url, rangeChunkSize: 256 * 1024, disableAutoFetch: true } : { data: source.data.slice() }),
      useWasm: false,
      wasmUrl: `${ASSET_BASE}wasm/`,
      standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
      cMapUrl: `${ASSET_BASE}cmaps/`,
      iccUrl: `${ASSET_BASE}iccs/`,
      enableXfa: false,
      // Every request stays on this origin with the session cookie.
      withCredentials: false,
    })
    return {
      promise: task.promise.then(wrap),
      cancel: () => void task.destroy(),
    }
  },
}
