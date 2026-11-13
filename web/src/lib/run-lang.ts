// What a Run names (desktop.md, "Environments and Toolchains — as built"; api.md §15 "Languages"): the language its
// code is written in (`lang`, unset = Python) and, for Python and Q#, the environment it asks for (`env`). Only names:
// which program they start is decided by the Runner of the device that executes it. Pure.
import type { BlockVM } from './types'

export const PYTHON = 'python'
export const QSHARP = 'qsharp'

/** A language id: 1–24 characters, a lowercase letter first. Compared exactly. */
export const LANG_ID = /^[a-z][a-z0-9_-]{0,23}$/
/** At most this many characters in the name of an environment. */
export const MAX_ENV_NAME = 60

/** The languages a Run's editor offers by name, in that order; any other id is typed by hand ("Other…"). */
export const KNOWN_LANGUAGES: readonly { id: string; name: string }[] = [
  { id: PYTHON, name: 'Python' },
  { id: QSHARP, name: 'Q#' },
  { id: 'julia', name: 'Julia' },
  { id: 'r', name: 'R' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'shell', name: 'Shell' },
]

export function isLangId(v: unknown): v is string {
  return typeof v === 'string' && LANG_ID.test(v)
}

// The characters the Runner refuses in an environment name, as it does (`envs::valid_name`, `inspect::is_hidden`):
// control characters, direction controls, and characters that draw as nothing or as a space.
function hidden(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x061c ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0x00a0 ||
    c === 0x00ad ||
    c === 0x034f ||
    (c >= 0x0600 && c <= 0x0605) ||
    c === 0x06dd ||
    c === 0x070f ||
    c === 0x0890 ||
    c === 0x0891 ||
    c === 0x08e2 ||
    c === 0x115f ||
    c === 0x1160 ||
    c === 0x1680 ||
    c === 0x17b4 ||
    c === 0x17b5 ||
    (c >= 0x180b && c <= 0x180f) ||
    (c >= 0x2000 && c <= 0x200d) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    (c >= 0x205f && c <= 0x2065) ||
    (c >= 0x206a && c <= 0x206f) ||
    c === 0x2800 ||
    c === 0x3000 ||
    c === 0x3164 ||
    (c >= 0xe000 && c <= 0xf8ff) ||
    (c >= 0xfe00 && c <= 0xfe0f) ||
    c === 0xfeff ||
    c === 0xffa0 ||
    (c >= 0xfff9 && c <= 0xfffb) ||
    c === 0x110bd ||
    c === 0x110cd ||
    (c >= 0x13430 && c <= 0x1343f) ||
    (c >= 0x1bca0 && c <= 0x1bca3) ||
    (c >= 0x1d173 && c <= 0x1d17a) ||
    (c >= 0xe0000 && c <= 0xe0fff) ||
    c >= 0xf0000
  )
}

/** An environment name a Run may ask for: one line of 1–60 characters, no space at either end, nothing hidden. */
export function isEnvName(v: unknown): v is string {
  if (typeof v !== 'string' || v === '' || v.trim() !== v) return false
  let n = 0
  for (const ch of v) {
    if (++n > MAX_ENV_NAME || hidden(ch.codePointAt(0)!)) return false
  }
  return true
}

/** Whether a Run in this language may ask for an environment: Python, and Q# (which a Python hosts). */
export function takesEnv(lang: string): boolean {
  return lang === PYTHON || lang === QSHARP
}

/**
 * What a language is called: the known ones by their names, then what this device's Runner calls it, else the id
 * itself.
 */
export function languageName(id: string, device?: Record<string, { name: string }>): string {
  const known = KNOWN_LANGUAGES.find((l) => l.id === id)
  if (known) return known.name
  const named = device?.[id]?.name
  return typeof named === 'string' && named.trim() !== '' ? named.trim() : id
}

/** The language of a Run as it is stored: `python` when unset. Not checked (see `isLangId`). */
export function runLang(block: Pick<BlockVM, 'run'>): string {
  const lang = block.run?.lang
  return lang === undefined || lang === '' ? PYTHON : lang
}

/** The environment a Run asks for, or undefined: none, or its language takes none. Not checked (see `isEnvName`). */
export function runEnv(block: Pick<BlockVM, 'run'>): string | undefined {
  const env = block.run?.env
  return env === undefined || env === '' || !takesEnv(runLang(block)) ? undefined : env
}
