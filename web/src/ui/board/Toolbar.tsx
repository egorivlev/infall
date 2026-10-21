import { MoreMenu } from '../page/MoreMenu'
import type { MenuItem } from '../page/MoreMenu'

type Props = {
  readOnly: boolean
  onAddCard: () => void
  onAddFrame: () => void
  /** M13: Import BibTeX… (Members, on the live Board). */
  onImportBibtex?: () => void
  /** M13: Export BibTeX — every Source on the Branch (anyone who reads the Board, Guests too). */
  onExportBibtex?: () => void
}

/** Top-left of the Board: adding (absent in read-only mode), then BibTeX in and out. */
export function Toolbar({ readOnly, onAddCard, onAddFrame, onImportBibtex, onExportBibtex }: Props) {
  const bibtex: MenuItem[] = []
  if (!readOnly && onImportBibtex) bibtex.push({ label: 'Import BibTeX…', onPick: onImportBibtex })
  if (onExportBibtex) bibtex.push({ label: 'Export BibTeX', onPick: onExportBibtex })
  if (readOnly && bibtex.length === 0) return null
  const add = !readOnly && (
    <div className="qb-toolbar" data-tour="add" role="toolbar" aria-label="Add to the Board">
      <button type="button" className="q-btn q-btn--sm qb-toolbar__btn" data-testid="toolbar-add-card" onClick={onAddCard}>
        + Card
      </button>
      <button type="button" className="q-btn q-btn--sm qb-toolbar__btn" data-testid="toolbar-add-frame" onClick={onAddFrame}>
        + Frame
      </button>
    </div>
  )
  if (bibtex.length === 0) return add || null
  return (
    <div className="qb-tools">
      {add}
      <div className="qb-toolbar" role="toolbar" aria-label="Sources on this Branch">
        <MoreMenu
          label="BibTeX: import or export the Sources on this Branch"
          title="Import or export BibTeX"
          glyph={
            <>
              BibTeX <span className="qb-toolbar__caret">▾</span>
            </>
          }
          items={bibtex}
          wrapClass="qb-toolbar__menu-wrap"
          buttonClass="q-btn q-btn--sm qb-toolbar__btn"
          menuClass="qb-toolbar__menu"
        />
      </div>
    </div>
  )
}
