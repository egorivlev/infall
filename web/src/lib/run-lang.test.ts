// M19 Part 2 and M19b in the lib: what a Run names (its language, the environment it asks for), how that is stored
// and checked, and what a result records of it.
import { describe, expect, it } from 'vitest'
import { applyOps, toPageIndex } from './board-state'
import type { Entities } from './board-state'
import { sha256Hex } from './code-hash'
import { ops } from './ops'
import { isEnvName, isLangId, languageName, runEnv, runLang, takesEnv } from './run-lang'
import { checkRunResult, encodeRunResult, forOldServer, toRunEvent, toRunResult } from './run-result'
import { FakeServer, ME, fakeRunResult } from './testing'
import type { BlockVM, RunEvent } from './types'

const run = (lang?: string, env?: string): Pick<BlockVM, 'run'> => ({ run: { result: null, broken: false, ...(lang ? { lang } : {}), ...(env ? { env } : {}) } })
const packages = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pkg${i + 1}`, `1.${i}`]))
const done = (patch: Partial<Extract<RunEvent, { type: 'done' }>> = {}): Extract<RunEvent, { type: 'done' }> => ({
  type: 'done',
  exit: 0,
  stopped: false,
  duration_ms: 10,
  code_sha256: sha256Hex('x'),
  output: '',
  output_truncated: false,
  figures: [],
  env: {},
  ...patch,
})

describe('language ids', () => {
  it.each(['python', 'qsharp', 'julia', 'r', 'javascript', 'shell', 'a', 'my-lang_2', 'a'.repeat(24)])('takes %s', (id) => {
    expect(isLangId(id)).toBe(true)
  })
  it.each(['', 'Julia', '2lang', '-x', 'a'.repeat(25), 'c++', 'q#', ' julia', 'julia\n', 'ünï'])('refuses %j', (id) => {
    expect(isLangId(id)).toBe(false)
  })
  it('refuses what is not text', () => {
    expect(isLangId(undefined)).toBe(false)
    expect(isLangId(3)).toBe(false)
  })
  it('names the known languages, then what the device calls one, then the id itself', () => {
    expect(['python', 'qsharp', 'julia', 'r', 'javascript', 'shell'].map((id) => languageName(id))).toEqual(['Python', 'Q#', 'Julia', 'R', 'JavaScript', 'Shell'])
    expect(languageName('haskell', { haskell: { name: 'Haskell' } })).toBe('Haskell')
    expect(languageName('haskell', { haskell: { name: '  ' } })).toBe('haskell')
    expect(languageName('julia', { julia: { name: 'My Julia' } })).toBe('Julia')
    expect(languageName('ocaml')).toBe('ocaml')
  })
})

describe('environment names', () => {
  it.each(['analysis', 'base', 'lab 2', 'a'.repeat(60), 'ünïcode', 'π', '😀'.repeat(60)])('takes %j', (name) => {
    expect(isEnvName(name)).toBe(true)
  })
  it.each([
    ['empty', ''],
    ['61 characters', 'a'.repeat(61)],
    ['two lines', 'a\nb'],
    ['a tab', 'a\tb'],
    ['a space at the start', ' lab'],
    ['a space at the end', 'lab '],
    ['a zero-width space', 'la​b'],
    ['a direction control', 'lab‮'],
    ['a no-break space inside', 'la b'],
    ['a line separator', 'la b'],
    ['a byte-order mark', '﻿lab'],
    ['a Hangul filler', 'laㅤb'],
    ['a private-use character', 'lab'],
    ['a control character', 'la\u0007b'],
  ])('refuses %s', (_what, name) => {
    expect(isEnvName(name)).toBe(false)
  })
  it('only Python and Q# take one', () => {
    expect(['python', 'qsharp', 'julia', 'r', 'shell', 'x'].map(takesEnv)).toEqual([true, true, false, false, false, false])
  })
})

describe('a Run as stored', () => {
  it('unset is Python; the environment counts only for Python and Q#', () => {
    expect(runLang(run())).toBe('python')
    expect(runLang({})).toBe('python')
    expect(runLang(run('julia'))).toBe('julia')
    expect(runEnv(run(undefined, 'analysis'))).toBe('analysis')
    expect(runEnv(run('qsharp', 'analysis'))).toBe('analysis')
    expect(runEnv(run('julia', 'analysis'))).toBeUndefined()
    expect(runEnv(run())).toBeUndefined()
  })

  it('ops: `lang` and `env` are Text on the Block; Python and nothing unset them', () => {
    expect(ops.setRunLang('r1', 'julia')).toEqual({ Set: { entity: 'r1', field: 'lang', value: { Text: 'julia' } } })
    expect(ops.setRunLang('r1', 'python')).toEqual({ Set: { entity: 'r1', field: 'lang', value: 'Null' } })
    expect(ops.setRunLang('r1', null)).toEqual({ Set: { entity: 'r1', field: 'lang', value: 'Null' } })
    expect(ops.setRunEnv('r1', 'analysis')).toEqual({ Set: { entity: 'r1', field: 'env', value: { Text: 'analysis' } } })
    expect(ops.setRunEnv('r1', '')).toEqual({ Set: { entity: 'r1', field: 'env', value: 'Null' } })
    expect(ops.setRunEnv('r1', null)).toEqual({ Set: { entity: 'r1', field: 'env', value: 'Null' } })
  })
  it('ops refuse what is not an id or a name', () => {
    expect(() => ops.setRunLang('r1', 'Julia')).toThrow(RangeError)
    expect(() => ops.setRunLang('r1', '')).toThrow(RangeError)
    expect(() => ops.setRunEnv('r1', 'a\nb')).toThrow(RangeError)
    expect(() => ops.setRunEnv('r1', 'e'.repeat(61))).toThrow(RangeError)
  })

  it('the Board reads them on a Run, keeps a Run without them as it was, and never on another block', () => {
    const made = applyOps({} as Entities, [
      ops.createCard({ id: 'a', x: 0, y: 0 }),
      ops.addBlock({ id: 'r1', card: 'a', type: 'run', text: 'println(1)', order: 'a' }),
      ops.addBlock({ id: 'r2', card: 'a', type: 'run', text: 'print(1)', order: 'b' }),
      ops.addBlock({ id: 't1', card: 'a', text: 'hello', order: 'c' }),
      ops.setRunLang('r1', 'julia'),
      ops.setRunEnv('r2', 'analysis'),
      { Set: { entity: 't1', field: 'lang', value: { Text: 'julia' } } },
    ])
    if (!made.ok) throw new Error('did not apply')
    const blocks = toPageIndex(made.entities).blocks.get('a')!
    expect(blocks.find((b) => b.id === 'r1')!.run).toEqual({ result: null, broken: false, lang: 'julia' })
    expect(blocks.find((b) => b.id === 'r2')!.run).toEqual({ result: null, broken: false, env: 'analysis' })
    expect(blocks.find((b) => b.id === 't1')!.run).toBeUndefined()
  })

  it('a change of language or environment is a new Block object; anything else keeps it', () => {
    const base = applyOps({} as Entities, [ops.createCard({ id: 'a', x: 0, y: 0 }), ops.addBlock({ id: 'r1', card: 'a', type: 'run', text: 'x', order: 'a' })])
    if (!base.ok) throw new Error('did not apply')
    const first = toPageIndex(base.entities)
    const again = toPageIndex(base.entities, first)
    expect(again).toBe(first)
    const julia = applyOps(base.entities, [ops.setRunLang('r1', 'julia')])
    if (!julia.ok) throw new Error('did not apply')
    const second = toPageIndex(julia.entities, first)
    expect(second.blocks.get('a')![0]).not.toBe(first.blocks.get('a')![0])
    expect(toPageIndex(julia.entities, second).blocks.get('a')![0]).toBe(second.blocks.get('a')![0])
  })

  it('the fake server checks the shape as the server is asked to, and an old one refuses the fields', async () => {
    const server = new FakeServer()
    server.commit([ops.createCard({ id: 'a', x: 0, y: 0 }), ops.addBlock({ id: 'r1', card: 'a', type: 'run', text: 'x', order: 'a' })], ME.id)
    const post = (op: unknown) =>
      server.fetch(`/api/branches/${server.find().info.id}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [op] }) })
    expect((await post(ops.setRunLang('r1', 'julia'))).status).toBe(200)
    expect((await post(ops.setRunEnv('r1', 'analysis'))).status).toBe(200)
    expect((await post({ Set: { entity: 'r1', field: 'lang', value: { Text: 'Julia' } } })).status).toBe(400)
    expect((await post({ Set: { entity: 'r1', field: 'env', value: { Text: 'a\nb' } } })).status).toBe(400)
    server.oldRuns = true
    const old = await post(ops.setRunLang('r1', 'r'))
    expect(old.status).toBe(400)
    expect((JSON.parse(await old.text()) as { error: { message: string } }).error.message).toBe('unknown field `lang` on Block')
  })
})

describe('a result that names what executed it', () => {
  it('takes a language, a runtime, an environment name and up to 32 packages', () => {
    const r = fakeRunResult('x', { lang: 'julia', env: { runtime: 'julia version 1.11.2', os: 'macos', arch: 'arm64' } })
    expect(checkRunResult(r)).not.toBeNull()
    expect(checkRunResult(fakeRunResult('x', { env: { python: '3.12.3', name: 'analysis', packages: packages(32) } }))).not.toBeNull()
    expect(checkRunResult(fakeRunResult('x', { env: { packages: packages(33) } }))).toBeNull()
    expect(checkRunResult(fakeRunResult('x', { env: { runtime: 'v'.repeat(40) } }))).not.toBeNull()
    expect(JSON.parse(encodeRunResult(r))).toEqual(r)
  })

  it('reads `lang` and `runtime` from `done`; a `lang` that is not text makes it unreadable', () => {
    const raw = { ...done(), lang: 'julia', env: { runtime: 'julia version 1.11.2', os: 'macos', gpu: 'x' } }
    expect(toRunEvent(raw)).toMatchObject({ type: 'done', lang: 'julia', env: { runtime: 'julia version 1.11.2', os: 'macos' } })
    expect(toRunEvent({ ...done(), lang: 7 })).toMatchObject({ type: 'error', reason: 'failed' })
    expect(toRunEvent({ type: 'error', reason: 'no_toolchain', message: 'Julia is not set up in Runner settings on this computer.' })).toEqual({
      type: 'error',
      reason: 'no_toolchain',
      message: 'Julia is not set up in Runner settings on this computer.',
    })
    expect(toRunEvent({ type: 'error', reason: 'no_environment', message: 'x' })).toMatchObject({ reason: 'no_environment' })
  })

  it('records the language only when it is not Python, as before for Python', () => {
    expect(toRunResult(done({ lang: 'python', env: { python: '3.12.3' } }), ME.id, 1)).not.toHaveProperty('lang')
    expect(toRunResult(done({ env: { python: '3.12.3' } }), ME.id, 1)).not.toHaveProperty('lang')
    const julia = toRunResult(done({ lang: 'julia', env: { runtime: '  julia version 1.11.2 ', os: 'macos' } }), ME.id, 1)!
    expect(julia.lang).toBe('julia')
    expect(julia.env).toEqual({ runtime: 'julia version 1.11.2', os: 'macos' })
    expect(toRunResult(done({ lang: 'Not An Id' }), ME.id, 1)).toBeNull()
  })

  it('keeps the first 32 packages and the first 40 characters of a runtime', () => {
    const r = toRunResult(done({ env: { python: '3.12.3', packages: packages(40), runtime: 'x'.repeat(50) } }), ME.id, 1)!
    expect(Object.keys(r.env!.packages!)).toEqual(Object.keys(packages(32)))
    expect(r.env!.runtime).toBe('x'.repeat(40))
  })

  it('records the environment the Run asked for, when it asked through `start`', () => {
    expect(toRunResult(done({ env: { python: '3.13.1' } }), ME.id, 1, { env: 'analysis' })!.env).toEqual({ python: '3.13.1', name: 'analysis' })
    expect(toRunResult(done({ env: {} }), ME.id, 1, { env: 'analysis' })!.env).toEqual({ name: 'analysis' })
    expect(toRunResult(done({ env: {} }), ME.id, 1)).not.toHaveProperty('env')
    expect(toRunResult(done({ env: {} }), ME.id, 1, { env: 'a\nb' })).not.toHaveProperty('env')
  })

  it('for a server from before M19: the first 8 packages, and nothing for a result that names more', () => {
    const many = fakeRunResult('x', { env: { python: '3.12.3', packages: packages(12) } })
    expect(Object.keys(forOldServer(many)!.env!.packages!)).toEqual(Object.keys(packages(8)))
    expect(forOldServer(fakeRunResult('x', { env: { packages: packages(8) } }))).toBeNull()
    expect(forOldServer(fakeRunResult('x', { lang: 'julia', env: { packages: packages(12) } }))).toBeNull()
    expect(forOldServer(fakeRunResult('x', { env: { name: 'lab', packages: packages(12) } }))).toBeNull()
  })
})
