import './suggestions.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { members as team, suggestions, useBoard, useMembers, useSession, useSuggestions } from '../../lib'
import type { Member } from '../../lib'
import { suggestionsPanel, useSuggestionsPanel } from '../bridge'
import { Link } from '../shell/Link'
import { useDelayedFlag } from '../shell/useDelayedFlag'
import { SuggestionBlock } from './SuggestionBlock'

type Props = {
  /** Called after the panel closed itself (✕ or Esc), so focus can go back to the Board. */
  onClose?: () => void
}

/**
 * Suggestions of the open Branch, docked left of the Board. The Board area mounts it while
 * `useSuggestionsPanel().open` (not for Guests, not while History previews an earlier moment).
 */
export function SuggestionsPanel({ onClose }: Props) {
  const list = useSuggestions()
  const board = useBoard()
  const memberList = useMembers()
  const session = useSession()
  const me = session.status === 'signed_in' ? session.member : null
  const previewId = useSuggestionsPanel((s) => s.preview?.id ?? null)
  const headRef = useRef<HTMLHeadingElement>(null)

  // Ask for the list when the panel opens: it is kept fresh from then on, this only tells loading from empty.
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    suggestions.reload().then(
      () => current && setLoad('ready'),
      () => current && setLoad('error'),
    )
    return () => {
      current = false
    }
  }, [attempt])
  const retry = () => {
    setLoad('loading')
    setAttempt((n) => n + 1)
  }

  // Names for "via Ana's AI" and the To-do owner picker; the list is empty until someone asks for it.
  const hasMembers = memberList.length > 0
  useEffect(() => {
    if (!hasMembers) void team.reload().catch(() => {})
  }, [hasMembers])

  useEffect(() => {
    headRef.current?.focus({ preventScroll: true })
    // Whatever was being previewed goes with the panel.
    return () => suggestionsPanel.preview(null)
  }, [])

  const people = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList])
  const owners = useMemo(() => {
    const others: Member[] = memberList.filter((m) => m.role !== 'guest' && m.id !== me?.id)
    others.sort((a, b) => a.name.localeCompare(b.name))
    return me ? [me, ...others] : others
  }, [memberList, me])
  const cards = useMemo(() => new Map(board.cards.map((c) => [c.id, c])), [board.cards])
  const pending = list.reduce((n, s) => (s.suggestion.state === 'pending' ? n + 1 : n), 0)

  const empty = list.length === 0
  const showLoading = useDelayedFlag(empty && load === 'loading', 150)

  const close = () => {
    suggestionsPanel.close()
    onClose?.()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.stopPropagation()
    close()
  }

  return (
    <aside className="qs-panel" data-testid="suggestions-panel" aria-labelledby="qs-title" onKeyDown={onKeyDown}>
      <header className="qs-head">
        <div className="qs-head__row">
          <h2 className="qs-head__title" id="qs-title" tabIndex={-1} ref={headRef}>
            Suggestions
          </h2>
          <span className="qs-head__count" data-testid="suggestions-count">
            {pending} pending
          </span>
          <span className="qs-spacer" />
          <button type="button" className="qs-head__close" aria-label="Close Suggestions" title="Close Suggestions" onClick={close}>
            ✕
          </button>
        </div>
        <p className="qs-head__line">Proposed by AI through a Member's access token. Nothing is added until someone accepts.</p>
      </header>

      {empty ? (
        <div className="qs-empty">
          {load === 'loading' && showLoading && <p className="qs-empty__note">Loading Suggestions…</p>}
          {load === 'error' && (
            <>
              <p className="qs-empty__line">Suggestions could not be loaded.</p>
              <button type="button" className="q-btn q-btn--sm" onClick={retry}>
                Try again
              </button>
            </>
          )}
          {load === 'ready' && (
            <>
              <h3 className="qs-empty__title">No Suggestions</h3>
              <p className="qs-empty__line">
                When a Member's AI proposes a Source or a Connection, it appears here for the team to review.
              </p>
              <Link href="/settings/ai">Set up AI access</Link>
            </>
          )}
        </div>
      ) : (
        <ul className="qs-list">
          {list.map((vm) => (
            <SuggestionBlock
              key={vm.suggestion.id}
              vm={vm}
              me={me}
              people={people}
              owners={owners}
              cards={cards}
              branchId={board.branch?.id}
              previewing={previewId === vm.suggestion.id}
            />
          ))}
        </ul>
      )}
    </aside>
  )
}
