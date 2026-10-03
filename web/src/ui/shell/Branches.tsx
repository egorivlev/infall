import { useEffect, useRef } from 'react'
import { history as boardHistory, useBoard, useBranches, useHistory, useMembers } from '../../lib'
import type { BranchInfo, Checkpoint } from '../../lib'
import { useHistoryPanel } from '../bridge'
import { orderBranches, parentName } from './branchMeta'
import { formatDateTime } from './dates'
import { Link } from './Link'
import { NewBranch } from './NewBranch'
import { branchPath, MAIN } from './router'

const ignore = () => {}

/** "main · 14 Nov, 10:02", or "main · ◆ Kick-off" when a known Checkpoint names exactly that moment. */
function startedFrom(b: BranchInfo, all: BranchInfo[], checkpoints: Checkpoint[]): string {
  const from = b.parent
  if (!from) return '—'
  const cp = checkpoints.find((c) => c.moment.branch === from.branch && c.moment.seq === from.seq)
  const when = cp ? `◆ ${cp.name}` : b.created_at === undefined ? '' : formatDateTime(b.created_at)
  return [parentName(b, all), when].filter(Boolean).join(' · ') || '—'
}

export function Branches({ current }: { current: string }) {
  const list = orderBranches(useBranches())
  const people = useMembers()
  const hist = useHistory()
  const openId = useBoard().branch?.id

  // The Checkpoint list comes from History, which follows the Branch the Board has open.
  const histRef = useRef(hist)
  useEffect(() => {
    histRef.current = hist
  })
  useEffect(() => {
    if (!openId) return
    const h = histRef.current
    if ((h.status === 'ready' || h.status === 'loading') && h.branch?.id === openId) return
    void Promise.resolve(boardHistory.open()).catch(ignore)
  }, [openId])
  // Leave History open if the History panel is using it.
  useEffect(
    () => () => {
      if (!useHistoryPanel.getState().open) boardHistory.close()
    },
    [],
  )

  const checkpoints = hist.status === 'ready' && hist.branch?.id === openId ? hist.checkpoints : []

  return (
    <div className="q-branches">
      <div className="q-branches__main">
        <div className="q-branches__title">
          <h1 className="q-branches__h">Branches</h1>
          <span className="q-mono q-hint">
            {list.length} {list.length === 1 ? 'Branch' : 'Branches'}
          </span>
        </div>
        <div className="q-tablebox">
          <table className="q-table q-branches__table">
            <thead>
              <tr>
                <th scope="col">Branch</th>
                <th scope="col">Started from</th>
                <th scope="col">Created by</th>
                <th scope="col" className="q-branches__num">
                  Changes
                </th>
                <th scope="col">
                  <span className="q-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <th scope="row" className="q-branches__cell-name">
                    <span className={`q-branches__name${b.name === MAIN ? '' : ' q-branches__name--branch'}`}>{b.name}</span>
                    {b.name === current && <span className="q-tag q-branches__open">open</span>}
                  </th>
                  <td className="q-branches__from">{startedFrom(b, list, checkpoints)}</td>
                  <td className="q-branches__by">{people.find((m) => m.id === b.created_by)?.name ?? '—'}</td>
                  <td className="q-branches__num q-mono">{b.seq}</td>
                  <td className="q-table__act">
                    {b.name === MAIN && <span className="q-table__note q-branches__default">default Branch</span>}
                    <Link href={branchPath(b.name)} className="q-btn q-btn--sm" aria-label={`Open ${b.name}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="q-hint q-branches__empty">Loading Branches…</p>}
        </div>
      </div>
      <NewBranch current={current} checkpoints={checkpoints} />
    </div>
  )
}
