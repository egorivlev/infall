import type { ReactNode } from 'react'

export type IconName =
  | 'board'
  | 'members'
  | 'plus'
  | 'search'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'branch'
  | 'user'
  | 'chevron'
  | 'frame'

const PATHS: Record<IconName, ReactNode> = {
  board: (
    <>
      <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" />
      <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" />
      <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" />
      <rect x="8" y="8" width="4.5" height="4.5" rx="1" />
    </>
  ),
  members: (
    <>
      <circle cx="5" cy="4.5" r="2.2" />
      <path d="M1.2 12 C1.8 8.8 8.2 8.8 8.8 12" />
      <path d="M9.5 3 A2 2 0 0 1 9.5 7 M10.5 9 C12 9.4 12.6 10.6 12.8 12" />
    </>
  ),
  plus: <path d="M7 2.5 V11.5 M2.5 7 H11.5" />,
  search: (
    <>
      <circle cx="5.6" cy="5.6" r="4" />
      <path d="M8.6 8.6 L12 12" />
    </>
  ),
  sun: (
    <>
      <circle cx="7" cy="7" r="2.6" />
      <path d="M7 1 V2.4 M7 11.6 V13 M1 7 H2.4 M11.6 7 H13 M2.8 2.8 L3.8 3.8 M10.2 10.2 L11.2 11.2 M11.2 2.8 L10.2 3.8 M3.8 10.2 L2.8 11.2" />
    </>
  ),
  moon: <path d="M11.5 8.6 A5 5 0 1 1 5.4 2.5 A4 4 0 0 0 11.5 8.6 Z" />,
  monitor: (
    <>
      <rect x="1.5" y="2" width="11" height="7.5" rx="1.2" />
      <path d="M5 12 H9 M7 9.5 V12" />
    </>
  ),
  branch: (
    <>
      <circle cx="3.5" cy="3" r="1.6" />
      <circle cx="3.5" cy="11" r="1.6" />
      <circle cx="10.5" cy="5" r="1.6" />
      <path d="M3.5 4.6 V9.4 M10.5 6.6 C10.5 9 3.5 8 3.5 9.4" />
    </>
  ),
  user: (
    <>
      <circle cx="7" cy="4.6" r="2.4" />
      <path d="M2.2 12.6 C2.9 8.8 11.1 8.8 11.8 12.6" />
    </>
  ),
  chevron: <path d="M3 5 L7 9 L11 5" />,
  frame: <rect x="1.5" y="3" width="11" height="8" rx="1.5" />,
}

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
