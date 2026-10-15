import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakeSuggestionsLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { ApiError } = await import('../../lib')
const { SuggestionsPanel } = await import('./SuggestionsPanel')
const { suggestionsPanel, useBoardRequest, useSuggestionsPanel } = await import('../bridge')
const { ANA, MEI, at, card, connectionSuggestion, sourceSuggestion } = await import('./testkit')
const { MAIN } = await import('../history/testkit')

const { boardStore, membersStore, suggestions, todos } = fake

const C1 = card('c1', 'Noise-induced plateaus')
const C2 = card('c2', 'Reward plateaus', { x: 400 })
const onClose = vi.fn<() => void>()

const block = (id: string) => screen.getByTestId(`suggestion-${id}`)
const preview = () => useSuggestionsPanel.getState().preview
/** Let promises settle (accept / reject / reload resolve in a microtask). */
const settle = () => act(async () => {})
const renderPanel = () => render(<SuggestionsPanel onClose={onClose} />)

beforeEach(() => {
  fake.reset()
  onClose.mockReset()
  boardStore.setState({ cards: [C1, C2] })
  useSuggestionsPanel.setState({ open: true, preview: null })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  act(() => suggestionsPanel.close())
})

describe('header and list', () => {
  it('counts the pending Suggestions', async () => {
    fake.show(sourceSuggestion('s1'), connectionSuggestion('k1'), sourceSuggestion('s2', { state: 'accepted', decided_by: MEI.id, decided_at: at(15, 10) }))
    renderPanel()
    await settle()
    expect(screen.getByRole('heading', { name: 'Suggestions' })).toBeInTheDocument()
    expect(screen.getByTestId('suggestions-count')).toHaveTextContent('2 pending')
    expect(screen.getByText("Proposed by AI through a Member's access token. Nothing is added until someone accepts.")).toBeInTheDocument()
  })

  it('shows a Source Suggestion: kind, Card, title, meta, why, and who proposed it', async () => {
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    const b = within(block('s1'))
    expect(b.getByText('Source')).toHaveClass('qs-kind')
    expect(b.getByText('Source')).not.toHaveClass('qs-kind--connection')
    expect(block('s1').querySelector('.qs-item__target')).toHaveTextContent('for Card: Noise-induced plateaus')
    expect(b.getByText('Noise-induced barren plateaus')).toHaveClass('qs-item__title')
    expect(b.getByText('Wang et al. · 2021 · arXiv:2007.14384')).toBeInTheDocument()
    expect(block('s1').querySelector('.qs-item__why')).toHaveTextContent('Why: The Page states this result but has no Source attached.')
    expect(b.getByText("via Mei's AI · claude-opus-4 · 14 Nov")).toBeInTheDocument()
    expect(b.getByRole('button', { name: 'Accept' })).toBeEnabled()
    expect(b.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('shows a Connection Suggestion with a dashed kind chip, and leaves out the model when there is none', async () => {
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    const b = within(block('k1'))
    expect(b.getByText('Connection')).toHaveClass('qs-kind', 'qs-kind--connection')
    expect(b.getByText('Board: main')).toBeInTheDocument()
    expect(block('k1').querySelector('.qs-item__title')).toHaveTextContent('Noise-induced plateaus → Reward plateaus')
    expect(b.getByText('may explain')).toHaveClass('qs-item__meta')
    expect(b.getByText("via Mei's AI · 14 Nov")).toBeInTheDocument()
  })

  it('says "a former Member" for someone who is no longer on the team', async () => {
    fake.show(
      sourceSuggestion('s1', { created_by: 'gone', model: undefined }),
      sourceSuggestion('s2', { state: 'rejected', decided_by: 'gone', decided_at: at(16, 8) }),
    )
    renderPanel()
    await settle()
    expect(within(block('s1')).getByText("via a former Member's AI · 14 Nov")).toBeInTheDocument()
    expect(within(block('s2')).getByText('Rejected by a former Member · 16 Nov')).toBeInTheDocument()
  })

  it('asks for the team when it has no names yet', async () => {
    membersStore.setState({ list: [] })
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    expect(fake.people.reload).toHaveBeenCalled()
  })
})

describe('previewing a Connection on the Board', () => {
  const K1 = { id: 'k1', from: 'c1', to: 'c2', kind: 'directed', label: 'may explain' }

  it('hovering sets the preview and leaving clears it', async () => {
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    fireEvent.mouseEnter(block('k1'))
    expect(preview()).toEqual(K1)
    expect(block('k1')).toHaveClass('is-previewing')
    expect(within(block('k1')).getByText('previewing on Board ↗')).toBeInTheDocument()
    fireEvent.mouseLeave(block('k1'))
    expect(preview()).toBeNull()
    expect(block('k1')).not.toHaveClass('is-previewing')
    expect(screen.queryByText('previewing on Board ↗')).toBeNull()
  })

  it('keyboard focus on its buttons sets the preview and moving on clears it', async () => {
    fake.show(connectionSuggestion('k1'), sourceSuggestion('s1'))
    renderPanel()
    await settle()
    const accept = within(block('k1')).getByRole('button', { name: 'Accept' })
    const reject = within(block('k1')).getByRole('button', { name: 'Reject' })
    act(() => accept.focus())
    expect(preview()).toEqual(K1)
    act(() => reject.focus()) // still inside the same block
    expect(preview()).toEqual(K1)
    act(() => within(block('s1')).getByRole('button', { name: 'Accept' }).focus())
    expect(preview()).toBeNull()
  })

  it('moves from one Connection to the next', async () => {
    fake.show(connectionSuggestion('k1'), connectionSuggestion('k2', { connection: { from: 'c2', to: 'c1', kind: 'related' } }))
    renderPanel()
    await settle()
    fireEvent.mouseEnter(block('k1'))
    fireEvent.mouseLeave(block('k1'))
    fireEvent.mouseEnter(block('k2'))
    expect(preview()).toEqual({ id: 'k2', from: 'c2', to: 'c1', kind: 'related', label: '' })
  })

  it('does not preview a Source, a decided Connection, or one whose Card is gone', async () => {
    fake.show(
      sourceSuggestion('s1'),
      connectionSuggestion('k1', { state: 'accepted', decided_by: MEI.id, decided_at: at(15, 10) }),
      connectionSuggestion('k2', { connection: { from: 'c1', to: 'nope', kind: 'related' } }, { stale: true, cards: ['c1'] }),
    )
    renderPanel()
    await settle()
    for (const id of ['s1', 'k1', 'k2']) {
      fireEvent.mouseEnter(block(id))
      expect(preview()).toBeNull()
      fireEvent.mouseLeave(block(id))
    }
  })

  it('clears the preview when the panel unmounts, also under StrictMode', async () => {
    fake.show(connectionSuggestion('k1'))
    const view = render(
      <StrictMode>
        <SuggestionsPanel />
      </StrictMode>,
    )
    await settle()
    fireEvent.mouseEnter(block('k1'))
    expect(preview()).toEqual(K1)
    view.unmount()
    expect(preview()).toBeNull()
  })

  it('clears the preview when the hovered Suggestion disappears from the list', async () => {
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    fireEvent.mouseEnter(block('k1'))
    act(() => fake.show())
    expect(preview()).toBeNull()
  })
})

describe('deciding', () => {
  it('accepting a Connection calls suggestions.accept and reads "Accepted by you · just now"', async () => {
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    fireEvent.mouseEnter(block('k1'))
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Accept' }))
    await settle()
    expect(suggestions.accept).toHaveBeenCalledExactlyOnceWith('k1')
    expect(within(block('k1')).getByText('Accepted by you · just now')).toBeInTheDocument()
    expect(block('k1')).toHaveClass('is-decided')
    expect(within(block('k1')).queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(preview()).toBeNull() // nothing left to preview
    expect(screen.getByTestId('suggestions-count')).toHaveTextContent('0 pending')
    expect(todos.add).not.toHaveBeenCalled()
  })

  it('accepting a Source offers a To-do, checked, assigned to you; creating it calls todos.add', async () => {
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('s1')).getByRole('button', { name: 'Accept' }))
    await settle()
    expect(suggestions.accept).toHaveBeenCalledExactlyOnceWith('s1')
    const offer = within(screen.getByTestId('suggestion-offer-s1'))
    expect(offer.getByText('✓ Source added to Card: Noise-induced plateaus')).toBeInTheDocument()
    expect(offer.getByRole('checkbox')).toBeChecked()
    expect(screen.getByTestId('suggestion-offer-s1')).toHaveTextContent('Also create a To-do: Read this, assigned to')
    const owner = offer.getByRole('combobox', { name: 'To-do owner' })
    expect(owner).toHaveValue(ANA.id)
    expect(within(owner).getAllByRole('option').map((o) => o.textContent)).toEqual(['Ana Ruiz (you)', 'Mei Tanaka'])
    expect(block('s1')).not.toHaveClass('is-decided')

    fireEvent.click(offer.getByRole('button', { name: 'Create To-do' }))
    await settle()
    expect(todos.add).toHaveBeenCalledExactlyOnceWith({
      owner: ANA.id,
      text: 'Read: Noise-induced barren plateaus',
      card: { id: 'c1', title: 'Noise-induced plateaus', branch: MAIN.id },
    })
    expect(screen.queryByTestId('suggestion-offer-s1')).toBeNull()
    expect(within(block('s1')).getByText('Accepted · To-do “Read this” created for Ana')).toBeInTheDocument()
  })

  it('assigns the To-do to the Member chosen', async () => {
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('s1')).getByRole('button', { name: 'Accept' }))
    await settle()
    fireEvent.change(screen.getByRole('combobox', { name: 'To-do owner' }), { target: { value: MEI.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Create To-do' }))
    await settle()
    expect(todos.add).toHaveBeenCalledWith(expect.objectContaining({ owner: MEI.id }))
    expect(within(block('s1')).getByText('Accepted · To-do “Read this” created for Mei')).toBeInTheDocument()
  })

  it('unchecked, the button reads "Done" and no To-do is created', async () => {
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('s1')).getByRole('button', { name: 'Accept' }))
    await settle()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.queryByRole('button', { name: 'Create To-do' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await settle()
    expect(todos.add).not.toHaveBeenCalled()
    expect(within(block('s1')).getByText('Accepted by you · just now')).toBeInTheDocument()
    expect(block('s1')).toHaveClass('is-decided')
  })

  it('keeps the offer and says so when the To-do cannot be created', async () => {
    todos.add.mockRejectedValueOnce(new Error('boom'))
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('s1')).getByRole('button', { name: 'Accept' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Create To-do' }))
    await settle()
    expect(within(block('s1')).getByText('That To-do could not be created. Try again in a moment.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create To-do' })).toBeEnabled()
  })

  it('rejecting reads "Rejected by you · just now · Undo", and Undo reopens it', async () => {
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Reject' }))
    await settle()
    expect(suggestions.reject).toHaveBeenCalledExactlyOnceWith('k1')
    expect(block('k1').querySelector('.qs-item__resolved')).toHaveTextContent('Rejected by you · just now · Undo')
    expect(block('k1')).toHaveClass('is-decided')

    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Undo' }))
    await settle()
    expect(suggestions.reopen).toHaveBeenCalledExactlyOnceWith('k1')
    expect(within(block('k1')).getByRole('button', { name: 'Accept' })).toBeEnabled()
    expect(block('k1').querySelector('.qs-item__resolved')).toBeNull()
  })

  it('words decisions made by others, and by you earlier, with the date; only your own rejection can be undone', async () => {
    fake.show(
      sourceSuggestion('s1', { state: 'accepted', decided_by: MEI.id, decided_at: at(15, 10) }),
      connectionSuggestion('k1', { state: 'rejected', decided_by: MEI.id, decided_at: at(16, 10) }),
      connectionSuggestion('k2', { state: 'rejected', decided_by: ANA.id, decided_at: at(17, 10) }),
      sourceSuggestion('s2', { state: 'accepted', decided_by: ANA.id, decided_at: at(18, 10) }),
    )
    renderPanel()
    await settle()
    expect(within(block('s1')).getByText('Accepted by Mei · 15 Nov')).toBeInTheDocument()
    expect(within(block('k1')).getByText('Rejected by Mei · 16 Nov')).toBeInTheDocument()
    expect(within(block('k1')).queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(block('k2').querySelector('.qs-item__resolved')).toHaveTextContent('Rejected by you · 17 Nov · Undo')
    expect(within(block('s2')).getByText('Accepted by you · 18 Nov')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByTestId('suggestion-offer-s2')).toBeNull()
  })

  it('stale: explains, and only offers Reject', async () => {
    fake.show(sourceSuggestion('s1', {}, { stale: true, cards: [] }))
    boardStore.setState({ cards: [C2] })
    renderPanel()
    await settle()
    const b = within(block('s1'))
    expect(b.getByText('The Card this was for is no longer on this Branch.')).toBeInTheDocument()
    expect(b.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(b.getByRole('button', { name: 'Reject' })).toBeEnabled()
    // The Card is gone, so its name is plain text.
    expect(block('s1').querySelector('.qs-item__target')).toHaveTextContent('for Card: Noise-induced plateaus')
    expect(b.queryByRole('button', { name: 'Noise-induced plateaus' })).toBeNull()
  })

  it('existingSource: says that accepting attaches the Source already in Sheaf', async () => {
    fake.show(sourceSuggestion('s1', {}, { existingSource: 'src-7' }))
    renderPanel()
    await settle()
    expect(within(block('s1')).getByText('Already in Sheaf — accepting attaches the existing Source.')).toBeInTheDocument()
    expect(within(block('s1')).getByRole('button', { name: 'Accept' })).toBeEnabled()
  })

  it('already_decided: says so and refreshes the list', async () => {
    suggestions.accept.mockRejectedValueOnce(new ApiError(409, 'already_decided', 'Already decided.'))
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    const before = suggestions.reload.mock.calls.length
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Accept' }))
    await settle()
    expect(within(block('k1')).getByText('Someone else already decided this one.')).toBeInTheDocument()
    expect(suggestions.reload.mock.calls.length).toBe(before + 1)
  })

  it('any other failure: a plain sentence in the block, and the buttons work again', async () => {
    suggestions.accept.mockRejectedValueOnce(new ApiError(500, 'internal', 'pq: deadlock detected'))
    suggestions.reject.mockRejectedValueOnce(new Error('boom'))
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    const before = suggestions.reload.mock.calls.length
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Accept' }))
    await settle()
    expect(within(block('k1')).getByText('This Suggestion could not be accepted. Try again in a moment.')).toBeInTheDocument()
    expect(screen.queryByText(/deadlock/)).toBeNull()
    expect(suggestions.reload.mock.calls.length).toBe(before)
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Reject' }))
    await settle()
    expect(within(block('k1')).getByText('This Suggestion could not be rejected. Try again in a moment.')).toBeInTheDocument()
    expect(within(block('k1')).getByRole('button', { name: 'Accept' })).toBeEnabled()
  })

  it('a Card that went away between looking and accepting: says the Card is gone', async () => {
    suggestions.accept.mockRejectedValueOnce(new ApiError(409, 'rejected', 'Rejected.'))
    fake.show(sourceSuggestion('s1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('s1')).getByRole('button', { name: 'Accept' }))
    await settle()
    expect(within(block('s1')).getByText('The Card this was for is no longer on this Branch.')).toBeInTheDocument()
    expect(screen.queryByTestId('suggestion-offer-s1')).toBeNull()
  })
})

describe('empty and loading', () => {
  it('empty: says what will appear here and links to AI access', async () => {
    renderPanel()
    await settle()
    expect(screen.getByRole('heading', { name: 'No Suggestions' })).toBeInTheDocument()
    expect(
      screen.getByText("When a Member's AI proposes a Source or a Connection, it appears here for the team to review."),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set up AI access' })).toHaveAttribute('href', '/settings/ai')
    expect(screen.getByTestId('suggestions-count')).toHaveTextContent('0 pending')
  })

  it('loading: nothing for 150 ms, then "Loading Suggestions…", then the list', async () => {
    vi.useFakeTimers()
    let loaded = () => {}
    suggestions.reload.mockImplementation(() => new Promise<void>((resolve) => (loaded = resolve)))
    renderPanel()
    expect(screen.queryByText('Loading Suggestions…')).toBeNull()
    expect(screen.queryByText('No Suggestions')).toBeNull()
    act(() => void vi.advanceTimersByTime(149))
    expect(screen.queryByText('Loading Suggestions…')).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(screen.getByText('Loading Suggestions…')).toBeInTheDocument()
    await act(async () => {
      fake.show(sourceSuggestion('s1'))
      loaded()
    })
    expect(screen.queryByText('Loading Suggestions…')).toBeNull()
    expect(block('s1')).toBeInTheDocument()
  })

  it('a list that could not be loaded: a plain sentence and "Try again"', async () => {
    suggestions.reload.mockRejectedValueOnce(new ApiError(0, 'network', 'Cannot reach the server.'))
    renderPanel()
    await settle()
    expect(screen.getByText('Suggestions could not be loaded.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'No Suggestions' })).toBeInTheDocument()
  })

  it('under StrictMode the list still ends up loaded', async () => {
    render(
      <StrictMode>
        <SuggestionsPanel />
      </StrictMode>,
    )
    await settle()
    expect(screen.getByRole('heading', { name: 'No Suggestions' })).toBeInTheDocument()
  })
})

describe('getting around', () => {
  it('a Card name in the target or the title focuses that Card on the Board', async () => {
    fake.show(sourceSuggestion('s1'), connectionSuggestion('k1'))
    renderPanel()
    await settle()
    fireEvent.click(within(block('s1')).getByRole('button', { name: 'Noise-induced plateaus' }))
    expect(useBoardRequest.getState().request).toMatchObject({ type: 'focus', target: 'card', id: 'c1' })
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Reward plateaus' }))
    expect(useBoardRequest.getState().request).toMatchObject({ type: 'focus', target: 'card', id: 'c2' })
    fireEvent.click(within(block('k1')).getByRole('button', { name: 'Noise-induced plateaus' }))
    expect(useBoardRequest.getState().request).toMatchObject({ type: 'focus', target: 'card', id: 'c1' })
  })

  it('moves focus to its heading when it opens', async () => {
    renderPanel()
    await settle()
    expect(screen.getByRole('heading', { name: 'Suggestions' })).toHaveFocus()
  })

  it('Esc with focus in the panel closes it', async () => {
    fake.show(connectionSuggestion('k1'))
    renderPanel()
    await settle()
    fireEvent.mouseEnter(block('k1'))
    fireEvent.keyDown(within(block('k1')).getByRole('button', { name: 'Reject' }), { key: 'Escape' })
    expect(useSuggestionsPanel.getState()).toMatchObject({ open: false, preview: null })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('✕ closes it', async () => {
    renderPanel()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Close Suggestions' }))
    expect(useSuggestionsPanel.getState().open).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
