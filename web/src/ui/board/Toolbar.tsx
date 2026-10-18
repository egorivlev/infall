type Props = {
  readOnly: boolean
  onAddCard: () => void
  onAddFrame: () => void
}

/** Top-left of the Board. Absent in read-only mode. */
export function Toolbar({ readOnly, onAddCard, onAddFrame }: Props) {
  if (readOnly) return null
  return (
    <div className="qb-toolbar" data-tour="add" role="toolbar" aria-label="Add to the Board">
      <button type="button" className="q-btn q-btn--sm qb-toolbar__btn" data-testid="toolbar-add-card" onClick={onAddCard}>
        + Card
      </button>
      <button type="button" className="q-btn q-btn--sm qb-toolbar__btn" data-testid="toolbar-add-frame" onClick={onAddFrame}>
        + Frame
      </button>
    </div>
  )
}
