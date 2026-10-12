// Small pure helpers for Run blocks: how durations, the environment and figures are written out.
import type { RunResult } from '../../../lib'

const pad = (n: number) => String(n).padStart(2, '0')

/** How long an execution took: "3.0 s", "42 s", "6 min 41 s", "2 h 05 min". '' when it is not a duration. */
export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 9950) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`
  const m = Math.floor(s / 60)
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`
}

/** The running clock: "0:42", "12:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export const MAX_PACKAGES = 3

/**
 * The environment of a result for the header strip: "py 3.12 · pennylane 0.38" — Python as
 * major.minor and at most three packages. `full` lists everything, for the tooltip. Both are plain
 * text; whatever a program put in there is clipped and shown as written.
 */
export function envLine(env: RunResult['env'] | undefined): { text: string; full: string } {
  if (typeof env !== 'object' || env === null) return { text: '', full: '' }
  const short: string[] = []
  const full: string[] = []
  if (typeof env.python === 'string') {
    const m = /^\s*(\d{1,4})\.(\d{1,4})/.exec(env.python)
    if (m) {
      short.push(`py ${m[1]}.${m[2]}`)
      full.push(`Python ${clip(oneLine(env.python), 40)}`)
    }
  }
  const packages =
    typeof env.packages === 'object' && env.packages !== null
      ? Object.entries(env.packages).filter(([name, version]) => name.trim() !== '' && typeof version === 'string')
      : []
  packages.forEach(([name, version], i) => {
    const item = oneLine(`${clip(oneLine(name), 32)} ${clip(oneLine(version), 16)}`)
    if (i < MAX_PACKAGES) short.push(item)
    if (i < 40) full.push(item)
  })
  if (packages.length > 40) full.push(`and ${packages.length - 40} more`)
  const machine = [env.os, env.arch].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => clip(oneLine(x), 40))
  if (machine.length) full.push(machine.join(' '))
  return { text: short.join(' · '), full: full.join(' · ') }
}

const BASE64 = /^[A-Za-z0-9+/]+=*$/

/**
 * The `src` of a captured figure, or null when the data is not plain base64. The data comes from
 * a program on someone else's computer: it only ever becomes the payload of a PNG data URL.
 */
export function figureSrc(png: unknown): string | null {
  if (typeof png !== 'string' || png === '' || !BASE64.test(png)) return null
  return `data:image/png;base64,${png}`
}

/** The lines of a Run's code as shown: line ends normalised, one closing line break not counted. */
export function codeLines(code: string): string[] {
  const text = code.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  return text === '' ? [] : text.split('\n')
}
