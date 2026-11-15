// Small pure helpers for Run blocks: how durations, the environment and figures are written out.
import { isLangId, languageName, PYTHON, QSHARP } from '../../../lib'
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

/** How many packages the result line names before "+N". */
export const SHOWN_PACKAGES = 2

/** What executed a result, for the line under its output (M19, M19b). Plain text only. */
export type RuntimeLine = {
  /** "Python 3.12.3", "Python 3.13.1 (analysis)", "Q#", "Julia 1.11.2", "Shell". */
  lead: string
  /** Every package as "name version", in the order recorded. */
  packages: string[]
  /** Everything known, for the tooltip: the runtime as recorded, the packages, the machine. */
  full: string
}

// "julia version 1.11.2" → "1.11.2"; "v22.3.0" → "22.3.0"; "GNU bash, version 5.2.26(1)-release" → "5.2.26".
function versionIn(text: string): string | null {
  const m = /(\d+(?:\.\d+)+)/.exec(text)
  return m ? m[1]! : null
}

/**
 * The line that names what executed a result: Python and its version and the environment the Run asked for, then
 * its packages ("Python 3.12.3 · numpy 2.1.0, scipy 1.14.1 +5"); Q# by its package ("Q# · qdk 1.34.0"); another
 * language by its name and the version its Toolchain gave ("Julia 1.11.2"). `name` is what the language is called.
 */
export function runtimeLine(result: Pick<RunResult, 'lang' | 'env'>, name: string): RuntimeLine {
  const env = typeof result.env === 'object' && result.env !== null ? result.env : {}
  const lang = typeof result.lang === 'string' && result.lang !== '' ? result.lang : 'python'
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' ? clip(oneLine(v), max) : '')
  const asked = text(env.name, 60)
  const packages =
    typeof env.packages === 'object' && env.packages !== null
      ? Object.entries(env.packages)
          .filter(([pkg, version]) => pkg.trim() !== '' && typeof version === 'string')
          .map(([pkg, version]) => oneLine(`${clip(oneLine(pkg), 60)} ${clip(oneLine(version), 40)}`))
      : []
  let lead: string
  const full: string[] = []
  if (lang === 'python') {
    const python = text(env.python, 40)
    lead = python ? `${name} ${python}` : name
    full.push(lead)
  } else if (lang === 'qsharp') {
    lead = name
    full.push(name)
    const python = text(env.python, 40)
    if (python) full.push(`through Python ${python}`)
  } else {
    const runtime = text(env.runtime, 40)
    const version = runtime ? versionIn(runtime) : null
    lead = version ? `${name} ${version}` : name
    full.push(runtime ? `${name}: ${runtime}` : name)
  }
  if (asked) {
    lead = `${lead} (${asked})`
    full.push(`environment “${asked}”`)
  }
  full.push(...packages)
  const machine = [env.os, env.arch].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => clip(oneLine(x), 40))
  if (machine.length) full.push(machine.join(' '))
  return { lead, packages, full: full.join(' · ') }
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

/** The hint under the code: what the language is, and where it runs. */
export function editorHint(lang: string): string {
  if (lang === PYTHON) return 'Python. Runs on the computer of whoever presses Run, in the desktop app, after they have seen the code. Figures drawn with matplotlib are captured.'
  if (lang === QSHARP) return 'Q#. Runs through the qdk package of a Python on the computer of whoever presses Run, in the desktop app, after they have seen the code.'
  if (!isLangId(lang)) return 'Runs on the computer of whoever presses Run, in the desktop app, in a language set up in its Runner settings, after they have seen the code.'
  const name = languageName(lang)
  return `${name}. Runs on the computer of whoever presses Run, in the desktop app, with ${name} as set up in its Runner settings, after they have seen the code.`
}
