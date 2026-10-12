const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true, focusable: false } as const

export function LockIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" {...base}>
      <rect x="1.5" y="5.5" width="9" height="6.5" rx="1" />
      <path d="M3.5 5.5 V3.8 A2.5 2.5 0 0 1 8.5 3.8 V5.5" />
    </svg>
  )
}

export function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" {...base}>
      <path d="M4.5 1.5 H7.5 L7 5 L9 7 H3 L5 5 Z M6 7 V11" />
    </svg>
  )
}

export function ScreenIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" {...base} strokeWidth={1.3}>
      <rect x="3" y="5" width="22" height="16" rx="2" />
      <path d="M9 25 H19 M10 12 H18 M10 15.5 H15" />
    </svg>
  )
}

export function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" {...base} strokeLinecap="round">
      <path d="M2 3.5 H11 M2 6.5 H11 M2 9.5 H8" />
    </svg>
  )
}

export function CrossIcon({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 9 9" {...base} strokeLinecap="round">
      <path d="M1.5 1.5 L7.5 7.5 M7.5 1.5 L1.5 7.5" />
    </svg>
  )
}

export function CollapseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" {...base} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 6.5 H8.5 M6 3.5 L9 6.5 L6 9.5 M11.5 2 V11" />
    </svg>
  )
}
