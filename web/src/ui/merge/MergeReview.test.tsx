// M3: the Merge review screen (9a).
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakeLib())
vi.mock('../../lib', () => fake.lib)

const { MergeReview } = await import('./MergeReview')
const { ALL_DECIDED, apiError, DELETED, decidedWith, IDLE, MAIN, QEC, READY, STATUS, TITLE } = await import('./testkit')

const { store, calls, impl } = fake

const renderReview = (from = 'try-QEC', into = 'main') => render(<MergeReview from={from} into={into} />)
const mergeButton = () => document.querySelector('button.q-merge__go') as HTMLButtonElement
const block = (n: number) => document.getElementById(`q-merge-c${n}`) as HTMLElement
const radios = (n: number) => within(block(n)).getAllByRole('radio')
const go = (path: string) => window.history.replaceState(null, '', path)

beforeEach(() => {
  fake.reset()
  go('/merge?from=try-QEC&into=main')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('lifecycle', () => {
  it('plans the Merge on mount and lets go on unmount', () => {
    const { unmount } = renderReview()
    expect(calls.lifecycle).toEqual(['open try-QEC main'])
    unmount()
    expect(calls.lifecycle).toEqual(['open try-QEC main', 'close'])
  })

  it('plans again when the Branches change', () => {
    store.setState({ ...READY, source: MAIN, target: QEC })
    const { rerender } = renderReview()
    rerender(<MergeReview from="main" into="try-QEC" />)
    expect(calls.lifecycle).toEqual(['open try-QEC main', 'close', 'open main try-QEC'])
  })

  it('ends open under StrictMode', () => {
    render(
      <StrictMode>
        <MergeReview from="try-QEC" into="main" />
      </StrictMode>,
    )
    expect(calls.lifecycle).toEqual(['open try-QEC main', 'close', 'open try-QEC main'])
    expect(screen.getByRole('heading', { level: 1, name: 'Merge try-QEC into main' })).toBeInTheDocument()
  })
})

describe('states', () => {
  it('says "Preparing the Merge…" only after 150 ms', () => {
    vi.useFakeTimers()
    store.setState(IDLE, true)
    renderReview()
    expect(screen.queryByText('Preparing the Merge…')).toBeNull()
    act(() => void vi.advanceTimersByTime(149))
    expect(screen.queryByText('Preparing the Merge…')).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the Merge…')
    act(() => store.setState({ ...IDLE, status: 'loading' }, true))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the Merge…')
    act(() => store.setState(READY, true))
    expect(screen.queryByText('Preparing the Merge…')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('does not show a review left over from two other Branches', () => {
    renderReview('ana/fit', 'main')
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('says so when there is nothing to merge', () => {
    store.setState({ ...READY, auto: [], conflicts: [], layoutKept: 0, nothingToMerge: true, autoSummary: 'Nothing to merge automatically' }, true)
    renderReview()
    expect(screen.getByRole('status')).toHaveTextContent('main already has everything from try-QEC.')
    expect(screen.getByRole('link', { name: 'Back to Branches' })).toHaveAttribute('href', '/branches')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('explains that only a Branch and the Branch it was started from can be merged', () => {
    store.setState({ ...IDLE, status: 'error', errorCode: 'not_parent_and_child', error: 'not parent and child' }, true)
    renderReview()
    expect(screen.getByRole('status')).toHaveTextContent('A Branch can only be merged with the Branch it was started from.')
    expect(screen.getByRole('link', { name: 'Back to Branches' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('names the Branch that does not exist', () => {
    store.setState({ ...IDLE, status: 'error', errorCode: 'not_found' }, true)
    renderReview('Try-qec', 'main')
    expect(screen.getByRole('status')).toHaveTextContent('There is no Branch called “Try-qec”.')
  })

  it('names both when it cannot tell which Branch is missing', () => {
    store.setState({ ...IDLE, status: 'error', errorCode: 'not_found' }, true)
    fake.known.setState({ list: [] })
    renderReview('a', 'b')
    expect(screen.getByRole('status')).toHaveTextContent('There is no Branch called “a”, or none called “b”.')
  })

  it('shows any other failure as a plain sentence with "Try again"', async () => {
    store.setState({ ...IDLE, status: 'error', errorCode: 'network', error: "Can't reach the server. Check your connection and try again." }, true)
    const user = userEvent.setup()
    renderReview()
    expect(screen.getByRole('status')).toHaveTextContent("Can't reach the server. Check your connection and try again.")
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(calls.lifecycle).toEqual(['open try-QEC main', 'open try-QEC main'])
  })
})

describe('header', () => {
  it('names both Branches as written and says what pressing Merge does', () => {
    store.setState({ ...READY, source: { ...QEC, name: 'ana/Fit & more' } })
    const { container } = renderReview('ana/Fit & more', 'main')
    expect(screen.getByRole('heading', { level: 1, name: 'Merge ana/Fit & more into main' })).toBeInTheDocument()
    expect(container.querySelector('.q-merge__lead')).toHaveTextContent('main doesn’t change until you press Merge. A Checkpoint is created on main first.')
    const chips = container.querySelectorAll('.q-merge__h .q-merge-name')
    expect(chips[0]).toHaveClass('q-merge-name--branch')
    expect(chips[1]).not.toHaveClass('q-merge-name--branch')
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/branches')
  })

  it('counts decided Conflicts and keeps Merge disabled until all are decided', () => {
    store.setState(decidedWith({ [STATUS.id]: 'source' }), true)
    const { container } = renderReview()
    expect(container.querySelector('.q-merge__progress')).toHaveTextContent('1 of 3 Conflicts decided')
    expect(Array.from(container.querySelectorAll('.q-merge__segment')).map((s) => s.getAttribute('data-decided'))).toEqual(['false', 'true', 'false'])
    expect(mergeButton()).toHaveTextContent('Merge · 2 left')
    expect(mergeButton()).toBeDisabled()
    expect(mergeButton()).toHaveAttribute('title', 'Decide all Conflicts first')

    act(() => store.setState(ALL_DECIDED, true))
    expect(container.querySelector('.q-merge__progress')).toHaveTextContent('3 of 3 Conflicts decided')
    expect(mergeButton()).toHaveTextContent('Merge into main')
    expect(mergeButton()).toBeEnabled()
  })

  it('reads "Merging…" while applying and "Merged ✓" afterwards, both disabled', () => {
    store.setState({ ...ALL_DECIDED, status: 'applying' }, true)
    renderReview()
    expect(mergeButton()).toHaveTextContent('Merging…')
    expect(mergeButton()).toBeDisabled()
    act(() => store.setState({ ...ALL_DECIDED, status: 'merged', result: { seq: 52, changes: 12 } }, true))
    expect(mergeButton()).toHaveTextContent('Merged ✓')
    expect(mergeButton()).toBeDisabled()
  })

  it('is ready at once when there are no Conflicts', () => {
    store.setState({ ...READY, conflicts: [], decided: 0 }, true)
    const { container } = renderReview()
    expect(container.querySelector('.q-merge__progress')).toHaveTextContent('No Conflicts')
    expect(mergeButton()).toBeEnabled()
    expect(within(screen.getByRole('navigation', { name: 'Review' })).getByText('No Conflicts.')).toBeInTheDocument()
  })
})

describe('what merges automatically', () => {
  it('opens and closes the list of automatic Changes', async () => {
    const user = userEvent.setup()
    renderReview()
    const toggle = screen.getByRole('button', { name: /Merges automatically/ })
    expect(toggle).toHaveTextContent('3 Changes · 1 Card added, 1 other Change, 1 Connection added')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '' })?.querySelector('.q-merge-auto__row') ?? null).toBeNull()
    expect(screen.queryByText('Union-find vs MWPM benchmark')).toBeNull()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Card addedUnion-find vs MWPM benchmark',
      'ChangeLattice surgery CNOT · summary',
      'Connection addedStim noise model → Threshold ≈ 1% · calibrates',
    ])

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Union-find vs MWPM benchmark')).toBeNull()
  })

  it('shows the number of automatic Changes in the side list', () => {
    const { container } = renderReview()
    expect(container.querySelector('.q-merge-nav__auto')).toHaveTextContent('✓Merges automatically3')
  })

  it('shows only the summary when there are no lines to list', () => {
    store.setState({ ...READY, auto: [], autoSummary: '6 moved or resized' }, true)
    renderReview()
    expect(screen.queryByRole('button', { name: /Merges automatically/ })).toBeNull()
    expect(screen.getByText('6 moved or resized')).toBeInTheDocument()
  })

  it('notes that Card positions follow the target, only when some were kept', () => {
    const { container } = renderReview()
    expect(container.querySelector('.q-merge-layout')).toHaveTextContent(
      'Card positions follow main. 6 Cards and Frames that were moved on try-QEC keep their main position and are not listed as Conflicts.',
    )
    act(() => store.setState({ layoutKept: 1 }))
    expect(container.querySelector('.q-merge-layout')).toHaveTextContent(
      'Card positions follow main. 1 Card or Frame that was moved on try-QEC keeps its main position and is not listed as a Conflict.',
    )
    act(() => store.setState({ layoutKept: 0 }))
    expect(container.querySelector('.q-merge-layout')).toBeNull()
  })
})

describe('a Conflict', () => {
  it('shows a field Conflict on text: number, type, title, headline, state and three options', () => {
    renderReview()
    const b = block(1)
    expect(b.querySelector('.q-merge-conflict__num')).toHaveTextContent('01')
    expect(b.querySelector('.q-merge-conflict__type')).toHaveTextContent('Same field')
    expect(within(b).getByRole('heading', { level: 2, name: 'Card: Threshold ≈ 1%' })).toBeInTheDocument()
    expect(within(b).getByText('Title changed on both')).toBeInTheDocument()
    expect(b.querySelector('.q-merge-conflict__state')).toHaveTextContent('Needs a decision')
    expect(b).toHaveAttribute('data-decided', 'false')
    expect(within(b).getByRole('radiogroup', { name: 'Card: Threshold ≈ 1%' })).toBeInTheDocument()
    // The target comes first, as in the mock-up.
    expect(radios(1).map((r) => r.textContent)).toEqual([
      'mainElena Varga · 15 NovThreshold ≈ 1% (circuit noise)',
      'try-QECMei Lin · 18 NovThreshold ≈ 0.57% (MWPM)',
      'Edit by handWrite a combined title',
    ])
    expect(radios(1).map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
    expect(b.querySelector('[data-pick="source"] .q-merge-opt__side')).toHaveClass('q-merge-opt__side--branch')
    expect(b.querySelector('[data-pick="target"] .q-merge-opt__side')).not.toHaveClass('q-merge-opt__side--branch')
    expect(within(b).queryByRole('textbox')).toBeNull()
  })

  it('shows a Status with its glyph and word in the Status colour; someone who left reads "Former Member"', () => {
    renderReview()
    const b = block(2)
    expect(b.querySelector('.q-merge-conflict__num')).toHaveTextContent('02')
    expect(within(b).getByRole('heading', { level: 2, name: 'Card: Union-find decoder' })).toBeInTheDocument()
    expect(radios(2).map((r) => r.textContent)).toEqual(['mainFormer Member · 16 NovIdea', 'try-QECMei Lin · 19 NovUnderstood'])
    const [target, source] = radios(2)
    expect(target?.querySelector('svg.q-glyph')).toHaveAttribute('data-shape', 'idea')
    expect(source?.querySelector('svg.q-glyph')).toHaveAttribute('data-shape', 'understood')
    expect(target?.querySelector<HTMLElement>('.q-merge-opt__value--status')?.style.color).toBe('var(--q-st-idea)')
    expect(source?.querySelector<HTMLElement>('.q-merge-opt__value--status')?.style.color).toBe('var(--q-st-understood)')
    // No glyph where the value is not a Status.
    expect(block(1).querySelector('svg.q-glyph')).toBeNull()
  })

  it('shows an edited-and-deleted Conflict with the two outcomes and no "Edit by hand"', () => {
    renderReview()
    const b = block(3)
    expect(b.querySelector('.q-merge-conflict__type')).toHaveTextContent('Edited · deleted')
    expect(within(b).getByRole('heading', { level: 2, name: 'Card: Neural decoders?' })).toBeInTheDocument()
    expect(within(b).getByText('Deleted on main, edited on try-QEC')).toBeInTheDocument()
    expect(radios(3).map((r) => r.textContent)).toEqual(['mainDelete the Card', 'try-QECMei LinKeep the Card with its edits: summary'])
  })

  it('choosing a side decides the Conflict', async () => {
    const user = userEvent.setup()
    renderReview()
    await user.click(radios(2)[1]!)
    expect(calls.decide).toEqual([[STATUS.id, 'source']])
    expect(radios(2).map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(block(2).querySelector('.q-merge-conflict__state')).toHaveTextContent('✓ Decided: try-QEC')
    expect(block(2)).toHaveAttribute('data-decided', 'true')

    await user.click(radios(2)[0]!)
    expect(calls.decide).toEqual([
      [STATUS.id, 'source'],
      [STATUS.id, 'target'],
    ])
    expect(block(2).querySelector('.q-merge-conflict__state')).toHaveTextContent('✓ Decided: main')
    expect(mergeButton()).toHaveTextContent('Merge · 2 left')

    // Choosing what is already chosen changes nothing.
    await user.click(radios(2)[0]!)
    expect(calls.decide).toHaveLength(2)
  })

  it('works as a radio group from the keyboard: one tab stop, arrows move and choose, wrapping', async () => {
    const user = userEvent.setup()
    renderReview()
    expect(radios(1).map((r) => r.tabIndex)).toEqual([0, -1, -1])
    radios(1)[0]!.focus()

    await user.keyboard('{ArrowRight}')
    expect(radios(1)[1]).toHaveFocus()
    expect(calls.decide).toEqual([[TITLE.id, 'source']])
    expect(radios(1).map((r) => r.tabIndex)).toEqual([-1, 0, -1])

    await user.keyboard('{ArrowLeft}')
    expect(radios(1)[0]).toHaveFocus()
    expect(calls.decide.at(-1)).toEqual([TITLE.id, 'target'])

    await user.keyboard('{ArrowUp}')
    expect(radios(1)[2]).toHaveFocus()
    expect(calls.decide.at(-1)).toEqual([TITLE.id, { custom: 'Threshold ≈ 0.57% (MWPM)' }])

    await user.keyboard('{ArrowDown}')
    expect(radios(1)[0]).toHaveFocus()
    expect(calls.decide.at(-1)).toEqual([TITLE.id, 'target'])

    // Space chooses the focused option.
    radios(2)[0]!.focus()
    await user.keyboard(' ')
    expect(calls.decide.at(-1)).toEqual([STATUS.id, 'target'])
    await user.keyboard('{ArrowDown}')
    expect(radios(2)[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(radios(2)[0]).toHaveFocus()
  })

  it('"Edit by hand" reveals a labelled field starting from the source text; typing updates the choice', async () => {
    const user = userEvent.setup()
    renderReview()
    await user.click(within(block(1)).getByRole('radio', { name: /Edit by hand/ }))
    expect(calls.decide).toEqual([[TITLE.id, { custom: 'Threshold ≈ 0.57% (MWPM)' }]])
    const field = within(block(1)).getByRole('textbox', { name: 'Your value — this is what main will get' })
    expect(field).toHaveValue('Threshold ≈ 0.57% (MWPM)')
    expect(block(1).querySelector('.q-merge-conflict__state')).toHaveTextContent('✓ Decided: Edit by hand')

    await user.type(field, '!')
    expect(calls.decide.at(-1)).toEqual([TITLE.id, { custom: 'Threshold ≈ 0.57% (MWPM)!' }])
    expect(field).toHaveValue('Threshold ≈ 0.57% (MWPM)!')

    fireEvent.change(field, { target: { value: 'Threshold ≈ 0.57% (often quoted as 1%)' } })
    expect(calls.decide.at(-1)).toEqual([TITLE.id, { custom: 'Threshold ≈ 0.57% (often quoted as 1%)' }])

    // Choosing "Edit by hand" again keeps what was written.
    const before = calls.decide.length
    await user.click(within(block(1)).getByRole('radio', { name: /Edit by hand/ }))
    expect(calls.decide).toHaveLength(before)
    expect(field).toHaveValue('Threshold ≈ 0.57% (often quoted as 1%)')

    // Taking a side instead hides the field.
    await user.click(radios(1)[0]!)
    expect(within(block(1)).queryByRole('textbox')).toBeNull()
  })

  it('starts "Edit by hand" empty when the source value is empty', async () => {
    store.setState({ ...READY, conflicts: [{ ...TITLE, source: { text: '(empty)' } }] }, true)
    const user = userEvent.setup()
    renderReview()
    await user.click(within(block(1)).getByRole('radio', { name: /Edit by hand/ }))
    expect(calls.decide).toEqual([[TITLE.id, { custom: '' }]])
    expect(within(block(1)).getByRole('textbox')).toHaveValue('')
  })
})

describe('side list', () => {
  it('lists each Conflict with its state, and moves focus to the Conflict heading', async () => {
    store.setState(decidedWith({ [STATUS.id]: 'source', [TITLE.id]: { custom: 'x' } }), true)
    const user = userEvent.setup()
    renderReview()
    const nav = screen.getByRole('navigation', { name: 'Review' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual([
      '✓Threshold ≈ 1% · TitleDecided · Edit by hand',
      '✓Union-find decoder · StatusDecided · try-QEC',
      'Neural decoders?Needs a decision',
    ])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#q-merge-c1', '#q-merge-c2', '#q-merge-c3'])

    await user.click(links[2]!)
    expect(within(block(3)).getByRole('heading', { level: 2 })).toHaveFocus()
    await user.click(links[0]!)
    expect(within(block(1)).getByRole('heading', { level: 2 })).toHaveFocus()
    // The route is untouched.
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/merge?from=try-QEC&into=main')
  })
})

describe('Checkpoint', () => {
  const field = () => screen.getByRole('textbox', { name: 'Checkpoint on main before merging' })

  it('shows the proposed name and passes every change on', async () => {
    const user = userEvent.setup()
    renderReview()
    expect(field()).toHaveValue('Before merging try-QEC')
    await user.type(field(), ' 2')
    expect(calls.checkpoint).toEqual(['Before merging try-QEC ', 'Before merging try-QEC 2'])
    expect(field()).toHaveValue('Before merging try-QEC 2')
  })

  it('says when the target already has a Checkpoint with that name, until the name changes', async () => {
    store.setState(ALL_DECIDED, true)
    impl.apply = async () => {
      throw apiError(409, 'name_taken')
    }
    const user = userEvent.setup()
    renderReview()
    await user.click(mergeButton())
    expect(calls.apply).toBe(1)
    expect(await screen.findByText('main already has a Checkpoint with that name.')).toBeInTheDocument()
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByRole('alert')).toBeNull()

    await user.type(field(), '2')
    expect(screen.queryByText('main already has a Checkpoint with that name.')).toBeNull()
  })

  it('asks for a name instead of merging without one', async () => {
    store.setState({ ...ALL_DECIDED, checkpointName: '  ' }, true)
    const user = userEvent.setup()
    renderReview()
    await user.click(mergeButton())
    expect(calls.apply).toBe(0)
    expect(screen.getByText('Give the Checkpoint a name.')).toBeInTheDocument()
  })
})

describe('merging', () => {
  it('applies, then shows the success banner with links and makes the options read-only', async () => {
    store.setState(ALL_DECIDED, true)
    impl.apply = async () => {
      store.setState({
        status: 'merged',
        result: { seq: 52, changes: 12, checkpoint: { name: 'Before merging try-QEC', moment: { branch: 'b-main', seq: 40 }, author: 'mei', at: 1 } },
      })
    }
    const user = userEvent.setup()
    renderReview()
    await user.click(mergeButton())
    expect(calls.apply).toBe(1)

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('✓ Merged into main. Checkpoint “Before merging try-QEC” was created — Restore to it from History to undo.')
    expect(within(banner).getByRole('link', { name: 'Open main' })).toHaveAttribute('href', '/')
    expect(within(banner).getByRole('link', { name: 'Back to Branches' })).toHaveAttribute('href', '/branches')
    expect(mergeButton()).toHaveTextContent('Merged ✓')
    expect(mergeButton()).toBeDisabled()

    expect(radios(2).map((r) => r.getAttribute('aria-disabled'))).toEqual(['true', 'true'])
    expect(within(block(2)).getByRole('radiogroup')).toHaveAttribute('aria-readonly', 'true')
    const before = calls.decide.length
    await user.click(radios(2)[1]!)
    radios(2)[0]!.focus()
    await user.keyboard('{ArrowRight}')
    expect(calls.decide).toHaveLength(before)
    expect(screen.getByRole('textbox', { name: 'Checkpoint on main before merging' })).toBeDisabled()
  })

  it('links to the Board of a target that is not main, and keeps a hand-written value readable', () => {
    store.setState(
      {
        ...decidedWith({ [TITLE.id]: { custom: 'Both' }, [STATUS.id]: 'target', [DELETED.id]: 'target' }),
        source: MAIN,
        target: { ...QEC, name: 'ana/fit 2' },
        status: 'merged',
        result: { seq: 20, changes: 4 },
      },
      true,
    )
    renderReview('main', 'ana/fit 2')
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('✓ Merged into ana/fit 2.')
    expect(banner).not.toHaveTextContent('Checkpoint')
    expect(within(banner).getByRole('link', { name: 'Open ana/fit 2' })).toHaveAttribute('href', '/b/ana%2Ffit%202')
    expect(within(block(1)).getByRole('textbox')).toHaveAttribute('readonly')
  })

  it('says the review was updated when a Branch changed underneath (stale)', async () => {
    store.setState(ALL_DECIDED, true)
    impl.apply = async () => {
      store.setState({ ...decidedWith({ [STATUS.id]: 'target' }), replanned: true }, true)
      throw apiError(409, 'stale')
    }
    const user = userEvent.setup()
    renderReview()
    expect(screen.queryByRole('status')).toBeNull()
    await user.click(mergeButton())
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A Branch changed while you were reviewing. The review was updated — check your decisions and Merge again.',
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mergeButton()).toHaveTextContent('Merge · 2 left')

    // The next decision clears it (the data layer does).
    await user.click(radios(1)[0]!)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows any other failure as a plain sentence by the buttons, and clears it on the next try', async () => {
    store.setState(ALL_DECIDED, true)
    impl.apply = async () => {
      throw apiError(-1, 'network')
    }
    const user = userEvent.setup()
    renderReview()
    await user.click(mergeButton())
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection and try again.")
    expect(mergeButton()).toBeEnabled()

    impl.apply = async () => {
      throw apiError(500, 'internal')
    }
    await user.click(mergeButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('The Merge could not be applied. Try again.')

    impl.apply = async () => {}
    await user.click(mergeButton())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls.apply).toBe(3)
  })
})
