import type { BoardStatus } from '../../lib'

const STATES: Record<BoardStatus, { word: string; tone: 'ok' | 'warn' | 'off' }> = {
  live: { word: 'Synced', tone: 'ok' },
  reconnecting: { word: 'Reconnecting…', tone: 'warn' },
  error: { word: 'Offline', tone: 'off' },
  loading: { word: 'Connecting…', tone: 'warn' },
  idle: { word: 'Connecting…', tone: 'warn' },
}

/**
 * Dot shape differs per state (filled, half, ring) as well as colour; the word always accompanies it.
 * A Guest sends nothing, so there is nothing to be "Synced": the live state reads "Read-only".
 */
export function SyncStatus({ status, readOnly = false }: { status: BoardStatus; readOnly?: boolean }) {
  const s = readOnly && status === 'live' ? { word: 'Read-only', tone: 'ok' as const } : STATES[status]
  return (
    <div className="q-sync" role="status">
      <span className={`q-sync__dot q-sync__dot--${s.tone}`} aria-hidden="true" />
      <span>{s.word}</span>
    </div>
  )
}
