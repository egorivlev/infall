// M19: a Source's PDF in its row of the Page's Sources — Attach PDF…, Open PDF, Replace… (confirmed), Remove PDF —
// and dropping a PDF file on the Sources section. Attaching, replacing and removing are each one Undo step.
import './sourcePdf.css'
import { useEffect, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { sourcePdf } from '../../lib'
import type { AttachedSource, SourcePdf } from '../../lib'
import { pdfFacts } from '../pdf/attach'
import { pdfReader } from '../pdf/readerStore'
import type { PdfWork, PdfWorkApi } from './sourcePdfWork'

type LineProps = {
  source: AttachedSource
  cardId: string
  canEdit: boolean
  api: PdfWorkApi
}

function Progress({ w }: { w: Extract<PdfWork, { kind: 'sending' }> }) {
  const pct = w.total > 0 ? Math.min(100, Math.round((w.sent / w.total) * 100)) : 0
  const done = w.total > 0 && w.sent >= w.total
  return (
    <div className="qp-pdf__sending">
      <span className="qp-pdf__state" role="status">
        Attaching “{w.name}”… {done ? 'reading its pages' : `${pct} %`}
      </span>
      <span
        className="qp-pdf__bar"
        role="progressbar"
        aria-label={`Attaching ${w.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={done ? 'Sent; counting the pages' : `${pct} %`}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      {!done && (
        <button type="button" className="qp-link" onClick={w.stop}>
          Stop
        </button>
      )}
    </div>
  )
}

function ConfirmReplace({ from, to, onReplace, onKeep }: { from: string; to: string; onReplace: () => void; onKeep: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => ref.current?.focus({ preventScroll: true }), [])
  return (
    <div className="qp-pdf__confirm" role="group" aria-label="Replace the PDF">
      <span className="qp-pdf__state">
        Replace “{from}” with “{to}”? Undo brings the old one back.
      </span>
      <button type="button" className="q-btn q-btn--sm" ref={ref} onClick={onReplace}>
        Replace
      </button>
      <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={onKeep}>
        Keep the old one
      </button>
    </div>
  )
}

/** The PDF line of one Source row. */
export function PdfLine({ source, cardId, canEdit, api }: LineProps) {
  const pdf: SourcePdf | null = sourcePdf(source)
  const w = api.work[source.id]
  const inputRef = useRef<HTMLInputElement>(null)
  const name = source.title || 'Untitled Source'
  const pick = () => inputRef.current?.click()
  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) api.offer(source, file)
  }
  const open = () => pdf && pdfReader.open({ cardId, sourceId: source.id, hash: pdf.hash, name: pdf.name, title: name })
  if (!pdf && !canEdit && !w) return null

  return (
    <div className="qp-pdf" data-pdf={pdf ? 'yes' : 'no'}>
      {canEdit && (
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="qp-pdf__input"
          tabIndex={-1}
          aria-hidden="true"
          data-testid={`pdf-input-${source.id}`}
          onChange={onPicked}
        />
      )}
      {pdf && (
        <span className="qp-pdf__file">
          <span className="qp-pdf__chip" aria-hidden="true">
            PDF
          </span>
          <span className="qp-pdf__name" title={pdf.name}>
            {pdf.name}
          </span>
          <span className="qp-pdf__facts">{pdfFacts(pdf)}</span>
        </span>
      )}
      {w?.kind === 'sending' ? (
        <Progress w={w} />
      ) : w?.kind === 'confirm' ? (
        <ConfirmReplace
          from={pdf?.name ?? ''}
          to={w.file.name}
          onReplace={() => {
            api.clear(source.id)
            void api.send(source, w.file)
          }}
          onKeep={() => api.clear(source.id)}
        />
      ) : (
        <span className="qp-pdf__actions">
          {pdf && (
            <button type="button" className="qp-pdf__open" aria-label={`Open PDF: ${name}`} onClick={open}>
              Open PDF
            </button>
          )}
          {canEdit && pdf && (
            <>
              <button type="button" className="qp-link" aria-label={`Replace the PDF of ${name}…`} onClick={pick}>
                Replace…
              </button>
              <button type="button" className="qp-link" aria-label={`Remove the PDF from ${name}`} onClick={() => api.remove(source)}>
                Remove PDF
              </button>
            </>
          )}
          {canEdit && !pdf && (
            <button type="button" className="qp-link qp-pdf__attach" aria-label={`Attach PDF… to ${name}`} title="Or drop a PDF file on this Source" onClick={pick}>
              Attach PDF…
            </button>
          )}
        </span>
      )}
      {w?.kind === 'failed' && (
        <p className="qp-pdf__failed" role="alert">
          {w.text}{' '}
          <button type="button" className="qp-link" onClick={() => api.clear(source.id)}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  )
}
