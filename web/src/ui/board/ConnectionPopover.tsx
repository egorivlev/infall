import { useRef, useState } from 'react'
import { useViewportStore } from '@xyflow/react'
import { CONNECTION_KINDS, ops } from '../../lib'
import type { CardVM, ConnectionKind, ConnectionVM } from '../../lib'
import { interfacePxPerScreenPx } from '../settings/apply'
import { route } from './geometry'
import { returnFocus } from './focus'
import { KIND_LABEL } from './status'
import { ui } from './uiStore'
import { useBoardActions } from './useBoardActions'

type Props = {
  conn: ConnectionVM
  from: CardVM
  to: CardVM
}

function KindIcon({ kind }: { kind: ConnectionKind }) {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2 5 H20" />
      {kind === 'directed' && <path d="M15 1.5 L20 5 L15 8.5" />}
      {kind === 'contradicts' && <path d="M3 1 V9 M19 1 V9" />}
    </svg>
  )
}

/** Shown under the selected Connection: its kind and its label. Screen-space, so it stays readable at any zoom. */
export function ConnectionPopover({ conn, from, to }: Props) {
  const t = useViewportStore((s) => s.transform)
  const actions = useBoardActions()
  // null while not typing: the field then follows remote changes to the label.
  const [draft, setDraft] = useState<string | null>(null)
  const skipCommit = useRef(false)

  const r = route(from, to)
  // The canvas works in screen pixels; the popover sits in the Board element, which the interface scale zooms.
  const k = interfacePxPerScreenPx(document.querySelector('.qb-board') ?? undefined)
  const left = (r.mx * t[2] + t[0]) * k
  const top = (r.my * t[2] + t[1]) * k + 18

  const commitLabel = () => {
    setDraft(null)
    if (skipCommit.current || draft === null) return
    const text = draft.trim()
    if (text !== conn.label) void actions.submit([ops.setText(conn.id, 'label', text)])
  }

  return (
    <div
      className="qb-popover"
      style={{ left, top }}
      role="dialog"
      aria-label="Connection"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          returnFocus(e.currentTarget)
          ui.clearSelection()
        }
      }}
    >
      <div className="qb-popover__kinds" role="radiogroup" aria-label="Kind">
        {CONNECTION_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={conn.kind === k}
            className="qb-kind"
            onClick={() => {
              if (k !== conn.kind) void actions.submit([ops.setKind(conn.id, k)])
            }}
          >
            <KindIcon kind={k} />
            <span>{KIND_LABEL[k]}</span>
          </button>
        ))}
      </div>
      <label className="qb-popover__field">
        <span className="q-caps">Label</span>
        <input
          className="q-input qb-popover__input"
          value={draft ?? conn.label}
          placeholder="e.g. builds on"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setDraft(conn.label)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              returnFocus(e.currentTarget)
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              returnFocus(e.currentTarget)
              skipCommit.current = true
              ui.clearSelection()
            }
          }}
        />
      </label>
      <button
        type="button"
        className="q-btn q-btn--sm q-btn--quiet q-btn--danger qb-popover__delete"
        onClick={() => {
          ui.clearSelection()
          actions.removeWithUndo([{ id: conn.id, kind: 'Connection' }])
        }}
      >
        Delete Connection
      </button>
    </div>
  )
}
