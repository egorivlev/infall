// The detail column: what happened in the selected Activity, and Restore.
import type { Activity, BoardPreview, Checkpoint } from '../../lib'
import { count, formatSpan } from './format'
import type { Person } from './format'
import { Avatar } from './Timeline'

type Props = {
  branch: string
  empty: boolean // no Changes on this Branch
  preview: BoardPreview | null // null = now
  activity: Activity | null // the Activity the previewed moment belongs to
  person: Person | null
  checkpoints: readonly Checkpoint[] // Checkpoints at exactly the previewed moment
  restoring: boolean
  onRestore: () => void
  /** M18: a moved copy reads its History but restores nothing. */
  readOnly?: boolean
}

export function Detail({ branch, empty, preview, activity, person, checkpoints, restoring, onRestore, readOnly = false }: Props) {
  if (empty) {
    return (
      <aside className="qh-detail" data-testid="history-detail" aria-label="Selected moment">
        <p className="qh-detail__note">No Changes on this Branch yet.</p>
      </aside>
    )
  }
  if (!preview) {
    return (
      <aside className="qh-detail" data-testid="history-detail" aria-label="Selected moment">
        <p className="qh-detail__note">This is the Board as it is now.</p>
      </aside>
    )
  }
  const partway = activity !== null && preview.seq < activity.toSeq
  return (
    <aside className="qh-detail" data-testid="history-detail" aria-label="Selected moment">
      <div className="qh-detail__scroll">
        {activity && person ? (
          <>
            <div className="qh-detail__who">
              <Avatar person={person} size={22} />
              <span className="qh-detail__name">{person.name}</span>
              <span className="qh-detail__when">{formatSpan(activity.startedAt, activity.endedAt)}</span>
            </div>
            <div className="qh-detail__count">{count(activity.count, 'Change')} in this Activity</div>
            <ul className="qh-detail__lines">
              {activity.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="qh-detail__name">The start of {branch}</div>
            <p className="qh-detail__hint">The Board before any Changes on this Branch.</p>
          </>
        )}
        {checkpoints.map((c) => (
          <div key={c.name} className="qh-detail__checkpoint">
            <span aria-hidden="true">◆</span> Checkpoint {c.name}
          </div>
        ))}
        {partway && <p className="qh-detail__hint">This moment is partway through the Activity.</p>}
      </div>
      {!readOnly && (
      <div className="qh-detail__foot">
        <button type="button" className="q-btn qh-restore" disabled={restoring} onClick={onRestore}>
          {restoring ? 'Restoring…' : (
            <>
              Restore <span className="q-mono">{branch}</span> to here
            </>
          )}
        </button>
        <p className="qh-detail__small">
          Restoring adds new Changes that bring the Board back to this moment. Nothing is deleted — undo it from History at
          any time.
        </p>
      </div>
      )}
    </aside>
  )
}
