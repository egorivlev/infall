// The `result` of a Run (api.md §15): reading the stored JSON strictly, writing it, building it from what the
// Runner reports, and saying it in one line where a raw value would otherwise be shown.
import type { RunEvent, RunResult, Value } from './types'

export const MAX_RESULT = 600_000 // characters of the JSON text
export const MAX_OUTPUT = 64_000
export const MAX_FIGURES = 3
export const MAX_FIGURE = 160_000 // base64 characters
const MAX_PACKAGES = 8
const MAX_PACKAGE_NAME = 60
const MAX_PACKAGE_VERSION = 40
const MAX_ENV_TEXT = 200
const MAX_MEMBER_ID = 200

const KEYS = ['v', 'by', 'at', 'code_sha256', 'exit', 'stopped', 'duration_ms', 'output', 'output_truncated', 'figures', 'env']
const ENV_KEYS = ['python', 'packages', 'os', 'arch']
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/ // with the length check below: standard base64, padded
const PNG_START = 'iVBORw0KGgo' // the PNG signature, in base64

export const NO_OUTPUT_RECORDED = 'No output recorded'
export const CANNOT_BE_SHOWN = 'This result cannot be shown'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function onlyKeys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(v).every((k) => allowed.includes(k))
}

// The limits are in characters; `length` counts an astral character twice, so a text over the limit by `length`
// is counted properly before it is refused.
function within(text: string, max: number): boolean {
  if (text.length <= max) return true
  if (text.length > max * 2) return false
  let n = 0
  for (const _ of text) if (++n > max) return false
  return true
}

const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const flag = (v: unknown): boolean => v === undefined || typeof v === 'boolean'
const shortText = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && within(v, max))

function goodFigure(v: unknown): boolean {
  if (!isRecord(v) || !onlyKeys(v, ['png'])) return false
  const png = v.png
  return typeof png === 'string' && png.length <= MAX_FIGURE && png.length % 4 === 0 && png.startsWith(PNG_START) && BASE64.test(png)
}

function goodEnv(v: unknown): boolean {
  if (v === undefined) return true
  if (!isRecord(v) || !onlyKeys(v, ENV_KEYS)) return false
  if (!shortText(v.python, MAX_ENV_TEXT) || !shortText(v.os, MAX_ENV_TEXT) || !shortText(v.arch, MAX_ENV_TEXT)) return false
  const packages = v.packages
  if (packages === undefined) return true
  if (!isRecord(packages)) return false
  const entries = Object.entries(packages)
  return (
    entries.length <= MAX_PACKAGES &&
    entries.every(([name, version]) => name !== '' && within(name, MAX_PACKAGE_NAME) && typeof version === 'string' && within(version, MAX_PACKAGE_VERSION))
  )
}

/** `v` itself when it is exactly a §15 result — no other keys, right types, within the limits — else null. */
export function checkRunResult(v: unknown): RunResult | null {
  if (!isRecord(v) || !onlyKeys(v, KEYS)) return null
  const good =
    v.v === 1 &&
    typeof v.by === 'string' &&
    v.by !== '' &&
    v.by.length <= MAX_MEMBER_ID &&
    amount(v.at) &&
    typeof v.code_sha256 === 'string' &&
    SHA256.test(v.code_sha256) &&
    (v.exit === null || (typeof v.exit === 'number' && Number.isInteger(v.exit))) &&
    flag(v.stopped) &&
    amount(v.duration_ms) &&
    typeof v.output === 'string' &&
    within(v.output, MAX_OUTPUT) &&
    flag(v.output_truncated) &&
    Array.isArray(v.figures) &&
    v.figures.length <= MAX_FIGURES &&
    v.figures.every(goodFigure) &&
    goodEnv(v.env)
  return good ? (v as unknown as RunResult) : null
}

// ---- reading ----

/** What a Run Block holds: its result, or `broken` when something is stored that cannot be read. */
export type StoredRun = { result: RunResult | null; broken: boolean }

const NONE: StoredRun = { result: null, broken: false }
const BROKEN: StoredRun = { result: null, broken: true }

// A result can be hundreds of kilobytes: it is parsed once. By the value object while the Board keeps it (an
// unrelated Change leaves the object in place), and by its text for the few moments the same text arrives in a new
// object (an optimistic op confirmed by the server, a Guest's refetched Board).
const byValue = new WeakMap<object, StoredRun>()
const MAX_BY_TEXT = 24
const byText = new Map<string, StoredRun>()

let parses = 0
/** For tests: how many times a stored result was actually parsed. */
export function resultParses(): number {
  return parses
}

function parse(raw: string): StoredRun {
  parses++
  if (!within(raw, MAX_RESULT)) return BROKEN
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return BROKEN
  }
  const result = checkRunResult(json)
  return result ? { result, broken: false } : BROKEN
}

/** Reads the `result` field of a Block. Unset or Null: no result. Anything that is not a §15 result: broken. */
export function readRunResult(value: Value | undefined): StoredRun {
  if (value === undefined || value === 'Null') return NONE
  if (!('Text' in value)) return BROKEN
  const seen = byValue.get(value)
  if (seen) return seen
  const raw = value.Text
  let stored = byText.get(raw)
  if (stored) byText.delete(raw)
  else stored = parse(raw)
  byText.set(raw, stored)
  if (byText.size > MAX_BY_TEXT) byText.delete(byText.keys().next().value!)
  byValue.set(value, stored)
  return stored
}

// ---- writing ----

// The same object with its keys in the order of the spec, and nothing else.
function ordered(r: RunResult): RunResult {
  const out: RunResult = { v: 1, by: r.by, at: r.at, code_sha256: r.code_sha256, exit: r.exit, duration_ms: r.duration_ms, output: r.output, figures: r.figures.map((f) => ({ png: f.png })) }
  if (r.stopped !== undefined) out.stopped = r.stopped
  if (r.output_truncated !== undefined) out.output_truncated = r.output_truncated
  if (r.env !== undefined) {
    const env: NonNullable<RunResult['env']> = {}
    if (r.env.python !== undefined) env.python = r.env.python
    if (r.env.packages !== undefined) env.packages = { ...r.env.packages }
    if (r.env.os !== undefined) env.os = r.env.os
    if (r.env.arch !== undefined) env.arch = r.env.arch
    out.env = env
  }
  return out
}

/** The JSON text to store for a result. Throws `RangeError` when it is not a §15 result or is too long to store. */
export function encodeRunResult(result: RunResult): string {
  if (!checkRunResult(result)) throw new RangeError('That is not the result of a Run.')
  const raw = JSON.stringify(ordered(result))
  if (!within(raw, MAX_RESULT)) throw new RangeError('The output is too large to be recorded.')
  return raw
}

// ---- making it fit ----

// A cut never lands inside a character: a position between the two halves of a pair moves one back.
function boundary(text: string, at: number): number {
  const c = text.charCodeAt(at)
  return at > 0 && at < text.length && c >= 0xdc00 && c <= 0xdfff ? at - 1 : at
}

/**
 * A result whose JSON text is within the 600 000 characters the server takes. The limit counts the text as
 * written, escapes included, so an output full of control characters can pass it while under its own limit. Then
 * the output is shortened further — its beginning and its end are kept, one line says how much was left out, and
 * `output_truncated` is set — and only if nothing of the output can stay, figures are dropped from the end.
 * A result that fits comes back as it is.
 */
export function fitRunResult(result: RunResult): RunResult {
  const size = (r: RunResult) => JSON.stringify(ordered(r)).length
  let total = size(result)
  if (total <= MAX_RESULT) return result
  const full = result.output
  const rest = total - JSON.stringify(full).length // everything but the output
  let fitted = result
  let keep = full.length
  while (total > MAX_RESULT && keep > 0) {
    // What the output may take, shared out by how much its characters take on average; then a little less.
    const room = MAX_RESULT - rest - 200
    const written = JSON.stringify(fitted.output).length
    keep = room <= 0 ? 0 : Math.min(keep - 1, Math.floor((keep * room * 0.95) / written))
    if (keep <= 0) {
      keep = 0
      fitted = { ...result, output: '', output_truncated: true }
    } else {
      const head = boundary(full, Math.ceil(keep / 2))
      const tailAt = boundary(full, full.length - Math.floor(keep / 2))
      const left = tailAt - head
      const output = `${full.slice(0, head)}\n[… ${left} characters of output left out so that the result fits …]\n${full.slice(tailAt)}`
      fitted = { ...result, output, output_truncated: true }
    }
    total = size(fitted)
  }
  while (total > MAX_RESULT && fitted.figures.length > 0) {
    fitted = { ...fitted, figures: fitted.figures.slice(0, -1) }
    total = size(fitted)
  }
  return fitted
}

// ---- from the Runner ----

const REASONS = ['declined', 'no_python', 'busy', 'failed'] as const
export const UNREADABLE_RESULT = 'The Runner sent a result that cannot be read.'

function textOrNothing(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * What the bridge handed over, checked. Null for something that is not an event (it is skipped). A `done` whose
 * parts have the wrong types still ends the execution: it reads as a failure.
 */
export function toRunEvent(raw: unknown): RunEvent | null {
  if (!isRecord(raw)) return null
  if (raw.type === 'approval' || raw.type === 'started') return { type: raw.type }
  if (raw.type === 'output') return typeof raw.text === 'string' ? { type: 'output', text: raw.text } : null
  if (raw.type === 'error') {
    const reason = REASONS.find((r) => r === raw.reason) ?? 'failed'
    return { type: 'error', reason, message: typeof raw.message === 'string' ? raw.message : '' }
  }
  if (raw.type !== 'done') return null
  const unreadable: RunEvent = { type: 'error', reason: 'failed', message: UNREADABLE_RESULT }
  const { exit, duration_ms, code_sha256, output, figures } = raw
  if (!(exit === null || typeof exit === 'number') || typeof duration_ms !== 'number' || typeof code_sha256 !== 'string' || typeof output !== 'string') {
    return unreadable
  }
  if (!Array.isArray(figures) || !figures.every((f) => isRecord(f) && typeof f.png === 'string')) return unreadable
  const env: Extract<RunEvent, { type: 'done' }>['env'] = {}
  if (isRecord(raw.env)) {
    const python = textOrNothing(raw.env.python)
    const os = textOrNothing(raw.env.os)
    const arch = textOrNothing(raw.env.arch)
    if (python !== undefined) env.python = python
    if (isRecord(raw.env.packages)) {
      const packages: Record<string, string> = {}
      for (const [name, version] of Object.entries(raw.env.packages)) if (typeof version === 'string') packages[name] = version
      env.packages = packages
    }
    if (os !== undefined) env.os = os
    if (arch !== undefined) env.arch = arch
  }
  return {
    type: 'done',
    exit,
    stopped: raw.stopped === true,
    duration_ms,
    code_sha256,
    output,
    output_truncated: raw.output_truncated === true,
    figures: (figures as { png: string }[]).map((f) => ({ png: f.png })),
    env,
  }
}

/**
 * The result to record for an execution that ended: who and when are the page's, the rest is what the app
 * reported (the code hash too: it is of the code the app executed), made to fit the server's limit
 * (`fitRunResult`). Null when that is not a §15 result.
 */
export function toRunResult(done: Extract<RunEvent, { type: 'done' }>, by: string, at: number): RunResult | null {
  const result: RunResult = {
    v: 1,
    by,
    at,
    code_sha256: done.code_sha256,
    exit: done.exit,
    duration_ms: done.duration_ms,
    output: done.output,
    figures: done.figures.map((f) => ({ png: f.png })),
  }
  if (done.stopped) result.stopped = true
  if (done.output_truncated) result.output_truncated = true
  if (Object.keys(done.env).length > 0) result.env = done.env
  return checkRunResult(result) ? ordered(fitRunResult(result)) : null
}

// ---- in one line ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 1204 → "1 204"
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+$)/g, ' ')
}

// "12 Nov, 14:02" in this device's time; the year is said when it is not this one.
function when(at: number, now: number): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return 'at an unknown time'
  const two = (n: number) => String(n).padStart(2, '0')
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** A result as one readable line: "Ana Ruiz · 12 Nov, 14:02 · exit 0 · 2 figures · 1 204 characters of output". */
export function runResultLine(result: RunResult, nameOf: (member: string) => string | undefined = () => undefined, now = Date.now()): string {
  const how = result.stopped ? 'stopped' : result.exit === null ? 'no exit code' : `exit ${result.exit}`
  const figures = result.figures.length
  const length = result.output.length
  return [
    nameOf(result.by) ?? 'Someone',
    when(result.at, now),
    how,
    figures === 0 ? '' : figures === 1 ? '1 figure' : `${figures} figures`,
    length === 0 ? 'no output' : length === 1 ? '1 character of output' : `${grouped(length)} characters of output`,
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

/** The stored value of a `result` field as one line: never the raw JSON. */
export function resultValueLine(value: Value | undefined, nameOf?: (member: string) => string | undefined, now?: number): string {
  const stored = readRunResult(value)
  if (stored.result) return runResultLine(stored.result, nameOf, now)
  return stored.broken ? CANNOT_BE_SHOWN : NO_OUTPUT_RECORDED
}
