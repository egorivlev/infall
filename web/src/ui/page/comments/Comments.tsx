// M18 (team-move.md, decision 9): the thread of one Card, in its Page under Sources and To-dos. Outside versioning
// like To-dos: the same on every Branch, never an Undo step, kept when the Card is removed. Members only.
import { Fragment, memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { comments, findMentions, MAX_COMMENT, mentionRanges, members as people, useMembers, useSession, useThread, useWorkspace } from '../../../lib'
import type { Comment, Member } from '../../../lib'
import { usePagePanel } from '../../bridge'
import { formatWhen } from '../../history/format'
import { serverSentence } from '../../shell/errorMessages'
import { motionAllowed } from '../../settings/apply'
import { initials } from '../../shell/initials'
import { renderInline } from '../markdown'
import { memberName } from '../people'
import './comments.css'
import { MentionField } from './MentionField'
import { mentionable } from './model'

/** The counter shows from here on. */
const NEAR_LIMIT = 9_000

const length = (text: string) => [...text.trim()].length
const group = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ')

/** A Comment's text: paragraphs and line breaks as written, the Page's inline Markdown and math, mentions marked. */
export const CommentText = memo(function CommentText({ text, mentions, people }: { text: string; mentions: readonly string[]; people: readonly Member[] }) {
  const named = useMemo(() => people.filter((m) => mentions.includes(m.id)), [people, mentions])
  const paragraphs = text.split(/\n{2,}/)
  return (
    <div className="qc-text">
      {paragraphs.map((para, p) => {
        const parts: ReactNode[] = []
        let at = 0
        for (const r of mentionRanges(para, named)) {
          if (r.start > at) parts.push(...lines(para.slice(at, r.start), `${p}:${at}`))
          parts.push(
            <span key={`m${r.start}`} className="qc-mention">
              {para.slice(r.start, r.end)}
            </span>,
          )
          at = r.end
        }
        if (at < para.length) parts.push(...lines(para.slice(at), `${p}:${at}`))
        return <p key={p}>{parts}</p>
      })}
    </div>
  )
})

function lines(text: string, key: string): ReactNode[] {
  return text.split('\n').map((line, i) => (
    <Fragment key={`${key}:${i}`}>
      {i > 0 && <br />}
      {renderInline(line)}
    </Fragment>
  ))
}

type Props = {
  card: string
  /** The Card is not live on this Branch (removed, or never here): the thread is still read and written. */
  removed?: boolean
}

export function Comments({ card, removed = false }: Props) {
  const session = useSession()
  const me = session.status === 'signed_in' ? session.member : null
  if (!me || me.role === 'guest') return null // Guests see none of it
  return <Thread card={card} removed={removed} me={me} />
}

function Thread({ card, removed, me }: { card: string; removed: boolean; me: Member }) {
  const thread = useThread(card)
  const list = useMembers()
  const ws = useWorkspace()
  const local = ws.kind === 'local'
  const readOnly = ws.readOnly === true
  const headId = useId()
  const [showResolved, setShowResolved] = useState(false)
  const [failure, setFailure] = useState('')
  const target = usePagePanel((s) => s.comment)
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => comments.watch(card), [card])
  const hasMembers = list.length > 0
  useEffect(() => {
    if (!hasMembers) void Promise.resolve(people.reload()).catch(() => {})
  }, [hasMembers])

  const candidates = useMemo(() => mentionable(list, me, local), [list, me, local])
  const count = thread.comments.length
  const collapsed = thread.resolved && !showResolved

  // For you asked for one Comment: show it (a resolved thread opens), scroll to it, focus it, mark it for a moment.
  const [lit, setLit] = useState<string | null>(null)
  const wanted = target?.id ?? null
  const ready = thread.status === 'ready'
  const found = ready && wanted !== null && thread.comments.some((c) => c.id === wanted)
  const [openedFor, setOpenedFor] = useState<number | null>(null)
  if (found && thread.resolved && !showResolved && target && openedFor !== target.nonce) {
    setOpenedFor(target.nonce)
    setShowResolved(true)
  }
  useEffect(() => {
    if (!ready || wanted === null || !found) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-comment="${CSS.escape(wanted)}"]`)
    if (!el) return
    el.scrollIntoView?.({ block: 'center', behavior: motionAllowed() ? 'smooth' : 'auto' })
    el.focus({ preventScroll: true })
    setLit(wanted)
    const t = window.setTimeout(() => setLit(null), 2400)
    return () => window.clearTimeout(t)
    // Again when For you asks again for the same Comment (a new nonce).
  }, [ready, wanted, found, target?.nonce, showResolved])

  const resolve = (resolved: boolean) => {
    setFailure('')
    Promise.resolve()
      .then(() => comments.setResolved(card, resolved))
      .then(
        () => setShowResolved(false),
        (e: unknown) => setFailure(`${resolved ? 'The thread could not be resolved.' : 'The thread could not be reopened.'} ${serverSentence(e)}`),
      )
  }

  return (
    <section className="qp-comments" aria-labelledby={headId} data-testid="page-comments">
      <div className="qp-comments__head">
        <h2 className="q-caps qp-comments__title" id={headId}>
          Comments{count > 0 ? ` · ${count}` : ''}
          {thread.resolved && <span className="qc-resolved-tag"> · resolved</span>}
        </h2>
        <span className="qp-spacer" />
        {!readOnly && count > 0 && (
          <button type="button" className="q-btn q-btn--sm" onClick={() => resolve(!thread.resolved)}>
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        )}
      </div>
      {removed && <p className="q-hint qc-note">On a Card that was removed. The thread is kept.</p>}
      {local && <p className="q-hint qc-note">Notes to yourself: this Workspace has one Member. They go with it if it moves to a Team server.</p>}
      {thread.status === 'loading' && count === 0 && <p className="q-hint" role="status">Loading Comments…</p>}
      {thread.status === 'error' && (
        <p className="q-error" role="alert">
          The Comments could not be loaded.{' '}
          <button type="button" className="q-btn q-btn--sm" onClick={() => void comments.reload(card).catch(() => {})}>
            Try again
          </button>
        </p>
      )}
      {ready && wanted !== null && !found && <p className="q-hint qc-note">That Comment was deleted.</p>}
      {thread.resolved && count > 0 && (
        <p className="qc-collapsed">
          <span>This thread is resolved.</span>{' '}
          <button type="button" className="qc-link" aria-expanded={!collapsed} onClick={() => setShowResolved((v) => !v)}>
            {collapsed ? `Show ${count === 1 ? 'the Comment' : `all ${count} Comments`}` : 'Hide the Comments'}
          </button>
        </p>
      )}
      {count > 0 && !collapsed && (
        <ol className="qc-list" ref={listRef}>
          {thread.comments.map((c) => (
            <CommentRow key={c.id} comment={c} me={me} people={list} candidates={candidates} readOnly={readOnly} lit={lit === c.id} />
          ))}
        </ol>
      )}
      {failure && (
        <p className="q-error" role="alert">
          {failure}
        </p>
      )}
      {!readOnly && !(thread.resolved && collapsed) && <WriteBox card={card} candidates={candidates} empty={count === 0} />}
      {!readOnly && thread.resolved && collapsed && <p className="q-hint">Reopen the thread to add a Comment.</p>}
    </section>
  )
}

type RowProps = { comment: Comment; me: Member; people: readonly Member[]; candidates: Member[]; readOnly: boolean; lit: boolean }

const CommentRow = memo(function CommentRow({ comment: c, me, people: list, candidates, readOnly, lit }: RowProps) {
  const author = memberName(list, c.author)
  const who = c.author === me.id ? me : list.find((m) => m.id === c.author)
  const mine = c.author === me.id
  const canDelete = !readOnly && (mine || me.role === 'admin')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.text)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const editRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  if (editing && readOnly) setEditing(false)

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    editRef.current?.focus({ preventScroll: true })
  }, [editing])

  const finish = () => {
    if (busy) return
    const n = length(draft)
    if (n === 0) return setError('Write something, or delete the Comment.')
    if (n > MAX_COMMENT) return setError(`Shorten it by ${group(n - MAX_COMMENT)} characters.`)
    if (draft.trim() === c.text) {
      refocus.current = true
      return setEditing(false)
    }
    setBusy(true)
    setError('')
    Promise.resolve()
      .then(() => comments.edit(c.id, draft, findMentions(draft, candidates)))
      .then(
        () => {
          setBusy(false)
          refocus.current = true
          setEditing(false)
        },
        (e: unknown) => {
          setBusy(false)
          setError(`The change could not be made. ${serverSentence(e)}`)
        },
      )
  }

  const remove = () => {
    setBusy(true)
    setError('')
    Promise.resolve()
      .then(() => comments.remove(c.id))
      .catch((e: unknown) => {
        setBusy(false)
        setConfirming(false)
        setError(`The Comment could not be deleted. ${serverSentence(e)}`)
      })
  }

  const when = formatWhen(c.created_at)
  const full = new Date(c.created_at).toLocaleString()
  return (
    <li className={lit ? 'qc-item is-lit' : 'qc-item'} data-comment={c.id} tabIndex={-1} aria-label={`${author.name}, ${when}${c.edited_at !== null ? ', edited' : ''}`}>
      <span className="q-avatar qc-item__avatar" style={{ background: who?.color ?? 'var(--q-ink-3)' }} aria-hidden="true">
        {initials(author.name)}
      </span>
      <div className="qc-item__body">
        <p className="qc-item__meta">
          <span className="qc-item__author">{author.name}</span>
          <time className="qc-item__time" dateTime={new Date(c.created_at).toISOString()} title={full}>
            {when}
          </time>
          {c.edited_at !== null && (
            <span className="qc-item__edited" title={`Edited ${new Date(c.edited_at).toLocaleString()}`}>
              · edited
            </span>
          )}
        </p>
        {editing ? (
          <form
            className="qc-edit"
            onSubmit={(e) => {
              e.preventDefault()
              finish()
            }}
          >
            <MentionField
              value={draft}
              onChange={(t) => {
                setDraft(t)
                if (error) setError('')
              }}
              members={candidates}
              label="Your Comment"
              showLabel={false}
              autoFocus
              onSubmit={finish}
              onCancel={() => {
                refocus.current = true
                setDraft(c.text)
                setEditing(false)
              }}
            />
            <Counter text={draft} />
            <div className="qc-actions">
              <button type="submit" className="q-btn q-btn--sm q-btn--primary" aria-disabled={busy}>
                {busy ? 'Changing…' : 'Done'}
              </button>
              <button
                type="button"
                className="q-btn q-btn--sm"
                onClick={() => {
                  refocus.current = true
                  setDraft(c.text)
                  setEditing(false)
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <CommentText text={c.text} mentions={c.mentions} people={list} />
        )}
        {!editing && !readOnly && (mine || canDelete) && (
          <div className="qc-actions qc-actions--row">
            {confirming ? (
              <span className="qc-confirm" role="group" aria-label="Delete this Comment?">
                <span>Delete this Comment? It cannot be brought back.</span>
                <button type="button" className="q-btn q-btn--sm q-btn--danger" aria-disabled={busy} onClick={remove} autoFocus>
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
                <button type="button" className="q-btn q-btn--sm" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </span>
            ) : (
              <>
                {mine && (
                  <button
                    ref={editRef}
                    type="button"
                    className="qc-link"
                    aria-label="Edit your Comment"
                    onClick={() => {
                      setDraft(c.text)
                      setEditing(true)
                    }}
                  >
                    Edit
                  </button>
                )}
                {canDelete && (
                  <button type="button" className="qc-link qc-link--danger" aria-label={mine ? 'Delete your Comment' : `Delete ${author.name}’s Comment`} onClick={() => setConfirming(true)}>
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {error && (
          <p className="q-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </li>
  )
})

/** "9 412 / 10 000" from 9 000 characters on; past the limit it says by how much, in the danger colour and in words. */
function Counter({ text, id }: { text: string; id?: string }) {
  const n = length(text)
  if (n < NEAR_LIMIT) return id ? <span id={id} className="q-sr">At most {group(MAX_COMMENT)} characters.</span> : null
  const over = n > MAX_COMMENT
  return (
    <p id={id} className={over ? 'qc-counter is-over' : 'qc-counter'} aria-live="polite">
      {group(n)} / {group(MAX_COMMENT)}
      {over && ` — ${group(n - MAX_COMMENT)} too many`}
    </p>
  )
}

function WriteBox({ card, candidates, empty }: { card: string; candidates: Member[]; empty: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hintId = useId()
  const counterId = useId()
  const n = length(text)
  const blocked = n === 0 || n > MAX_COMMENT || busy

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (blocked) return
    const value = text
    setBusy(true)
    setError('')
    Promise.resolve()
      .then(() => comments.post(card, value, findMentions(value, candidates)))
      .then(
        () => {
          setBusy(false)
          // Something new typed meanwhile stays.
          setText((now) => (now === value ? '' : now))
        },
        (err: unknown) => {
          setBusy(false)
          setError(`The Comment could not be added. ${serverSentence(err)}`)
        },
      )
  }

  return (
    <form className="qc-write" onSubmit={submit}>
      <MentionField
        value={text}
        onChange={(t) => {
          setText(t)
          if (error) setError('')
        }}
        members={candidates}
        label={empty ? 'Start the thread' : 'Add a Comment'}
        placeholder={empty ? 'A question or a remark about this Card…' : undefined}
        describedBy={`${hintId} ${counterId}`}
        onSubmit={() => submit()}
      />
      <div className="qc-write__foot">
        <span className="q-hint qc-write__hint" id={hintId}>
          @ to mention a Member · Markdown and $math$ · ⌘Enter to add
        </span>
        <Counter text={text} id={counterId} />
        <button type="submit" className="q-btn q-btn--sm q-btn--primary" aria-disabled={blocked} title={n > MAX_COMMENT ? `A Comment can be at most ${group(MAX_COMMENT)} characters long.` : undefined}>
          {busy ? 'Adding…' : 'Add Comment'}
        </button>
      </div>
      {error && (
        <p className="q-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
