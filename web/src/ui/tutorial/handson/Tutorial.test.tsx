import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Kit } from './testkit'

const h = vi.hoisted(() => ({ kit: null as unknown as Kit }))
vi.mock('../../../lib', async () => {
  const { makeKit } = await import('./testkit')
  h.kit = makeKit()
  return h.kit.module
})

import { historyPanel, pagePanel, searchUse } from '../../bridge'
import { SAMPLE } from './names'
import { handsOn, SAVE_MS, useHandsOn } from './store'
import { block, BRANCHES, card } from './testkit'
import { Tutorial, TutorialProgress } from './Tutorial'
import { MISSING_AFTER_MS } from './watch'

const kit = () => h.kit
const CONTROLS = ['board', 'add', 'search', 'todos', 'suggestions', 'branches', 'checkpoint', 'history', 'branch', 'ai', 'account']

/** A stand-in for the shell: the controls the steps point at, the rail with the progress, and the Tutorial. */
function Screen() {
  return (
    <>
      {CONTROLS.map((name) => (
        <button key={name} type="button" data-tour={name}>
          {name}
        </button>
      ))}
      <div data-tour="page">
        <iframe className="qp-vframe__frame" title="Visual: A walk" />
      </div>
      <aside aria-label="rail">
        <TutorialProgress />
      </aside>
      <Tutorial />
    </>
  )
}

const showing = () => useHandsOn.getState().step
const dialog = () => document.querySelector<HTMLElement>('[data-tutorial="step"]')
const title = () => dialog()?.querySelector('h3')?.textContent
const press = (name: string) => userEvent.click(within(dialog()!).getByRole('button', { name }))
const lastSaved = () => kit().saved.at(-1) as { status: string; step: string; results: Record<string, string>; card?: string } | undefined

async function open(at?: string, results: Record<string, string> = {}) {
  if (at) kit().stored = { v: 1, status: 'running', step: at, results }
  render(<Screen />)
  await waitFor(() => expect(useHandsOn.getState().phase).toBe('running'))
}

/** Every step from the first up to `id`, each skipped. */
async function skipTo(id: string) {
  while (showing() !== id) await act(async () => handsOn.skip())
}

beforeEach(() => {
  kit().reset()
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  pagePanel.close()
  historyPanel.close()
  vi.useRealTimers()
  delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
})

describe('starting and keeping its place', () => {
  it('starts by itself at step 1 the first time, and keeps that on the server', async () => {
    await open()
    expect(title()).toBe('The Board')
    expect(screen.getByText('Tutorial, step 1 of 18')).toBeInTheDocument()
    expect(dialog()).toHaveFocus()
    expect(lastSaved()).toEqual({ v: 1, status: 'running', step: 'look', results: {} })
  })

  it('carries on where it was', async () => {
    await open('checkpoint', { look: 'done', card: 'skipped' })
    expect(title()).toBe('A Checkpoint')
    expect(screen.getByLabelText('Step 13 of 18')).toBeInTheDocument()
  })

  describe('progress saved before Undo was a step (seventeen steps)', () => {
    // Exactly what the Tutorial of seventeen steps wrote: steps by id, no 'undo' anywhere.
    const before = { v: 1, status: 'running', step: 'page', results: { look: 'done', card: 'done' }, card: 'new' }

    it('loads, and carries on at the very step it was on, with what was done and the Card made', async () => {
      kit().stored = before
      render(<Screen />)
      await waitFor(() => expect(useHandsOn.getState().phase).toBe('running'))
      expect(title()).toBe('Its Page')
      expect(screen.getByLabelText('Step 4 of 18')).toBeInTheDocument()
      expect(useHandsOn.getState()).toMatchObject({ step: 'page', results: { look: 'done', card: 'done' }, card: 'new' })
      expect(kit().saved).toEqual([]) // loading writes nothing back
    })

    it('shows Undo as still to do, and it can be gone back to', async () => {
      kit().stored = before
      render(<Screen />)
      await waitFor(() => expect(useHandsOn.getState().phase).toBe('running'))
      const rail = screen.getByRole('complementary', { name: 'rail' })
      await userEvent.click(within(rail).getByRole('button', { name: 'All steps' }))
      const items = within(within(rail).getByRole('list', { name: 'Steps of the tutorial' })).getAllByRole('button')
      expect(items[1]).toHaveTextContent('2. A Card of your ownDone')
      expect(items[2]).toHaveTextContent('3. UndoTo do')
      expect(items[3]).toHaveTextContent('4. Its PageShowing')
      await userEvent.click(items[2]!)
      expect(title()).toBe('Undo')
    })

    it('left at step 2, goes on to Undo once the Card is made', async () => {
      kit().stored = { v: 1, status: 'left', step: 'card', results: { look: 'done' } }
      render(<Screen />)
      await waitFor(() => expect(useHandsOn.getState().phase).toBe('left'))
      act(() => handsOn.resume())
      expect(title()).toBe('A Card of your own')
      act(() => kit().board((b) => ({ cards: [...b.cards, card('new', 'Drift', { status: 'reading' })] })))
      await waitFor(() => expect(showing()).toBe('undo'))
    })

    it('left at the end, lists Undo as not reached', async () => {
      const results = { look: 'done', card: 'done', page: 'done', source: 'skipped', connection: 'done', frame: 'done', search: 'done', todo: 'done', suggestion: 'done', visual: 'done', run: 'not_tried', checkpoint: 'done', branch: 'done', merge: 'done', history: 'done', ai: 'not_tried' }
      kit().stored = { v: 1, status: 'running', step: 'end', results }
      render(<Screen />)
      await waitFor(() => expect(useHandsOn.getState().phase).toBe('running'))
      const box = within(dialog()!)
      expect(box.getByRole('region', { name: 'Not reached' })).toHaveTextContent(/^Not reachedUndo$/)
      expect(box.getByRole('region', { name: 'Tried' })).not.toHaveTextContent('Undo')
      expect(screen.getByLabelText('Step 18 of 18')).toBeInTheDocument()
    })
  })

  it('stays away once left, until the account menu asks for it', async () => {
    kit().stored = { v: 1, status: 'left', step: 'merge', results: {} }
    render(<Screen />)
    await waitFor(() => expect(useHandsOn.getState().phase).toBe('left'))
    expect(dialog()).toBeNull()
    expect(screen.queryByText('Tutorial')).toBeNull()
    act(() => handsOn.resume())
    expect(title()).toBe('A Merge')
  })

  it('starts nothing when the server cannot be asked, and can still be started', async () => {
    kit().loadFails = new Error('offline')
    render(<Screen />)
    await waitFor(() => expect(useHandsOn.getState().phase).toBe('left'))
    expect(dialog()).toBeNull()
    act(() => handsOn.resume())
    expect(title()).toBe('The Board')
  })

  it('writes the progress once after a burst of changes', async () => {
    await open()
    vi.useFakeTimers()
    const before = kit().saved.length
    act(() => handsOn.skip())
    act(() => handsOn.skip())
    act(() => handsOn.skip())
    expect(kit().saved.length).toBe(before)
    act(() => void vi.advanceTimersByTime(SAVE_MS))
    expect(kit().saved.length).toBe(before + 1)
    expect(lastSaved()).toMatchObject({ step: 'page', results: { look: 'skipped', card: 'skipped', undo: 'skipped' } })
  })

  it('“Leave the tutorial” leaves at any step, is written at once, and “Tutorial” brings it back there', async () => {
    await open('search')
    await press('Leave the tutorial')
    expect(dialog()).toBeNull()
    expect(lastSaved()).toMatchObject({ status: 'left', step: 'search' })
    expect(screen.getByRole('status')).toHaveTextContent('You left the tutorial')
    act(() => handsOn.resume())
    expect(title()).toBe('Search')
    expect(dialog()).toHaveFocus()
  })

  it('“Hide” puts the step away; the rail keeps the progress and shows it again', async () => {
    await open()
    await press('Hide')
    expect(dialog()).toBeNull()
    const rail = screen.getByRole('complementary', { name: 'rail' })
    expect(within(rail).getByText('The Board')).toBeInTheDocument()
    await userEvent.click(within(rail).getByRole('button', { name: 'Show step' }))
    expect(title()).toBe('The Board')
    await userEvent.keyboard('{Escape}') // Esc hides too; it does not leave
    expect(dialog()).toBeNull()
    expect(useHandsOn.getState().phase).toBe('running')
    expect(within(rail).getByRole('button', { name: 'Show step' })).toHaveFocus()
  })

  it('lists every step with how it went, and goes to the one chosen', async () => {
    await open('todo', { look: 'done', card: 'skipped', run: 'not_tried' })
    const rail = screen.getByRole('complementary', { name: 'rail' })
    await userEvent.click(within(rail).getByRole('button', { name: 'All steps' }))
    const list = within(rail).getByRole('list', { name: 'Steps of the tutorial' })
    const items = within(list).getAllByRole('button')
    expect(items).toHaveLength(18)
    expect(items[0]).toHaveTextContent('1. The BoardDone')
    expect(items[1]).toHaveTextContent('2. A Card of your ownSkipped')
    expect(items[2]).toHaveTextContent('3. UndoTo do')
    expect(items[8]).toHaveTextContent('9. To-dosShowing')
    expect(items[8]).toHaveAttribute('aria-current', 'step')
    expect(items[11]).toHaveTextContent('12. A RunNot tried')
    expect(items[12]).toHaveTextContent('13. A CheckpointTo do')
    await userEvent.click(items[3]!)
    expect(title()).toBe('Its Page')
  })

  it('forgets everything when the Workspace is left, after writing what was not written yet', async () => {
    await open()
    act(() => handsOn.skip())
    cleanup()
    expect(lastSaved()).toMatchObject({ step: 'card' })
    expect(useHandsOn.getState().phase).toBe('off')
  })
})

describe('each step moves on by itself once it has been done', () => {
  it('1: opening the Page of “Welcome to Infall” — and not of another Card', async () => {
    await open()
    const board = screen.getByRole('button', { name: 'board' })
    act(() => board.focus())
    act(() => pagePanel.open('paper-a'))
    expect(showing()).toBe('look')
    act(() => pagePanel.open('welcome'))
    await waitFor(() => expect(showing()).toBe('card'))
    expect(useHandsOn.getState().results.look).toBe('done')
    expect(board).toHaveFocus() // reached by doing: focus stays with the person
    expect(screen.getByRole('status')).toHaveTextContent('Done: The Board. Step 2 of 18: A Card of your own.')
  })

  it('2: a new Card with a title and a status — not one that was there, and not one left as an Idea', async () => {
    await open('card')
    act(() => kit().board((b) => ({ cards: b.cards.map((c) => (c.id === 'paper-b' ? { ...c, status: 'dead_end' } : c)) })))
    act(() => kit().board((b) => ({ cards: [...b.cards, card('new', 'Drift', { status: 'idea' })] })))
    act(() => kit().board((b) => ({ cards: [...b.cards, card('new2', '', { status: 'reading' })] })))
    expect(showing()).toBe('card')
    act(() => kit().board((b) => ({ cards: b.cards.map((c) => (c.id === 'new' ? { ...c, status: 'open_question' } : c)) })))
    await waitFor(() => expect(showing()).toBe('undo'))
    expect(useHandsOn.getState().card).toBe('new')
  })

  it('2: Cards of another Branch are not new Cards', async () => {
    await open('card')
    act(() => kit().board({ status: 'loading', branch: undefined, cards: [] }))
    act(() => kit().board({ status: 'live', branch: BRANCHES.longer, cards: [card('w10k', SAMPLE.addedOnBranch, { status: 'reading' })] }))
    expect(showing()).toBe('card')
  })

  it('3: an Undo — the slip made on purpose, taken back', async () => {
    await open('undo')
    act(() => kit().setUndo({ undo: 'Move Card Pólya 1921', redo: null })) // the slip: a new step, nothing undone
    expect(showing()).toBe('undo')
    act(() => kit().setUndo({ undo: 'Status: Drift → Reading', redo: 'Move Card Pólya 1921' })) // ⌘Z, a button, the Edit menu
    await waitFor(() => expect(showing()).toBe('page'))
    expect(useHandsOn.getState().results.undo).toBe('done')
  })

  it('3: taking back step 2’s own work counts too, down to the last step there is', async () => {
    kit().setUndo({ undo: 'Add Card Drift', redo: null })
    await open('undo')
    act(() => kit().setUndo({ undo: null, redo: 'Add Card Drift' }))
    await waitFor(() => expect(showing()).toBe('page'))
  })

  it('3: what is not an Undo — a Redo, a step not undone, a Merge emptying the list, another Branch’s list', async () => {
    kit().setUndo({ undo: 'Status: Drift → Reading', redo: 'Move Card Pólya 1921' }) // undone before the step began
    await open('undo')
    act(() => kit().setUndo({ undo: 'Move Card Pólya 1921', redo: null })) // Redo
    act(() => kit().setUndo({ undo: 'Status: Drift → Reading', redo: null })) // "Not undone — …": dropped, never in Redo
    act(() => kit().setUndo({ undo: null, redo: null })) // a Merge landed; or the Board closed for a Branch switch
    act(() => kit().setUndo({ undo: 'Add Card Walks', redo: 'Move Card Drift' })) // the other Branch's list
    act(() => kit().board((b) => ({ cards: b.cards.map((c) => (c.id === 'paper-a' ? { ...c, x: 640, y: 40 } : c)) }))) // a Card moved back by hand
    expect(showing()).toBe('undo')
  })

  it('3: rings the Board’s Undo and Redo buttons', async () => {
    const view = await open('undo').then(() => render(<div data-tour="undo" />))
    const target = view.container.firstElementChild as HTMLElement
    target.getBoundingClientRect = () => ({ left: 160, top: 80, width: 56, height: 30, right: 216, bottom: 110, x: 160, y: 80, toJSON: () => ({}) })
    act(() => kit().board((b) => ({ ...b }))) // anything that makes the ring look again
    await waitFor(() => expect(document.querySelector<HTMLElement>('.q-tour-ring')).toHaveStyle({ left: '156px', top: '76px' }))
  })

  it('4: a line of text with a formula on a Page', async () => {
    await open('page')
    act(() => kit().set((w) => ({ board: { ...w.board, cards: [...w.board.cards, card('mine', 'Drift', { status: 'reading' })] } })))
    act(() => useHandsOn.setState({ card: 'mine' }))
    act(() => kit().set((w) => ({ blocks: { ...w.blocks, mine: [block('m1', 'mine', { text: 'no math here' })] } })))
    act(() => kit().set((w) => ({ blocks: { ...w.blocks, mine: [block('m1', 'mine', { text: '$x$' })] } }))) // a formula alone
    expect(showing()).toBe('page')
    act(() => kit().set((w) => ({ blocks: { ...w.blocks, mine: [block('m1', 'mine', { text: 'The spread grows as $\\sqrt{n}$.' })] } })))
    await waitFor(() => expect(showing()).toBe('source'))
  })

  it('4: the formula that was already on the open Page does not count', async () => {
    act(() => pagePanel.open('welcome'))
    await open('page')
    expect(showing()).toBe('page')
    act(() => kit().set((w) => ({ blocks: { ...w.blocks, welcome: [...w.blocks.welcome!, block('b-new', 'welcome', { text: 'And then $y$ too.', order: 'V' })] } })))
    await waitFor(() => expect(showing()).toBe('source'))
  })

  it('5: a Source attached to a Card', async () => {
    await open('source')
    act(() => kit().board((b) => ({ cards: b.cards.map((c) => (c.id === 'paper-b' ? { ...c, sources: 1 } : c)) })))
    await waitFor(() => expect(showing()).toBe('connection'))
  })

  it('6: a new Connection with a label', async () => {
    await open('connection')
    act(() => kit().board((b) => ({ connections: [...b.connections, { id: 'k2', from: 'welcome', to: 'run', kind: 'directed', label: '' }] })))
    expect(showing()).toBe('connection')
    act(() => kit().board((b) => ({ connections: b.connections.map((c) => (c.id === 'k2' ? { ...c, label: 'leads to' } : c)) })))
    await waitFor(() => expect(showing()).toBe('frame'))
  })

  it('7: a new Frame with a Card in it', async () => {
    await open('frame')
    act(() => kit().board((b) => ({ frames: [...b.frames, { id: 'f2', title: 'Mine', x: 2000, y: 2000, w: 520, h: 360 }] })))
    expect(showing()).toBe('frame')
    act(() => kit().board((b) => ({ cards: b.cards.map((c) => (c.id === 'paper-b' ? { ...c, x: 2100, y: 2100 } : c)) })))
    await waitFor(() => expect(showing()).toBe('search'))
  })

  it('8: a Card chosen from Search', async () => {
    await open('search')
    act(() => searchUse.chose('run'))
    await waitFor(() => expect(showing()).toBe('todo'))
  })

  it('9: the To-do ticked and another one made, in either order', async () => {
    await open('todo')
    act(() => kit().set((w) => ({ todos: [...w.todos, { id: 'pending:1', owner: 'me', text: 'Plot it', done: false, created_by: 'me', created_at: Date.now() }] })))
    expect(showing()).toBe('todo')
    act(() => kit().set((w) => ({ todos: w.todos.map((t) => (t.id === 't1' ? { ...t, done: true } : t)) })))
    await waitFor(() => expect(showing()).toBe('suggestion'))
  })

  it('10: the waiting Suggestion accepted or rejected', async () => {
    await open('suggestion')
    act(() => kit().set((w) => ({ suggestions: w.suggestions.map((s) => ({ ...s, suggestion: { ...s.suggestion, state: 'rejected' as const } })) })))
    await waitFor(() => expect(showing()).toBe('visual'))
  })

  it('11: on the Page of “Watch a walk”, using its Visual', async () => {
    await open('visual')
    const frame = screen.getByTitle('Visual: A walk')
    act(() => frame.focus()) // on another Page: not this Visual
    expect(showing()).toBe('visual')
    act(() => pagePanel.open('visual'))
    act(() => screen.getByRole('button', { name: 'board' }).focus())
    act(() => frame.focus())
    await waitFor(() => expect(showing()).toBe('run'))
  })

  it('12: the Run executed — a new result on its Page', async () => {
    await open('run')
    expect(within(dialog()!).queryByText(/Check again/)).toBeNull() // Python is there
    act(() =>
      kit().set((w) => ({
        blocks: { ...w.blocks, run: [block('b-run', 'run', { type: 'run', title: 'msd', text: 'print(1)', run: { result: { ...w.blocks.run![0]!.run!.result!, at: 5000 }, broken: false } })] },
      })),
    )
    await waitFor(() => expect(showing()).toBe('checkpoint'))
  })

  it('13: a Checkpoint added to the open Branch', async () => {
    await open('checkpoint')
    act(() => kit().board((b) => ({ branch: { ...b.branch!, checkpoints: 2 } })))
    await waitFor(() => expect(showing()).toBe('branch'))
  })

  it('14: to longer-walks and back to main', async () => {
    await open('branch')
    act(() => kit().board({ status: 'live', branch: BRANCHES.longer }))
    expect(showing()).toBe('branch')
    act(() => kit().board({ status: 'live', branch: BRANCHES.main }))
    await waitFor(() => expect(showing()).toBe('merge'))
  })

  it('15: the Merge of longer-walks into main landed', async () => {
    await open('merge')
    act(() => kit().set((w) => ({ merge: { ...w.merge, status: 'ready', source: BRANCHES.longer, target: BRANCHES.main } })))
    expect(showing()).toBe('merge')
    act(() => kit().set((w) => ({ merge: { ...w.merge, status: 'merged' } })))
    await waitFor(() => expect(showing()).toBe('history'))
  })

  it('16: History opened (a Restore is not needed)', async () => {
    await open('history')
    act(() => historyPanel.toggle())
    await waitFor(() => expect(showing()).toBe('ai'))
  })

  it('17: an answer pinned to a Page', async () => {
    await open('ai')
    const answer = { id: 'a1', role: 'assistant' as const, text: 'It grows like n.', at: 1, status: 'done' as const }
    const conversation = { id: 'c1', title: 'q', createdAt: 1, updatedAt: 1, messages: [answer] }
    act(() => kit().set((w) => ({ ai: { ...w.ai, current: conversation } })))
    expect(showing()).toBe('ai')
    act(() => kit().set((w) => ({ ai: { ...w.ai, current: { ...conversation, messages: [{ ...answer, pinned: [{ card: 'welcome', cardTitle: SAMPLE.welcome, block: 'p1' }] }] } } })))
    await waitFor(() => expect(showing()).toBe('end'))
  })

  it('“Skip this step” is always there, and moves on with the step marked skipped', async () => {
    await open()
    for (let i = 0; i < 17; i++) {
      expect(within(dialog()!).getByRole('button', { name: 'Skip this step' })).toBeInTheDocument()
      await press('Skip this step')
      expect(dialog()).toHaveFocus()
    }
    expect(title()).toBe('The end')
    expect(Object.values(useHandsOn.getState().results)).toEqual(Array(17).fill('skipped'))
  })

  it('never makes a Change: a step that is skipped or done leaves the Board as it was', async () => {
    await open()
    const board = kit().w.board
    await skipTo('end')
    expect(kit().w.board).toBe(board)
  })
})

describe('when a tool is missing (decision 6)', () => {
  it('the Run step in a browser says what is needed, shows where the output is, and is passed as not tried', async () => {
    kit().setRunner({ available: false, reason: 'browser' })
    await open('run')
    const box = within(dialog()!)
    expect(box.getByText('Runs are executed only by the Infall desktop app, on your own computer.')).toBeInTheDocument()
    expect(box.getByText(/The output captured the last time it was executed is already on the Page of “Random walk experiment”/)).toBeInTheDocument()
    await press('Check again')
    expect(kit().calls.runsRefresh).toBe(1)
    await press('Skip this step')
    expect(useHandsOn.getState().results.run).toBe('not_tried')
  })

  it('the Run step without Python offers the Runner settings, and goes on once Python is found', async () => {
    kit().setRunner({ available: true })
    await open('run')
    expect(within(dialog()!).getByText('Install Python 3, then choose it in the Runner settings.')).toBeInTheDocument()
    await press('Runner settings')
    expect(kit().calls.runsConfigure).toBe(1)
    act(() => kit().setRunner({ available: true, python: { path: '/opt/python3', version: '3.13.0' } }))
    await waitFor(() => expect(within(dialog()!).queryByText(/Install Python/)).toBeNull())
    await press('Skip this step')
    expect(useHandsOn.getState().results.run).toBe('skipped') // it was there by then: skipped, not "not tried"
  })

  it('the AI step without Claude Code or a key says what to install, checks again, and is passed as not tried', async () => {
    kit().setAi({ provider: 'none', reason: 'desktop_no_claude', desktop: true, openrouter: { enabled: true } })
    await open('ai')
    const box = within(dialog()!)
    expect(box.getByText('Install Claude Code, or add an OpenRouter key under AI access.')).toBeInTheDocument()
    expect(box.getByText(/“Pin to Page” would copy it into the Page/)).toBeInTheDocument()
    await press('Check again')
    expect(kit().calls.aiRefresh).toBe(1)
    expect(box.getByRole('button', { name: 'AI access' })).toBeInTheDocument()
    await press('Skip this step')
    expect(useHandsOn.getState().results.ai).toBe('not_tried')
  })

  it('says nothing while it is still looking', async () => {
    kit().setAi({ provider: 'none', reason: 'loading', desktop: true, openrouter: { enabled: false } })
    await open('ai')
    expect(within(dialog()!).getByText(/Looking for what this step needs/)).toBeInTheDocument()
    expect(within(dialog()!).queryByRole('button', { name: 'Check again' })).toBeNull()
  })
})

describe('when what a step needs was removed', () => {
  it('says so after a moment, and the step can be skipped', async () => {
    await open()
    act(() => kit().board((b) => ({ cards: b.cards.filter((c) => c.title !== SAMPLE.welcome) })))
    await waitFor(() => expect(within(dialog()!).getByRole('note')).toHaveTextContent('There is no Card called “Welcome to Infall” on this Board any more'), {
      timeout: MISSING_AFTER_MS + 1000,
    })
    await press('Skip this step')
    expect(showing()).toBe('card')
  })

  it('a Visual, a Run, the To-do, the Suggestion and the Branch, each in its own words', async () => {
    kit().set((w) => ({
      board: { ...w.board, cards: w.board.cards.filter((c) => c.id !== 'run') },
      blocks: { ...w.blocks, visual: [] },
      todos: [],
      suggestions: [],
      branches: [BRANCHES.main],
    }))
    // Each note waits MISSING_AFTER_MS before it shows: move the clock rather than wait for it, so that a loaded
    // machine cannot make this slow. Not a moment less than that wait, though: just before it, there is no note.
    const note = async (step: string, text: RegExp) => {
      await act(async () => handsOn.goTo(step as never))
      act(() => void vi.advanceTimersByTime(MISSING_AFTER_MS - 1))
      expect(within(dialog()!).queryByRole('note')).toBeNull()
      act(() => void vi.advanceTimersByTime(1))
      expect(within(dialog()!).getByRole('note')).toHaveTextContent(text)
    }
    await open()
    vi.useFakeTimers()
    await note('visual', /The Page of “Watch a walk” has no Visual any more/)
    await note('run', /There is no Card called “Random walk experiment”/)
    await note('todo', /adding one of your own is enough/)
    await note('suggestion', /No Suggestion is waiting on this Branch/)
    await note('branch', /There is no Branch called longer-walks any more/)
    await note('merge', /There is no Branch called longer-walks any more/)
  })

  it('with the To-do gone, making one is the whole step', async () => {
    kit().set({ todos: [] })
    await open('todo')
    act(() => kit().set({ todos: [{ id: 't9', owner: 'me', text: 'Mine', done: false, created_by: 'me', created_at: Date.now() }] }))
    await waitFor(() => expect(showing()).toBe('suggestion'))
  })

  it('a thing that comes back takes the note away', async () => {
    await open()
    const all = kit().w.board.cards
    act(() => kit().board((b) => ({ cards: b.cards.filter((c) => c.title !== SAMPLE.welcome) })))
    await waitFor(() => expect(within(dialog()!).queryByRole('note')).not.toBeNull(), { timeout: MISSING_AFTER_MS + 1000 })
    act(() => kit().board({ cards: all }))
    await waitFor(() => expect(within(dialog()!).queryByRole('note')).toBeNull())
  })
})

describe('the end', () => {
  it('says what was tried, skipped and not tried, and what a Team Workspace adds', async () => {
    await open('end', { look: 'done', card: 'done', undo: 'done', run: 'not_tried', ai: 'not_tried', merge: 'skipped' })
    const box = within(dialog()!)
    expect(box.getByRole('region', { name: 'Tried' })).toHaveTextContent(/^TriedThe Board · A Card of your own · Undo$/)
    expect(box.getByRole('region', { name: 'Skipped' })).toHaveTextContent('A Merge')
    expect(box.getByRole('region', { name: /Not tried/ })).toHaveTextContent('A Run · The AI sidebar')
    expect(box.getByRole('region', { name: 'Not reached' })).toHaveTextContent(/^Not reachedIts Page · A Source/)
    expect(box.getByRole('region', { name: 'What a Team Workspace adds' })).toHaveTextContent(/Members.*invites.*Guests/)
    expect(box.queryByRole('button', { name: 'Back to workspaces' })).toBeNull() // no desktop app
    expect(box.queryByRole('button', { name: 'Skip this step' })).toBeNull()
    await press('Finish')
    expect(dialog()).toBeNull()
    expect(lastSaved()).toMatchObject({ status: 'finished' })
  })

  it('lists Undo as skipped when it was skipped', async () => {
    await open('end', { look: 'done', card: 'done', undo: 'skipped' })
    expect(within(dialog()!).getByRole('region', { name: 'Skipped' })).toHaveTextContent(/^SkippedUndo$/)
  })

  it('“Back to workspaces” in the desktop app calls its bridge', async () => {
    const switchWorkspace = vi.fn(async () => {})
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { switchWorkspace }
    await open('end')
    await press('Back to workspaces')
    expect(switchWorkspace).toHaveBeenCalledTimes(1)
  })

  it('“Back to workspaces” is not offered by an app without the bridge function', async () => {
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '0.11' }
    await open('end')
    expect(within(dialog()!).queryByRole('button', { name: 'Back to workspaces' })).toBeNull()
  })

  it('once finished, the account menu starts it again from step 1', async () => {
    kit().stored = { v: 1, status: 'finished', step: 'end', results: { look: 'done' } }
    render(<Screen />)
    await waitFor(() => expect(useHandsOn.getState().phase).toBe('finished'))
    act(() => handsOn.resume())
    expect(title()).toBe('The Board')
    expect(useHandsOn.getState().results).toEqual({})
  })
})

describe('on screen', () => {
  it('is a region of the rail, named by its title and read with the step count', async () => {
    await open()
    const box = screen.getByRole('region', { name: 'The Board' })
    expect(screen.getByRole('complementary', { name: 'rail' })).toContainElement(box)
    expect(box).toHaveAccessibleDescription(/^Tutorial, step 1 of 18 This Tutorial Workspace is yours alone/)
  })

  it('lays nothing over the app but the ring, which lets clicks through', async () => {
    await open('checkpoint')
    await waitFor(() => expect(document.querySelector('.q-tour-ring')).not.toBeNull())
    const rail = screen.getByRole('complementary', { name: 'rail' })
    expect(rail).toContainElement(dialog())
    expect(rail).toContainElement(within(rail).getByRole('button', { name: 'Skip this step' }))
  })

  it('rings the control a step is about', async () => {
    await open('checkpoint')
    await waitFor(() => expect(document.querySelector('.q-tour-ring')).not.toBeNull())
  })

  it('rings the very Card a step names, when it is on screen', async () => {
    const view = await open().then(() => render(<div data-card="welcome" data-tour="card" />))
    const target = view.container.firstElementChild as HTMLElement
    target.getBoundingClientRect = () => ({ left: 300, top: 200, width: 224, height: 132, right: 524, bottom: 332, x: 300, y: 200, toJSON: () => ({}) })
    act(() => kit().board((b) => ({ ...b }))) // the watcher reports the Card
    await waitFor(() => expect(document.querySelector<HTMLElement>('.q-tour-ring')).toHaveStyle({ left: '296px', top: '196px' }))
  })

  it('leaves Tab to the rest of the app', async () => {
    await open()
    fireEvent.keyDown(dialog()!, { key: 'Tab' })
    for (let i = 0; i < 6; i++) await userEvent.tab()
    expect(dialog()).not.toContainElement(document.activeElement as HTMLElement)
    expect(dialog()).toBeInTheDocument()
  })
})
