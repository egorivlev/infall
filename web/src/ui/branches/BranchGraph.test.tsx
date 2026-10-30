// The Branch Graph screen against the real data layer and the fake server (lib/testing.ts).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatWhen, ops } from '../../lib'
import type { Op } from '../../lib'
import { branchesStore } from '../../lib/branches-store'
import { membersStore } from '../../lib/people'
import { sessionStore } from '../../lib/session-store'
import { FakeServer, ME, OTHER } from '../../lib/testing'
import { useHistoryPanel } from '../bridge'
import { useGraphPreview } from '../history/fromGraph'
import { newBranchIntent } from '../shell/newBranchIntent'
import { BranchGraph } from './BranchGraph'
import { graphSelection } from './state'

let server: FakeServer
const base = new Date()
base.setHours(9, 0, 0, 0)
const t = (min: number) => base.getTime() + min * 60_000
const hm = (min: number) => formatWhen(t(min))
const card = (id: string, title: string): Op => ops.createCard({ id, x: 0, y: 0, title })

/**
 * main: Me adds Alpha and Beta (09:00–09:01), Checkpoint Kick-off right after; Other starts exp-A there and adds
 * Gamma (09:20), then Delta and renames Gamma (09:40); Me adds Epsilon on main (10:00) and merges exp-A (10:20);
 * Me starts "empty" from main at that moment and makes no Change on it.
 */
function seed() {
  server.now = t(0)
  server.commit([card('a1', 'Alpha')], ME.id)
  server.now = t(1)
  server.commit([card('a2', 'Beta')], ME.id)
  server.now = t(2)
  server.checkpoint('Kick-off', 2, ME.id)
  server.now = t(3)
  server.fork('exp-A', { branch: 'main-id', seq: 2 }, OTHER.id)
  server.now = t(20)
  server.commit([card('e1', 'Gamma')], OTHER.id, 'exp-A')
  server.now = t(40)
  server.commit([card('e2', 'Delta'), ops.setText('e1', 'title', 'Gamma 2')], OTHER.id, 'exp-A')
  server.now = t(60)
  server.commit([card('m3', 'Epsilon')], ME.id)
  server.now = t(80)
  server.commit([card('e1', 'Gamma 2'), card('e2', 'Delta')], ME.id, 'main', { Merge: { batch: 'b1', source: { branch: 'exp-A-id', seq: 3 } } })
  server.now = t(90)
  server.fork('empty', { branch: 'main-id', seq: 4 }, ME.id)
  branchesStore.setState({ branches: server.all.map((b) => server.info(b)) })
}

const list = () => screen.getByRole('listbox', { name: 'Branch Graph' })
const options = () => within(list()).getAllByRole('option')
const option = (name: RegExp | string) => within(list()).getByRole('option', { name })
const field = () => screen.getByRole('textbox', { name: 'New Branch' })
const detail = () => screen.getByTestId('graph-detail')
const label = (name: string) => screen.getByText(name, { selector: '.qg-label__name' }).closest('.qg-label') as HTMLElement
const posts = (path: string) => server.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body)

async function show(current = 'main') {
  const view = render(<BranchGraph current={current} />)
  await waitFor(() => expect(options().length).toBeGreaterThan(0))
  return view
}
/** Waits until the words of the rows on screen have arrived. */
const words = () => waitFor(() => expect(option(/^main, Me, .*, Merged exp-A into main/)).toBeInTheDocument())

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  window.history.replaceState(null, '', '/branches')
  act(() => {
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    membersStore.setState({ members: [ME, OTHER] })
    branchesStore.setState({ branches: [] })
  })
  seed()
})

afterEach(() => {
  cleanup()
  act(() => {
    graphSelection.clear()
    newBranchIntent.clear()
    useGraphPreview.setState({ current: null })
    useHistoryPanel.setState({ open: false })
    sessionStore.setState({ status: 'signed_out' }, true)
  })
  vi.unstubAllGlobals()
})

describe('the graph', () => {
  it('draws every Branch from the first Change: one row per Activity, newest first, and the start', async () => {
    await show()
    expect(screen.getByRole('heading', { level: 1, name: 'Branches' })).toBeInTheDocument()
    expect(screen.getByText('3 Branches')).toBeInTheDocument()
    await words()
    expect(options().map((o) => o.getAttribute('aria-label'))).toEqual([
      `main, Me, ${hm(80)}, Merged exp-A into main`,
      `empty, the start, no Changes yet`,
      `main, Me, ${hm(60)}, Added Card Epsilon`,
      `exp-A, Other, ${hm(40)}, Added Card Delta`,
      `exp-A, Other, ${hm(20)}, Added Card Gamma`,
      `main, Me, ${hm(1)}, Added Card Alpha, Checkpoint Kick-off`,
      'main, before the first Change',
    ])
    // Rows of the Activities say who, when and the first line, "+N" for more; ◆ on the dot it ends.
    const delta = option(/^exp-A, Other, .*Delta/)
    expect(delta).toHaveTextContent(`Other${hm(40)}Added Card Delta+1`)
    expect(delta).toHaveAttribute('aria-setsize', '6')
    expect(option(/Kick-off/)).toHaveTextContent('◆ Kick-off')
  })

  it('labels each Branch at the top end of its line: who started it and when, Open, and the Merges it can take part in', async () => {
    await show('exp-A')
    const main = within(label('main'))
    expect(main.getByText('default Branch')).toBeInTheDocument()
    expect(main.getAllByRole('link').map((a) => a.textContent)).toEqual(['Open'])
    const exp = within(label('exp-A'))
    expect(exp.getByText('open')).toBeInTheDocument() // the Branch the Board has open
    expect(exp.getByText(`from main · Other · ${hm(3)}`)).toBeInTheDocument()
    expect(exp.getByRole('link', { name: 'Merge exp-A into main…' })).toHaveAttribute('href', '/merge?from=exp-A&into=main')
    expect(exp.getByRole('link', { name: 'Update exp-A from main…' })).toHaveAttribute('href', '/merge?from=main&into=exp-A')
    expect(exp.getByRole('link', { name: 'Open exp-A' })).toHaveAttribute('href', '/b/exp-A')
    expect(exp.getByRole('link', { name: 'Merge exp-A into main…' })).toHaveAttribute('data-tour', 'merge-into:exp-A')
    expect(within(label('empty')).getByText(`from main · Me · ${hm(90)}`)).toBeInTheDocument()
  })

  it('fills in words only for rows in view, never changing a row’s height', async () => {
    await show()
    const top = options()[0]!
    const height = top.style.height
    expect(top.querySelector('.qg-row__wait')).not.toBeNull() // a quiet placeholder until the words arrive
    await words()
    expect(top.querySelector('.qg-row__wait')).toBeNull()
    expect(top.style.height).toBe(height)
    // One Board and one range of Changes per Branch with rows in view.
    const gets = server.requests.filter((r) => r.method === 'GET' && /\/(board\?at=|changes\?)/.test(r.path)).map((r) => r.path)
    expect(gets.filter((p) => p.includes('/main-id/'))).toHaveLength(2)
    expect(gets.filter((p) => p.includes('/exp-A-id/'))).toHaveLength(2)
  })

  it('has only the rows in view in the document when the history is long', async () => {
    for (let i = 0; i < 400; i++) {
      server.now = t(100 + i * 11) // a pause over ten minutes: one Activity each
      server.commit([card(`n${i}`, `Card ${i}`)], i % 2 ? ME.id : OTHER.id)
    }
    await show()
    const rows = options()
    expect(rows.length).toBeLessThan(80)
    expect(rows[0]).toHaveAttribute('aria-setsize', '406')
    expect(rows[0]).toHaveAttribute('aria-posinset', '1')
  })

  it('shows a new Branch when the Branch list changes (the `branches` frame)', async () => {
    await show()
    server.now = t(95)
    server.fork('later', { branch: 'main-id', seq: 5 }, OTHER.id)
    act(() => branchesStore.setState({ branches: server.all.map((b) => server.info(b)) }))
    await waitFor(() => expect(label('later')).toBeInTheDocument())
    expect(screen.getByText('4 Branches')).toBeInTheDocument()
  })

  it('says so when the graph cannot be loaded, and tries again', async () => {
    server.failGraph = 1
    render(<BranchGraph current="main" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The Branch Graph could not be loaded.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(options().length).toBe(7))
  })
})

describe('starting a Branch', () => {
  it('from now on the open Branch: a name and Enter, then it is opened', async () => {
    await show()
    expect(screen.getByText('Starts from now on main')).toBeInTheDocument()
    await userEvent.type(field(), '  decoder rewrite/v2 {Enter}')
    await waitFor(() => expect(window.location.pathname).toBe('/b/decoder%20rewrite%2Fv2'))
    expect(posts('/api/branches')).toEqual([{ name: 'decoder rewrite/v2', from: { branch: 'main-id', seq: 5 } }])
  })

  it('"New Branch…" from the switcher: the newest dot of the open Branch selected, the cursor in the field', async () => {
    newBranchIntent.request()
    await show('exp-A')
    await waitFor(() => expect(field()).toHaveFocus())
    await waitFor(() => expect(option(new RegExp(`^exp-A, Other, ${hm(40)}`))).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByText('Starts from now on exp-A')).toBeInTheDocument()
    expect(within(detail()).getByText('exp-A')).toBeInTheDocument()
  })

  it('from a dot on a Branch that is not open: clicking it while naming moves the start, and the cursor stays', async () => {
    await show()
    await words()
    await userEvent.click(field())
    await userEvent.keyboard('fit')
    await userEvent.click(option(/^exp-A, Other, .*Gamma/))
    expect(field()).toHaveFocus()
    expect(screen.getByText(`Starts from Other's work at ${hm(20)} on exp-A`)).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(window.location.pathname).toBe('/b/fit'))
    expect(posts('/api/branches')).toEqual([{ name: 'fit', from: { branch: 'exp-A-id', seq: 1 } }])
  })

  it('from a Checkpoint: its ◆, or the ◆ in the detail', async () => {
    await show()
    await words()
    await userEvent.click(within(option(/Kick-off/)).getByText('Kick-off'))
    expect(screen.getByText('Starts from Checkpoint Kick-off on main')).toBeInTheDocument()
    const cp = within(detail()).getByRole('button', { name: 'Checkpoint Kick-off' })
    expect(cp).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(cp)
    expect(screen.getByText(`Starts from your work at ${hm(1)} on main`)).toBeInTheDocument()
    await userEvent.click(cp)
    expect(screen.getByText('Starts from Checkpoint Kick-off on main')).toBeInTheDocument()
    await userEvent.type(field(), 'from-kickoff{Enter}')
    await waitFor(() => expect(posts('/api/branches')).toEqual([{ name: 'from-kickoff', from: { branch: 'main-id', seq: 2 } }]))
  })

  it('from a Branch with no Changes: its fork point', async () => {
    await show()
    await userEvent.click(option('empty, the start, no Changes yet'))
    expect(screen.getByText('Starts from now on empty')).toBeInTheDocument()
    expect(detail()).toHaveTextContent('The start of empty')
    expect(detail()).toHaveTextContent('No Changes yet.')
    await userEvent.type(field(), 'next{Enter}')
    await waitFor(() => expect(posts('/api/branches')).toEqual([{ name: 'next', from: { branch: 'empty-id', seq: 0 } }]))
  })

  it('"New Branch from here" puts the cursor in the field with that dot chosen', async () => {
    await show()
    await userEvent.click(option(new RegExp(`^main, Me, ${hm(60)}`)))
    await userEvent.click(within(detail()).getByRole('button', { name: 'New Branch from here' }))
    expect(field()).toHaveFocus()
    expect(screen.getByText(`Starts from your work at ${hm(60)} on main`)).toBeInTheDocument()
  })

  it('shows errors at the field: no name, too long, name taken', async () => {
    await show()
    await userEvent.click(screen.getByRole('button', { name: 'Create Branch and switch to it' }))
    expect(screen.getByText('Give the Branch a name.')).toBeInTheDocument()
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    await userEvent.type(field(), 'x'.repeat(61) + '{Enter}')
    expect(screen.getByText('Use 60 characters or fewer.')).toBeInTheDocument()
    await userEvent.clear(field())
    await userEvent.type(field(), 'exp-A{Enter}')
    expect(await screen.findByText('A Branch with that name already exists.')).toBeInTheDocument()
    expect(field()).toHaveAccessibleDescription('Starts from now on main A Branch with that name already exists.')
    expect(field()).toHaveFocus()
    expect(window.location.pathname).toBe('/branches')
    await userEvent.type(field(), '-2')
    expect(screen.queryByText('A Branch with that name already exists.')).toBeNull()
  })
})

describe('a selected dot', () => {
  it('shows all its lines, its Branch, who, when and how many Changes', async () => {
    await show()
    await words()
    await userEvent.click(option(/^exp-A, Other, .*Delta/))
    const d = within(detail())
    expect(d.getByText('exp-A')).toBeInTheDocument()
    expect(d.getByText('Other')).toBeInTheDocument()
    expect(d.getByText('2 Changes in this Activity')).toBeInTheDocument()
    expect(d.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Added Card Delta', 'Renamed Card Gamma → Gamma 2'])
  })

  it('a Merge names where it came from and can show that moment', async () => {
    await show()
    await words()
    await userEvent.click(option(/Merged exp-A into main/))
    const d = within(detail())
    expect(d.getByText('Merge')).toBeInTheDocument()
    expect(detail()).toHaveTextContent(`Brought in exp-A as it was at ${hm(40)}.`)
    await userEvent.click(d.getByRole('button', { name: 'Show that moment' }))
    expect(option(/^exp-A, Other, .*Delta/)).toHaveAttribute('aria-selected', 'true')
  })

  it('"Show every Change": each Change in plain words with its time, as many as it says', async () => {
    await show()
    await words()
    await userEvent.click(option(/^exp-A, Other, .*Delta/))
    await userEvent.click(within(detail()).getByRole('button', { name: 'Show every Change' }))
    const all = await screen.findByRole('region', { name: 'Every Change' })
    await waitFor(() => expect(within(all).getAllByRole('listitem')).toHaveLength(2))
    expect(within(all).getByText('2 Changes')).toBeInTheDocument()
    expect(within(all).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `${hm(40)}OtherAdded Card Delta`,
      `${hm(40)}OtherRenamed Card Gamma → Gamma 2`,
    ])
  })

  it('"Add Checkpoint here": a name, and the dot gets its ◆', async () => {
    await show()
    await words()
    await userEvent.click(option(/^exp-A, Other, .*Gamma$/))
    await userEvent.click(within(detail()).getByRole('button', { name: 'Add Checkpoint here' }))
    const name = within(detail()).getByRole('textbox', { name: 'Checkpoint name' })
    expect(name).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(within(detail()).getByText('Give the Checkpoint a name.')).toBeInTheDocument()
    await userEvent.keyboard('first look{Enter}')
    await waitFor(() => expect(option(/Checkpoint first look/)).toHaveAttribute('aria-selected', 'true'))
    expect(posts('/api/branches/exp-A-id/checkpoints')).toEqual([{ name: 'first look', seq: 1 }])
    expect(within(detail()).getByRole('button', { name: 'Checkpoint first look' })).toBeInTheDocument()
    expect(within(detail()).queryByRole('textbox', { name: 'Checkpoint name' })).toBeNull()
  })

  it('"Add Checkpoint here" says when the name is taken', async () => {
    await show()
    await userEvent.click(option(/Kick-off/))
    await userEvent.click(within(detail()).getByRole('button', { name: 'Add Checkpoint here' }))
    await userEvent.keyboard('Kick-off{Enter}')
    expect(await within(detail()).findByText('This Branch already has a Checkpoint with that name.')).toBeInTheDocument()
  })

  it('"Preview the Board" opens that Branch with History at that moment, and asks to come back here', async () => {
    await show()
    await userEvent.click(option(new RegExp(`^exp-A, Other, ${hm(20)}`)))
    await userEvent.click(within(detail()).getByRole('button', { name: 'Preview the Board' }))
    expect(window.location.pathname).toBe('/b/exp-A')
    expect(useHistoryPanel.getState().open).toBe(true)
    expect(useGraphPreview.getState().current).toMatchObject({ branch: 'exp-A', branchId: 'exp-A-id', seq: 1, back: '/branches', phase: 'opening' })
  })
})

describe('the keyboard', () => {
  it('↑/↓ rows, ←/→ the neighbouring line, Enter the actions, N the name field, Esc out of the field and then the selection', async () => {
    await show()
    const box = list()
    act(() => box.focus())
    await userEvent.keyboard('{ArrowDown}') // nothing selected yet: now on the open Branch
    const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected()?.getAttribute('aria-label')).toMatch(/^main, Me, .*/)
    expect(box).toHaveAttribute('aria-activedescendant', selected()!.id)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(selected()?.getAttribute('aria-label')).toMatch(/^exp-A, Other/)
    await userEvent.keyboard('{ArrowRight}')
    expect(selected()?.getAttribute('aria-label')).toBe('empty, the start, no Changes yet')
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(selected()?.getAttribute('aria-label')).toMatch(/^main, Me/)
    await userEvent.keyboard('{End}')
    expect(selected()?.getAttribute('aria-label')).toBe('main, before the first Change')
    await userEvent.keyboard('{Home}')
    expect(selected()?.getAttribute('aria-label')).toMatch(new RegExp(`^main, Me, ${hm(80)}`))

    await userEvent.keyboard('{Enter}')
    expect(within(detail()).getByRole('button', { name: 'New Branch from here' })).toHaveFocus()

    act(() => box.focus())
    await userEvent.keyboard('n')
    expect(field()).toHaveFocus()
    expect(field()).toHaveValue('') // the key moved the cursor; it typed nothing
    await userEvent.keyboard('{Escape}')
    expect(box).toHaveFocus()
    expect(selected()).toBeDefined()
    await userEvent.keyboard('{Escape}')
    expect(selected()).toBeUndefined()
    expect(screen.getByText('Starts from now on main')).toBeInTheDocument()
  })

  it('in the detail the keyboard keeps its place: a ◆ chosen, a Checkpoint added; Esc goes back to the graph', async () => {
    await show()
    const box = list()
    act(() => box.focus())
    await userEvent.keyboard('{End}{ArrowUp}{Enter}')
    expect(within(detail()).getByRole('button', { name: 'New Branch from here' })).toHaveFocus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    const cp = within(detail()).getByRole('button', { name: 'Checkpoint Kick-off' })
    expect(cp).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByText('Starts from Checkpoint Kick-off on main')).toBeInTheDocument()
    expect(cp).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(box).toHaveFocus()
    expect(option(/Kick-off/)).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}{Tab}{Tab}')
    const add = within(detail()).getByRole('button', { name: 'Add Checkpoint here' })
    expect(add).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(within(detail()).getByRole('textbox', { name: 'Checkpoint name' })).toHaveFocus()
    await userEvent.keyboard('{Escape}') // closes the field, not the detail
    expect(add).toHaveFocus()
    await userEvent.keyboard('{Enter}second{Enter}')
    await waitFor(() => expect(within(detail()).getByRole('button', { name: 'Checkpoint second' })).toBeInTheDocument())
    expect(within(detail()).getByRole('button', { name: 'Add Checkpoint here' })).toHaveFocus()
  })

  it('gives the graph one place in the tab order; the labels’ actions and the detail come after it', async () => {
    await show()
    fireEvent.focus(list())
    expect(list()).toHaveAttribute('tabindex', '0')
    for (const o of options()) expect(o).not.toHaveAttribute('tabindex')
  })
})
