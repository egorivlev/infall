import '../port.css'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { BlockVM, CardVM, RunResult } from '../../../lib'
import { MarkdownView } from '../MarkdownView'
import { figureSrc, formatDuration } from '../runs/format'
import { sourceLink } from '../sourceId'
import { longDate } from './markdown'
import type { MarkdownSource } from './markdown'

type Props = {
  card: CardVM
  blocks: readonly BlockVM[]
  sources: readonly MarkdownSource[]
  nameOf: (memberId: string) => string
  /** Called once the system's print dialog is done (or the page could not print). */
  onDone: () => void
}

function RunOutput({ result, title, nameOf }: { result: RunResult; title: string; nameOf: Props['nameOf'] }) {
  const ended = result.exit === null || result.stopped ? 'stopped' : result.exit !== 0 ? `exit ${result.exit}` : ''
  return (
    <div className="qp-print__out">
      {result.figures.map((f, i) => {
        const src = figureSrc(f.png)
        return src ? <img key={i} className="qp-print__figure" src={src} alt={`Figure ${i + 1} of Run ${title}`} /> : null
      })}
      {result.output !== '' && <pre className="qp-print__output">{result.output}</pre>}
      {result.output_truncated && <p className="qp-print__small">Part of the output was left out.</p>}
      <p className="qp-print__small">
        Last run by {nameOf(result.by)}, {longDate(result.at)} · {formatDuration(result.duration_ms)}
        {ended && ` · ${ended}`}
      </p>
    </div>
  )
}

function PrintBlock({ block, nameOf }: { block: BlockVM; nameOf: Props['nameOf'] }) {
  if (block.type === 'visual') {
    return (
      <p className="qp-print__note">
        Visual: {block.title.trim() || 'Untitled'}. It is interactive — open this Page in Infall to use it.
      </p>
    )
  }
  if (block.type === 'run') {
    const title = block.title.trim() || 'Run'
    const result = block.run?.result ?? null
    return (
      <section className="qp-print__run" aria-label={`Run ${title}`}>
        <p className="qp-print__runhead">Run · {title}</p>
        <pre className="qp-print__code">{block.text.replace(/\n$/, '')}</pre>
        {block.run?.broken ? (
          <p className="qp-print__small">This result cannot be shown.</p>
        ) : result ? (
          <RunOutput result={result} title={title} nameOf={nameOf} />
        ) : (
          <p className="qp-print__small">Not executed yet.</p>
        )}
      </section>
    )
  }
  if (block.ai) {
    const ai = block.ai
    return (
      <section className="qp-print__pin">
        <p className="qp-print__small">
          <b>AI-generated</b> · {ai.model || 'unknown model'} · pinned by {nameOf(ai.pinnedBy)}, {longDate(ai.pinnedAt)} ·{' '}
          {ai.reviewedBy ? `reviewed by ${nameOf(ai.reviewedBy)}` : 'not reviewed by a Member'}
        </p>
        <MarkdownView text={block.text} />
      </section>
    )
  }
  return <MarkdownView text={block.text} />
}

/**
 * The Page alone, for the system's print dialog: a copy outside the app (no rail, bars or Board), black on white
 * in either theme, formulas typeset, Run output in full. Shown only while printing (`@media print` in export.css);
 * it asks for the dialog once its figures have loaded.
 */
export function PrintView({ card, blocks, sources, nameOf, onDone }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const done = useRef(onDone)
  useLayoutEffect(() => {
    done.current = onDone
  })

  useEffect(() => {
    let cancelled = false
    const finish = () => {
      window.removeEventListener('afterprint', finish)
      if (!cancelled) done.current()
    }
    const images = [...(rootRef.current?.querySelectorAll('img') ?? [])]
    void Promise.all(images.map((img) => (typeof img.decode === 'function' ? img.decode().catch(() => undefined) : undefined))).then(() => {
      if (cancelled) return
      window.addEventListener('afterprint', finish)
      try {
        window.print()
      } catch {
        finish()
      }
    })
    return () => {
      cancelled = true
      window.removeEventListener('afterprint', finish)
    }
  }, [])

  return createPortal(
    <div className="qp-print" ref={rootRef} data-testid="page-print">
      <h1 className="qp-print__title">{card.title || 'Untitled'}</h1>
      {card.summary.trim() && <p className="qp-print__summary">{card.summary}</p>}
      {blocks.map((b) => (
        <div className="qp-print__block" key={b.id}>
          <PrintBlock block={b} nameOf={nameOf} />
        </div>
      ))}
      {sources.length > 0 && (
        <section className="qp-print__sources">
          <h2 className="qp-print__head">Sources</h2>
          <ol>
            {sources.map((s, i) => {
              const link = sourceLink(s)
              return (
                <li key={i}>
                  {s.authors && <>{s.authors} </>}
                  {s.year && <>({s.year}). </>}
                  <i>{s.title || 'Untitled Source'}</i>.{link && <> {link.text.startsWith('doi:') || link.text.startsWith('arXiv:') ? link.text : link.href}</>}
                  {s.note && <> — {s.note}</>}
                </li>
              )
            })}
          </ol>
        </section>
      )}
    </div>,
    document.body,
  )
}
