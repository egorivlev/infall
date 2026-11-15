import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { lookupQuery, lookupSource, newId, ops, page, pdfFiles } from '../../lib'
import type { AttachedSource, LookupResult, Op } from '../../lib'
import { attachFailure, attachOps, pdfFacts, pdfStep, readyFrom } from '../pdf/attach'
import type { PreparedPdf } from '../pdf/attach'
import { useBoardActions } from '../board/useBoardActions'
import { ImportBibtex } from './bibtex/ImportBibtex'
import { toBibtex } from './bibtex/write'
import { exportFile } from './export/exportFile'
import { fileName } from './files'
import { LOOKUP_NEEDS_ID, listWords, lookupFailure, registryOf } from './lookupText'
import { identifierText, parseIdentifier, sourceLink } from './sourceId'
import { PdfLine } from './SourcePdf'
import { usePdfDrop, usePdfWork } from './sourcePdfWork'
import type { PdfWorkApi } from './sourcePdfWork'

const NEEDS_ID = 'This needs a URL starting with http:// or https://, or a DOI such as 10.1103/PhysRevA.52.R2493.'

type RowProps = {
  source: AttachedSource
  cardId: string
  canEdit: boolean
  onEdit: (id: string) => void
  onRemove: (source: AttachedSource) => void
  /** M19: the work on this Source's PDF, shared with the drop on the section. */
  pdf: PdfWorkApi
  /** A file is being dragged over this row. */
  dropping: boolean
}

const SourceRow = memo(function SourceRow({ source, cardId, canEdit, onEdit, onRemove, pdf, dropping }: RowProps) {
  const link = sourceLink(source)
  const name = source.title || 'Untitled Source'
  return (
    <li className={`qp-source${dropping ? ' is-drop' : ''}`} data-source={source.id} data-testid={`source-${source.id}`}>
      <span className={`qp-source__title${source.title ? '' : ' is-empty'}`}>{name}</span>
      <span className="qp-source__year">{source.year}</span>
      <span className="qp-source__authors">{source.authors}</span>
      {link ? (
        <a className="qp-source__id" href={link.href} target="_blank" rel="noreferrer noopener">
          {link.text}
        </a>
      ) : (
        <span />
      )}
      {canEdit && (
        <span className="qp-source__actions">
          <button type="button" className="qp-link" data-edit aria-label={`Edit Source: ${name}`} onClick={() => onEdit(source.id)}>
            Edit
          </button>
          <button type="button" className="qp-link" aria-label={`Remove from this Card: ${name}`} onClick={() => onRemove(source)}>
            Remove from this Card
          </button>
        </span>
      )}
      <PdfLine source={source} cardId={cardId} canEdit={canEdit} api={pdf} />
    </li>
  )
})

// ---- Look up (M13): the title, authors and year of a DOI or an arXiv paper, from the server ----

type Detail = 'title' | 'authors' | 'year'
const DETAIL_WORD: Record<Detail, string> = { title: 'title', authors: 'authors', year: 'year' }
const DETAIL_LABEL: Record<Detail, string> = { title: 'Title', authors: 'Authors', year: 'Year' }

type Look =
  | { kind: 'idle' }
  | { kind: 'asking'; registry: string }
  | { kind: 'note'; text: string }
  | { kind: 'failed'; text: string }
  | { kind: 'differs'; registry: string; found: Partial<Record<Detail, string>> }

/** M19, decision 9: after Look up answered for an arXiv id, the server may fetch that paper's PDF — on this button only. */
type Fetch =
  | { kind: 'none' }
  | { kind: 'offer'; id: string }
  | { kind: 'asking'; id: string }
  | { kind: 'ready'; id: string; pdf: PreparedPdf }
  | { kind: 'failed'; id: string; text: string }

type FormProps = {
  cardId: string
  attached: readonly AttachedSource[]
  /** The Source being edited; absent when adding. */
  editing?: AttachedSource
  onDone: () => void
}

function SourceForm({ cardId, attached, editing, onDone }: FormProps) {
  const actions = useBoardActions()
  const errorId = useId()
  const idRef = useRef<HTMLInputElement>(null)
  const initialId = editing ? identifierText(editing) : ''
  const [idText, setIdText] = useState(initialId)
  const [title, setTitle] = useState(editing?.title ?? '')
  const [authors, setAuthors] = useState(editing?.authors ?? '')
  const [year, setYear] = useState(editing?.year ?? '')
  const [touched, setTouched] = useState(false)
  const [look, setLook] = useState<Look>({ kind: 'idle' })
  const [fetchPdf, setFetchPdf] = useState<Fetch>({ kind: 'none' })
  const fetching = useRef(0)
  useEffect(() => () => void fetching.current++, [])
  const lookNoteId = useId()
  const idInputId = useId()
  // The answer that is still wanted: typing another identifier, or closing the form, makes an older one harmless.
  const asking = useRef(0)
  useEffect(() => () => void asking.current++, [])

  useEffect(() => {
    idRef.current?.focus({ preventScroll: true })
  }, [])

  const current = { title, authors, year }
  const setDetail: Record<Detail, (v: string) => void> = { title: setTitle, authors: setAuthors, year: setYear }

  const lookUp = async () => {
    if (look.kind === 'asking') return
    const query = lookupQuery(idText)
    if (!query) {
      setLook({ kind: 'failed', text: LOOKUP_NEEDS_ID })
      return
    }
    const ticket = ++asking.current
    const registry = registryOf(query)
    setLook({ kind: 'asking', registry })
    let found: LookupResult
    try {
      found = await lookupSource(query)
    } catch (e) {
      if (ticket === asking.current) setLook({ kind: 'failed', text: lookupFailure(e, registry) })
      return
    }
    if (ticket !== asking.current) return
    // An arXiv paper: its PDF can be fetched (not for a Source that has one already).
    if ('arxiv' in query && !editing?.pdf) setFetchPdf((f) => (f.kind === 'ready' && f.id === query.arxiv ? f : { kind: 'offer', id: query.arxiv }))
    // A bare arXiv id is not an address a Source can keep: put the paper's address (or DOI) in its place.
    if (!parseIdentifier(idText)) {
      const better = found.url ?? (found.doi ? `doi:${found.doi}` : '')
      if (better) setIdText(better)
    }
    const filled: Detail[] = []
    const differs: Partial<Record<Detail, string>> = {}
    for (const d of ['title', 'authors', 'year'] as const) {
      const theirs = found[d].trim()
      const mine = current[d].trim()
      if (theirs === '' || theirs === mine) continue
      if (mine === '') {
        setDetail[d](theirs)
        filled.push(d)
      } else differs[d] = theirs
    }
    if (Object.keys(differs).length > 0) {
      setLook({ kind: 'differs', registry, found: differs })
      return
    }
    const none = (['title', 'authors', 'year'] as const).every((d) => found[d].trim() === '')
    setLook({
      kind: 'note',
      text: filled.length
        ? `Filled in the ${listWords(filled.map((d) => DETAIL_WORD[d]))} from ${registry}. Nothing is added until you press ${editing ? 'Update Source' : 'Add Source'}.`
        : none
          ? `${registry} knows this one but has no title, authors or year for it. Fill them in by hand.`
          : `The fields already match what ${registry} has.`,
    })
  }

  const fetchFromArxiv = async () => {
    if (fetchPdf.kind !== 'offer' && fetchPdf.kind !== 'failed') return
    const id = fetchPdf.id
    const ticket = ++fetching.current
    setFetchPdf({ kind: 'asking', id })
    try {
      const stored = await pdfFiles.fetchArxiv(id)
      const pdf = await readyFrom(stored, `${id.replace('/', '_')}.pdf`)
      if (ticket === fetching.current) setFetchPdf({ kind: 'ready', id, pdf })
    } catch (e) {
      if (ticket === fetching.current) setFetchPdf({ kind: 'failed', id, text: attachFailure(e) })
    }
  }

  const replaceAll = () => {
    if (look.kind !== 'differs') return
    const words: string[] = []
    for (const [d, v] of Object.entries(look.found) as [Detail, string][]) {
      setDetail[d](v)
      words.push(DETAIL_WORD[d])
    }
    setLook({ kind: 'note', text: `Replaced the ${listWords(words)} with what ${look.registry} has.` })
  }

  const parsed = useMemo(() => parseIdentifier(idText), [idText])
  const found = parsed ? page.findSource(parsed) : undefined
  // Adding: the same Source is already on this Branch — attach that one. Editing: it would become a duplicate.
  const existing = !editing ? found : undefined
  const onThisCard = existing ? attached.some((a) => a.id === existing.id) : false
  const clash = editing && found && found.id !== editing.id ? found : undefined
  const error = clash
    ? `Another Source in Infall already has this URL or DOI: ${clash.title || 'Untitled Source'}.`
    : touched && !parsed
      ? NEEDS_ID
      : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!parsed || clash) {
      setTouched(true)
      idRef.current?.focus()
      return
    }
    if (editing) {
      const batch: Op[] = []
      if (idText.trim() !== initialId) {
        const doi = 'doi' in parsed ? parsed.doi : ''
        const url = 'url' in parsed ? parsed.url : ''
        if (doi !== editing.doi) batch.push(ops.setSourceField(editing.id, 'doi', doi))
        if (url !== editing.url) batch.push(ops.setSourceField(editing.id, 'url', url))
      }
      const fields = { title, authors, year } as const
      for (const field of ['title', 'authors', 'year'] as const) {
        const value = fields[field].trim()
        if (value !== editing[field]) batch.push(ops.setSourceField(editing.id, field, value))
      }
      if (fetchPdf.kind === 'ready') {
        // Only the PDF changed: the step is named for it.
        const label = batch.length === 0 ? pdfStep.attach(title.trim() || editing.title) : undefined
        batch.push(...attachOps(editing.id, fetchPdf.pdf))
        void actions.submit(batch, label ? { label } : undefined)
      } else void actions.submit(batch)
    } else if (existing) {
      if (!onThisCard) void actions.submit([ops.attach({ card: cardId, source: existing.id })])
    } else {
      const id = newId()
      const details: { title?: string; authors?: string; year?: string } = {}
      if (title.trim()) details.title = title.trim()
      if (authors.trim()) details.authors = authors.trim()
      if (year.trim()) details.year = year.trim()
      // One batch: the Source, its place on this Card (and its PDF, when one was fetched) arrive together or not at all.
      const batch = [ops.createSource({ id, ...parsed, ...details }), ops.attach({ card: cardId, source: id })]
      if (fetchPdf.kind === 'ready') batch.push(...attachOps(id, fetchPdf.pdf))
      void actions.submit(batch)
    }
    onDone()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation() // cancels the form, not the panel
    onDone()
  }

  const shared = editing ? editing.cards.length : 0
  return (
    <form className="qp-source-form" aria-label={editing ? 'Edit Source' : 'Add Source'} noValidate onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="q-field">
        <label className="q-label" htmlFor={idInputId}>
          URL or DOI
        </label>
        <div className="qp-lookup">
          <input
            ref={idRef}
            id={idInputId}
            className="q-input qp-source-form__id"
            value={idText}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="https://arxiv.org/abs/… or 10.1103/…"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setIdText(e.target.value)
              // Another identifier: an answer still on its way is for the old one.
              if (look.kind !== 'idle') {
                asking.current++
                setLook({ kind: 'idle' })
              }
              if (fetchPdf.kind !== 'none') {
                fetching.current++
                setFetchPdf({ kind: 'none' })
              }
            }}
            onBlur={() => setTouched(idText.trim() !== '')}
          />
          {!existing && (
            <button
              type="button"
              className="q-btn qp-lookup__btn"
              aria-disabled={look.kind === 'asking' ? true : undefined}
              aria-describedby={look.kind !== 'idle' && look.kind !== 'asking' ? lookNoteId : undefined}
              title="Fill in the title, authors and year from Crossref (DOIs) or arXiv"
              onClick={() => void lookUp()}
            >
              {look.kind === 'asking' ? 'Looking up…' : 'Look up'}
            </button>
          )}
        </div>
      </div>
      {!existing && (
        <div className="qp-lookup__status" aria-live="polite" id={lookNoteId}>
          {look.kind === 'asking' && <p className="qp-lookup__note">Asking {look.registry}… The form stays usable meanwhile.</p>}
          {look.kind === 'note' && <p className="qp-lookup__note">{look.text}</p>}
          {look.kind === 'failed' && <p className="qp-lookup__note is-failed">{look.text}</p>}
          {look.kind === 'differs' && (
            <div className="qp-lookup__differs">
              <p className="qp-lookup__note">{look.registry} has other details than the ones in the form:</p>
              <dl>
                {(Object.entries(look.found) as [Detail, string][]).map(([d, v]) => (
                  <div key={d}>
                    <dt>{DETAIL_LABEL[d]}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="qp-lookup__choice">
                <button type="button" className="q-btn q-btn--sm" onClick={replaceAll}>
                  Use these
                </button>
                <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={() => setLook({ kind: 'idle' })}>
                  Keep mine
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {!existing && fetchPdf.kind !== 'none' && (
        <div className="qp-fetch" aria-live="polite">
          {(fetchPdf.kind === 'offer' || fetchPdf.kind === 'asking' || fetchPdf.kind === 'failed') && (
            <button
              type="button"
              className="q-btn q-btn--sm"
              aria-disabled={fetchPdf.kind === 'asking' ? true : undefined}
              title="Infall’s server downloads it from arxiv.org; only the arXiv id is sent"
              onClick={() => void fetchFromArxiv()}
            >
              {fetchPdf.kind === 'asking' ? 'Fetching the PDF…' : fetchPdf.kind === 'failed' ? 'Try fetching the PDF again' : 'Fetch the PDF from arXiv'}
            </button>
          )}
          {fetchPdf.kind === 'asking' && <p className="qp-fetch__note">Asking arXiv for arXiv:{fetchPdf.id}… The form stays usable meanwhile.</p>}
          {fetchPdf.kind === 'ready' && (
            <p className="qp-fetch__note" role="status">
              The PDF from arXiv is ready ({pdfFacts(fetchPdf.pdf)}). It is attached when you press {editing ? 'Update Source' : 'Add Source'}.
            </p>
          )}
          {fetchPdf.kind === 'failed' && (
            <p className="qp-fetch__note is-failed" role="alert">
              {fetchPdf.text}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="q-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      {existing ? (
        <p className="qp-source-form__found" role="status">
          {onThisCard ? 'Already on this Card: ' : 'Already in Infall: '}
          <b>{existing.title || 'Untitled Source'}</b>
        </p>
      ) : (
        <>
          <label className="q-field">
            <span className="q-label">Title</span>
            <input className="q-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="qp-source-form__row">
            <label className="q-field">
              <span className="q-label">Authors</span>
              <input className="q-input" value={authors} onChange={(e) => setAuthors(e.target.value)} />
            </label>
            <label className="q-field qp-source-form__year">
              <span className="q-label">Year</span>
              <input className="q-input" value={year} inputMode="numeric" maxLength={9} onChange={(e) => setYear(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {shared > 1 && <p className="q-hint">This Source is on {shared} Cards; the changes show on all of them.</p>}
      <div className="qp-source-form__buttons">
        <button type="submit" className="q-btn q-btn--primary" disabled={onThisCard}>
          {editing ? 'Update Source' : existing ? 'Attach' : 'Add Source'}
        </button>
        <button type="button" className="q-btn q-btn--quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type Props = {
  cardId: string
  /** The Card's title, for the name of an exported file. */
  cardTitle: string
  sources: readonly AttachedSource[]
  /** Members, when nobody else is editing the Page: add, edit, remove and import. Export is for everyone who reads it. */
  canEdit: boolean
}

/** The Sources attached to this Card. `form` is 'add', the id of the Source being edited, or null. */
export function Sources({ cardId, cardTitle, sources, canEdit }: Props) {
  const actions = useBoardActions()
  const pdf = usePdfWork(cardId)
  const drop = usePdfDrop(sources, canEdit, pdf)
  const rootRef = useRef<HTMLElement>(null)
  const [form, setForm] = useState<string | null>(null)
  const [importing, setImporting] = useState<HTMLElement | null>(null)
  const exportBibtex = () => void exportFile(fileName(`${cardTitle || 'Untitled'} - Sources`, 'bib'), toBibtex(sources), 'application/x-bibtex')
  const returnTo = useRef<string | null>(null)
  const shown = canEdit ? form : null

  // When a form closes, focus goes back to the button that opened it.
  useEffect(() => {
    const target = returnTo.current
    if (form !== null || target === null) return
    returnTo.current = null
    const root = rootRef.current
    if (!root) return
    const row = [...root.querySelectorAll('[data-source]')].find((el) => el.getAttribute('data-source') === target)
    const button = row?.querySelector<HTMLElement>('[data-edit]') ?? root.querySelector<HTMLElement>('[data-add]')
    button?.focus({ preventScroll: true })
  }, [form])

  const [handlers] = useState(() => ({
    edit: (id: string) => setForm(id),
    remove: (source: AttachedSource) =>
      actions.removeWithUndo(
        [{ id: source.attachment, kind: 'Attachment' }],
        `Removed ${source.title ? `Source ${source.title}` : 'the Source'} from this Card.`,
      ),
  }))
  const close = () => {
    returnTo.current = form
    setForm(null)
  }

  return (
    <section
      className={`qp-sources${drop.over !== null ? ' is-drop' : ''}`}
      ref={rootRef}
      data-tour="sources"
      aria-labelledby="qp-sources-head"
      {...drop.handlers}
    >
      <h2 className="qp-sources__head" id="qp-sources-head">
        <span className="q-caps">Sources</span> <span className="qp-sources__n">{sources.length}</span>
      </h2>
      {sources.length > 0 && (
        <ul className="qp-sources__list">
          {sources.map((s) =>
            shown === s.id ? (
              <li key={s.id} className="qp-source qp-source--form" data-source={s.id}>
                <SourceForm cardId={cardId} attached={sources} editing={s} onDone={close} />
              </li>
            ) : (
              <SourceRow
                key={s.id}
                source={s}
                cardId={cardId}
                canEdit={canEdit}
                onEdit={handlers.edit}
                onRemove={handlers.remove}
                pdf={pdf}
                dropping={drop.over === s.id}
              />
            ),
          )}
        </ul>
      )}
      {sources.length === 0 && shown !== 'add' && <p className="qp-sources__none">No Sources on this Card yet.</p>}
      {drop.note && (
        <p className="qp-sources__drop" role="status">
          {drop.note}
        </p>
      )}
      {shown === 'add' && (
        <div className="qp-source qp-source--form">
          <SourceForm cardId={cardId} attached={sources} onDone={close} />
        </div>
      )}
      {(canEdit || sources.length > 0) && (
        <div className="qp-sources__tools">
          {canEdit && shown !== 'add' && (
            <button type="button" className="qp-sources__add" data-add onClick={() => setForm('add')}>
              + Add Source
            </button>
          )}
          <span className="qp-sources__spacer" />
          {canEdit && (
            <button type="button" className="qp-link qp-sources__tool" onClick={(e) => setImporting(e.currentTarget)}>
              Import BibTeX…
            </button>
          )}
          {sources.length > 0 && (
            <button type="button" className="qp-link qp-sources__tool" title="These Sources as a .bib file" onClick={exportBibtex}>
              Export BibTeX
            </button>
          )}
        </div>
      )}
      {importing && <ImportBibtex target={{ kind: 'card', cardId }} opener={importing} onClose={() => setImporting(null)} />}
    </section>
  )
}
