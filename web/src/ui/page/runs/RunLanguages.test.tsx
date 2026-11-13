// M19 Part 2 and M19b on the Run block: the language beside the title, what this device can execute, waiting for a
// choice in the Runner window, the line that names what executed a result, the result of other code when the language
// or environment changed, and the editor's language and environment. The sync layer is the Page panel's stand-in.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerSetup, RunResult } from '../../../lib'

const fake = await vi.hoisted(async () => (await import('../testkit')).createFakePageLib())
vi.mock('../../../lib', async (orig) => fake.module(await orig<typeof import('../../../lib')>()))

const { PagePanel } = await import('../PagePanel')
const { editLock } = await import('../lock')
const { toasts } = await import('../../board/toastStore')
const { pagePanel, usePagePanel } = await import('../../bridge')
const { GUEST, card, run, runResult } = await import('../testkit')
const { MAIN } = await import('../../history/testkit')
const { CHOOSING_LINE } = await import('./RunBlock')

const { boardStore, pageStore, sessionStore, runsStore, staleStore, runs, submit } = fake

const LANGS = { python: { name: 'Python', version: '3.12.3' }, julia: { name: 'Julia', version: 'julia version 1.11.2' }, qsharp: { name: 'Q#', version: 'qdk 1.34.0' } }
const NEW_APP: RunnerSetup = { available: true, python: { path: '/usr/bin/python3', version: '3.12.3' }, languages: LANGS, environments: ['analysis', 'quantum'] }
const OLD_APP: RunnerSetup = { available: true, python: { path: '/usr/bin/python3', version: '3.12.3' } }
const packages = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pkg${i + 1}`, `1.${i}`]))

/** The Run `r1` on Card `a`, in that language and asking for that environment. */
function setRun(lang?: string, env?: string, result: RunResult | null = null) {
  const r = run('r1', 'a', '1', 'model.jl', 'println("hi")\n', result)
  r.run = { ...r.run!, ...(lang ? { lang } : {}), ...(env ? { env } : {}) }
  pageStore.setState({ blocks: [r] })
}

beforeEach(() => {
  fake.reset()
  usePagePanel.setState({ cardId: 'a', full: false })
  boardStore.setState({ cards: [card('a', 'Dynamics')] })
  setRun('julia')
})
afterEach(() => {
  cleanup()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
    pagePanel.close()
  })
})

const open = () => render(<PagePanel cardId="a" full={false} onClose={() => {}} />)
const row = () => screen.getByTestId('block-r1')
const inRow = () => within(row())
const button = (name: string) => inRow().getByRole('button', { name })
const desktop = (runner: RunnerSetup = NEW_APP) => runsStore.setState({ runner })
const lastBatch = () => submit.mock.calls[submit.mock.calls.length - 1]![0]

describe('the language beside the title', () => {
  it('"Run · Julia", "Run · Python" for a Run without one, the id for a language nobody named', () => {
    open()
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · Julia')
    act(() => setRun())
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · Python')
    act(() => setRun('qsharp'))
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · Q#')
    act(() => setRun('haskell'))
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · haskell')
  })
  it('a language this device has named by itself is called by that name', () => {
    desktop({ ...NEW_APP, languages: { ...LANGS, haskell: { name: 'Haskell' } } })
    setRun('haskell')
    open()
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · Haskell')
  })
  it('the environment a Python or Q# Run asks for is shown after the title; not for Julia', () => {
    setRun(undefined, 'analysis')
    open()
    expect(row().querySelector('.qp-run__asks')).toHaveTextContent('analysis')
    act(() => setRun('julia', 'analysis'))
    expect(row().querySelector('.qp-run__asks')).toBeNull()
  })
})

describe('what this device can execute', () => {
  it('an app too old for languages: the sentence, Run held back, nothing to set up', () => {
    desktop(OLD_APP)
    open()
    expect(screen.getByTestId('run-lang-r1')).toHaveTextContent('Update Infall on this computer to run Julia code.')
    expect(button('Run')).toHaveAttribute('aria-disabled', 'true')
    expect(button('Run')).toHaveAttribute('title', 'Update Infall on this computer to run Julia code.')
    fireEvent.click(button('Run'))
    expect(runs.run).not.toHaveBeenCalled()
    expect(inRow().queryByRole('button', { name: 'Open Runner settings' })).toBeNull()
  })
  it('a language not set up here: the Runner’s sentence and Open Runner settings at that language', () => {
    desktop({ ...NEW_APP, languages: { python: LANGS.python } })
    open()
    expect(screen.getByTestId('run-lang-r1')).toHaveTextContent('Julia is not set up in Runner settings on this computer.')
    fireEvent.click(button('Run'))
    expect(runs.run).not.toHaveBeenCalled()
    fireEvent.click(button('Open Runner settings'))
    expect(runs.configure).toHaveBeenCalledWith('julia')
  })
  it('a language set up here: Run as for Python', () => {
    desktop()
    open()
    expect(screen.queryByTestId('run-lang-r1')).toBeNull()
    fireEvent.click(button('Run'))
    expect(runs.run).toHaveBeenCalledWith('r1')
  })
  it('Python and the Tutorial’s Runs are untouched by an old app', () => {
    desktop(OLD_APP)
    setRun(undefined, 'analysis')
    open()
    expect(screen.queryByTestId('run-lang-r1')).toBeNull()
    fireEvent.click(button('Run'))
    expect(runs.run).toHaveBeenCalledWith('r1')
  })
  it('in a browser readers see the captured output as today, and nothing about languages', () => {
    setRun('julia', undefined, runResult({ lang: 'julia', output: 'hi\n', env: { runtime: 'julia version 1.11.2' } }))
    open()
    expect(screen.queryByTestId('run-lang-r1')).toBeNull()
    expect(inRow().getByRole('group', { name: 'Output of Run model.jl' })).toHaveTextContent('hi')
    expect(row().querySelector('.qp-run__runtime-line')).toHaveTextContent('Julia 1.11.2')
    expect(button('Run')).toBeDisabled()
  })
  it('a Guest reads it and is offered nothing', () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    boardStore.setState({ readOnly: true })
    runsStore.setState({ runner: { available: false, reason: 'guest' } })
    setRun('julia', undefined, runResult({ lang: 'julia', env: { runtime: 'julia version 1.11.2' } }))
    render(<PagePanel cardId="a" full={false} onClose={() => {}} />)
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · Julia')
    expect(row().querySelector('.qp-run__runtime-line')).toHaveTextContent('Julia 1.11.2')
    expect(screen.queryByTestId('run-lang-r1')).toBeNull()
    expect(inRow().queryAllByRole('button')).toEqual([])
  })
  it('waiting for a choice in the Runner window while it asks which environment a name means', () => {
    desktop()
    setRun(undefined, 'lab')
    open()
    act(() => runsStore.setState({ live: { block: 'r1', branch: MAIN.id, state: 'approval', output: '', choosing: true } }))
    expect(inRow().getByText(CHOOSING_LINE)).toBeInTheDocument()
    expect(CHOOSING_LINE).toBe('Waiting for a choice in the Runner window…')
    expect(screen.getByTestId('run-status-r1')).toHaveTextContent('Waiting for a choice in the Runner window')
    act(() => runsStore.setState({ live: { block: 'r1', branch: MAIN.id, state: 'approval', output: '' } }))
    expect(inRow().queryByText(CHOOSING_LINE)).toBeNull()
    expect(inRow().getByText(/Check the Infall window that just opened/)).toBeInTheDocument()
  })
  it('closed without a choice: the Runner’s sentence, with Runner settings', () => {
    desktop()
    setRun(undefined, 'lab')
    open()
    act(() =>
      runsStore.setState({ last: { block: 'r1', branch: MAIN.id, status: 'failed', reason: 'no_environment', message: 'No environment on this computer is chosen for “lab”.' } }),
    )
    expect(screen.getByTestId('run-outcome-r1')).toHaveTextContent('No environment on this computer is chosen for “lab”.')
    fireEvent.click(within(screen.getByTestId('run-outcome-r1')).getByRole('button', { name: 'Runner settings…' }))
    expect(runs.configure).toHaveBeenCalledWith()
  })
  it('a start refused by the layer says the layer’s sentence', async () => {
    desktop()
    const { ApiError } = await import('../../../lib')
    runs.run.mockRejectedValueOnce(new ApiError(409, 'no_toolchain', 'Julia is not set up in Runner settings on this computer.'))
    open()
    await act(async () => {
      fireEvent.click(button('Run'))
    })
    expect(screen.getByTestId('run-outcome-r1')).toHaveTextContent('Julia is not set up in Runner settings on this computer.')
  })
})

describe('the line that names what executed a result', () => {
  it('Julia by its version; Q# by its package', () => {
    setRun('julia', undefined, runResult({ lang: 'julia', env: { runtime: 'julia version 1.11.2', os: 'macos', arch: 'arm64' } }))
    open()
    const line = row().querySelector('.qp-run__runtime-line')!
    expect(line.textContent).toBe('Julia 1.11.2')
    expect(line).toHaveAttribute('title', 'Julia: julia version 1.11.2 · macos arm64')
    act(() => setRun('qsharp', undefined, runResult({ lang: 'qsharp', env: { python: '3.12.3', packages: { qdk: '1.34.0' } } })))
    expect(row().querySelector('.qp-run__runtime-line')!.textContent).toBe('Q# · qdk 1.34.0')
  })
  it('Python: its version, the first packages, and all 32 behind "+30"', () => {
    setRun(undefined, undefined, runResult({ env: { python: '3.12.3', packages: packages(32) } }))
    open()
    expect(row().querySelector('.qp-run__runtime-line')!.textContent).toBe('Python 3.12.3 · pkg1 1.0, pkg2 1.1 +30')
    const more = button('Show all 32 packages of Run model.jl')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(inRow().queryByRole('list', { name: 'Packages of Run model.jl' })).toBeNull()
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const list = inRow().getByRole('list', { name: 'Packages of Run model.jl' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(Object.entries(packages(32)).map(([n, v]) => `${n} ${v}`))
    fireEvent.click(button('Hide the packages of Run model.jl'))
    expect(inRow().queryByRole('list', { name: 'Packages of Run model.jl' })).toBeNull()
  })
  it('two packages or fewer: no disclosure', () => {
    setRun(undefined, undefined, runResult({ env: { python: '3.12.3', packages: { numpy: '2.1.0', scipy: '1.14.1' } } }))
    open()
    expect(row().querySelector('.qp-run__runtime-line')!.textContent).toBe('Python 3.12.3 · numpy 2.1.0, scipy 1.14.1')
    expect(row().querySelector('.qp-run__runtime-more')).toBeNull()
  })
  it('the environment the Run asked for, beside the Python', () => {
    setRun(undefined, 'analysis', runResult({ env: { python: '3.13.1', name: 'analysis', packages: { numpy: '2.1.0' } } }))
    open()
    expect(row().querySelector('.qp-run__runtime-line')!.textContent).toBe('Python 3.13.1 (analysis) · numpy 2.1.0')
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('· current code')
  })
})

describe('a result of other code', () => {
  it('made as Python, on a Run that became Julia: not current', () => {
    setRun('julia', undefined, runResult())
    open()
    expect(row().querySelector('.qp-run__stale')).toHaveTextContent('· ran as Python')
    expect(row().querySelector('.qp-run__record')).not.toHaveTextContent('current code')
  })
  it('made in another environment than the Run now asks for', () => {
    setRun(undefined, 'analysis', runResult())
    open()
    expect(row().querySelector('.qp-run__stale')).toHaveTextContent('· ran in the default environment')
    act(() => setRun(undefined, undefined, runResult({ env: { name: 'analysis' } })))
    expect(row().querySelector('.qp-run__stale')).toHaveTextContent('· ran in “analysis”')
  })
  it('a changed code is said first', () => {
    setRun('julia', undefined, runResult())
    staleStore.setState({ by: { r1: true } })
    open()
    expect(row().querySelector('.qp-run__stale')).toHaveTextContent('· code changed since')
  })
})

describe('the editor', () => {
  const edit = () => {
    open()
    fireEvent.click(button('Edit'))
  }
  const language = () => inRow().getByRole('combobox', { name: 'Language' })
  const envField = () => inRow().queryByRole('combobox', { name: 'Environment this Run asks for' }) ?? inRow().queryByRole('textbox', { name: 'Environment this Run asks for' })

  it('offers Python, Q#, Julia, R, JavaScript, Shell and Other…, at the Run’s language', () => {
    edit()
    expect(within(language()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Python', 'Q#', 'Julia', 'R', 'JavaScript', 'Shell', 'Other…'])
    expect(language()).toHaveValue('julia')
    expect(envField()).toBeNull() // Julia asks for no environment
  })
  it('a new language is one batch with the rest of the edit (one step of Undo)', () => {
    edit()
    fireEvent.change(language(), { target: { value: 'r' } })
    fireEvent.change(inRow().getByRole('textbox', { name: 'Name' }), { target: { value: 'model.R' } })
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([
      { fake: 'setBlockTitle', block: 'r1', title: 'model.R' },
      { fake: 'setRunLang', block: 'r1', lang: 'r' },
    ])
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · R')
  })
  it('back to Python, with an environment chosen from this device’s', () => {
    desktop()
    edit()
    fireEvent.change(language(), { target: { value: 'python' } })
    const env = envField()!
    expect(env).toHaveAttribute('list')
    const options = [...document.getElementById(env.getAttribute('list')!)!.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(options).toEqual(['analysis', 'quantum'])
    fireEvent.change(env, { target: { value: '  analysis ' } })
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([
      { fake: 'setRunLang', block: 'r1', lang: 'python' },
      { fake: 'setRunEnv', block: 'r1', env: 'analysis' },
    ])
  })
  it('free text is allowed for the environment; one that cannot be a name is said under the field', () => {
    setRun(undefined, 'analysis')
    edit()
    const env = envField()!
    expect(env).toHaveValue('analysis')
    fireEvent.change(env, { target: { value: 'my lab​' } })
    fireEvent.blur(env)
    expect(inRow().getByText(/An environment name is one line of at most 60 characters/)).toBeInTheDocument()
    expect(env).toHaveAttribute('aria-invalid', 'true')
    fireEvent.click(button('Done'))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.change(env, { target: { value: 'my lab' } })
    expect(env).not.toHaveAttribute('aria-invalid')
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([{ fake: 'setRunEnv', block: 'r1', env: 'my lab' }])
  })
  it('emptying the environment asks for the default one', () => {
    setRun('qsharp', 'quantum')
    edit()
    fireEvent.change(envField()!, { target: { value: '' } })
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([{ fake: 'setRunEnv', block: 'r1', env: '' }])
  })
  it('a language that takes no environment drops the one asked for', () => {
    setRun(undefined, 'analysis')
    edit()
    fireEvent.change(language(), { target: { value: 'shell' } })
    expect(envField()).toBeNull()
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([
      { fake: 'setRunLang', block: 'r1', lang: 'shell' },
      { fake: 'setRunEnv', block: 'r1', env: '' },
    ])
  })
  it('Other… takes an id, checked before anything is sent', () => {
    edit()
    fireEvent.change(language(), { target: { value: 'other' } })
    const id = inRow().getByRole('textbox', { name: 'Language id' })
    fireEvent.change(id, { target: { value: 'Haskell' } })
    fireEvent.click(button('Done'))
    expect(submit).not.toHaveBeenCalled()
    expect(inRow().getByText('A language id is 1–24 characters: a lowercase letter, then lowercase letters, digits, - or _.')).toBeInTheDocument()
    fireEvent.change(id, { target: { value: 'haskell' } })
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([{ fake: 'setRunLang', block: 'r1', lang: 'haskell' }])
  })
  it('a Run in a language this build has no name for opens at Other… with its id', () => {
    setRun('haskell')
    edit()
    expect(language()).toHaveValue('other')
    expect(inRow().getByRole('textbox', { name: 'Language id' })).toHaveValue('haskell')
    fireEvent.click(button('Done'))
    expect(submit).not.toHaveBeenCalled() // nothing changed
  })
  it('the hint names the language', () => {
    edit()
    expect(inRow().getByText(/^Julia\. Runs on the computer of whoever presses Run/)).toBeInTheDocument()
    fireEvent.change(language(), { target: { value: 'python' } })
    expect(inRow().getByText(/^Python\. Runs on the computer of whoever presses Run.*matplotlib/)).toBeInTheDocument()
  })
  it('Cancel sends nothing', () => {
    edit()
    fireEvent.change(language(), { target: { value: 'r' } })
    fireEvent.click(button('Cancel'))
    expect(submit).not.toHaveBeenCalled()
    expect(row().querySelector('.qp-run__kind')).toHaveTextContent('Run · Julia')
  })
})
