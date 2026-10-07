import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ops } from '../../lib'
import type { CardVM, ConnectionVM, Status } from '../../lib'
import { pagePanel } from '../bridge'
import { returnFocus } from './focus'
import { StatusGlyph } from './StatusGlyph'
import { StatusMenu } from './StatusMenu'
import { STATUS_LABEL, STATUS_TOKEN } from './status'
import { useBoardActions } from './useBoardActions'

type Props = {
  card: CardVM
  connections: readonly ConnectionVM[] // all Connections; the inspector picks this Card's
  cards: ReadonlyMap<string, CardVM>
  readOnly: boolean
  onSelectCard: (id: string) => void
  onDelete: () => void
  onClose: () => void
}

/** Follows the snapshot until focused; then keeps its own draft until blur, so remote updates never overwrite typing. */
function TextField({
  label,
  value,
  multiline,
  placeholder,
  onCommit,
}: {
  label: string
  value: string
  multiline?: boolean
  placeholder?: string
  onCommit: (text: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  const commit = () => {
    const text = (draft ?? value).trim()
    setDraft(null)
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    if (draft !== null && text !== value) onCommit(text)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      cancelledRef.current = true
      returnFocus(e.currentTarget)
      e.currentTarget.blur()
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      returnFocus(e.currentTarget)
      e.currentTarget.blur()
    }
  }
  const common = {
    className: 'q-input',
    value: draft ?? value,
    placeholder,
    onFocus: () => setDraft(value),
    onBlur: commit,
    onKeyDown,
  }
  return (
    <label className="q-field">
      <span className="q-label">{label}</span>
      {multiline ? (
        <textarea {...common} rows={5} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <input {...common} onChange={(e) => setDraft(e.target.value)} />
      )}
    </label>
  )
}

type Row = { id: string; other: CardVM; mark: string; kind: ConnectionVM['kind']; label: string }

function rowsFor(card: CardVM, connections: readonly ConnectionVM[], cards: ReadonlyMap<string, CardVM>): Row[] {
  const out: Row[] = []
  for (const c of connections) {
    if (c.from !== card.id && c.to !== card.id) continue
    const outgoing = c.from === card.id
    const other = cards.get(outgoing ? c.to : c.from)
    if (!other) continue
    const mark = c.kind === 'directed' ? (outgoing ? '→' : '←') : '—'
    out.push({ id: c.id, other, mark, kind: c.kind, label: c.label })
  }
  return out
}

export function Inspector({ card, connections, cards, readOnly, onSelectCard, onDelete, onClose }: Props) {
  const actions = useBoardActions()
  const rows = rowsFor(card, connections, cards)
  const setStatus = (s: Status) => {
    if (s !== card.status) void actions.submit([ops.setStatus(card.id, s)])
  }

  return (
    <aside className="qb-inspector" data-testid="inspector" aria-label="Card inspector">
      <header className="qb-inspector__head">
        <span className="q-caps">Card</span>
        <span className="qb-inspector__id q-mono" title={card.id}>
          {card.id.slice(0, 8)}
        </span>
        <span className="qb-spacer" />
        <button type="button" className="q-btn q-btn--icon q-btn--quiet q-btn--sm" aria-label="Close" title="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="qb-inspector__body">
        <button type="button" className="q-btn q-btn--primary qb-inspector__open" onClick={() => pagePanel.open(card.id)}>
          Open Page
        </button>
        {readOnly ? (
          <>
            <h2 className={`qb-inspector__title${card.title ? '' : ' is-empty'}`}>{card.title || 'Untitled'}</h2>
            <div className="qb-inspector__status" style={{ color: `var(--q-st-${STATUS_TOKEN[card.status]})` }}>
              <StatusGlyph status={card.status} size={11} label={null} />
              <span>{STATUS_LABEL[card.status]}</span>
            </div>
            {card.summary && <p className="qb-inspector__summary">{card.summary}</p>}
          </>
        ) : (
          <>
            <TextField
              key={`${card.id}-title`}
              label="Title"
              value={card.title}
              placeholder="Untitled"
              onCommit={(t) => void actions.submit([ops.setText(card.id, 'title', t)])}
            />
            <TextField
              key={`${card.id}-summary`}
              label="Summary"
              value={card.summary}
              multiline
              onCommit={(t) => void actions.submit([ops.setText(card.id, 'summary', t)])}
            />
            <div className="q-field">
              <span className="q-label">Status</span>
              <StatusMenu variant="inline" value={card.status} onPick={setStatus} label="Status" />
            </div>
          </>
        )}

        <section className="qb-inspector__section">
          <h3 className="q-caps">Connections</h3>
          {rows.length === 0 ? (
            <p className="q-hint">No Connections yet.</p>
          ) : (
            <ul className="qb-inspector__conns">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" className="qb-inspector__conn" onClick={() => onSelectCard(r.other.id)}>
                    <span className="qb-inspector__mark" aria-hidden="true">
                      {r.mark}
                    </span>
                    <span className="qb-inspector__other">{r.other.title || 'Untitled'}</span>
                    {(r.label || r.kind === 'contradicts') && (
                      <span className="qb-inspector__kind q-mono">{r.label || 'contradicts'}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {!readOnly && (
        <footer className="qb-inspector__foot">
          <button type="button" className="q-btn q-btn--danger" onClick={onDelete}>
            Delete Card
          </button>
        </footer>
      )}
    </aside>
  )
}
