/** The Sheaf mark: three stalks bound by an accent band. */
export function Logo({ size = 18 }: { size?: number }) {
  const stroke = size >= 24 ? 1.4 : 1.6
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
      <path d="M4.5 2 C7.2 6.5 7.2 11.5 4.5 16" stroke="var(--q-ink)" strokeWidth={stroke} strokeLinecap="round" />
      <path d="M9 2 V16" stroke="var(--q-ink)" strokeWidth={stroke} strokeLinecap="round" />
      <path d="M13.5 2 C10.8 6.5 10.8 11.5 13.5 16" stroke="var(--q-ink)" strokeWidth={stroke} strokeLinecap="round" />
      <rect x="4.6" y="7.4" width="8.8" height="3.2" rx="1" fill="var(--q-accent)" />
    </svg>
  )
}
