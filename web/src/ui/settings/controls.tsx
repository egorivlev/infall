// The parts every Settings section is built from (M17, design B3): a settings row — name and a one-line description
// on the left, one control on the right, a hairline under it — and the section's head. Every change applies at once:
// there is no Save. The controls themselves are the shared ones in ui/kit (q-seg, q-scale).
import { useId } from 'react'
import type { ReactNode, Ref } from 'react'

export { ScaleSelect } from '../kit'
export { Segmented } from '../kit'

type RowProps = {
  label: string
  description?: string
  /** Whether the value differs from its default: "Reset" is only there then. */
  changed: boolean
  onReset: () => void
  /** A pictogram of what the setting changes (the three scales, told apart at a glance). */
  pic?: ReactNode
  children: (ids: { labelId: string; descriptionId?: string; controlId: string }) => ReactNode
}

/**
 * The control names itself with aria-labelledby (a radio group, a spinbutton): a <label for> would rename a chosen
 * radio "Theme". After Reset the button is gone, so focus goes to the control it reset.
 */
export function SettingRow({ label, description, changed, onReset, pic, children }: RowProps) {
  const id = useId()
  const labelId = `${id}-label`
  const descriptionId = description ? `${id}-desc` : undefined
  const controlId = `${id}-control`
  const reset = () => {
    onReset()
    window.setTimeout(() => (document.getElementById(controlId) ?? document.getElementById(`${controlId}-on`))?.focus(), 0)
  }
  return (
    <div className="q-set-row">
      <div className="q-set-row__text">
        {pic}
        <div className="q-set-row__words">
          <span className="q-set-row__label" id={labelId}>
            {label}
          </span>
          {description && (
            <p className="q-set-row__desc" id={descriptionId}>
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="q-set-row__control">
        {changed && (
          <button type="button" className="q-btn q-btn--sm q-btn--ghost q-set-row__reset" aria-label={`Reset ${label} to default`} onClick={reset}>
            Reset
          </button>
        )}
        {children({ labelId, descriptionId, controlId })}
      </div>
    </div>
  )
}

/** The three scales' pictograms (design B3): a window — bars, a rail with lines of text, two Cards — with the part the
 *  scale changes drawn in ink and the rest in --q-ink-3. */
export function ScalePic({ part }: { part: 'interface' | 'text' | 'board' }) {
  const all = part === 'interface'
  const ink = (on: boolean) => (on ? 'var(--q-ink)' : 'var(--q-ink-3)')
  return (
    <svg className="q-set-row__pic" width="48" height="34" viewBox="0 0 48 34" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="46" height="32" rx="3" fill="none" stroke={ink(all)} strokeWidth={all ? 2 : 1.2} />
      <path d="M1 8 H47 M12 8 V33" stroke={ink(all)} strokeWidth={all ? 1.6 : 1} />
      <path d="M4 14 H9 M4 19 H9 M4 24 H8" stroke={ink(all || part === 'text')} strokeWidth={part === 'text' ? 2 : 1.2} strokeLinecap="round" />
      <rect x="17" y="13" width="10" height="7" rx="1.5" fill="none" stroke={ink(all || part === 'board')} strokeWidth={part === 'board' ? 2 : 1.2} />
      <rect x="32" y="21" width="10" height="7" rx="1.5" fill="none" stroke={ink(all || part === 'board')} strokeWidth={part === 'board' ? 2 : 1.2} />
    </svg>
  )
}

/** A section of Settings: its title (the page's heading), what it is about, and the section-wide Reset. */
export function SectionHead({ title, intro, headingRef, onResetAll, canResetAll }: {
  title: string
  intro?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
  onResetAll?: () => void
  canResetAll?: boolean
}) {
  return (
    <header className="q-settings__head q-set-head">
      <div className="q-set-head__row">
        <h1 className="q-title q-settings__title" ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        {onResetAll && (
          <button type="button" className="q-btn q-btn--sm q-btn--soft" disabled={!canResetAll} onClick={onResetAll}>
            Reset {title} to defaults
          </button>
        )}
      </div>
      {intro && <p className="q-settings__text">{intro}</p>}
    </header>
  )
}
