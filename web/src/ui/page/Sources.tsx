import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { newId, ops, page } from '../../lib'
import type { AttachedSource, Op } from '../../lib'
import { useBoardActions } from '../board/useBoardActions'
import { identifierText, parseIdentifier, sourceLink } from './sourceId'

const NEEDS_ID = 'This needs a URL starting with http:// or https://, or a DOI such as 10.1103/PhysRevA.52.R2493.'

type RowProps = {
  source: AttachedSource
  canEdit: boolean
  onEdit: (id: string) => void
  onRemove: (source: AttachedSource) => void
}

const SourceRow = memo(function SourceRow({ source, canEdit, onEdit, onRemove }: RowProps) {
  const link = sourceLink(source)
  const name = source.title || 'Untitled Source'
  return (
    <li className="qp-source" data-source={source.id} data-testid={`source-${source.id}`}>
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
    </li>
  )
})

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

  useEffect(() => {
    idRef.current?.focus({ preventScroll: true })
  }, [])

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
      void actions.submit(batch)
    } else if (existing) {
      if (!onThisCard) void actions.submit([ops.attach({ card: cardId, source: existing.id })])
    } else {
      const id = newId()
      const details: { title?: string; authors?: string; year?: string } = {}
      if (title.trim()) details.title = title.trim()
      if (authors.trim()) details.authors = authors.trim()
      if (year.trim()) details.year = year.trim()
      // One batch: the Source and its place on this Card arrive together or not at all.
      void actions.submit([ops.createSource({ id, ...parsed, ...details }), ops.attach({ card: cardId, source: id })])
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
      <label className="q-field">
        <span className="q-label">URL or DOI</span>
        <input
          ref={idRef}
          className="q-input qp-source-form__id"
          value={idText}
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="https://arxiv.org/abs/… or 10.1103/…"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setIdText(e.target.value)}
          onBlur={() => setTouched(idText.trim() !== '')}
        />
      </label>
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

type Props = { cardId: string; sources: readonly AttachedSource[]; canEdit: boolean }

/** The Sources attached to this Card. `form` is 'add', the id of the Source being edited, or null. */
export function Sources({ cardId, sources, canEdit }: Props) {
  const actions = useBoardActions()
  const rootRef = useRef<HTMLElement>(null)
  const [form, setForm] = useState<string | null>(null)
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
    <section className="qp-sources" ref={rootRef} aria-labelledby="qp-sources-head">
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
              <SourceRow key={s.id} source={s} canEdit={canEdit} onEdit={handlers.edit} onRemove={handlers.remove} />
            ),
          )}
        </ul>
      )}
      {sources.length === 0 && shown !== 'add' && <p className="qp-sources__none">No Sources on this Card yet.</p>}
      {shown === 'add' && (
        <div className="qp-source qp-source--form">
          <SourceForm cardId={cardId} attached={sources} onDone={close} />
        </div>
      )}
      {canEdit && shown !== 'add' && (
        <button type="button" className="qp-sources__add" data-add onClick={() => setForm('add')}>
          + Add Source
        </button>
      )}
    </section>
  )
}
