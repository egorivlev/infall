import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardVM, ConnectionVM } from '../../lib'

const submit = vi.fn<(ops: unknown[]) => Promise<void>>()
vi.mock('../../lib', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib')>()
  return { ...real, board: { open: vi.fn(), close: vi.fn(), submit: (ops: unknown[]) => submit(ops) } }
})

const { ops } = await import('../../lib')
const { Inspector } = await import('./Inspector')
const { StatusMenu } = await import('./StatusMenu')
const { Toolbar } = await import('./Toolbar')
const { EmptyState, LoadingNote } = await import('./BoardMessage')
const { toasts } = await import('./toastStore')

const card = (id: string, title: string, extra: Partial<CardVM> = {}): CardVM => ({
  id,
  title,
  summary: '',
  status: 'idea',
  x: 0,
  y: 0,
  w: 224,
  h: 132,
  ...extra,
})

const A = card('a', 'Surface code basics', { summary: 'Stabilizers on a lattice.', status: 'understood' })
const B = card('b', 'MWPM decoder')
const C = card('c', 'Toric code')
const cards = new Map([A, B, C].map((c) => [c.id, c]))
const conns: ConnectionVM[] = [
  { id: 'k1', from: 'a', to: 'b', kind: 'directed', label: 'builds on' },
  { id: 'k2', from: 'c', to: 'a', kind: 'related', label: '' },
  { id: 'k3', from: 'b', to: 'c', kind: 'related', label: '' }, // not A's
]

function renderInspector(readOnly = false, overrides: Partial<Parameters<typeof Inspector>[0]> = {}) {
  const props = {
    card: A,
    connections: conns,
    cards,
    readOnly,
    onSelectCard: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<Inspector {...props} />) }
}

beforeEach(() => {
  submit.mockReset()
  submit.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  act(() => toasts.clear())
})

describe('Inspector', () => {
  it('confirms a title edit on Enter with one setText op', async () => {
    const user = userEvent.setup()
    renderInspector()
    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Rotated surface code{Enter}')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith([ops.setText('a', 'title', 'Rotated surface code')])
  })

  it('confirms the summary on blur, and Esc cancels without sending', async () => {
    const user = userEvent.setup()
    renderInspector()
    const summary = screen.getByRole('textbox', { name: 'Summary' })
    await user.type(summary, ' Distance d.')
    await user.tab()
    expect(submit).toHaveBeenLastCalledWith([ops.setText('a', 'summary', 'Stabilizers on a lattice. Distance d.')])

    submit.mockClear()
    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.type(title, ' draft{Escape}')
    expect(submit).not.toHaveBeenCalled()
    expect(title).toHaveValue('Surface code basics')
  })

  it('keeps the draft while typing even if the Card changes remotely', async () => {
    const user = userEvent.setup()
    const { rerender, props } = renderInspector()
    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.type(title, '!')
    rerender(<Inspector {...props} card={{ ...A, title: 'Changed elsewhere' }} />)
    expect(title).toHaveValue('Surface code basics!')
    await user.tab()
    rerender(<Inspector {...props} card={{ ...A, title: 'Changed again' }} />)
    expect(title).toHaveValue('Changed again')
  })

  it('sets the status from its picker', async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.click(screen.getByRole('radio', { name: 'Open question' }))
    expect(submit).toHaveBeenCalledWith([ops.setStatus('a', 'open_question')])
  })

  it("lists the Card's Connections and selects the other Card on click", async () => {
    const user = userEvent.setup()
    const { props } = renderInspector()
    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('button')
    expect(items.map((b) => b.textContent)).toEqual(['→MWPM decoderbuilds on', '—Toric code'])
    await user.click(items[1]!)
    expect(props.onSelectCard).toHaveBeenCalledWith('c')
  })

  it('offers Delete Card', async () => {
    const user = userEvent.setup()
    const { props } = renderInspector()
    await user.click(screen.getByRole('button', { name: 'Delete Card' }))
    expect(props.onDelete).toHaveBeenCalled()
  })
})

describe('read-only', () => {
  it('Inspector shows the Card without any editing affordance', () => {
    renderInspector(true)
    expect(screen.getByTestId('inspector')).toHaveTextContent('Surface code basics')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete Card' })).toBeNull()
    // Navigation along Connections is still allowed.
    expect(screen.getAllByRole('button', { name: /MWPM decoder|Toric code/ })).toHaveLength(2)
  })

  it('Toolbar is absent', () => {
    const { container } = render(<Toolbar readOnly onAddCard={vi.fn()} onAddFrame={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('empty state has no add prompt or button', () => {
    render(<EmptyState readOnly onAddCard={vi.fn()} />)
    expect(screen.getByText('Nothing on this Board yet')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Double-click/)).toBeNull()
  })
})

describe('Toolbar', () => {
  it('adds a Card and a Frame', async () => {
    const user = userEvent.setup()
    const onAddCard = vi.fn()
    const onAddFrame = vi.fn()
    render(<Toolbar readOnly={false} onAddCard={onAddCard} onAddFrame={onAddFrame} />)
    await user.click(screen.getByTestId('toolbar-add-card'))
    await user.click(screen.getByTestId('toolbar-add-frame'))
    expect(onAddCard).toHaveBeenCalledOnce()
    expect(onAddFrame).toHaveBeenCalledOnce()
  })
})

describe('empty and loading', () => {
  it('empty state renders its prompt and the + Card button', async () => {
    const user = userEvent.setup()
    const onAddCard = vi.fn()
    render(<EmptyState readOnly={false} onAddCard={onAddCard} />)
    expect(screen.getByRole('heading', { name: 'Nothing on this Board yet' })).toBeInTheDocument()
    expect(screen.getByText('Double-click anywhere to add the first Card.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Card' }))
    expect(onAddCard).toHaveBeenCalledOnce()
  })

  it('shows nothing for 150 ms, then plain loading text', () => {
    vi.useFakeTimers()
    try {
      render(<LoadingNote />)
      expect(screen.queryByText('Loading Board…')).toBeNull()
      act(() => vi.advanceTimersByTime(149))
      expect(screen.queryByText('Loading Board…')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByText('Loading Board…')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('StatusMenu', () => {
  it('lists the five statuses with glyph and word, marks the current one, and picks', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<StatusMenu value="reading" onPick={onPick} onClose={vi.fn()} />)
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['Idea', 'Reading', 'Understood', 'Open question', 'Dead end · kept'])
    expect(items.every((i) => i.querySelector('svg.q-glyph'))).toBe(true)
    expect(screen.getByRole('menuitemradio', { name: 'Reading' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'Reading' })).toHaveFocus()
    await user.click(screen.getByRole('menuitemradio', { name: 'Dead end · kept' }))
    expect(onPick).toHaveBeenCalledWith('dead_end')
  })

  it('moves with arrow keys and closes on Esc', () => {
    const onClose = vi.fn()
    render(<StatusMenu value="idea" onPick={vi.fn()} onClose={onClose} />)
    const menu = screen.getByRole('menu', { name: 'Status' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitemradio', { name: 'Reading' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitemradio', { name: 'Dead end · kept' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
