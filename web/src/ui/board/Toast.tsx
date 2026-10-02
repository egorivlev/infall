import { useToasts, toasts } from './toastStore'

export function Toast() {
  const items = useToasts((s) => s.items)
  return (
    <div className="qb-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="qb-toast" data-testid="toast" title={t.title}>
          <span className="qb-toast__msg">{t.message}</span>
          {t.action && (
            <button type="button" className="q-btn q-btn--sm qb-toast__action" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="qb-toast__close"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => toasts.dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
