import { useCallback, useState } from 'react'
import { useReactFlow, useViewportStore } from '@xyflow/react'
import { useBoard, useHistory } from '../../../lib'
import { MoreMenu } from '../../page/MoreMenu'
import type { MenuItem } from '../../page/MoreMenu'
import { toasts } from '../toastStore'
import { ExportDialog } from './ExportDialog'
import type { ExportFormat } from './run'
import type { Area, BoardContent } from './svg'

type Open = { format: ExportFormat; content: BoardContent; at?: number | null; visibleArea: Area | null }

/**
 * "Export ▾" in the Board's toolbar: the Board as SVG or PNG. It exports what the Board shows — the open Branch now,
 * or the moment History previews — for anyone who can read it (Guests too). Lives inside the Board's React Flow.
 */
export function BoardExportMenu() {
  const snap = useBoard()
  const preview = useHistory().preview
  const rf = useReactFlow()
  const width = useViewportStore((s) => s.width)
  const height = useViewportStore((s) => s.height)
  const [open, setOpen] = useState<Open | null>(null)

  const pick = useCallback(
    (format: ExportFormat) => {
      const shown = preview ?? snap
      if (shown.cards.length === 0 && shown.frames.length === 0) {
        toasts.show({ message: 'There is nothing on this Board to export yet.' })
        return
      }
      // The view in Board units: React Flow's size is in the canvas's own pixels, which the viewport maps from.
      const vp = rf.getViewport()
      const visibleArea = width > 0 && height > 0 && vp.zoom > 0 ? { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: width / vp.zoom, h: height / vp.zoom } : null
      setOpen({
        format,
        // What is shown at this moment; Changes arriving meanwhile do not move what is being exported.
        content: { cards: shown.cards, frames: shown.frames, connections: shown.connections },
        at: preview ? preview.at : undefined,
        visibleArea,
      })
    },
    [preview, snap, rf, width, height],
  )

  const items: MenuItem[] = [
    { label: 'Board as SVG…', onPick: () => pick('svg') },
    { label: 'Board as PNG…', onPick: () => pick('png') },
  ]

  return (
    <>
      <MoreMenu
        label="Export the Board as a picture"
        title="Export the Board as SVG or PNG"
        glyph={
          <>
            Export <span className="qb-toolbar__caret">▾</span>
          </>
        }
        items={items}
        wrapClass="qb-toolbar__menu-wrap"
        buttonClass="q-btn q-btn--sm qb-toolbar__btn"
        menuClass="qb-toolbar__menu"
      />
      {open && (
        <ExportDialog
          format={open.format}
          content={open.content}
          branch={snap.branch?.name ?? 'main'}
          at={open.at}
          visibleArea={open.visibleArea}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
