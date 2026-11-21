import '../port.css'
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, board, page, undo } from '../../../lib'
import { preparePdf } from '../../pdf/attach'
import { desktopFolders } from '../../pdf/desktop'
import { readFileText } from '../files'
import { count } from '../people'
import { packBatches, planBoardImport, planCardImport } from './importPlan'
import type { ImportPlan } from './importPlan'
import { addPdfOps, entriesWithPdf, gatherPdfs, outcomeLines } from './importPdfs'
import type { PdfOutcome } from './importPdfs'
import { describeProblem, parseBibtex } from './parse'

/** Where the entries go: Sources on one Card, or Cards in a new Frame on the Board. */
export type ImportTarget =
  | { kind: 'card'; cardId: string }
  | {
      kind: 'board'
      /** The Frame's top-left corner, asked for when the import starts. */
      place: () => { x: number; y: number }
      /** Called with the new Frame once everything has arrived (the Board shows it). */
      onFrame: (frameId: string) => void
    }

type Props = {
  target: ImportTarget
  onClose: () => void
  /** What opened the dialog; focus goes back to it (Safari does not focus a clicked button). Default: what had focus. */
  opener?: HTMLElement | null
}

/** Larger than any BibTeX file a person keeps; probably the wrong file. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

type Stage =
  | { kind: 'choose' }
  | { kind: 'attaching'; done: number; total: number }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'done'; total: number; created: number; reused: number; pdfs: PdfOutcome | null }
  | { kind: 'stopped'; done: number; total: number; why: string; pdfs: PdfOutcome | null }

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Sends the batches one after the other, so the person sees it move and the Board stays responsive. All of them are
 * one step of Undo, however many entries (docs/specs/undo.md decision 3).
 */
async function send(plan: ImportPlan, entries: number, onProgress: (done: number) => void): Promise<{ done: number; error?: unknown }> {
  let done = 0
  const step = undo.begin({ label: `Import ${count(entries, 'entry', 'entries')} from BibTeX` })
  try {
    for (const batch of packBatches(plan)) {
      try {
        await step.add(() => board.submit(batch.ops))
      } catch (error) {
        return { done, error }
      }
      done += batch.entries
      onProgress(done)
      // A breath between batches: React paints the progress, other Members' Changes come in.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    step.end()
  }
  return { done }
}

function stoppedBecause(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'closed') return 'the Board was closed before it finished.'
    if (error.status === 0) return 'the server could not be reached. Check the connection, then import the rest again.'
    return error.message.endsWith('.') ? error.message : `${error.message}.`
  }
  return 'something unexpected went wrong.'
}

/** The report's line when the file named PDFs but none were attached. */
function noFilesLine(n: number, desktop: boolean): string {
  const had = n === 1 ? '1 entry had a PDF in its file field' : `${n} entries had a PDF in their file field`
  return desktop ? `${had}; no folder was picked, so no PDF was attached.` : `${had}; in a browser no PDF is attached (the desktop app can attach them).`
}

const fileTitle = (name: string) => name.replace(/\.(bib|bibtex|txt)$/i, '').trim()

/**
 * Import BibTeX…: a `.bib` file (picked, or its text pasted) becomes Sources on a Card or Cards on the Board.
 * A modal: focus stays inside, Esc and Cancel close it (not while importing), focus returns to the opener.
 */
export function ImportBibtex({ target, onClose, opener: openerProp }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const introId = useId()
  const textId = useId()
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [fileError, setFileError] = useState('')
  const [stage, setStage] = useState<Stage>({ kind: 'choose' })
  const shown = useDeferredValue(text)
  const parsed = useMemo(() => parseBibtex(shown), [shown])
  const busy = stage.kind === 'importing' || stage.kind === 'attaching'
  // M19 (decision 10): the PDFs an entry's `file` field names — attached in the desktop app from a folder the
  // person picks; in a browser the entries come in without them, and the report says how many had one.
  const folders = useMemo(() => desktopFolders(), [])
  const [folder, setFolder] = useState<{ token: string; name: string } | null>(null)
  const [folderError, setFolderError] = useState('')
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const opener = openerProp ?? (document.activeElement as HTMLElement | null)
    fileRef.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [openerProp])

  // After a finished import, focus moves to "Done" so the report is read from its start.
  useEffect(() => {
    if (stage.kind === 'done' || stage.kind === 'stopped') ref.current?.querySelector<HTMLButtonElement>('[data-done]')?.focus()
  }, [stage.kind])

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    setFileError('')
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setFileError(`“${file.name}” is larger than 10 MB, much more than a BibTeX file usually is. Pick the .bib file itself, or paste the entries below.`)
      return
    }
    try {
      setText(await readFileText(file))
      setName(file.name)
    } catch {
      setFileError(`“${file.name}” could not be read. Pick it again, or paste its text below.`)
    }
  }

  const n = parsed.entries.length
  const withPdf = useMemo(() => entriesWithPdf(parsed.entries), [parsed.entries])

  const pickFolder = async () => {
    if (!folders) return
    setFolderError('')
    try {
      const picked = await folders.pick()
      if (picked) setFolder(picked)
    } catch (e) {
      setFolderError(`The folder could not be opened. ${e instanceof Error ? e.message : ''}`.trim())
    }
  }

  const start = async () => {
    if (busy || n === 0) return
    const entries = parsed.entries
    // The PDFs first: each is read from the folder and stored, so the Sources' fields can go in with the entries.
    let gathered: Awaited<ReturnType<typeof gatherPdfs>> | null = null
    if (folders && folder && withPdf > 0) {
      setStage({ kind: 'attaching', done: 0, total: withPdf })
      gathered = await gatherPdfs(
        entries,
        (path) => folders.read(folder.token, path),
        (bytes, fileName) => preparePdf(bytes, fileName),
        (done, total) => setStage({ kind: 'attaching', done, total }),
      )
    }
    const plan =
      target.kind === 'card'
        ? planCardImport(entries, target.cardId, (input) => page.findSource(input))
        : planBoardImport(entries, target.place(), fileTitle(name) || 'Imported BibTeX', (input) => page.findSource(input))
    if (gathered) addPdfOps(plan, gathered.byEntry, gathered.outcome)
    const pdfs = gathered?.outcome ?? null
    setStage({ kind: 'importing', done: 0, total: entries.length })
    const result = await send(plan, entries.length, (done) => setStage({ kind: 'importing', done, total: entries.length }))
    if (result.error !== undefined) {
      setStage({ kind: 'stopped', done: result.done, total: entries.length, why: stoppedBecause(result.error), pdfs })
      return
    }
    setStage({ kind: 'done', total: entries.length, created: plan.created, reused: plan.reused, pdfs })
    if (target.kind === 'board' && plan.frame) target.onFrame(plan.frame.id)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      if (!busy) closeRef.current()
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

  const onCard = target.kind === 'card'
  const intro = onCard
    ? 'Each entry becomes a Source on this Card. An entry whose DOI or address is already in Infall uses that Source.'
    : 'Each entry becomes a Card with its Source, laid out in a new Frame named after the file. An entry whose DOI or address is already in Infall uses that Source.'
  const problems = parsed.problems

  const report = (() => {
    if (stage.kind === 'done') {
      const lines = [
        `Imported ${count(stage.total, 'entry', 'entries')}${onCard ? '' : ` as ${count(stage.total, 'Card')}`}.`,
        stage.created > 0 && `${count(stage.created, 'new Source')}.`,
        stage.reused > 0 && `Reused ${count(stage.reused, 'Source')} already in Infall.`,
        ...(stage.pdfs ? outcomeLines(stage.pdfs, folder?.name ?? 'the folder') : []),
        !stage.pdfs && withPdf > 0 && noFilesLine(withPdf, Boolean(folders)),
      ]
      return lines.filter((l): l is string => Boolean(l))
    }
    if (stage.kind === 'stopped') {
      return [
        `The import stopped after ${stage.done} of ${count(stage.total, 'entry', 'entries')}: ${stage.why}`,
        stage.done > 0 ? 'What arrived is kept. To take it back, use Undo.' : 'Nothing was added.',
      ]
    }
    return []
  })()

  return createPortal(
    <div className="q-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={ref}
        className="q-dialog qp-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        data-testid="bibtex-import"
      >
        <h2 className="q-dialog__title" id={titleId}>
          Import BibTeX
        </h2>
        <p className="q-dialog__body" id={introId}>
          {intro}
        </p>

        {stage.kind === 'choose' && (
          <>
            <label className="q-field">
              <span className="q-label">BibTeX file</span>
              <input
                ref={fileRef}
                type="file"
                className="qp-import__file"
                accept=".bib,.bibtex,.txt,text/x-bibtex,application/x-bibtex,text/plain"
                onChange={(e) => void onFile(e)}
              />
            </label>
            {fileError && (
              <p className="q-error" role="alert">
                {fileError}
              </p>
            )}
            <label className="q-field" htmlFor={textId}>
              <span className="q-label">Or paste the entries</span>
            </label>
            <textarea
              id={textId}
              className="q-input qp-import__text"
              rows={7}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              placeholder="@article{key, title = {…}, author = {…}, year = {…}}"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setName('')
              }}
            />
            {withPdf > 0 && (
              <div className="qp-import__pdfs" data-testid="bibtex-pdfs">
                {folders ? (
                  <>
                    <p className="qp-import__pdfs-line">
                      {count(withPdf, 'entry names a PDF', 'entries name a PDF')} in its <code>file</code> field.{' '}
                      {folder ? (
                        <>
                          PDFs from <b>“{folder.name}”</b> are attached to their Sources.
                        </>
                      ) : (
                        'Pick the folder the paths start from — the one Zotero exported to, or Zotero’s storage folder — to attach them.'
                      )}
                    </p>
                    <div className="qp-import__pdfs-actions">
                      <button type="button" className="q-btn q-btn--sm" onClick={() => void pickFolder()}>
                        {folder ? 'Choose another folder…' : 'Attach the PDFs…'}
                      </button>
                      {folder && (
                        <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={() => setFolder(null)}>
                          Import without PDFs
                        </button>
                      )}
                    </div>
                    {folderError && (
                      <p className="q-error" role="alert">
                        {folderError}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="qp-import__pdfs-line">
                    {count(withPdf, 'entry names a PDF', 'entries name a PDF')} in its <code>file</code> field. In a browser the entries come in without
                    their PDFs; the desktop app can attach them.
                  </p>
                )}
              </div>
            )}
            <p className="qp-import__found" role="status" aria-live="polite">
              {text.trim() === ''
                ? 'Zotero, Mendeley and JabRef export BibTeX: in Zotero, File › Export Library… › BibTeX.'
                : n === 0 && problems.length === 0
                  ? 'No entries found yet. An entry starts with @article{, @book{, @misc{ and so on.'
                  : `${count(n, 'entry', 'entries')} found${name ? ` in “${name}”` : ''}.${problems.length ? ` ${count(problems.length, 'entry', 'entries')} could not be read.` : ''}`}
            </p>
          </>
        )}

        {stage.kind === 'attaching' && (
          <div className="qp-import__progress">
            <progress max={stage.total} value={stage.done} aria-label="PDFs read and sent" />
            <p role="status">
              Attaching the PDFs… {stage.done} of {stage.total}
            </p>
          </div>
        )}

        {stage.kind === 'importing' && (
          <div className="qp-import__progress">
            <progress max={stage.total} value={stage.done} aria-label="Import progress" />
            <p role="status">
              Importing… {stage.done} of {stage.total}
            </p>
          </div>
        )}

        {report.length > 0 && (
          <div className="qp-import__report" role="status">
            {report.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}

        {problems.length > 0 && !busy && (
          <details className="qp-import__problems" open={stage.kind !== 'choose'}>
            <summary>
              Could not read {count(problems.length, 'entry', 'entries')}
              {stage.kind === 'choose' ? ` — ${problems.length === 1 ? 'it' : 'they'} will be left out` : ''}
            </summary>
            <ul>
              {problems.slice(0, 50).map((p, i) => (
                <li key={i}>{describeProblem(p)}</li>
              ))}
              {problems.length > 50 && <li>…and {problems.length - 50} more.</li>}
            </ul>
          </details>
        )}

        <div className="q-dialog__actions">
          {stage.kind === 'choose' ? (
            <>
              <button type="button" className="q-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="q-btn q-btn--primary" disabled={n === 0} onClick={() => void start()}>
                {n === 0 ? 'Import' : `Import ${count(n, 'entry', 'entries')}`}
              </button>
            </>
          ) : stage.kind === 'importing' || stage.kind === 'attaching' ? (
            <button type="button" className="q-btn" disabled>
              Importing…
            </button>
          ) : (
            <button type="button" className="q-btn q-btn--primary" data-done onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
