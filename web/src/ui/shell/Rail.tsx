import { useBoard } from '../../lib'
import type { Member } from '../../lib'
import { boardBridge } from '../bridge'
import { frameCounts } from './frameCounts'
import { Icon } from './Icon'
import { Link } from './Link'
import { branchPath } from './router'
import type { ShellView } from './Shell'
import { SyncStatus } from './SyncStatus'
import { useOnBoard } from './useOnBoard'

export function Rail({ member, route, branch }: { member: Member; route: ShellView; branch: string }) {
  const { frames, cards, readOnly, status } = useBoard()
  const counts = frameCounts(frames, cards)
  const onBoard = useOnBoard()
  const canAdd = member.role !== 'guest' && !readOnly
  return (
    <aside className="q-rail">
      <nav aria-label="Main" className="q-rail__nav">
        <Link href={branchPath(branch)} className="q-rail__item" aria-current={route === 'board' ? 'page' : undefined}>
          <Icon name="board" />
          <span>Board</span>
        </Link>
        {member.role !== 'guest' && (
          <Link href="/branches" className="q-rail__item" aria-current={route === 'branches' ? 'page' : undefined}>
            <Icon name="branch" />
            <span>Branches</span>
          </Link>
        )}
        {member.role === 'admin' && (
          <Link href="/members" className="q-rail__item" aria-current={route === 'members' ? 'page' : undefined}>
            <Icon name="members" />
            <span>Members</span>
          </Link>
        )}
      </nav>
      <section className="q-rail__frames" aria-labelledby="q-frames-h">
        <div className="q-rail__head">
          <h2 className="q-caps" id="q-frames-h">
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
      <footer className="q-rail__foot">
        <SyncStatus status={status} />
        <div className="q-rail__host">{window.location.host}</div>
      </footer>
    </aside>
  )
}
