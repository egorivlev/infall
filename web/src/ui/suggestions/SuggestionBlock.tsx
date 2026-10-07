import { memo, useEffect, useId, useState } from 'react'
import type { FocusEvent, ReactNode } from 'react'
import { suggestions, todos } from '../../lib'
import type { CardVM, Member, SuggestionVM } from '../../lib'
import { boardBridge, suggestionsPanel, useSuggestionsPanel } from '../bridge'
import { firstName } from '../page/people'
import { codeOf, decidedLine, failureSentence, viaLine } from './words'
import type { People } from './words'

type Props = {
  vm: SuggestionVM
  me: Member | null
  people: People
  owners: readonly Member[] // who a To-do can be assigned to: you first
  cards: ReadonlyMap<string, CardVM> // live Cards of the open Board
  branchId: string | undefined
  previewing: boolean // the Board is drawing this one
}

/** What happened to this Suggestion here, just now — the server only knows "accepted" / "rejected". */
type Mine = 'accepted' | 'rejected' | null
/** After accepting a Source: the To-do offer, then how it ended. */
type Offer = 'none' | 'open' | 'created' | 'declined'

function CardName({ card }: { card: CardVM }) {
  return (
    <button
      type="button"
      className="qs-card"
      title="Show this Card on the Board"
      onClick={() => boardBridge.focus('card', card.id)}
    >
      {card.title || 'Untitled'}
    </button>
  )
}

function SuggestionBlockImpl({ vm, me, people, owners, cards, branchId, previewing }: Props) {
  const s = vm.suggestion
  const pending = s.state === 'pending'
  const conn = s.kind === 'connection' ? s.connection : undefined
  const forCard = s.kind === 'source' && s.card ? cards.get(s.card) : undefined
  const fromCard = conn ? cards.get(conn.from) : undefined
  const toCard = conn ? cards.get(conn.to) : undefined

  const [decidedHere, setMine] = useState<Mine>(null)
  // Only while the decision still stands as ours.
  const mine: Mine = decidedHere === s.state && (s.decided_by === undefined || s.decided_by === me?.id) ? decidedHere : null
  const [offer, setOffer] = useState<Offer>('none')
  const [busy, setBusy] = useState<null | 'accept' | 'reject' | 'reopen' | 'todo'>(null)
  const [error, setError] = useState<string | null>(null)
  const [todoOn, setTodoOn] = useState(true)
  const [owner, setOwner] = useState<string | null>(null) // null: you
  const [todoFor, setTodoFor] = useState('')
  const [addedTo, setAddedTo] = useState<{ id: string; title: string } | null>(null)
  const selectId = useId()

  // ---- preview on the Board: a pending Connection whose two Cards are there, while hovered or focused ----
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const canPreview = pending && !vm.stale && fromCard !== undefined && toCard !== undefined
  const active = canPreview && (hovered || focused)
  const from = conn?.from
  const to = conn?.to
  const kind = conn?.kind
  const label = conn?.label?.trim() ?? ''
  useEffect(() => {
    if (!active || !from || !to || !kind) return
    suggestionsPanel.preview({ id: s.id, from, to, kind, label })
    return () => {
      // Only take down our own preview: another block may have put up its own meanwhile.
      if (useSuggestionsPanel.getState().preview?.id === s.id) suggestionsPanel.preview(null)
    }
  }, [active, s.id, from, to, kind, label])

  const onBlur = (e: FocusEvent<HTMLLIElement>) => {
    if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setFocused(false)
  }

  // ---- decisions ----
  const fail = (e: unknown, action: 'accept' | 'reject' | 'reopen') => {
    setError(failureSentence(e, action))
    // Someone else got there first: show what they decided.
    if (codeOf(e) === 'already_decided') void suggestions.reload().catch(() => {})
  }

  const accept = async () => {
    if (busy) return
    setBusy('accept')
    setError(null)
    try {
      const result = await suggestions.accept(s.id)
      setMine('accepted')
      if (s.kind === 'source') {
        const id = result.cardId ?? s.card
        if (id) setAddedTo({ id, title: cards.get(id)?.title ?? '' })
        setOffer('open')
      }
    } catch (e) {
      fail(e, 'accept')
    } finally {
      setBusy(null)
    }
  }

  const reject = async () => {
    if (busy) return
    setBusy('reject')
    setError(null)
    try {
      await suggestions.reject(s.id)
      setMine('rejected')
    } catch (e) {
      fail(e, 'reject')
    } finally {
      setBusy(null)
    }
  }

  const undo = async () => {
    if (busy) return
    setBusy('reopen')
    setError(null)
    try {
      await suggestions.reopen(s.id)
      setMine(null)
    } catch (e) {
      fail(e, 'reopen')
    } finally {
      setBusy(null)
    }
  }

  const ownerId = owner ?? me?.id ?? owners[0]?.id
  const finishOffer = async () => {
    if (busy) return
    if (!todoOn) return setOffer('declined')
    if (!ownerId) return
    setBusy('todo')
    setError(null)
    try {
      const card = addedTo && branchId ? { id: addedTo.id, title: addedTo.title, branch: branchId } : undefined
      await todos.add({ owner: ownerId, text: `Read: ${vm.title}`, ...(card ? { card } : {}) })
      setTodoFor(firstName(owners.find((m) => m.id === ownerId)?.name))
      setOffer('created')
    } catch {
      setError('That To-do could not be created. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  // ---- what the block says ----
  // "for Card: <name>" and "A → B" with the names as buttons while those Cards are on the Board; else the words as given.
  const target: ReactNode = forCard ? (
    <>
      for Card: <CardName card={forCard} />
    </>
  ) : (
    vm.target
  )
  const title: ReactNode =
    conn && fromCard && toCard ? (
      <>
        <CardName card={fromCard} /> {conn.kind === 'directed' ? '→' : '—'} <CardName card={toCard} />
      </>
    ) : (
      vm.title
    )

  const offering = s.state === 'accepted' && offer === 'open'
  let resolved: ReactNode = null
  if (s.state === 'accepted' && !offering) {
    if (offer === 'created') resolved = `Accepted · To-do “Read this” created for ${todoFor}`
    else if (mine === 'accepted') resolved = 'Accepted by you · just now'
    else if (busy === 'accept') resolved = 'Accepting…'
    else resolved = decidedLine(s, people, me?.id)
  } else if (s.state === 'rejected') {
    const byMe = mine === 'rejected' || (s.decided_by !== undefined && s.decided_by === me?.id)
    resolved = (
      <>
        {mine === 'rejected' ? 'Rejected by you · just now' : busy === 'reject' ? 'Rejecting…' : decidedLine(s, people, me?.id)}
        {byMe && (
          <>
            {' · '}
            <button type="button" className="qs-undo" disabled={busy !== null} onClick={() => void undo()}>
              Undo
            </button>
          </>
        )}
      </>
    )
  }

  const cls = `qs-item${previewing ? ' is-previewing' : ''}${!pending && !offering ? ' is-decided' : ''}`
  return (
    <li
      className={cls}
      data-testid={`suggestion-${s.id}`}
      data-state={s.state}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <div className="qs-item__top">
        <span className={`qs-kind${s.kind === 'connection' ? ' qs-kind--connection' : ''}`}>
          {s.kind === 'connection' ? 'Connection' : 'Source'}
        </span>
        <span className="qs-item__target">{target}</span>
        <span className="qs-spacer" />
        {previewing && <span className="qs-item__previewing">previewing on Board ↗</span>}
      </div>
      <div className="qs-item__title">{title}</div>
      {vm.meta && <div className="qs-item__meta">{vm.meta}</div>}
      <p className="qs-item__why">
        <b>Why:</b> {s.reason}
      </p>
      <div className="qs-item__via">{viaLine(s, people)}</div>

      {pending && vm.stale && <p className="qs-item__note">The Card this was for is no longer on this Branch.</p>}
      {pending && !vm.stale && vm.existingSource && (
        <p className="qs-item__note">Already in Qoop — accepting attaches the existing Source.</p>
      )}

      {pending && (
        <div className="qs-item__actions">
          {!vm.stale && (
            <button type="button" className="q-btn q-btn--sm q-btn--primary qs-btn" disabled={busy !== null} onClick={() => void accept()}>
              Accept
            </button>
          )}
          <button type="button" className="q-btn q-btn--sm qs-btn" disabled={busy !== null} onClick={() => void reject()}>
            Reject
          </button>
        </div>
      )}

      {offering && (
        <div className="qs-offer" data-testid={`suggestion-offer-${s.id}`}>
          <div className="qs-offer__added">
            ✓ Source added to Card: {addedTo?.title || forCard?.title || 'Untitled'}
          </div>
          <div className="qs-offer__row">
            <label className="qs-offer__check">
              <input type="checkbox" checked={todoOn} onChange={(e) => setTodoOn(e.target.checked)} />
              <span>
                Also create a To-do: <b>Read this</b>, assigned to
              </span>
            </label>
            <label className="qs-sr" htmlFor={selectId}>
              To-do owner
            </label>
            <select
              id={selectId}
              className="qs-offer__owner"
              value={ownerId ?? ''}
              disabled={!todoOn}
              onChange={(e) => setOwner(e.target.value)}
            >
              {owners.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === me?.id ? `${m.name} (you)` : m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button type="button" className="q-btn q-btn--sm qs-offer__done" disabled={busy !== null} onClick={() => void finishOffer()}>
              {todoOn ? 'Create To-do' : 'Done'}
            </button>
          </div>
        </div>
      )}

      <div className="qs-item__state" aria-live="polite">
        {resolved !== null && <div className="qs-item__resolved">{resolved}</div>}
        {error && <p className="q-error qs-item__error">{error}</p>}
      </div>
    </li>
  )
}

export const SuggestionBlock = memo(SuggestionBlockImpl)
