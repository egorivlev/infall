import { useEffect, useState } from 'react'

/** Empty Board: a quiet prompt. Read-only viewers get only the headline. */
export function EmptyState({ readOnly, onAddCard }: { readOnly: boolean; onAddCard: () => void }) {
  return (
    <div className="qb-empty">
      <h2 className="qb-empty__title">Nothing on this Board yet</h2>
      {!readOnly && (
        <>
          <p className="qb-empty__line">Double-click anywhere to add the first Card.</p>
          <button type="button" className="q-btn qb-empty__btn" onClick={onAddCard}>
            + Card
          </button>
        </>
      )}
    </div>
  )
}

/** Nothing for the first 150 ms, then plain text. */
export function LoadingNote({ delay = 150 }: { delay?: number }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  if (!shown) return null
  return <div className="qb-note">Loading Board…</div>
}

export function ErrorNote({ detail }: { detail?: string }) {
  return (
    <div className="qb-note" title={detail}>
      The Board could not be loaded.
    </div>
  )
}
