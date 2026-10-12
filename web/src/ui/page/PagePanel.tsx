import './page.css'
import { memo, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { ops, useBoard, useHistory, usePage } from '../../lib'
import type { CardVM, PageVM, Status } from '../../lib'
import { boardBridge, pagePanel } from '../bridge'
import { centre, containsPoint } from '../board/geometry'
import { StatusGlyph } from '../board/StatusGlyph'
import { StatusMenu } from '../board/StatusMenu'
import { STATUS_LABEL, STATUS_TOKEN } from '../board/status'
import { Toast } from '../board/Toast'
import { useBoardActions } from '../board/useBoardActions'
import { formatTime } from '../shell/dates'
import { initials } from '../shell/initials'
import { Blocks } from './Blocks'
import { DraftArea } from './DraftArea'
import { PageTodos } from './PageTodos'
import { count, firstName } from './people'
import { Sources } from './Sources'

type Props = {
  cardId: string
  /** Fill the whole Board area instead of docking to its right edge. */
  full: boolean
  /** Close the panel and put focus back on the Card. */
  onClose: (cardId: string) => void
}

function StatusPicker({ card, readOnly }: { card: CardVM; readOnly: boolean }) {
  const actions = useBoardActions()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const style = { ['--st' as string]: `var(--q-st-${STATUS_TOKEN[card.status]})` }
  const chip = (
    <>
      <StatusGlyph status={card.status} size={10} label={null} />
      <span>{STATUS_LABEL[card.status]}</span>
    </>
  )
  if (readOnly) {
    return (
      <span className="qp-status" style={style}>
        {chip}
      </span>
    )
  }
  const shut = () => {
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }
  const pick = (s: Status) => {
    shut()
    if (s !== card.status) void actions.submit([ops.setStatus(card.id, s)])
  }
  return (
    <span className="qp-status-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="qp-status qp-status--btn"
        style={style}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${STATUS_LABEL[card.status]}. Change status`}
        title="Change status"
        onClick={() => setOpen((o) => !o)}
      >
        {chip}
        <span className="qp-status__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <StatusMenu value={card.status} onPick={pick} onClose={shut} />}
    </span>
  )
}

function Title({ card, canEdit, headingRef }: { card: CardVM; canEdit: boolean; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const actions = useBoardActions()
  const [editing, setEditing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  if (editing && !canEdit) setEditing(false) // the Page turned read-only under the editor

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus({ preventScroll: true })
  }, [editing])

  const shown = card.title || 'Untitled'
  const empty = card.title ? '' : ' is-empty'
  return (
    <h1 className="qp-title" ref={headingRef} tabIndex={-1}>
      {editing && canEdit ? (
        <DraftArea
          initial={card.title}
          label="Title"
          confirm="enter"
          selectAll
          className="qp-title__editor"
          placeholder="Untitled"
          onFinish={(r) => {
            refocus.current = r.keyboard
            setEditing(false)
            const text = r.text.replace(/\s*\n\s*/g, ' ').trim()
            if (r.commit && text !== card.title) void actions.submit([ops.setText(card.id, 'title', text)])
          }}
        />
      ) : canEdit ? (
        <button ref={buttonRef} type="button" className={`qp-title__text qp-title__btn${empty}`} title="Edit the title" onClick={() => setEditing(true)}>
          {shown}
        </button>
      ) : (
        <span className={`qp-title__text${empty}`}>{shown}</span>
      )}
    </h1>
  )
}

function LockBanner({ editor }: { editor: NonNullable<PageVM['editor']> }) {
  const name = editor.member?.name
  const who = firstName(name)
  return (
    <div className="qp-lock" role="status" data-testid="page-lock" style={{ ['--who' as string]: editor.member?.color ?? 'var(--q-ink-3)' }}>
      <span className="q-avatar qp-lock__avatar" aria-hidden="true">
        {name ? initials(name) : '?'}
      </span>
      <span>
        <b>{who} is editing this Page</b>
        <span className="qp-lock__rest">
          {' '}
          · since {formatTime(editor.since)}. You can read it and change the Card’s status; the Page opens for editing when they’re done.
        </span>
      </span>
    </div>
  )
}

/** The Simulations of a Page for the meta line: " · 1 Visual · 2 Runs"; nothing when there are none. */
function simulations(blocks: PageVM['blocks']): string {
  const visuals = blocks.filter((b) => b.type === 'visual').length
  const runCount = blocks.filter((b) => b.type === 'run').length
  return [visuals > 0 && count(visuals, 'Visual'), runCount > 0 && count(runCount, 'Run')]
    .filter((part): part is string => Boolean(part))
    .map((part) => ` · ${part}`)
    .join('')
}

const MARK = { out: '→', in: '←', none: '—' } as const

const Connections = memo(function Connections({ connections }: { connections: PageVM['connections'] }) {
  return (
    <section className="qp-conns" aria-labelledby="qp-conns-head">
      <h2 className="q-caps qp-conns__head" id="qp-conns-head">
        Connections
      </h2>
      {connections.length === 0 ? (
        <span className="qp-conns__none">No Connections yet.</span>
      ) : (
        <ul className="qp-conns__list">
          {connections.map((c) => {
            const label = c.label || (c.kind === 'contradicts' ? 'contradicts' : '')
            return (
              <li key={c.id}>
                <button type="button" className="qp-conn" title="Show this Card on the Board" onClick={() => boardBridge.focus('card', c.other.id)}>
                  {label && <span className="qp-conn__label">{label}</span>}
                  {label && ' '}
                  <span className="qp-conn__mark">{MARK[c.direction]}</span>{' '}
                  <span className="qp-conn__title">{c.other.title || 'Untitled'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
})

/**
 * The Page of a Card, docked beside the live Board. Not a dialog: the Board stays usable, focus is
 * not trapped, and Esc closes it only when the key was not meant for an editor or a field.
 */
export function PagePanel({ cardId, full, onClose }: Props) {
  const vm = usePage(cardId)
  const board = useBoard()
  const { card, editor } = vm
  const readOnly = board.readOnly
  // The Board closes the Page while History shows an earlier moment; if one is ever shown, Runs are for reading only.
  const previewing = useHistory().preview !== null
  const canEdit = !readOnly && !editor && card !== null
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [cardId])

  const close = () => onClose(cardId)
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    // Editors and forms keep their own Esc (they stop it); a plain field keeps the panel open too.
    if (e.target instanceof Element && e.target.closest('input, textarea, select')) return
    e.stopPropagation()
    close()
  }

  const frame = card ? board.frames.find((f) => containsPoint(f, centre(card))) : undefined
  const waiting = card === null && (board.status === 'idle' || board.status === 'loading')
  const sync = readOnly
    ? 'Read-only'
    : editor
      ? `Read-only while ${firstName(editor.member?.name)} edits`
      : board.pending > 0
        ? 'Syncing…'
        : 'Synced'
  const label = card ? `Page of ${card.title || 'Untitled'}` : waiting ? 'Page' : 'Page of a removed Card'

  return (
    <section className={`qp-panel${full ? ' is-full' : ''}`} aria-label={label} data-testid="page-panel" onKeyDown={onKeyDown}>
      <header className="qp-head">
        <svg className="qp-head__icon" width="13" height="14" viewBox="0 0 13 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <path d="M1.5 1 H8.5 L11.5 4 V13 H1.5 Z M8.5 1 V4 H11.5" />
        </svg>
        {frame && (
          <>
            <span className="qp-crumb">Frame: {frame.title || 'Untitled'}</span>
            <span className="qp-crumb__sep" aria-hidden="true">
              ›
            </span>
          </>
        )}
        <span className="qp-crumb is-current">Page</span>
        {card && <StatusPicker card={card} readOnly={readOnly} />}
        <span className="qp-spacer" />
        {card && <span className="qp-sync">{sync}</span>}
        <button
          type="button"
          className="qp-head__btn"
          aria-pressed={full}
          aria-label="Open full width"
          title={full ? 'Back to the side panel' : 'Open full width'}
          onClick={() => pagePanel.toggleFull()}
        >
          ⤢
        </button>
        <button type="button" className="qp-head__btn" aria-label="Close Page" title="Close Page" onClick={close}>
          ✕
        </button>
      </header>

      {card && editor && !readOnly && <LockBanner editor={editor} />}

      <div className="qp-scroll">
        {card ? (
          <div className="qp-col">
            <div className="qp-top">
              <Title card={card} canEdit={canEdit} headingRef={headingRef} />
              <p className="qp-meta">
                {count(vm.blocks.length, 'block')} · {count(vm.sources.length, 'Source')} · {count(vm.connections.length, 'Connection')}
                {simulations(vm.blocks)}
              </p>
            </div>
            <Blocks cardId={cardId} blocks={vm.blocks} canEdit={canEdit} readOnly={readOnly || previewing} branchId={board.branch?.id} />
            <Sources cardId={cardId} sources={vm.sources} canEdit={canEdit} />
            {!readOnly && <PageTodos card={card} branchId={board.branch?.id} />}
            <Connections connections={vm.connections} />
          </div>
        ) : waiting ? (
          <div className="qp-col qp-gone">
            <h1 className="qp-gone__line" ref={headingRef} tabIndex={-1}>
              Loading Page…
            </h1>
          </div>
        ) : (
          <div className="qp-col qp-gone">
            <h1 className="qp-gone__title" ref={headingRef} tabIndex={-1}>
              This Card was removed.
            </h1>
            <button type="button" className="q-btn" onClick={close}>
              Close
            </button>
          </div>
        )}
      </div>

      <Toast />
    </section>
  )
}
