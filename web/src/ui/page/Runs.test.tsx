// Run blocks in the Page panel (M8): reading one in every state, executing it, the outcome strip,
// editing, the "⋯" menu, adding one — and that nothing a person or a program wrote can become markup.
// The sync layer's `useRuns` / `runs` / `useRunStale` are stand-ins (see testkit).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunLive, RunOutcome, RunnerSetup } from '../../lib'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { ApiError } = await import('../../lib')
const { PagePanel } = await import('./PagePanel')
const { RELEASE_GRACE_MS, editLock } = await import('./lock')
const { RUN_STARTER } = await import('./runs/starter')
const { COLLAPSED_LINES } = await import('./runs/RunBlock')
const { indentSelection } = await import('./runs/indent')
const { codeLines, envLine, figureSrc, formatDuration, formatElapsed } = await import('./runs/format')
const { toasts } = await import('../board/toastStore')
const { pagePanel, usePagePanel } = await import('../bridge')
const { GUEST, MEI, block, card, run, runResult, visual } = await import('./testkit')
const { MAIN, at } = await import('../history/testkit')

const { boardStore, pageStore, sessionStore, historyStore, membersStore, runsStore, staleStore, runs, submit, page } = fake

const CODE = 'import pennylane as qml\n\ndev = qml.device("default.qubit", wires=4)\nprint("reward", 176.4)\n'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const DESKTOP: RunnerSetup = { available: true, python: { path: '/usr/bin/python3', version: '3.12.4' }, folder: '/Users/ana/qoop-runs' }
const onClose = vi.fn<(cardId: string) => void>()

beforeEach(() => {
  fake.reset()
  onClose.mockReset()
  usePagePanel.setState({ cardId: 'a', full: false })
  boardStore.setState({ cards: [card('a', 'QRL on CartPole')] })
  pageStore.setState({
    blocks: [block('b1', 'a', '1', 'First paragraph'), run('r1', 'a', '2', 'policy_cartpole.py', CODE), block('b3', 'a', '3', 'Third paragraph')],
  })
})
afterEach(() => {
  cleanup()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
    pagePanel.close()
  })
  vi.useRealTimers()
})

const open = () => render(<PagePanel cardId="a" full={false} onClose={onClose} />)
const openStrict = () =>
  render(
    <StrictMode>
      <PagePanel cardId="a" full={false} onClose={onClose} />
    </StrictMode>,
  )
const row = (id = 'r1') => screen.getByTestId(`block-${id}`)
const inRow = (id = 'r1') => within(row(id))
const group = (id = 'r1') => row(id).querySelector('.qp-run') as HTMLElement
const button = (name: string, id = 'r1') => inRow(id).getByRole('button', { name })
const noButton = (name: string, id = 'r1') => inRow(id).queryByRole('button', { name })
const status = (id = 'r1') => screen.getByTestId(`run-status-${id}`)
const lastBatch = () => submit.mock.calls[submit.mock.calls.length - 1]![0]
const flush = () => act(async () => {})

const desktop = (runner: RunnerSetup = DESKTOP) => runsStore.setState({ runner })
const live = (state: RunLive['state'], extra: Partial<RunLive> = {}) =>
  runsStore.setState({ live: { block: 'r1', branch: MAIN.id, state, output: '', ...extra } })
const ended = (statusOf: RunOutcome['status'], extra: Partial<RunOutcome> = {}) =>
  runsStore.setState({ live: null, last: { block: 'r1', branch: MAIN.id, status: statusOf, ...extra } })
const setResult = (result: ReturnType<typeof runResult> | null, broken = false) =>
  pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'r1' ? { ...b, run: { result, broken } } : b)) }))

describe('Runs: how things are written out', () => {
  it('durations: "3.0 s", "42 s", "6 min 41 s", "2 h 05 min"', () => {
    expect(formatDuration(3000)).toBe('3.0 s')
    expect(formatDuration(140)).toBe('0.1 s')
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(401_000)).toBe('6 min 41 s')
    expect(formatDuration(365_000)).toBe('6 min 05 s')
    expect(formatDuration(7_500_000)).toBe('2 h 05 min')
    expect(formatDuration(3_599_700)).toBe('1 h 00 min')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(-1)).toBe('')
  })

  it('the running clock: "0:42", "12:05", "1:02:03"', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(42_900)).toBe('0:42')
    expect(formatElapsed(725_000)).toBe('12:05')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
    expect(formatElapsed(-5)).toBe('0:00')
  })

  it('the environment: Python as major.minor and at most three packages', () => {
    expect(envLine({ python: '3.12.4', packages: { pennylane: '0.38', torch: '2.4.1', numpy: '2.1.0', scipy: '1.14' } }).text).toBe(
      'py 3.12 · pennylane 0.38 · torch 2.4.1 · numpy 2.1.0',
    )
    expect(envLine({ python: '3.11.9 (main, Apr 2 2024)' }).text).toBe('py 3.11')
    expect(envLine({ python: 'pypy' }).text).toBe('')
    expect(envLine(undefined)).toEqual({ text: '', full: '' })
    expect(envLine({ python: '3.12.4', packages: { a: '1', b: '2', c: '3', d: '4' }, os: 'macOS 15', arch: 'arm64' }).full).toBe(
      'Python 3.12.4 · a 1 · b 2 · c 3 · d 4 · macOS 15 arm64',
    )
    // Not what the contract says a result holds — still only ever text.
    expect(envLine({ packages: { x: 5 as unknown as string } }).text).toBe('')
  })

  it('a figure becomes a PNG data URL only when its data is plain base64', () => {
    expect(figureSrc(PNG)).toBe(`data:image/png;base64,${PNG}`)
    expect(figureSrc('QUJD')).toBe('data:image/png;base64,QUJD')
    for (const bad of ['', 'AAAA" onerror="x', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'AA AA', 'AA\nAA', '=AAA', 'AA=A', '<svg>', 5, null, undefined, {}])
      expect(figureSrc(bad)).toBeNull()
  })

  it('code lines: line ends normalised, one closing line break not counted', () => {
    expect(codeLines('a\r\nb\n')).toEqual(['a', 'b'])
    expect(codeLines('a\n\n')).toEqual(['a', ''])
    expect(codeLines('')).toEqual([])
  })
})

describe('Runs: reading', () => {
  it('is a group named after the Run, with the header, the numbered code and the output part', () => {
    open()
    const g = screen.getByRole('group', { name: 'Run policy_cartpole.py' })
    expect(g).toBe(group())
    expect(g.querySelector('.qp-run__kind')).toHaveTextContent('Run')
    expect(g.querySelector('.qp-run__title')).toHaveTextContent('policy_cartpole.py')
    const code = inRow().getByRole('group', { name: 'Code of Run policy_cartpole.py' })
    expect(code).toHaveAttribute('tabindex', '0') // long lines scroll sideways: reachable from the keyboard
    expect(code.querySelector('.qp-run__gutter')).toHaveTextContent('1 2 3 4', { normalizeWhitespace: true })
    expect(code.querySelector('.qp-run__gutter')).toHaveAttribute('aria-hidden', 'true')
    expect(code.querySelector('.qp-run__lines')!.textContent).toBe(CODE.trimEnd())
    expect(g.querySelector('.qp-run__label')).toHaveTextContent('Output')
    expect(inRow().getByText('Not executed yet.')).toBeInTheDocument()
    expect(g.querySelector('.qp-run__env')).toBeNull() // nothing before the first result
    expect(g.querySelector('.qp-run__record')).toBeNull()
  })

  it('a Run without a name reads "Untitled Run"; one without code says so', () => {
    pageStore.setState({ blocks: [run('r1', 'a', '1', '', '')] })
    desktop()
    open()
    expect(screen.getByRole('group', { name: 'Untitled Run' })).toBeInTheDocument()
    expect(inRow().getByText('This Run has no code yet.')).toBeInTheDocument()
    const go = button('Run')
    expect(go).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(go)
    expect(runs.run).not.toHaveBeenCalled()
  })

  it(`code longer than ${COLLAPSED_LINES} lines is folded: "Show all N lines" / "Show less"`, () => {
    const long = Array.from({ length: 30 }, (_, i) => `x${i + 1} = ${i}`).join('\n')
    pageStore.setState({ blocks: [run('r1', 'a', '1', 'long.py', long)] })
    open()
    const lines = () => row().querySelector('.qp-run__lines')!.textContent!.split('\n')
    expect(lines()).toHaveLength(24)
    const more = button('Show all 30 lines')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(lines()).toHaveLength(30)
    expect(lines()[29]).toBe('x30 = 29')
    const less = button('Show less')
    expect(less).toBe(more) // the same button: focus stays on it
    expect(less).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(less)
    expect(lines()).toHaveLength(24)
  })

  it('exactly 24 lines are not folded', () => {
    pageStore.setState({ blocks: [run('r1', 'a', '1', 'ok.py', Array.from({ length: 24 }, (_, i) => `l${i}`).join('\n'))] })
    open()
    expect(inRow().queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  it('the Page meta line counts Runs and Visuals', () => {
    open()
    expect(screen.getByText('3 blocks · 0 Sources · 0 Connections · 1 Run')).toBeInTheDocument()
    act(() =>
      pageStore.setState((s) => ({ blocks: [...s.blocks, visual('v1', 'a', '4', 'Bloch', '<p>x</p>'), run('r2', 'a', '5', 'b.py', 'print(2)')] })),
    )
    expect(screen.getByText('5 blocks · 0 Sources · 0 Connections · 1 Visual · 2 Runs')).toBeInTheDocument()
  })
})

describe('Runs: where code can run', () => {
  it('browser, never executed: "Desktop app only", a disabled Run button and the strip', () => {
    open()
    expect(inRow().getByText('Desktop app only')).toBeInTheDocument()
    expect(button('Run')).toBeDisabled()
    expect(button('Run')).toHaveAttribute('title', 'Running code needs the desktop app')
    expect(inRow().getByText("Code can only run in the Infall desktop app. You're in the browser — this Run has not been executed yet.")).toBeInTheDocument()
    expect(noButton('More for Run policy_cartpole.py')).toBeNull()
  })

  it('browser, with a result: the strip points at the captured output below', () => {
    setResult(runResult())
    open()
    expect(
      inRow().getByText("Code can only run in the Infall desktop app. You're in the browser — the captured output from the last Run is shown below."),
    ).toBeInTheDocument()
    expect(inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' })).toHaveTextContent('episode 500 reward 176.4')
  })

  it('an older desktop app: the strip asks for an update', () => {
    desktop({ available: false, reason: 'old_app' })
    open()
    expect(inRow().getByText('This version of the desktop app cannot run code. Update the app.')).toBeInTheDocument()
    expect(button('Run')).toBeDisabled()
  })

  it('while the Runner is still being asked: a disabled button and no strip', () => {
    desktop({ available: false, reason: 'loading' })
    open()
    expect(button('Run')).toBeDisabled()
    expect(row().querySelector('.qp-run__strip')).toBeNull()
  })

  it('a Guest: the code and the captured output, no button, no strip, nothing to edit', () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    boardStore.setState({ readOnly: true })
    desktop({ available: false, reason: 'guest' })
    setResult(runResult({ figures: [{ png: PNG }] }))
    open()
    expect(inRow().queryAllByRole('button')).toEqual([])
    expect(row().querySelector('.qp-run__strip')).toBeNull()
    expect(row().querySelector('.qp-run__lines')!.textContent).toBe(CODE.trimEnd())
    expect(inRow().getByRole('img', { name: 'Figure 1 of Run policy_cartpole.py' })).toBeInTheDocument()
    expect(inRow().getByText(/Last run by Mei Tanaka/)).toBeInTheDocument()
    expect(group()).toHaveAttribute('tabindex', '-1')
  })

  it('a moment in History: no button and no strip, even in the desktop app', () => {
    desktop()
    historyStore.setState({ preview: { seq: 3, at: null, cards: [], frames: [], connections: [] } })
    setResult(runResult())
    open()
    expect(noButton('Run')).toBeNull()
    expect(noButton('More for Run policy_cartpole.py')).toBeNull()
    expect(row().querySelector('.qp-run__strip')).toBeNull()
    expect(inRow().getByText(/Last run by Mei Tanaka/)).toBeInTheDocument()
  })

  it('desktop app without a Python chosen: "Set up the Runner…" opens the Runner settings', () => {
    desktop({ available: true })
    open()
    expect(noButton('Run')).toBeNull()
    fireEvent.click(button('Set up the Runner…'))
    expect(runs.configure).toHaveBeenCalledTimes(1)
    expect(runs.run).not.toHaveBeenCalled()
  })

  it('desktop app, ready: a primary "Run" that executes this Run', () => {
    desktop()
    open()
    const go = button('Run')
    expect(go).toBeEnabled()
    expect(go).not.toHaveAttribute('aria-disabled')
    expect(go).toHaveAttribute('title', 'Run on this computer')
    expect(go).toHaveClass('q-btn--primary')
    expect(row().querySelector('.qp-run__strip')).toBeNull()
    expect(inRow().queryByText('Desktop app only')).toBeNull()
    fireEvent.click(go)
    expect(runs.run).toHaveBeenCalledTimes(1)
    expect(runs.run).toHaveBeenCalledWith('r1')
  })

  it('under someone else’s soft lock a Member can still execute, but not edit or clear', () => {
    desktop()
    setResult(runResult())
    pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } })
    open()
    expect(noButton('Edit')).toBeNull()
    expect(noButton('Delete block')).toBeNull()
    fireEvent.click(button('Run'))
    expect(runs.run).toHaveBeenCalledWith('r1')
    fireEvent.click(button('More for Run policy_cartpole.py'))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Runner settings…'])
  })
})

describe('Runs: an execution in this window', () => {
  it('approval: the button waits, a line says where to look, and it is announced', () => {
    desktop()
    open()
    act(() => live('approval'))
    const go = button('Waiting for you…')
    expect(go).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(go)
    expect(runs.run).not.toHaveBeenCalled()
    expect(runs.stop).not.toHaveBeenCalled()
    expect(inRow().getByText('Check the Infall window that just opened: it shows this code and asks before running it.')).toBeInTheDocument()
    expect(status()).toHaveTextContent('Waiting for you in the Infall window')
    expect(inRow().queryByText('live')).toBeNull()
  })

  it('running: "Stop", the clock ticking each second, "live", and the live output as text', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 22, 12, 0, 42))
    desktop()
    open()
    act(() => live('running', { startedAt: Date.now() - 42_000, output: 'episode 1\n' }))
    expect(inRow().getByRole('timer')).toHaveTextContent('0:42')
    act(() => vi.advanceTimersByTime(1000))
    expect(inRow().getByRole('timer')).toHaveTextContent('0:43')
    act(() => vi.advanceTimersByTime(60_000))
    expect(inRow().getByRole('timer')).toHaveTextContent('1:43')
    expect(inRow().getByText('live')).toBeInTheDocument()
    expect(status()).toHaveTextContent('Run started')
    const out = inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' })
    expect(out.tagName).toBe('PRE')
    expect(out).toHaveAttribute('aria-live', 'off')
    expect(out.textContent).toBe('episode 1\n')
    const stop = button('Stop')
    expect(stop).not.toHaveAttribute('aria-disabled')
    fireEvent.click(stop)
    expect(runs.stop).toHaveBeenCalledTimes(1)
    expect(runs.run).not.toHaveBeenCalled()
  })

  it('the clock is cleaned up when the Run ends and when the Page closes (StrictMode too)', () => {
    vi.useFakeTimers()
    desktop()
    const view = openStrict()
    const idle = vi.getTimerCount() // whatever else the panel keeps
    act(() => live('running', { startedAt: Date.now() }))
    expect(vi.getTimerCount()).toBe(idle + 1)
    act(() => live('saving', { startedAt: Date.now() }))
    expect(vi.getTimerCount()).toBe(idle)
    expect(inRow().queryByRole('timer')).toBeNull()
    act(() => live('running', { startedAt: Date.now() }))
    expect(vi.getTimerCount()).toBe(idle + 1)
    view.unmount()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(idle)
  })

  it('running before anything was printed: "No output yet."', () => {
    desktop()
    open()
    act(() => live('running', { startedAt: Date.now() }))
    expect(inRow().getByText('No output yet.')).toBeInTheDocument()
  })

  it('saving: "Recording…", no clock, no "live"', () => {
    desktop()
    open()
    act(() => live('saving', { startedAt: Date.now() - 5000, output: 'done\n' }))
    const go = button('Recording…')
    expect(go).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(go)
    expect(runs.stop).not.toHaveBeenCalled()
    expect(inRow().queryByRole('timer')).toBeNull()
    expect(inRow().queryByText('live')).toBeNull()
    expect(inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' }).textContent).toBe('done\n')
  })

  it('while live, the live output stands in for the stored one and the stored figures are out of sight', () => {
    desktop()
    setResult(runResult({ output: 'OLD OUTPUT\n', figures: [{ png: PNG }], output_truncated: true }))
    open()
    expect(inRow().getAllByRole('img')).toHaveLength(1)
    act(() => live('running', { startedAt: Date.now(), output: 'new\n' }))
    expect(inRow().queryByRole('img')).toBeNull()
    expect(inRow().queryByText(/OLD OUTPUT/)).toBeNull()
    expect(inRow().queryByText('Part of the output was left out.')).toBeNull()
    expect(row().querySelector('.qp-run__record')).toBeNull()
    expect(inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' }).textContent).toBe('new\n')
    // Declined or failed without a new result: the stored one is back.
    act(() => ended('declined'))
    expect(inRow().getAllByRole('img')).toHaveLength(1)
    expect(inRow().getByText(/OLD OUTPUT/)).toBeInTheDocument()
  })

  it('the output stays scrolled to the end while live — unless the Member scrolled up', () => {
    desktop()
    open()
    act(() => live('running', { startedAt: Date.now(), output: 'a\n' }))
    const pre = inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' })
    let height = 400
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(pre, 'clientHeight', { configurable: true, get: () => 320 })
    Object.defineProperty(pre, 'scrollTop', { configurable: true, writable: true, value: 0 })
    act(() => live('running', { startedAt: Date.now(), output: 'a\nb\n' }))
    expect(pre.scrollTop).toBe(400)
    // The Member scrolls up to read…
    pre.scrollTop = 10
    fireEvent.scroll(pre)
    height = 600
    act(() => live('running', { startedAt: Date.now(), output: 'a\nb\nc\n' }))
    expect(pre.scrollTop).toBe(10)
    // …and back to the end: it follows again.
    pre.scrollTop = 280
    fireEvent.scroll(pre)
    height = 800
    act(() => live('running', { startedAt: Date.now(), output: 'a\nb\nc\nd\n' }))
    expect(pre.scrollTop).toBe(800)
    expect(inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' })).toBe(pre) // one element throughout
  })

  it('chunks of live output touch only the output: code and other blocks keep their DOM, the text is one node', () => {
    desktop()
    open()
    act(() => live('running', { startedAt: Date.now(), output: 'x' }))
    const codeNode = row().querySelector('.qp-run__lines code')!.firstChild
    const other = row('b1').firstElementChild
    const pre = inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' })
    const big = 'line of output\n'.repeat(4266) // about 64 000 characters
    act(() => live('running', { startedAt: Date.now(), output: big }))
    expect(pre.childNodes).toHaveLength(1)
    expect(pre.firstChild!.nodeType).toBe(Node.TEXT_NODE)
    expect(pre.textContent).toBe(big)
    expect(row().querySelector('.qp-run__lines code')!.firstChild).toBe(codeNode)
    expect(row('b1').firstElementChild).toBe(other)
  })

  it('another Run is live: this one cannot start, and says why', () => {
    desktop()
    pageStore.setState((s) => ({ blocks: [...s.blocks, run('r2', 'a', '4', 'other.py', 'print(2)')] }))
    open()
    act(() => live('running', { startedAt: Date.now() }))
    const go = button('Run', 'r2')
    expect(go).toHaveAttribute('aria-disabled', 'true')
    expect(go).toHaveAttribute('title', 'Another Run is in progress')
    fireEvent.click(go)
    expect(runs.run).not.toHaveBeenCalled()
    expect(within(row('r2')).queryByRole('timer')).toBeNull()
    expect(status('r2')).toHaveTextContent('')
    // The other one's Edit and Delete still work: only the live block is held.
    expect(button('Edit', 'r2')).toBeEnabled()
    expect(within(row('r2')).getByRole('button', { name: 'Delete block' })).toBeEnabled()
  })

  it('the same Run executing on another Branch counts as another Run here', () => {
    desktop()
    open()
    act(() => live('running', { branch: 'other-branch', startedAt: Date.now(), output: 'elsewhere' }))
    expect(button('Run')).toHaveAttribute('title', 'Another Run is in progress')
    expect(inRow().queryByText('elsewhere')).toBeNull()
    act(() => ended('failed', { branch: 'other-branch', message: 'Nope.' }))
    expect(inRow().queryByText('Nope.')).toBeNull()
  })

  it('the live block cannot be edited or deleted from this window', () => {
    desktop()
    open()
    act(() => live('running', { startedAt: Date.now() }))
    expect(button('Edit')).toBeDisabled()
    expect(button('Delete block')).toBeDisabled()
    expect(button('Delete block')).toHaveAttribute('title', 'This Run is in progress')
    fireEvent.keyDown(group(), { key: 'Enter' })
    expect(inRow().queryByRole('textbox')).toBeNull()
    fireEvent.click(button('More for Run policy_cartpole.py'))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Runner settings…'])
  })

  it('focus stays on the one button through Run → Waiting → Stop → Recording → Run', () => {
    desktop()
    open()
    const go = button('Run')
    go.focus()
    fireEvent.click(go)
    act(() => live('approval'))
    expect(button('Waiting for you…')).toBe(go)
    expect(go).toHaveFocus()
    act(() => live('running', { startedAt: Date.now() }))
    expect(button('Stop')).toBe(go)
    expect(go).toHaveFocus()
    act(() => live('saving'))
    expect(button('Recording…')).toBe(go)
    expect(go).toHaveFocus()
    act(() => {
      setResult(runResult({ by: 'ana' }))
      ended('recorded')
    })
    expect(button('Run')).toBe(go)
    expect(go).toHaveFocus()
    expect(go).not.toHaveAttribute('aria-disabled')
  })
})

describe('Runs: a recorded result', () => {
  it('shows the environment in the header, figures on plates, the text, and the record line', () => {
    setResult(
      runResult({
        figures: [{ png: PNG }, { png: 'QUJD' }, { png: PNG }],
        env: { python: '3.12.4', packages: { pennylane: '0.38.0', torch: '2.4.1', numpy: '2.1.0', scipy: '1.14.1' }, os: 'macOS 15.1', arch: 'arm64' },
      }),
    )
    open()
    const env = row().querySelector('.qp-run__env')!
    expect(env.textContent).toBe('py 3.12 · pennylane 0.38.0 · torch 2.4.1 · numpy 2.1.0')
    expect(env.getAttribute('title')).toContain('scipy 1.14.1')
    const figures = inRow().getAllByRole('img')
    expect(figures.map((f) => f.getAttribute('alt'))).toEqual([
      'Figure 1 of Run policy_cartpole.py',
      'Figure 2 of Run policy_cartpole.py',
      'Figure 3 of Run policy_cartpole.py',
    ])
    expect(figures.map((f) => f.getAttribute('src'))).toEqual([`data:image/png;base64,${PNG}`, 'data:image/png;base64,QUJD', `data:image/png;base64,${PNG}`])
    for (const f of figures) expect(f).toHaveClass('qp-run__fig')
    const out = inRow().getByRole('group', { name: 'Output of Run policy_cartpole.py' })
    expect(out.textContent).toBe('episode 500  reward 176.4\n')
    // Figures come before the text.
    expect(figures[2]!.compareDocumentPosition(out) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const record = row().querySelector('.qp-run__record')!
    expect(record).toHaveTextContent('Last run by Mei Tanaka, 12 Nov, 14:02 · current code')
    expect(record.querySelector('.q-avatar')).toHaveTextContent('MT')
    expect(record.querySelector('time')).toHaveAttribute('datetime', new Date(runResult().at).toISOString())
    expect(record.querySelector('.qp-run__stats')!.textContent).toBe('3.0 s')
    expect(inRow().queryByText('Part of the output was left out.')).toBeNull()
  })

  it('your own execution reads "by you"; someone no longer on the team "a former Member"', () => {
    setResult(runResult({ by: 'ana', duration_ms: 401_000 }))
    open()
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('Last run by you, 12 Nov, 14:02')
    expect(row().querySelector('.qp-run__stats')!.textContent).toBe('6 min 41 s')
    act(() => setResult(runResult({ by: 'gone' })))
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('Last run by a former Member, 12 Nov, 14:02')
    expect(row().querySelector('.qp-run__record .q-avatar')).toHaveTextContent('?')
    act(() => membersStore.setState({ list: [] }))
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('Last run by a Member, 12 Nov, 14:02')
  })

  it('exit code other than 0: the words "exit N", not colour alone', () => {
    setResult(runResult({ exit: 1, duration_ms: 42_000, output: 'Traceback (most recent call last):\nZeroDivisionError\n' }))
    open()
    const stats = row().querySelector('.qp-run__stats')!
    expect(stats.textContent).toBe('42 s · exit 1')
    expect(stats.querySelector('.qp-run__exit')).toHaveTextContent('exit 1')
    expect(inRow().getByText(/ZeroDivisionError/)).toBeInTheDocument()
  })

  it('stopped: the word "stopped" (also when the exit code is simply missing)', () => {
    setResult(runResult({ exit: null, stopped: true, duration_ms: 7_500_000 }))
    open()
    expect(row().querySelector('.qp-run__stats')!.textContent).toBe('2 h 05 min · stopped')
    act(() => setResult(runResult({ exit: null })))
    expect(row().querySelector('.qp-run__stats')!.textContent).toBe('3.0 s · stopped')
    expect(row().querySelector('.qp-run__exit')).toBeNull()
  })

  it('truncated output says so', () => {
    setResult(runResult({ output_truncated: true }))
    open()
    expect(inRow().getByText('Part of the output was left out.')).toBeInTheDocument()
  })

  it('a result with neither text nor figures: "No output."', () => {
    setResult(runResult({ output: '' }))
    open()
    expect(inRow().getByText('No output.')).toBeInTheDocument()
    expect(row().querySelector('.qp-run__record')).not.toBeNull()
  })

  it('code changed since the result: the record line says so; not known yet: it says neither', () => {
    setResult(runResult())
    staleStore.setState({ by: { r1: true } })
    open()
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('Last run by Mei Tanaka, 12 Nov, 14:02 · code changed since')
    expect(row().querySelector('.qp-run__stale')).toHaveTextContent('· code changed since')
    act(() => staleStore.setState({ by: { r1: null } }))
    expect(row().querySelector('.qp-run__by')!.textContent).toBe('Last run by Mei Tanaka, 12 Nov, 14:02')
    act(() => staleStore.setState({ by: { r1: false } }))
    expect(row().querySelector('.qp-run__by')!.textContent).toBe('Last run by Mei Tanaka, 12 Nov, 14:02 · current code')
  })

  it('a result that cannot be read: "This result cannot be shown." — and it can be cleared', () => {
    desktop()
    setResult(null, true)
    open()
    expect(inRow().getByText('This result cannot be shown.')).toBeInTheDocument()
    expect(inRow().queryByText('Not executed yet.')).toBeNull()
    fireEvent.click(button('More for Run policy_cartpole.py'))
    expect(screen.getByRole('menuitem', { name: 'Clear output' })).toBeInTheDocument()
  })

  it('a result with odd values in it is still shown, never thrown', () => {
    setResult({
      ...runResult(),
      at: Number.NaN,
      duration_ms: Number.NaN,
      figures: [{ png: PNG }, null, { png: 7 }] as unknown as { png: string }[],
      env: { python: 3 as unknown as string, packages: 'x' as unknown as Record<string, string> },
    })
    open()
    expect(inRow().getAllByRole('img')).toHaveLength(1)
    expect(inRow().getByText('2 figures could not be shown.')).toBeInTheDocument()
    expect(row().querySelector('.qp-run__by')!.textContent).toBe('Last run by Mei Tanaka · current code')
    expect(row().querySelector('time')).toBeNull()
    expect(row().querySelector('.qp-run__env')).toBeNull()
  })

  it('a figure the browser cannot draw is taken out', () => {
    setResult(runResult({ figures: [{ png: 'QUJD' }] }))
    open()
    fireEvent.error(inRow().getByRole('img'))
    expect(inRow().queryByRole('img')).toBeNull()
    expect(inRow().getByText('One figure could not be shown.')).toBeInTheDocument()
  })
})

describe('Runs: how the last execution ended', () => {
  beforeEach(() => desktop())

  it('declined: nothing is shown or announced', () => {
    open()
    act(() => live('approval'))
    act(() => ended('declined'))
    expect(row().querySelector('.qp-run__strip')).toBeNull()
    expect(status()).toHaveTextContent('')
    expect(button('Run')).not.toHaveAttribute('aria-disabled')
  })

  it('recorded: no strip — the new result is the confirmation — and "Run finished" is announced', () => {
    open()
    act(() => live('saving'))
    act(() => {
      setResult(runResult({ by: 'ana' }))
      ended('recorded')
    })
    expect(row().querySelector('.qp-run__strip')).toBeNull()
    expect(status()).toHaveTextContent('Run finished')
    expect(status()).toHaveAttribute('role', 'status')
    expect(status()).toHaveAttribute('aria-live', 'polite')
    expect(inRow().getAllByRole('status')).toHaveLength(1)
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('Last run by you')
  })

  it('recorded after Stop: "Run stopped" is announced', () => {
    open()
    act(() => {
      setResult(runResult({ by: 'ana', exit: null, stopped: true }))
      ended('recorded')
    })
    expect(status()).toHaveTextContent('Run stopped')
  })

  it('failed: the sentence, announced as "Run failed: …", with Dismiss', () => {
    open()
    act(() => ended('failed', { message: 'The Runner stopped answering.' }))
    const strip = screen.getByTestId('run-outcome-r1')
    expect(strip).toHaveTextContent('The Runner stopped answering.')
    expect(status()).toHaveTextContent('Run failed: The Runner stopped answering.')
    expect(within(strip).queryByRole('button', { name: 'Runner settings…' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Dismiss' }))
    expect(runs.dismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('run-outcome-r1')).toBeNull()
    expect(button('Run')).toHaveFocus() // the strip went away with the pressed button: focus is not lost
    expect(status()).toHaveTextContent('')
  })

  it('failed because of Python: also "Runner settings…"', () => {
    open()
    act(() => ended('failed', { message: 'Python was not found at /usr/bin/python3.' }))
    const strip = screen.getByTestId('run-outcome-r1')
    fireEvent.click(within(strip).getByRole('button', { name: 'Runner settings…' }))
    expect(runs.configure).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('run-outcome-r1')).toBeInTheDocument() // stays until dismissed
  })

  it('unsaved: says what happened, "Record again" retries, "Discard" drops it', async () => {
    open()
    act(() => ended('unsaved', { message: 'Can’t reach the server.', unsaved: runResult({ by: 'ana' }) }))
    const strip = () => screen.getByTestId('run-outcome-r1')
    expect(strip()).toHaveTextContent('The output was captured but could not be recorded: Can’t reach the server.')
    expect(status()).toHaveTextContent('The output was captured but could not be recorded: Can’t reach the server.')

    let reject!: (e: unknown) => void
    runs.saveAgain.mockImplementationOnce(() => new Promise<void>((_, no) => (reject = no)))
    fireEvent.click(within(strip()).getByRole('button', { name: 'Record again' }))
    expect(runs.saveAgain).toHaveBeenCalledTimes(1)
    const busy = within(strip()).getByRole('button', { name: 'Recording…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    expect(runs.saveAgain).toHaveBeenCalledTimes(1)
    await act(async () => reject(new ApiError(0, 'network', 'offline')))
    expect(strip()).toHaveTextContent('It could not be recorded this time either.')

    // The second try works: the sync layer reports "recorded" and the strip goes.
    runs.saveAgain.mockImplementationOnce(async () => {
      setResult(runResult({ by: 'ana' }))
      ended('recorded')
    })
    fireEvent.click(within(strip()).getByRole('button', { name: 'Record again' }))
    await flush()
    expect(screen.queryByTestId('run-outcome-r1')).toBeNull()
    expect(status()).toHaveTextContent('Run finished')

    act(() => ended('unsaved', { message: 'The Branch is not open.', unsaved: runResult({ by: 'ana' }) }))
    fireEvent.click(within(strip()).getByRole('button', { name: 'Discard' }))
    expect(runs.dismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('run-outcome-r1')).toBeNull()
    expect(button('Run')).toHaveFocus()
  })

  it('when it cannot even start, the reason is said in plain words and can be dismissed', async () => {
    open()
    runs.run.mockRejectedValueOnce(new ApiError(409, 'busy', 'busy'))
    fireEvent.click(button('Run'))
    await flush()
    expect(screen.getByTestId('run-outcome-r1')).toHaveTextContent('Another Run is in progress.')
    expect(status()).toHaveTextContent('Run failed: Another Run is in progress.')
    fireEvent.click(within(screen.getByTestId('run-outcome-r1')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('run-outcome-r1')).toBeNull()

    runs.run.mockRejectedValueOnce(new ApiError(404, 'not_found', 'x'))
    fireEvent.click(button('Run'))
    await flush()
    expect(screen.getByTestId('run-outcome-r1')).toHaveTextContent('This Run is no longer on the Page.')
    // Pressing Run again clears the old sentence.
    fireEvent.click(button('Run'))
    await flush()
    expect(screen.queryByTestId('run-outcome-r1')).toBeNull()

    runs.run.mockRejectedValueOnce(new Error('boom <b>x</b>'))
    fireEvent.click(button('Run'))
    await flush()
    expect(screen.getByTestId('run-outcome-r1')).toHaveTextContent('The Run could not be started. Try again.')
  })

  it('an outcome belongs to its own Run only', () => {
    pageStore.setState((s) => ({ blocks: [...s.blocks, run('r2', 'a', '4', 'other.py', 'print(2)')] }))
    open()
    act(() => ended('failed', { message: 'It broke.' }))
    expect(within(row('r1')).getByText('It broke.')).toBeInTheDocument()
    expect(within(row('r2')).queryByText('It broke.')).toBeNull()
    expect(status('r2')).toHaveTextContent('')
  })
})

describe('Runs: editing', () => {
  const edit = () => fireEvent.click(button('Edit'))
  const nameField = (id = 'r1') => inRow(id).getByRole<HTMLInputElement>('textbox', { name: 'Name' })
  const codeField = (id = 'r1') => inRow(id).getByRole<HTMLTextAreaElement>('textbox', { name: 'Code' })
  const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => fireEvent.input(field, { target: { value } })

  it('"Edit" opens the Name field and the code, with the hint; nothing is submitted yet', () => {
    open()
    edit()
    expect(inRow().getByRole('group', { name: 'Block 2, Run editor' })).toBeInTheDocument()
    expect(nameField()).toHaveValue('policy_cartpole.py')
    expect(nameField()).toHaveFocus()
    const code = codeField()
    expect(code).toHaveValue(CODE)
    expect(code.rows).toBeGreaterThanOrEqual(14)
    expect(code).toHaveAttribute('spellcheck', 'false')
    expect(code).toHaveAttribute('autocapitalize', 'off')
    expect(code).toHaveAccessibleDescription(
      /^Python\. Runs on the computer of whoever presses Run, in the desktop app, after they have seen the code\. Figures drawn with matplotlib are captured\./,
    )
    expect(submit).not.toHaveBeenCalled()
    expect(page.startEditing).toHaveBeenCalledWith('a')
  })

  it('Enter on the focused block opens the editor; the block says so to screen readers', () => {
    open()
    expect(group()).toHaveAttribute('tabindex', '0')
    expect(group()).toHaveAccessibleDescription('Press Enter to edit.')
    fireEvent.keyDown(group(), { key: 'Enter' })
    expect(codeField()).toBeInTheDocument()
  })

  it('Enter on a button inside the block does not open the editor', () => {
    desktop()
    open()
    fireEvent.keyDown(button('Run'), { key: 'Enter' })
    expect(inRow().queryByRole('textbox')).toBeNull()
  })

  it('"Done" submits the changed name and code as one batch and keeps the result', () => {
    setResult(runResult())
    open()
    edit()
    type(nameField(), '  policy   v2.py ')
    type(codeField(), 'print(2)\n')
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([
      { fake: 'setBlockTitle', block: 'r1', title: 'policy v2.py' },
      { fake: 'setBlockText', block: 'r1', text: 'print(2)\n' },
    ])
    expect(screen.getByRole('group', { name: 'Run policy v2.py' })).toHaveFocus()
    expect(row().querySelector('.qp-run__lines')!.textContent).toBe('print(2)')
    // Editing does not clear the output.
    expect(row().querySelector('.qp-run__record')).toHaveTextContent('Last run by Mei Tanaka')
  })

  it('only what changed is submitted; nothing changed, nothing submitted', () => {
    open()
    edit()
    type(codeField(), 'print(3)')
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'r1', text: 'print(3)' }])
    submit.mockClear()
    edit()
    fireEvent.click(button('Done'))
    expect(submit).not.toHaveBeenCalled()
  })

  it('⌘Enter finishes like "Done"; leaving a field does not', () => {
    open()
    edit()
    type(codeField(), 'print(4)')
    fireEvent.blur(codeField())
    expect(submit).not.toHaveBeenCalled()
    expect(codeField()).toBeInTheDocument()
    fireEvent.keyDown(codeField(), { key: 'Enter', metaKey: true })
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'r1', text: 'print(4)' }])
    expect(inRow().queryByRole('textbox')).toBeNull()
  })

  it('"Cancel" and Esc discard the draft; Esc does not close the panel', () => {
    open()
    edit()
    type(codeField(), 'nope')
    fireEvent.click(button('Cancel'))
    expect(inRow().queryByRole('textbox')).toBeNull()
    edit()
    expect(codeField()).toHaveValue(CODE)
    type(nameField(), 'nope.py')
    fireEvent.keyDown(nameField(), { key: 'Escape' })
    expect(inRow().queryByRole('textbox')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(group()).toHaveFocus()
  })

  it('Tab inserts four spaces at the caret; Shift+Tab takes them back; focus stays in the field', () => {
    open()
    edit()
    const code = codeField()
    type(code, 'ab')
    code.setSelectionRange(1, 1)
    expect(fireEvent.keyDown(code, { key: 'Tab' })).toBe(false)
    expect(code.value).toBe('a    b')
    expect([code.selectionStart, code.selectionEnd]).toEqual([5, 5])
    type(code, 'for i in x:\n    print(i)\n')
    code.setSelectionRange(20, 20)
    expect(fireEvent.keyDown(code, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(code.value).toBe('for i in x:\nprint(i)\n')
    expect([code.selectionStart, code.selectionEnd]).toEqual([16, 16])
    // Nothing to take back: still not a way out of the field by accident.
    expect(fireEvent.keyDown(code, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(code.value).toBe('for i in x:\nprint(i)\n')
    // With a modifier the key is left to the system.
    expect(fireEvent.keyDown(code, { key: 'Tab', ctrlKey: true })).toBe(true)
  })

  it('Tab and Shift+Tab move every selected line', () => {
    const el = document.createElement('textarea')
    el.value = 'a\n\nb\nc'
    el.setSelectionRange(0, 4)
    indentSelection(el, false)
    expect(el.value).toBe('    a\n\n    b\nc')
    expect([el.selectionStart, el.selectionEnd]).toEqual([4, 12])
    indentSelection(el, true)
    expect(el.value).toBe('a\n\nb\nc')
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 4])
    el.value = '  a\n\tb\n      c'
    el.setSelectionRange(0, el.value.length)
    indentSelection(el, true)
    expect(el.value).toBe('a\nb\n  c')
  })

  it('the draft is the editor’s own: a remote change does not overwrite what is being typed', () => {
    open()
    edit()
    type(codeField(), 'mine')
    act(() => pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'r1' ? { ...b, text: 'theirs' } : b)) })))
    expect(codeField()).toHaveValue('mine')
  })

  it('works under StrictMode: Done and Cancel still finish', () => {
    openStrict()
    edit()
    type(codeField(), 'print(5)')
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'r1', text: 'print(5)' }])
    edit()
    fireEvent.click(button('Cancel'))
    expect(inRow().queryByRole('textbox')).toBeNull()
  })

  it('claims the soft lock while the editor is open and releases it after', () => {
    vi.useFakeTimers()
    open()
    edit()
    expect(page.startEditing).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Cancel'))
    expect(page.stopEditing).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
  })

  it('someone else starts editing the Page: the editor closes, nothing is submitted', () => {
    open()
    edit()
    type(codeField(), 'half')
    act(() => pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } }))
    expect(inRow().queryByRole('textbox')).toBeNull()
    expect(noButton('Edit')).toBeNull()
    expect(group()).toHaveAttribute('tabindex', '-1')
    expect(submit).not.toHaveBeenCalled()
  })

  it('moves and deletes like any block', () => {
    open()
    fireEvent.click(button('Move block up'))
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'r1', order: '0' }])
    fireEvent.click(button('Delete block'))
    expect(screen.queryByTestId('block-r1')).toBeNull()
    expect(screen.getByText('Deleted 1 block.')).toBeInTheDocument()
  })
})

describe('Runs: adding one', () => {
  it('"+ Add block" → "Run" creates it with the starter in one op and opens the editor', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Text', 'Visual', 'Run'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', type: 'run', title: 'experiment.py', text: RUN_STARTER.source, order: '4' }])
    const id = (lastBatch()[0] as { id: string }).id
    const name = within(row(id)).getByRole('textbox', { name: 'Name' })
    expect(name).toHaveValue('experiment.py')
    expect(name).toHaveFocus()
    expect(within(row(id)).getByRole('textbox', { name: 'Code' })).toHaveValue(RUN_STARTER.source)
  })

  it('the starter is three lines: two of comment, and a print', () => {
    const lines = codeLines(RUN_STARTER.source)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^# A Run: /)
    expect(lines[1]).toMatch(/^# /)
    expect(lines[2]).toBe('print("hello from Infall")')
  })

  it('a new Run left as it is stays on the Page', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block before block 2' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
    const id = (lastBatch()[0] as { id: string }).id
    fireEvent.click(within(row(id)).getByRole('button', { name: 'Cancel' }))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('group', { name: 'Run experiment.py' })).toBeInTheDocument()
  })
})

describe('Runs: the "⋯" menu', () => {
  const more = () => button('More for Run policy_cartpole.py')
  const items = () => screen.getAllByRole('menuitem').map((i) => i.textContent)

  it('is there for Members in the desktop app only', () => {
    open()
    expect(noButton('More for Run policy_cartpole.py')).toBeNull()
    act(() => desktop())
    expect(more()).toHaveAttribute('aria-haspopup', 'menu')
    expect(more()).toHaveAttribute('aria-expanded', 'false')
  })

  it('offers "Runner settings…", and "Clear output" once there is a result', () => {
    desktop()
    open()
    fireEvent.click(more())
    expect(more()).toHaveAttribute('aria-expanded', 'true')
    expect(items()).toEqual(['Runner settings…'])
    expect(screen.getByRole('menuitem', { name: 'Runner settings…' })).toHaveFocus()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Runner settings…' }))
    expect(runs.configure).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(more()).toHaveFocus()
    act(() => setResult(runResult()))
    fireEvent.click(more())
    expect(items()).toEqual(['Runner settings…', 'Clear output'])
  })

  it('arrow keys move; Esc closes the menu, not the panel, and focus returns to "⋯"', () => {
    desktop()
    setResult(runResult())
    open()
    fireEvent.click(more())
    const [first, second] = screen.getAllByRole('menuitem')
    fireEvent.keyDown(first!, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second!, { key: 'ArrowDown' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first!, { key: 'End' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(more()).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('"Clear output" asks first; Cancel changes nothing and focus returns to "⋯"', () => {
    desktop()
    setResult(runResult())
    open()
    fireEvent.click(more())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear output' }))
    const dialog = screen.getByRole('dialog', { name: 'Clear the output of this Run?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveTextContent('The captured output and figures of policy_cartpole.py are removed from the Page for everyone.')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
    expect(more()).toHaveFocus()
    expect(row().querySelector('.qp-run__record')).not.toBeNull()
  })

  it('confirming clears the result: one op, the block reads "Not executed yet.", focus returns', async () => {
    desktop()
    setResult(runResult({ figures: [{ png: PNG }] }))
    open()
    fireEvent.click(more())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear output' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear output' }))
    await flush()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([{ fake: 'setRunResult', block: 'r1', result: null }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(inRow().getByText('Not executed yet.')).toBeInTheDocument()
    expect(inRow().queryByRole('img')).toBeNull()
    expect(more()).toHaveFocus()
  })

  it('Esc in the dialog closes the dialog only', () => {
    desktop()
    setResult(runResult())
    open()
    fireEvent.click(more())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear output' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('Runs: nothing written by people or programs becomes markup', () => {
  const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'

  it('name, code, output, environment, figure data and messages are text; only real base64 becomes an image', () => {
    desktop()
    pageStore.setState({
      blocks: [
        run(
          'r1',
          'a',
          '1',
          EVIL,
          `</code></pre>${EVIL}\nprint("<b>bold</b>")`,
          runResult({
            output: `<iframe src="javascript:alert(1)"></iframe>${EVIL}\u001b[31mred\u001b[0m`,
            figures: [{ png: '"><script>window.__pwned=1</script>' }, { png: 'javascript:alert(1)' }, { png: 'AAAA" onerror="window.__pwned=1' }, { png: PNG }],
            env: { python: '3.12.1<script>x</script>', packages: { '<i>pkg</i>': '<u>1.0</u>' }, os: '<b>os</b>' },
          }),
        ),
      ],
    })
    open()
    act(() => ended('failed', { message: `Python: ${EVIL}` }))
    const r = row()
    expect(r.querySelectorAll('script, iframe, b, i, u, [onerror], [onclick]')).toHaveLength(0)
    const images = r.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]!.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    expect(images[0]!.getAttribute('alt')).toBe(`Figure 4 of Run ${EVIL}`)
    expect(inRow().getByText('3 figures could not be shown.')).toBeInTheDocument()
    expect(r.querySelector('.qp-run__title')!.textContent).toBe(EVIL)
    expect(r.querySelector('.qp-run__lines')!.textContent).toBe(`</code></pre>${EVIL}\nprint("<b>bold</b>")`)
    expect(r.querySelector('.qp-run__text')!.textContent).toContain('<iframe src="javascript:alert(1)"></iframe>')
    expect(r.querySelector('.qp-run__text')!.childNodes).toHaveLength(1)
    expect(r.querySelector('.qp-run__env')!.textContent).toBe('py 3.12 · <i>pkg</i> <u>1.0</u>')
    expect(screen.getByTestId('run-outcome-r1').textContent).toContain(EVIL)
    expect(status().textContent).toContain(EVIL)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()

    // The same strings in the live output, the editor and the confirm dialog.
    act(() => live('running', { startedAt: Date.now(), output: EVIL }))
    expect(r.querySelector('.qp-run__text')!.textContent).toBe(EVIL)
    expect(r.querySelectorAll('script, img')).toHaveLength(0)
    act(() => runsStore.setState({ live: null, last: null }))
    fireEvent.click(button(`More for Run ${EVIL}`))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear output' }))
    expect(screen.getByRole('dialog').querySelectorAll('script, img')).toHaveLength(0)
    expect(screen.getByRole('dialog')).toHaveTextContent(EVIL)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(button('Edit'))
    expect(row().querySelectorAll('script, img')).toHaveLength(0)
    expect(inRow().getByRole('textbox', { name: 'Name' })).toHaveValue(EVIL)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})

describe('Runs: accessibility basics', () => {
  it('controls come in order: header, code, output', () => {
    desktop()
    setResult(runResult())
    const long = Array.from({ length: 30 }, (_, i) => `x${i}`).join('\n')
    pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'r1' ? { ...b, text: long } : b)) }))
    open()
    const stops = [...group().querySelectorAll<HTMLElement>('button, [tabindex="0"]')].map(
      (el) => el.getAttribute('aria-label') ?? el.textContent ?? '',
    )
    expect(stops).toEqual([
      'Edit',
      'More for Run policy_cartpole.py',
      'Run',
      'Code of Run policy_cartpole.py',
      'Show all 30 lines',
      'Output of Run policy_cartpole.py',
    ])
  })

  it('every image has a name, the glyphs are hidden, the status element is the only live region', () => {
    desktop()
    setResult(runResult({ figures: [{ png: PNG }] }))
    open()
    for (const svg of row().querySelectorAll('svg')) expect(svg).toHaveAttribute('aria-hidden', 'true')
    for (const img of row().querySelectorAll('img')) expect(img.getAttribute('alt')).toMatch(/^Figure \d+ of Run /)
    expect([...row().querySelectorAll('[aria-live]')].map((el) => el.getAttribute('aria-live')).sort()).toEqual(['off', 'polite'])
    for (const b of inRow().getAllByRole('button')) expect(b).toHaveAccessibleName()
  })
})
