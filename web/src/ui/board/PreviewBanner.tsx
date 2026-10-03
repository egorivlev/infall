import { momentLabel } from '../history/format'

type Props = {
  branch: string
  at: number | null // time of the previewed moment; null at the very start of the Branch
  onBack: () => void
}

/** Centred at the top of the Board while it shows an earlier moment from History. */
export function PreviewBanner({ branch, at, onBack }: Props) {
  return (
    <div className="qb-preview" data-testid="preview-banner" role="group" aria-label="History preview">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="5" />
        <path d="M6.5 3.5 V6.5 L8.6 7.8" />
      </svg>
      <span className="qb-preview__text">
        Previewing <b className="q-mono">{branch}</b> at <b>{momentLabel(at)}</b>
      </span>
      <span className="qb-preview__chip">read-only</span>
      <button type="button" className="q-btn q-btn--sm" onClick={onBack}>
        Back to now
      </button>
    </div>
  )
}
