import { useReactFlow, useViewportStore } from '@xyflow/react'
import { usePrefs } from '../settings/prefs'
import { useZoomLevel } from './useZoomLevel'

const MODE_LABEL = { full: 'full Cards', compact: 'titles', tile: 'zoomed out — status only' } as const

type Props = { cards: number; frames: number; onFit: () => void }

export function ZoomHud({ cards, frames, onFit }: Props) {
  // The person's zoom: React Flow's zoom over the Board scale (Settings → Board), so 100% is the Board scale.
  const base = usePrefs((s) => s.boardScale)
  const pct = useViewportStore((s) => Math.round((s.transform[2] * 10000) / base))
  const level = useZoomLevel()
  const rf = useReactFlow()
  return (
    <>
      <div className="qb-hud" role="group" aria-label="Zoom">
        <button
          type="button"
          className="qb-hud__btn"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => void rf.zoomOut({ duration: 140 })}
        >
          −
        </button>
        <span className="qb-hud__pct" aria-live="polite">
          {pct}%
        </span>
        <button
          type="button"
          className="qb-hud__btn"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => void rf.zoomIn({ duration: 140 })}
        >
          +
        </button>
        <span className="qb-hud__sep" />
        <button type="button" className="qb-hud__btn qb-hud__fit" data-testid="zoom-fit" title="Fit the Board to the view" onClick={onFit}>
          Fit
        </button>
      </div>
      <div className="qb-counts" aria-hidden="true">
        <span>
          {cards} {cards === 1 ? 'Card' : 'Cards'} · {frames} {frames === 1 ? 'Frame' : 'Frames'}
        </span>
        <span>·</span>
        <span>{MODE_LABEL[level]}</span>
      </div>
    </>
  )
}
