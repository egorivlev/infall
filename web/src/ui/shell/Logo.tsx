/** The lower half of the disc's ellipse: the part that passes in front of the hole. */
const DISC = 'M1.2 12 A10.8 2.6 0 0 0 22.8 12'

/**
 * The Infall mark: a black hole inside its bright ring, with the near side of the accretion disc crossing in front.
 * Its colours are its own and do not follow the theme. The gap around the disc is drawn in the colour of what the
 * mark sits on: `--q-logo-cut`, set by the surface (the title bar sets it), `--q-surface` otherwise.
 */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <g transform="rotate(-12 12 12)">
        <circle cx="12" cy="12" r="6.6" fill="#000" stroke="#ffd98f" strokeWidth="2.2" />
        <path d={DISC} stroke="var(--q-logo-cut, var(--q-surface))" strokeWidth="3.8" strokeLinecap="round" />
        <path d={DISC} stroke="#f2a03d" strokeWidth="1.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}
