// The Runner monitor against the real sync layer: a fake server behind the Board, the lib's fake desktop app
// (`fakeDesktop`, `fakeRunner`) on the page, and Runs started through `runs.run` as the Run block does.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board, ops, runs } from '../../../lib'
import { sessionStore } from '../../../lib/session-store'
import { FakeServer, FakeSocket, GUEST, ME, fakeDesktop, fakeRunner, installDesktop, settle } from '../../../lib/testing'
import type { FakeExecution, FakeRunner } from '../../../lib/testing'
import { pagePanel, usePagePanel } from '../../bridge'
import { TopBar } from '../TopBar'
import { NO_USAGE_AFTER_MS, RunMonitor } from './RunMonitor'

const GB = 1024 ** 3

let server: FakeServer
let runner: FakeRunner
let uninstall: () => void = () => {}

/** Does something to the lib from outside React, and lets everything it sets off land. */
async function go(fn: () => void = () => {}) {
  await act(async () => {
    fn()
    await settle()
  })
}

/** The Board open on main, where the Card "Threshold" holds the Run `r1` ("Sweep"). */
async function openBoard() {
  await board.open('main')
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.find('main').info.id, seq: server.find('main').log.length })
  await settle()
}

/** The desktop app on the page, with its Runner. */
async function inApp() {
  uninstall = installDesktop(fakeDesktop({ runner }))
  await runs.refresh()
}

/** Starts `r1`; the fake Runner holds it at the approval until told otherwise. */
async function start(id = 'r1'): Promise<FakeExecution> {
  await go(() => void runs.run(id).catch(() => {}))
  return runner.last()
}

const trigger = () => screen.getByRole('button', { name: /^Run / })
const noTrigger = () => expect(screen.queryByRole('button', { name: /^Run / })).toBeNull()
const popover = () => screen.getByRole('dialog', { name: 'Runner monitor' })
const noPopover = () => expect(screen.queryByRole('dialog', { name: 'Runner monitor' })).toBeNull()
/** The value beside a label in the popover. */
const row = (label: string) => {
  const term = within(popover()).getByText(label, { selector: 'dt' })
  return term.nextElementSibling as HTMLElement
}
const noRow = (label: string) => expect(within(popover()).queryByText(label, { selector: 'dt' })).toBeNull()

beforeEach(async () => {
  server = new FakeServer()
  server.commit(
    [
      ops.createCard({ id: 'a', x: 0, y: 0, title: 'Threshold' }),
      ops.addBlock({ id: 'k1', card: 'a', text: 'Notes', order: 'G' }),
      ops.addBlock({ id: 'r1', card: 'a', type: 'run', text: 'print(1)\n', title: 'Sweep', order: 'V' }),
      ops.addBlock({ id: 'r2', card: 'a', type: 'run', text: 'print(2)\n', order: 'k' }),
    ],
    ME.id,
  )
  FakeSocket.all = []
  runner = fakeRunner()
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  window.history.replaceState(null, '', '/')
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  await openBoard()
})

afterEach(async () => {
  cleanup()
  // Signing out lets go of whatever is still in flight.
  sessionStore.setState({ status: 'signed_out' }, true)
  await settle()
  board.close()
  uninstall()
  uninstall = () => {}
  pagePanel.close()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('when it is there', () => {
  it('is absent while nothing runs', async () => {
    await inApp()
    const { container } = render(<RunMonitor />)
    await go()
    expect(container).toBeEmptyDOMElement()
  })

  it('is absent in the browser: there is no Runner to start anything', async () => {
    const { container } = render(<RunMonitor />)
    await go(() => void runs.run('r1').catch(() => {}))
    expect(container).toBeEmptyDOMElement()
    expect(runner.executions).toHaveLength(0)
  })

  it('is absent for a Guest, in the app too', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await inApp()
    const { container } = render(<RunMonitor />)
    await go(() => void runs.run('r1').catch(() => {}))
    expect(container).toBeEmptyDOMElement()
  })

  it('appears at the approval, saying it waits, with no time', async () => {
    await inApp()
    render(<RunMonitor />)
    await start()
    expect(trigger()).toHaveAccessibleName('Run Sweep: waiting for you')
    expect(trigger()).toHaveTextContent('Sweep')
    expect(trigger()).toHaveTextContent('Waiting for you…')
    expect(trigger()).not.toHaveTextContent(/\d:\d\d/)
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    noPopover()
  })

  it('shows the running time once started, and goes when the Run has ended', async () => {
    await inApp()
    render(<RunMonitor />)
    const x = await start()
    await go(() => x.start())
    expect(trigger()).toHaveAccessibleName('Run Sweep: running')
    expect(trigger()).toHaveTextContent('0:00')
    expect(trigger()).not.toHaveTextContent('Waiting')
    await go(() => x.done())
    noTrigger()
  })

  it('goes when the Member declines in the app', async () => {
    await inApp()
    render(<RunMonitor />)
    const x = await start()
    await go(() => x.error('declined'))
    noTrigger()
  })

  it('names a Run without a title', async () => {
    await inApp()
    render(<RunMonitor />)
    await start('r2')
    expect(trigger()).toHaveAccessibleName('Run Untitled Run: waiting for you')
  })

  it('sits in the top bar for a Member, and not for a Guest', async () => {
    await inApp()
    const { unmount } = render(<TopBar member={ME} branch="main" available />)
    await start()
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Run Sweep: waiting for you' })).toBeInTheDocument()
    unmount()
    render(<TopBar member={GUEST} branch="main" available />)
    await go()
    noTrigger()
  })
})

describe('the popover', () => {
  /** `r1` running, the popover open. */
  async function opened() {
    await inApp()
    render(<RunMonitor />)
    const x = await start()
    await go(() => x.start())
    fireEvent.click(trigger())
    return x
  }

  it('is a labelled region that takes focus, with the Run and its Card', async () => {
    await opened()
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(trigger()).toHaveAttribute('aria-controls', popover().id)
    expect(popover()).toHaveFocus()
    expect(within(popover()).getByText('Sweep')).toBeInTheDocument()
    expect(within(popover()).getByRole('button', { name: /Threshold/ })).toBeInTheDocument()
    expect(row('Now')).toHaveTextContent('Running')
    expect(row('Running')).toHaveTextContent('0:00')
  })

  it('at the approval says where to look, and has nothing to measure or stop', async () => {
    await inApp()
    render(<RunMonitor />)
    await start()
    fireEvent.click(trigger())
    expect(row('Now')).toHaveTextContent("Waiting for you in the Runner's window")
    for (const label of ['Progress', 'Processor', 'Memory', 'Graphics', 'Running', 'Left']) noRow(label)
    expect(within(popover()).queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows what the Run takes: processor, memory with its peak, graphics', async () => {
    const x = await opened()
    await go(() => x.stats({ cpu_percent: 182, cores: 10, memory_bytes: 1.4 * GB, memory_total_bytes: 24 * GB, gpu: { percent: 76, name: 'Apple M2 Pro' } }))
    await go(() => x.stats({ cpu_percent: 182, cores: 10, memory_bytes: 1.2 * GB, memory_total_bytes: 24 * GB, gpu: { percent: 76, name: 'Apple M2 Pro' } }))
    expect(row('Processor')).toHaveTextContent('182 % · 1.8 of 10 cores')
    expect(row('Memory')).toHaveTextContent('1.2 GB of 24 GB · peak 1.4 GB')
    expect(row('Graphics')).toHaveTextContent('76 % · whole computer · Apple M2 Pro')

    const processor = within(popover()).getByRole('meter', { name: 'Processor' })
    expect(processor).toHaveAttribute('aria-valuenow', '18')
    expect(processor).toHaveAttribute('aria-valuetext', '182 % · 1.8 of 10 cores')
    const memory = within(popover()).getByRole('meter', { name: 'Memory' })
    expect(memory).toHaveAttribute('aria-valuenow', '5')
    expect(memory).toHaveAttribute('aria-valuetext', '1.2 GB of 24 GB')
    expect(memory).not.toHaveClass('is-warn')
    expect(within(popover()).getByRole('meter', { name: 'Graphics' })).toHaveAttribute('aria-valuetext', '76 %, whole computer')
  })

  it('says when the graphics processor is not reported', async () => {
    const x = await opened()
    await go(() => x.stats())
    expect(row('Graphics')).toHaveTextContent('Not reported on this computer')
    expect(within(popover()).queryByRole('meter', { name: 'Graphics' })).toBeNull()
  })

  it('turns the memory meter to the warning at 90 %, in words too', async () => {
    const x = await opened()
    await go(() => x.stats({ memory_bytes: 21.6 * GB, memory_total_bytes: 24 * GB }))
    const memory = within(popover()).getByRole('meter', { name: 'Memory' })
    expect(memory).toHaveClass('is-warn')
    expect(memory).toHaveAttribute('aria-valuetext', '21.6 GB of 24 GB, nearly full')
  })

  it('shows the step the code reports as what happens now', async () => {
    const x = await opened()
    await go(() => x.stats({ step: 'thermalising' }))
    expect(row('Now')).toHaveTextContent('thermalising')
    await go(() => x.stats())
    expect(row('Now')).toHaveTextContent('Running')
  })

  it('without progress says there is no estimate, and how the code could give one', async () => {
    const x = await opened()
    await go(() => x.stats())
    noRow('Progress')
    expect(row('Left')).toHaveTextContent('No estimate — the code reports no progress')
    expect(within(row('Left')).getByText('qoop.progress(done, total)')).toBeInTheDocument()
    expect(trigger().querySelector('.q-mon__line')).toBeNull()
  })

  it('announces nothing as the numbers change', async () => {
    const x = await opened()
    await go(() => x.stats({ step: 'sweep', progress: { done: 1, total: 4 } }))
    expect(document.querySelector('[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"]')).toBeNull()
  })

  it('Stop asks the Runner to stop this Run', async () => {
    const x = await opened()
    runner.cancelStops = false // an app that takes its time: the Run stays in flight
    const stop = within(popover()).getByRole('button', { name: 'Stop' })
    fireEvent.click(stop)
    await go()
    expect(runner.cancelled).toEqual([x.request.id])
    expect(popover()).toBeInTheDocument()
  })

  it('Esc closes it and gives focus back to the button', async () => {
    const user = userEvent.setup()
    await inApp()
    render(<RunMonitor />)
    const x = await start()
    await go(() => x.start())
    await user.click(trigger())
    expect(popover()).toHaveFocus()
    await user.keyboard('{Escape}')
    noPopover()
    expect(trigger()).toHaveFocus()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  it('a press outside closes it; pressing the button again closes it too', async () => {
    const user = userEvent.setup()
    await opened()
    await user.click(document.body)
    noPopover()
    await user.click(trigger())
    expect(popover()).toBeInTheDocument()
    await user.click(trigger())
    noPopover()
  })

  it('stays open, where it was, while samples arrive', async () => {
    const x = await opened()
    const pop = popover()
    await go(() => x.stats({ memory_bytes: 1 * GB }))
    await go(() => x.stats({ memory_bytes: 2 * GB }))
    expect(popover()).toBe(pop)
    expect(pop).toHaveFocus()
  })

  it('the Card button opens the Page of that Card, closes the popover and brings the Run into view', async () => {
    await opened()
    // The Run as the Page panel renders it.
    const block = document.createElement('div')
    block.setAttribute('data-block', 'r1')
    const view = document.createElement('div')
    view.className = 'qp-run'
    view.tabIndex = -1
    const scrolled = vi.fn()
    block.scrollIntoView = scrolled
    block.append(view)
    document.body.append(block)

    fireEvent.click(within(popover()).getByRole('button', { name: /Threshold/ }))
    expect(usePagePanel.getState().cardId).toBe('a')
    noPopover()
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(view).toHaveFocus()
  })

  it('has no Card button once the Run is gone from its Page', async () => {
    await opened()
    await go(() => void board.submit([ops.remove('r1')]))
    expect(within(popover()).queryByRole('button', { name: /Threshold/ })).toBeNull()
    expect(within(popover()).getByText('No longer on its Page')).toBeInTheDocument()
    // The name it had is kept.
    expect(trigger()).toHaveAccessibleName('Run Sweep: running')
  })
})

describe('over time', () => {
  /** `r1` running with the clock in the test's hands, the popover open. */
  async function opened() {
    await inApp()
    render(<RunMonitor />)
    const x = await start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    await go(() => x.start())
    fireEvent.click(trigger())
    return x
  }
  const pass = (ms: number) => go(() => vi.advanceTimersByTime(ms))

  it('ticks the running time in the button and in the popover', async () => {
    await opened()
    await pass(42_000)
    expect(trigger()).toHaveTextContent('0:42')
    expect(row('Running')).toHaveTextContent('0:42')
    expect(within(popover()).getByRole('timer', { name: 'Running for' })).toHaveTextContent('0:42')
  })

  it('shows the progress with "estimating…" until the rate is known, then about how long is left', async () => {
    const x = await opened()
    await pass(1000)
    await go(() => x.stats({ progress: { done: 10, total: 100 } }))
    expect(row('Progress')).toHaveTextContent('10 of 100 · estimating…')
    expect(row('Left')).toHaveTextContent('estimating…')
    const bar = within(popover()).getByRole('progressbar', { name: 'Progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '10')
    expect(bar).toHaveAttribute('aria-valuetext', '10 of 100, estimating…')
    expect(trigger().querySelector('.q-mon__line')).not.toBeNull()

    // 2 more in 4 s; 88 to go at that rate: 176 s
    await pass(4000)
    await go(() => x.stats({ progress: { done: 12, total: 100 } }))
    expect(row('Progress')).toHaveTextContent('12 of 100 · about 3 min left')
    expect(row('Left')).toHaveTextContent('about 3 min')
    expect(within(popover()).getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuetext', '12 of 100, about 3 min left')
  })

  it('says it is finishing when everything is counted', async () => {
    const x = await opened()
    await pass(5000)
    await go(() => x.stats({ progress: { done: 100, total: 100 } }))
    expect(row('Progress')).toHaveTextContent('100 of 100 · finishing…')
    expect(row('Left')).toHaveTextContent('finishing…')
  })

  it('waits for the first sample, and after 10 s without one says only that there are no numbers yet', async () => {
    await opened()
    const usage = ['Processor', 'Memory', 'Graphics']
    for (const label of usage) expect(row(label)).toHaveTextContent('Measuring…')
    await pass(NO_USAGE_AFTER_MS - 1)
    for (const label of usage) expect(row(label)).toHaveTextContent('Measuring…')
    await pass(1)
    // The same rows, so nothing moves; and nothing is claimed about the app.
    for (const label of usage) expect(row(label)).toHaveTextContent('No numbers yet')
    expect(popover()).not.toHaveTextContent(/does not report/)
    noRow('Left')
    expect(row('Now')).toHaveTextContent('Running')
    expect(row('Running')).toHaveTextContent('0:10')
    expect(within(popover()).getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('shows a first sample that comes late, and says nothing more about missing numbers', async () => {
    const x = await opened()
    await pass(NO_USAGE_AFTER_MS + 5000)
    expect(row('Processor')).toHaveTextContent('No numbers yet')
    await go(() => x.stats())
    expect(popover()).not.toHaveTextContent('No numbers yet')
    expect(row('Processor')).toHaveTextContent('96 % · 1.0 of 10 cores')
    expect(row('Left')).toBeInTheDocument()
  })

  it('never says so when samples arrive in time', async () => {
    const x = await opened()
    await pass(900)
    await go(() => x.stats())
    await pass(NO_USAGE_AFTER_MS * 3)
    expect(popover()).not.toHaveTextContent('No numbers yet')
    expect(row('Processor')).toHaveTextContent('96 % · 1.0 of 10 cores')
  })

  it('keeps the last numbers and stops the time while the result is recorded', async () => {
    const x = await opened()
    await pass(5000)
    await go(() => x.stats({ memory_bytes: 2 * GB }))
    // The server takes its time with the result.
    let release = () => {}
    const held = new Promise<void>((r) => (release = r))
    const fetchNow = server.fetch
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetchNow>) => {
      await held
      return fetchNow(...args)
    })
    await go(() => x.done())
    expect(trigger()).toHaveAccessibleName('Run Sweep: recording the result')
    expect(row('Now')).toHaveTextContent('Recording the result…')
    expect(row('Memory')).toHaveTextContent('2 GB of 16 GB')
    expect(within(popover()).getByRole('button', { name: 'Stop' })).toBeDisabled()
    await pass(7000)
    expect(row('Running')).toHaveTextContent('0:05')
    await go(release)
    noTrigger()
  })
})
