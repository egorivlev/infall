import type { ReactNode } from 'react'
import { Logo } from './Logo'

/** The centred 380px card on --q-sunken used by every access screen. */
export function AccessCard({ title, subtitle, children }: { title?: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="q-access">
      <div className="q-access__card">
        <div className="q-access__brand">
          <Logo size={26} />
          <span>Sheaf</span>
        </div>
        {title && (
          <div className="q-access__head">
            <h1 className="q-access__title">{title}</h1>
            {subtitle && <p className="q-access__sub">{subtitle}</p>}
          </div>
        )}
        {children}
      </div>
    </main>
  )
}
