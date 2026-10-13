import { describe, expect, it } from 'vitest'
import { sha256Hex } from './code-hash'
import {
  CANNOT_BE_SHOWN,
  checkRunResult,
  encodeRunResult,
  fitRunResult,
  MAX_RESULT,
  NO_OUTPUT_RECORDED,
  readRunResult,
  resultParses,
  resultValueLine,
  runResultLine,
  MAX_STEP,
  toRunEvent,
  toRunResult,
  UNREADABLE_RESULT,
} from './run-result'
import { fakeRunResult, TINY_PNG } from './testing'
import type { RunEvent, RunResult, Value } from './types'

// Half of a character pair standing alone: what a careless cut leaves behind.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const GOOD: RunResult = {
  v: 1,
  by: 'ana',
  at: 1_790_000_000_000,
  code_sha256: sha256Hex('print(1)'),
  exit: 0,
  stopped: false,
  duration_ms: 401_000,
  output: '1\n',
  output_truncated: false,
  figures: [{ png: TINY_PNG }],
  env: { python: '3.12.3', packages: { pennylane: '0.38.0' }, os: 'macos', arch: 'arm64' },
}
const T = (v: unknown): Value => ({ Text: typeof v === 'string' ? v : JSON.stringify(v) })
const done = (patch: Partial<Extract<RunEvent, { type: 'done' }>> = {}): Extract<RunEvent, { type: 'done' }> => ({
  type: 'done',
  exit: 0,
  stopped: false,
  duration_ms: 10,
  code_sha256: sha256Hex('x'),
  output: 'out',
  output_truncated: false,
  figures: [],
  env: {},
  ...patch,
})

describe('checkRunResult', () => {
  it('takes exactly the shape of the spec, with and without the optional parts', () => {
    expect(checkRunResult(GOOD)).toBe(GOOD)
    const { stopped: _s, output_truncated: _t, env: _e, ...bare } = GOOD
    expect(checkRunResult({ ...bare, figures: [], exit: null, stopped: true })).not.toBeNull()
    expect(checkRunResult({ ...bare, env: {} })).not.toBeNull()
    expect(checkRunResult({ ...bare, exit: -9 })).not.toBeNull()
  })
  it.each([
    ['not an object', 'text'],
    ['an array', [GOOD]],
    ['another version', { ...GOOD, v: 2 }],
    ['an unknown key', { ...GOOD, extra: 1 }],
    ['no author', { ...GOOD, by: '' }],
    ['a time that is not a number', { ...GOOD, at: '1790000000000' }],
    ['a negative time', { ...GOOD, at: -1 }],
    ['a hash in capitals', { ...GOOD, code_sha256: GOOD.code_sha256.toUpperCase() }],
    ['a short hash', { ...GOOD, code_sha256: 'abc' }],
    ['an exit code that is not whole', { ...GOOD, exit: 1.5 }],
    ['an exit code as text', { ...GOOD, exit: '0' }],
    ['a missing exit code', { ...GOOD, exit: undefined }],
    ['stopped that is not a flag', { ...GOOD, stopped: 'yes' }],
    ['a negative duration', { ...GOOD, duration_ms: -5 }],
    ['an endless duration', { ...GOOD, duration_ms: Infinity }],
    ['an output that is not text', { ...GOOD, output: 5 }],
    ['an output over 64 000 characters', { ...GOOD, output: 'x'.repeat(64_001) }],
    ['no figures list', { ...GOOD, figures: undefined }],
    ['four figures', { ...GOOD, figures: [1, 2, 3, 4].map(() => ({ png: TINY_PNG })) }],
    ['a figure that is not a PNG', { ...GOOD, figures: [{ png: 'aGVsbG8gd29ybGQ=' }] }],
    ['a figure that is not base64', { ...GOOD, figures: [{ png: `${TINY_PNG.slice(0, 20)}"><script>` }] }],
    ['a figure without padding', { ...GOOD, figures: [{ png: TINY_PNG.replace(/=+$/, '') }] }],
    ['a figure with other keys', { ...GOOD, figures: [{ png: TINY_PNG, alt: 'x' }] }],
    ['a figure that is too large', { ...GOOD, figures: [{ png: TINY_PNG.slice(0, 12) + 'A'.repeat(160_000) }] }],
    ['an env that is not an object', { ...GOOD, env: 'macos' }],
    ['an env with unknown parts', { ...GOOD, env: { gpu: 'yes' } }],
    ['nine packages', { ...GOOD, env: { packages: Object.fromEntries([...'abcdefghi'].map((k) => [k, '1'])) } }],
    ['a package version that is not text', { ...GOOD, env: { packages: { numpy: 2 } } }],
    ['a package name that is too long', { ...GOOD, env: { packages: { ['n'.repeat(61)]: '1' } } }],
  ])('refuses %s', (_what, value) => {
    expect(checkRunResult(value)).toBeNull()
  })
  it('counts characters, not UTF-16 units, at the limit', () => {
    expect(checkRunResult({ ...GOOD, output: '😀'.repeat(64_000) })).not.toBeNull()
    expect(checkRunResult({ ...GOOD, output: '😀'.repeat(64_001) })).toBeNull()
  })
})

describe('readRunResult', () => {
  it('reads nothing as no result, not as a broken one', () => {
    expect(readRunResult(undefined)).toEqual({ result: null, broken: false })
    expect(readRunResult('Null')).toEqual({ result: null, broken: false })
  })
  it('reads a stored result', () => {
    expect(readRunResult(T(GOOD))).toEqual({ result: GOOD, broken: false })
  })
  it.each([
    ['text that is not JSON', T('{"v":1,')],
    ['an empty text', T('')],
    ['JSON of another shape', T({ v: 1, output: 'hi' })],
    ['JSON that is not an object', T('null')],
    ['a number', { Float: 3 } as Value],
    ['a reference', { Ref: 'a' } as Value],
    ['a text over 600 000 characters', T(`${JSON.stringify(GOOD)}${' '.repeat(MAX_RESULT)}`)],
  ])('reads %s as broken, without throwing', (_what, value) => {
    expect(readRunResult(value)).toEqual({ result: null, broken: true })
  })
  it('parses a value once: the same object, and the same text in a new object, come from memory', () => {
    const raw = JSON.stringify({ ...GOOD, output: 'memo '.repeat(1000) })
    const value = T(raw)
    const before = resultParses()
    const first = readRunResult(value)
    expect(resultParses()).toBe(before + 1)
    expect(readRunResult(value)).toBe(first)
    expect(readRunResult({ Text: raw })).toBe(first)
    expect(readRunResult({ Text: raw.slice(0, 10) + raw.slice(10) })).toBe(first)
    expect(resultParses()).toBe(before + 1)
  })
})

describe('encodeRunResult', () => {
  it('writes the keys in the order of the spec and only those that are set', () => {
    const shuffled = { figures: [], output: 'o', exit: 0, duration_ms: 3, code_sha256: GOOD.code_sha256, at: 5, by: 'me', v: 1 } as RunResult
    expect(encodeRunResult(shuffled)).toBe(`{"v":1,"by":"me","at":5,"code_sha256":"${GOOD.code_sha256}","exit":0,"duration_ms":3,"output":"o","figures":[]}`)
    expect(JSON.parse(encodeRunResult(GOOD))).toEqual(GOOD)
  })
  it('refuses what is not a result, and one whose text is too long', () => {
    expect(() => encodeRunResult({ ...GOOD, exit: 0.5 })).toThrow(RangeError)
    const big = { png: TINY_PNG.slice(0, 12) + 'A'.repeat(159_988) }
    expect(() => encodeRunResult({ ...GOOD, output: '\u0001'.repeat(64_000), figures: [big, big] })).toThrow(RangeError)
  })
})

describe('fitRunResult', () => {
  const big = { png: TINY_PNG.slice(0, 12) + 'A'.repeat(159_988) }
  it('leaves a result that fits alone', () => {
    expect(fitRunResult(GOOD)).toBe(GOOD)
  })
  it('shortens an output whose escapes push the text over the limit: head and tail stay, the flag is set', () => {
    // 64 000 control characters are 384 000 characters once written as JSON; with three figures that is too much.
    const output = `START${'\u001b'.repeat(63_990)}FINIS`
    const fitted = fitRunResult({ ...GOOD, output, output_truncated: false, figures: [big, big, big] })
    expect(encodeRunResult(fitted).length).toBeLessThanOrEqual(MAX_RESULT)
    expect(fitted.figures).toHaveLength(3)
    expect(fitted.output_truncated).toBe(true)
    expect(fitted.output.startsWith('START')).toBe(true)
    expect(fitted.output.endsWith('FINIS')).toBe(true)
    expect(fitted.output).toMatch(/\n\[… \d+ characters of output left out so that the result fits …\]\n/)
    expect(fitted.output.length).toBeGreaterThan(10_000) // no more is dropped than has to be
    expect(checkRunResult(fitted)).not.toBeNull()
  })
  it('never cuts a character in two', () => {
    const output = '😀'.repeat(10) + '\u0001'.repeat(63_000) + '😀'.repeat(10)
    const fitted = fitRunResult({ ...GOOD, output, figures: [big, big, big] })
    expect(encodeRunResult(fitted).length).toBeLessThanOrEqual(MAX_RESULT)
    expect(fitted.output).not.toMatch(LONE_SURROGATE)
  })
  it('drops figures from the end only when no output at all would fit', () => {
    const one = { png: TINY_PNG.slice(0, 12) + 'A'.repeat(159_988) }
    const figures = [one, { png: one.png.slice(0, -4) + 'BBBB' }, { png: one.png.slice(0, -4) + 'CCCC' }]
    // Not a result the app can send (the name is far too long); it stands for anything that leaves no room.
    const crowded = { ...GOOD, by: 'm'.repeat(130_000), output: 'hello', figures }
    const fitted = fitRunResult(crowded)
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_RESULT)
    expect(fitted.output).toBe('')
    expect(fitted.output_truncated).toBe(true)
    expect(fitted.figures).toEqual(figures.slice(0, 2))
  })
})

describe('toRunEvent', () => {
  it('passes the events of the bridge on, checked', () => {
    expect(toRunEvent({ type: 'approval' })).toEqual({ type: 'approval' })
    expect(toRunEvent({ type: 'started', extra: 1 })).toEqual({ type: 'started' })
    expect(toRunEvent({ type: 'output', text: 'hi' })).toEqual({ type: 'output', text: 'hi' })
    expect(toRunEvent({ type: 'error', reason: 'no_python', message: 'Choose a Python.' })).toEqual({ type: 'error', reason: 'no_python', message: 'Choose a Python.' })
    expect(toRunEvent(done())).toEqual(done())
  })
  it('skips what is not an event', () => {
    for (const raw of [null, 'done', 5, {}, { type: 'progress' }, { type: 'output' }, { type: 'output', text: 5 }]) expect(toRunEvent(raw)).toBeNull()
  })
  it('reads an unknown error reason as failed and a missing message as none', () => {
    expect(toRunEvent({ type: 'error', reason: 'on_fire' })).toEqual({ type: 'error', reason: 'failed', message: '' })
  })
  it('reads a done it cannot read as a failure, so the execution still ends', () => {
    const unreadable = { type: 'error', reason: 'failed', message: UNREADABLE_RESULT }
    expect(toRunEvent({ type: 'done' })).toEqual(unreadable)
    expect(toRunEvent({ ...done(), output: null })).toEqual(unreadable)
    expect(toRunEvent({ ...done(), figures: [{ png: 5 }] })).toEqual(unreadable)
    expect(toRunEvent({ ...done(), exit: 'zero' })).toEqual(unreadable)
  })
  it('keeps only the parts of a done it knows', () => {
    const raw = { ...done(), stopped: 'no', gpu: 'yes', env: { python: '3.12', gpu: 'yes', packages: { numpy: '2.0', odd: 5 } }, figures: [{ png: TINY_PNG, w: 3 }] }
    expect(toRunEvent(raw)).toEqual(done({ env: { python: '3.12', packages: { numpy: '2.0' } }, figures: [{ png: TINY_PNG }] }))
    expect(toRunEvent({ ...done(), env: undefined })).toEqual(done())
  })
})

describe('toRunEvent: stats (M9)', () => {
  const usage = { cpu_percent: 182, cores: 10, memory_bytes: 1.2e9, memory_total_bytes: 24e9, processes: 3 }
  const stats = (patch: Record<string, unknown> = {}) => toRunEvent({ type: 'stats', ...usage, ...patch })

  it('passes a sample on, with only the parts it knows', () => {
    expect(stats()).toEqual({ type: 'stats', ...usage })
    const full = { gpu: { percent: 76, name: 'Apple M2 Pro' }, step: 'thermalising', progress: { done: 45, total: 100 } }
    expect(stats(full)).toEqual({ type: 'stats', ...usage, ...full })
    expect(stats({ gpu: { percent: 5, vendor: 'x' }, energy: 3, progress: { done: 1, total: 2, unit: 'it' } })).toEqual({
      type: 'stats',
      ...usage,
      gpu: { percent: 5 },
      progress: { done: 1, total: 2 },
    })
    expect(stats({ cpu_percent: 0, memory_bytes: 0, processes: 0 })).toMatchObject({ cpu_percent: 0, memory_bytes: 0, processes: 0 })
  })
  it('reads an optional part given as null, or an empty step, as left out', () => {
    expect(stats({ gpu: null, step: null, progress: null })).toEqual({ type: 'stats', ...usage })
    expect(stats({ step: '', gpu: { percent: 3, name: null } })).toEqual({ type: 'stats', ...usage, gpu: { percent: 3 } })
    expect(stats({ gpu: { percent: 3, name: '' } })).toEqual({ type: 'stats', ...usage, gpu: { percent: 3 } })
  })
  it.each([
    ['a measure missing', { cores: undefined }],
    ['a measure that is not a number', { cpu_percent: '182' }],
    ['a negative number', { memory_bytes: -1 }],
    ['a number that is not finite', { memory_total_bytes: Infinity }],
    ['NaN', { processes: NaN }],
    ['a graphics reading that is not an object', { gpu: 76 }],
    ['a graphics reading without its percent', { gpu: { name: 'M2' } }],
    ['a negative graphics percent', { gpu: { percent: -1 } }],
    ['a graphics name that is not text', { gpu: { percent: 1, name: 5 } }],
    ['a step that is not text', { step: 5 }],
    ['progress that is not an object', { progress: 0.45 }],
    ['progress without a total', { progress: { done: 1 } }],
    ['a total of zero', { progress: { done: 0, total: 0 } }],
    ['a negative total', { progress: { done: 0, total: -5 } }],
    ['a negative done', { progress: { done: -1, total: 5 } }],
    ['a done that is not finite', { progress: { done: Infinity, total: 5 } }],
    ['a total that is not finite', { progress: { done: 1, total: Infinity } }],
  ])('drops the whole sample for %s', (_what, patch) => {
    expect(stats(patch)).toBeNull()
  })
  it('brings a done over its total down to it', () => {
    expect(stats({ progress: { done: 120, total: 100 } })).toMatchObject({ progress: { done: 100, total: 100 } })
    expect(stats({ progress: { done: 100, total: 100 } })).toMatchObject({ progress: { done: 100, total: 100 } })
  })
  it('cuts a step to 120 characters, never inside one', () => {
    const cut = stats({ step: 'x'.repeat(500) }) as { step: string }
    expect(cut.step).toBe('x'.repeat(MAX_STEP))
    expect(stats({ step: 'y'.repeat(MAX_STEP) })).toMatchObject({ step: 'y'.repeat(MAX_STEP) })
    const astral = stats({ step: '𝛑'.repeat(200) }) as { step: string }
    expect(Array.from(astral.step)).toHaveLength(MAX_STEP)
    expect(astral.step).not.toMatch(LONE_SURROGATE)
  })
})

describe('toRunResult', () => {
  it('takes who and when from the page and the rest from the app, the hash included', () => {
    const event = done({ exit: 3, duration_ms: 99, output: 'boom', figures: [{ png: TINY_PNG }], env: { python: '3.12.3' }, code_sha256: sha256Hex('other code') })
    expect(toRunResult(event, 'me', 777)).toEqual({
      v: 1,
      by: 'me',
      at: 777,
      code_sha256: sha256Hex('other code'),
      exit: 3,
      duration_ms: 99,
      output: 'boom',
      figures: [{ png: TINY_PNG }],
      env: { python: '3.12.3' },
    })
  })
  it('always has figures; says stopped and truncated only when true; leaves an empty env out', () => {
    const plain = toRunResult(done(), 'me', 1)!
    expect(Object.keys(plain)).toEqual(['v', 'by', 'at', 'code_sha256', 'exit', 'duration_ms', 'output', 'figures'])
    expect(plain.figures).toEqual([])
    const stopped = toRunResult(done({ exit: null, stopped: true, output_truncated: true }), 'me', 1)!
    expect(stopped).toMatchObject({ exit: null, stopped: true, output_truncated: true })
  })
  it('is null for what the server would never take', () => {
    expect(toRunResult(done({ code_sha256: 'nope' }), 'me', 1)).toBeNull()
    expect(toRunResult(done({ exit: 0.5 }), 'me', 1)).toBeNull()
    expect(toRunResult(done({ figures: [{ png: 'not a png' }] }), 'me', 1)).toBeNull()
    expect(toRunResult(done({ output: 'x'.repeat(64_001) }), 'me', 1)).toBeNull()
  })
  it('makes a result fit the limit of the server', () => {
    const fig = { png: TINY_PNG.slice(0, 12) + 'A'.repeat(159_988) }
    const result = toRunResult(done({ output: '\u0007'.repeat(64_000), figures: [fig, fig, fig] }), 'me', 1)!
    expect(encodeRunResult(result).length).toBeLessThanOrEqual(MAX_RESULT)
    expect(result.output_truncated).toBe(true)
    expect(result.figures).toHaveLength(3)
  })
})

describe('a result in one line', () => {
  const now = new Date(2026, 10, 22, 9, 0).getTime()
  const at = new Date(2026, 10, 12, 14, 2).getTime()
  const names = (id: string) => (id === 'ana' ? 'Ana Ruiz' : undefined)
  it('says who, when, how it ended, the figures and how much output', () => {
    const result = fakeRunResult('x', { by: 'ana', at, output: 'x'.repeat(1204), figures: [{ png: TINY_PNG }, { png: TINY_PNG }] })
    expect(runResultLine(result, names, now)).toBe('Ana Ruiz · 12 Nov, 14:02 · exit 0 · 2 figures · 1 204 characters of output')
  })
  it('says a stopped one, one without an exit code, one figure, no figures, no output, large numbers', () => {
    expect(runResultLine(fakeRunResult('x', { by: 'ana', at, exit: null, stopped: true, output: 'a' }), names, now)).toBe('Ana Ruiz · 12 Nov, 14:02 · stopped · 1 character of output')
    expect(runResultLine(fakeRunResult('x', { by: 'ana', at, exit: null, figures: [{ png: TINY_PNG }] }), names, now)).toBe('Ana Ruiz · 12 Nov, 14:02 · no exit code · 1 figure · no output')
    expect(runResultLine(fakeRunResult('x', { by: 'ana', at, exit: 1, output: 'x'.repeat(64_000) }), names, now)).toBe('Ana Ruiz · 12 Nov, 14:02 · exit 1 · 64 000 characters of output')
  })
  it('says Someone for a Member it has no name for, and the year when it is another one', () => {
    const lastYear = new Date(2025, 0, 3, 7, 5).getTime()
    expect(runResultLine(fakeRunResult('x', { by: 'gone', at: lastYear, output: 'abc' }), names, now)).toBe('Someone · 3 Jan 2025, 07:05 · exit 0 · 3 characters of output')
  })
  it('says a stored value: nothing, something unreadable, or the line — never the JSON', () => {
    expect(resultValueLine('Null', names, now)).toBe(NO_OUTPUT_RECORDED)
    expect(resultValueLine(undefined)).toBe('No output recorded')
    expect(resultValueLine(T('{"v":9}'), names, now)).toBe(CANNOT_BE_SHOWN)
    expect(resultValueLine(T(fakeRunResult('x', { by: 'ana', at, output: 'hi' })), names, now)).toBe('Ana Ruiz · 12 Nov, 14:02 · exit 0 · 2 characters of output')
  })
})
