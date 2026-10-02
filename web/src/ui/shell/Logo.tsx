export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
      <circle cx="9" cy="9" r="7.2" stroke="var(--q-ink)" strokeWidth="1.4" />
      <circle cx="11.6" cy="6.4" r="1.9" fill="var(--q-accent)" />
      <path d="M12.6 12.6 L16 16" stroke="var(--q-ink)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
