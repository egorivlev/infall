// The History panel: sits under the Board while useHistoryPanel().open. Scrubbing only calls
// history.preview(); the Board above renders whatever useHistory().preview holds.
import './history.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ApiError, history, useBoard, useHistory, useMembers } from '../../lib'
import { toasts } from '../board/toastStore'
import { historyPanel } from '../bridge'
import { Detail } from './Detail'
import { FORMER_MEMBER, count, momentLabel, personOf } from './format'
import type { Person } from './format'
import { activityAt, buildLanes, dayTicks, positionOf, seqForStep } from './model'
import { Timeline } from './Timeline'

export const RESTORE_UNDO_MS = 10_000
export const RESTORE_FAILED = 'That Restore did not go through. Try again.'
export const RESTORE_OFFLINE = 'That Restore did not go through — the server could not be reached. Try again.'

// history.open() reports failure through useHistory().status; nothing more to do with the rejection here.
const ignore = () => {}

/** Resolves true when the Restore landed; raises the failure toast otherwise. */
async function runRestore(seq: number): Promise<boolean> {
  try {
    await history.restore(seq)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.code === 'closed') return false // the Board was closed; nothing to report
    const offline = e instanceof ApiError && e.status === 0
    toasts.show({ message: offline ? RESTORE_OFFLINE : RESTORE_FAILED, title: e instanceof Error ? e.message : String(e) })
    return false
  }
}

/** True only after `active` has stayed true for `ms`. */
function useDelayed(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => setOn(true), ms)
    return () => {
      clearTimeout(t)
      setOn(false)
    }
  }, [active, ms])
  return active && on
}

type Props = {
  /** Called after Esc or the close button has closed the panel (e.g. to move focus back to the Board). */
  onClose?: () => void
}

export function HistoryPanel({ onClose }: Props) {
  const hist = useHistory()
  const snap = useBoard()
  const memberList = useMembers()
  const rootRef = useRef<HTMLElement>(null)
  const undoToast = useRef<number | null>(null)
  const [restoring, setRestoring] = useState(false)

  // History follows the Branch the Board has open: open it with the panel, close it with the panel,
  // and again whenever the Branch changes. Cleanup is synchronous so open/close stay paired under StrictMode.
  const branchId = snap.branch?.id
  useEffect(() => {
    if (!branchId) return
    void Promise.resolve(history.open()).catch(ignore)
    return () => {
      // An Undo offer belongs to this Branch's History; it must not outlive it.
      if (undoToast.current !== null) toasts.dismiss(undoToast.current)
      undoToast.current = null
      history.close()
    }
  }, [branchId])

  const { activities, checkpoints, preview, head } = hist
  const n = activities.length
  const ready = hist.status === 'ready'
  const branch = hist.branch?.name ?? snap.branch?.name ?? 'main'

  const headRef = useRef(head)
  useLayoutEffect(() => {
    headRef.current = head
  })

  const lanes = useMemo(() => buildLanes(activities), [activities])
  const ticks = useMemo(() => dayTicks(activities), [activities])
  const people = useMemo(() => {
    const byId = new Map(memberList.map((m) => [m.id, m]))
    const out = new Map<string, Person>()
    for (const a of activities) if (!out.has(a.author)) out.set(a.author, personOf(byId, a.author))
    for (const c of checkpoints) if (!out.has(c.author)) out.set(c.author, personOf(byId, c.author))
    return out
  }, [memberList, activities, checkpoints])

  const seq = preview ? preview.seq : null
  const pos = seq === null ? n : positionOf(activities, seq)
  const selected = seq === null ? -1 : activityAt(activities, seq)
  const activity = selected >= 0 ? (activities[selected] ?? null) : null
  const here = useMemo(() => (seq === null ? [] : checkpoints.filter((c) => c.moment.seq === seq)), [checkpoints, seq])

  // Stable: the memoised blocks and markers keep their props while scrubbing.
  const pick = useCallback((to: number) => history.preview(to >= headRef.current ? null : to), [])
  const activitiesRef = useRef(activities)
  useLayoutEffect(() => {
    activitiesRef.current = activities
  })
  const stepTo = useCallback((k: number) => history.preview(seqForStep(activitiesRef.current, k)), [])

  const restore = async () => {
    if (!preview || restoring) return
    const before = head
    const message = `Restored ${branch} to ${momentLabel(preview.at)}.`
    setRestoring(true)
    const ok = await runRestore(preview.seq)
    setRestoring(false)
    if (!ok) return
    history.preview(null)
    // The button is gone at "now"; keep keyboard focus in the panel.
    rootRef.current?.querySelector<HTMLElement>('.qh-range')?.focus({ preventScroll: true })
    const id = toasts.show(
      {
        message,
        action: {
          label: 'Undo',
          run: () => {
            toasts.dismiss(id)
            if (undoToast.current === id) undoToast.current = null
            void runRestore(before)
          },
        },
      },
      RESTORE_UNDO_MS,
    )
    undoToast.current = id
  }

  const close = () => {
    historyPanel.close()
    onClose?.()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.stopPropagation()
    close()
  }

  const loading = useDelayed(hist.status === 'idle' || hist.status === 'loading', 150)

  return (
    <section
      ref={rootRef}
      className="qh-panel"
      data-testid="history-panel"
      aria-label={`History of ${branch}`}
      onKeyDown={onKeyDown}
    >
      <div className="qh-main">
        <header className="qh-head">
          <h2 className="qh-title">
            History of <span className="q-mono">{branch}</span>
          </h2>
          {ready && (
            <span className="qh-counts" data-testid="history-counts">
              {count(n, 'Activity', 'Activities')} · {count(head, 'Change')} · {count(checkpoints.length, 'Checkpoint')}
            </span>
          )}
          <span className="qh-spacer" />
          <button
            type="button"
            className="q-btn q-btn--icon q-btn--quiet q-btn--sm"
            aria-label="Close History"
            title="Close History (Esc)"
            onClick={close}
          >
            ×
          </button>
        </header>
        {ready ? (
          <Timeline
            activities={activities}
            checkpoints={checkpoints}
            lanes={lanes}
            ticks={ticks}
            people={people}
            former={FORMER_MEMBER}
            seq={seq}
            pos={pos}
            step={Math.ceil(pos)}
            selected={selected}
            valueText={preview ? momentLabel(preview.at) : 'now'}
            onStep={stepTo}
            onPick={pick}
          />
        ) : hist.status === 'error' ? (
          <div className="qh-status" role="alert">
            <span title={hist.error}>History could not be loaded.</span>
            <button type="button" className="q-btn q-btn--sm" onClick={() => void Promise.resolve(history.open()).catch(ignore)}>
              Try again
            </button>
          </div>
        ) : (
          <div className="qh-status">{loading ? 'Loading History…' : null}</div>
        )}
      </div>
      {ready && (
        <Detail
          branch={branch}
          empty={n === 0}
          preview={preview}
          activity={activity}
          person={activity ? (people.get(activity.author) ?? FORMER_MEMBER) : null}
          checkpoints={here}
          restoring={restoring}
          onRestore={() => void restore()}
        />
      )}
    </section>
  )
}
