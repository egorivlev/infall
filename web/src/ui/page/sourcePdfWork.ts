// M19: the work on a Source's PDF (attach, replace after a confirmation, remove), shared by the rows of the Page's
// Sources and the drop of a file on the section. Each is one Undo step, named by `pdfStep`.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { pdfOps, undo } from '../../lib'
import type { AttachedSource } from '../../lib'
import { toasts } from '../board/toastStore'
import { showUndoNote } from '../board/undoActions'
import { useBoardActions } from '../board/useBoardActions'
import { attachFailure, attachOps, looksLikePdf, pdfStep, preparePdf } from '../pdf/attach'

/** Where one Source's PDF stands while something is being done to it. */
export type PdfWork =
  | { kind: 'sending'; name: string; sent: number; total: number; stop: () => void }
  | { kind: 'confirm'; file: File }
  | { kind: 'failed'; text: string }

const NOT_PDF = (name: string) => `“${name}” is not a PDF. Attach a .pdf file.`

let removals = 0

/** The work on each Source's PDF, and the gestures that start it. Shared by the rows and the drop on the section. */
export function usePdfWork(cardId: string) {
  const actions = useBoardActions()
  const [work, setWork] = useState<Record<string, PdfWork>>({})
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const put = useCallback((id: string, w: PdfWork | null) => {
    if (!alive.current) return
    setWork((all) => {
      const next = { ...all }
      if (w) next[id] = w
      else delete next[id]
      return next
    })
  }, [])

  /** Sends `file` and puts it on `source` (replacing what it had: the caller confirmed). */
  const send = useCallback(
    async (source: AttachedSource, file: File) => {
      const ctrl = new AbortController()
      const had = source.pdf !== undefined
      put(source.id, { kind: 'sending', name: file.name, sent: 0, total: file.size, stop: () => ctrl.abort() })
      try {
        const pdf = await preparePdf(file, file.name, {
          signal: ctrl.signal,
          onProgress: (sent, total) => put(source.id, { kind: 'sending', name: file.name, sent, total, stop: () => ctrl.abort() }),
        })
        put(source.id, null)
        const label = had ? pdfStep.replace(source.title) : pdfStep.attach(source.title)
        await actions.submit(attachOps(source.id, pdf), { label })
      } catch (e) {
        put(source.id, { kind: 'failed', text: attachFailure(e) })
      }
    },
    [actions, put],
  )

  /** A file picked or dropped for `source`: a PDF without one is sent at once; one that would replace asks first. */
  const offer = useCallback(
    (source: AttachedSource, file: File) => {
      if (!looksLikePdf(file)) return put(source.id, { kind: 'failed', text: NOT_PDF(file.name) })
      if (source.pdf) return put(source.id, { kind: 'confirm', file })
      void send(source, file)
    },
    [put, send],
  )

  const remove = useCallback(
    (source: AttachedSource) => {
      const key = `pdf-remove:${++removals}`
      const name = source.title || 'Untitled Source'
      const pending = actions.submit(pdfOps.remove(source.id), { label: pdfStep.remove(source.title), key })
      const id = toasts.show({
        message: `Removed the PDF from ${name}.`,
        action: {
          label: 'Undo',
          run: () => {
            toasts.dismiss(id)
            void pending.then(async (ok) => {
              if (ok) showUndoNote(await undo.undo(key))
            })
          },
        },
      })
    },
    [actions],
  )

  return { work, offer, send, remove, clear: (id: string) => put(id, null), cardId }
}

export type PdfWorkApi = ReturnType<typeof usePdfWork>

/** Dropping a PDF file on the Sources section: on a Source's row, or anywhere when the Card has only one Source. */
export function usePdfDrop(sources: readonly AttachedSource[], canEdit: boolean, api: PdfWorkApi) {
  const [over, setOver] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const target = (e: DragEvent): AttachedSource | undefined => {
    const row = e.target instanceof Element ? e.target.closest('[data-source]') : null
    const id = row?.getAttribute('data-source')
    if (id) return sources.find((s) => s.id === id)
    return sources.length === 1 ? sources[0] : undefined
  }
  if (!canEdit) return { over: null, note: '', handlers: {} }
  return {
    over,
    note,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        const t = target(e)
        setOver(t ? t.id : '')
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget instanceof Element && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setOver(null)
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(null)
        const file = e.dataTransfer.files?.[0]
        if (!file) return
        const t = target(e)
        if (!t) {
          setNote(sources.length === 0 ? 'Add the Source first, then attach its PDF.' : 'Drop the PDF on the Source it belongs to.')
          return
        }
        setNote('')
        api.offer(t, file)
      },
    },
  }
}
