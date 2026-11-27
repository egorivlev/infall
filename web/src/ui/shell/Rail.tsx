import { useCallback, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useBoard, useForYou, useWorkspace } from '../../lib'
import type { Member } from '../../lib'
import { boardBridge } from '../bridge'
import { TutorialProgress } from '../tutorial'
import { frameCounts } from './frameCounts'
import { Icon } from './Icon'
import { Link } from './Link'
import { branchPath, FOR_YOU_PATH, TODOS_PATH } from './router'
import type { ShellView } from './Shell'
import { SuggestionsItem } from './SuggestionsItem'
import { SyncStatus } from './SyncStatus'
import { useDismiss } from './useDismiss'
import { useOnBoard } from './useOnBoard'
import { useRoom } from '../settings/apply'

export function Rail({ member, route, branch }: { member: Member; route: ShellView; branch: string }) {
  const { frames, cards, readOnly, status } = useBoard()
  const counts = frameCounts(frames, cards)
  const onBoard = useOnBoard()
  const canAdd = member.role !== 'guest' && !readOnly
  const ws = useWorkspace()
  const local = ws.kind === 'local' // one Member, nobody to invite: no Members
  const moved = ws.readOnly === true // a moved copy: nothing to accept or reject
  const unseen = useForYou().unseen

  // In a narrow room (shell.css) the rail is folded to its icons; this opens it over the work area until a choice is
  // made in it, Esc, or a press outside. Elsewhere the button is not shown and `open` changes nothing.
  const room = useRoom()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const railRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  useDismiss(open, close, railRef, toggleRef)
  // Another room, screen or Branch folds it again (reset while rendering, not in an effect).
  const where = `${room}\n${route}\n${branch}`
  const [openedAt, setOpenedAt] = useState(where)
  if (openedAt !== where) {
    setOpenedAt(where)
    if (open) setOpen(false)
  }
  const onChoose = (e: MouseEvent) => {
    const el = e.target as Element
    if (el.closest('a, .q-rail__frame, [data-tour="suggestions"]')) setOpen(false)
  }

  return (
    <aside className={open ? 'q-rail is-open' : 'q-rail'} ref={railRef} onClick={onChoose}>
      <button
        type="button"
        ref={toggleRef}
        className="q-btn q-btn--icon q-btn--quiet q-rail__toggle"
        aria-expanded={open}
        aria-label={open ? 'Fold the side bar' : 'Unfold the side bar'}
        title={open ? 'Fold the side bar' : 'Unfold the side bar: names, Frames'}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="rail" />
      </button>
      <nav aria-label="Main" className="q-rail__nav" data-tour="rail">
        <Link href={branchPath(branch)} className="q-rail__item" title="Board" aria-current={route === 'board' ? 'page' : undefined}>
          <Icon name="board" />
          <span>Board</span>
        </Link>
        {member.role !== 'guest' && (
          <Link href={TODOS_PATH} className="q-rail__item" title="To-dos" data-tour="todos" aria-current={route === 'todos' ? 'page' : undefined}>
            <Icon name="todos" />
            <span>To-dos</span>
          </Link>
        )}
        {member.role !== 'guest' && (
          <Link
            href={FOR_YOU_PATH}
            className="q-rail__item"
            title="For you: Comments that mention you"
            aria-label={`For you, ${unseen} unseen`}
            aria-current={route === 'for-you' ? 'page' : undefined}
          >
            <Icon name="mention" />
            <span className="q-rail__label">For you</span>
            {/* Addressed to you: the only count that turns accent. A zero is not drawn (the spoken name still says it). */}
            {unseen > 0 && (
              <span className="q-count q-count--att" aria-hidden="true">
                {unseen}
              </span>
            )}
          </Link>
        )}
        {member.role !== 'guest' && !moved && <SuggestionsItem onBoard={route === 'board'} />}
        {member.role !== 'guest' && (
          <Link href="/branches" className="q-rail__item" title="Branches" data-tour="branches" aria-current={route === 'branches' ? 'page' : undefined}>
            <Icon name="branch" />
            <span>Branches</span>
          </Link>
        )}
        {member.role === 'admin' && !local && (
          <Link href="/members" className="q-rail__item" title="Members" aria-current={route === 'members' ? 'page' : undefined}>
            <Icon name="members" />
            <span>Members</span>
          </Link>
        )}
      </nav>
      <section className="q-rail__frames" aria-labelledby="q-frames-h">
        <div className="q-rail__head">
          <h2 className="q-lab" id="q-frames-h">
            Frames
          </h2>
          {canAdd && (
            <button
              type="button"
              className="q-btn q-btn--sm q-btn--icon q-btn--quiet"
              aria-label="Add Frame"
              title="Add Frame"
              onClick={() => onBoard(() => boardBridge.createFrame())}
            >
              <Icon name="plus" size={12} />
            </button>
          )}
        </div>
        {frames.length === 0 ? (
          <p className="q-hint q-rail__empty">No Frames yet.</p>
        ) : (
          <ul className="q-rail__list">
            {frames.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="q-rail__frame"
                  title="Jump to Frame"
                  aria-label={`${f.title || 'Untitled Frame'}, ${counts[f.id] ?? 0} ${counts[f.id] === 1 ? 'Card' : 'Cards'}`} onClick={() => onBoard(() => boardBridge.focus('frame', f.id))}>
                  <Icon name="frame" size={12} />
                  <span className="q-rail__frame-name">{f.title || 'Untitled Frame'}</span>
                  <span className="q-rail__count">
                    {counts[f.id] ?? 0}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <TutorialProgress />
      <footer className="q-rail__foot">
        <SyncStatus status={status} readOnly={member.role === 'guest' || moved} />
        {/* A Local Workspace has no server to name: it lives here (M17, B1). */}
        {local ? <div className="q-rail__host">On this computer</div> : <div className="q-rail__host q-rail__host--address">{window.location.host}</div>}
      </footer>
    </aside>
  )
}
