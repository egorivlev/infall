import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { ops } = await import('../../lib')
const { PagePanel } = await import('./PagePanel')
const { RELEASE_GRACE_MS, editLock } = await import('./lock')
const { toasts } = await import('../board/toastStore')
const { pagePanel, useBoardRequest, usePagePanel } = await import('../bridge')
const { ANA, GUEST, MEI, block, card, source, todo } = await import('./testkit')
const { MAIN, at } = await import('../history/testkit')

const { boardStore, pageStore, todoStore, sessionStore, submit, page, todos, orderBetween } = fake

const A = card('a', 'QRL on CartPole', { status: 'open_question', x: 40, y: 40 })
const B = card('b', 'Data re-uploading', { x: 900 })
const C = card('c', 'Reward plateaus at ~180', { x: 900, y: 400 })
const onClose = vi.fn<(cardId: string) => void>()

function seed() {
  boardStore.setState({
    cards: [A, B, C],
    frames: [{ id: 'f1', title: 'QRL experiments', x: 0, y: 0, w: 520, h: 360 }],
    connections: [
      { id: 'k1', from: 'a', to: 'b', kind: 'directed', label: 'uses' },
      { id: 'k2', from: 'c', to: 'a', kind: 'directed', label: '' },
      { id: 'k3', from: 'a', to: 'c', kind: 'contradicts', label: '' },
      { id: 'k4', from: 'b', to: 'c', kind: 'related', label: 'elsewhere' },
    ],
  })
  pageStore.setState({
    blocks: [
      block('b2', 'a', '2', '## Method\n\nSecond paragraph'),
      block('b1', 'a', '1', 'First **bold** paragraph'),
      block('b3', 'a', '3', 'Third with $x^2$'),
      block('bx', 'b', '1', 'On another Card'),
    ],
    sources: [
      source('s1', { title: 'Parametrized quantum policies', authors: 'S. Jerbi, V. Dunjko', year: '2021', url: 'https://arxiv.org/abs/2103.05577', cards: ['a'] }),
      source('s2', { title: 'Data re-uploading for a universal quantum classifier', year: '2020', doi: '10.22331/q-2020-02-06-226', cards: ['a', 'b'] }),
      source('s3', { url: 'https://www.nature.com/articles/s41586-019-1666-5', cards: ['a'] }),
      source('s4', { title: 'Scheme for reducing decoherence', doi: '10.1103/physreva.52.r2493' }),
    ],
    attachments: [
      { id: 'at1', card: 'a', source: 's1' },
      { id: 'at2', card: 'a', source: 's2' },
      { id: 'at3', card: 'a', source: 's3' },
      { id: 'at9', card: 'b', source: 's2' },
    ],
  })
  todoStore.setState({
    list: [
      todo('t1', 'ana', 'Try trainable β in the softmax readout', { card: { id: 'a', title: 'QRL on CartPole', branch: MAIN.id }, created_at: 1 }),
      todo('t2', 'mei', 'Re-run with 5 seeds', { card: { id: 'a', title: 'QRL on CartPole', branch: MAIN.id }, created_by: 'ana', created_at: 2 }),
      todo('t3', 'ana', 'Already done', { card: { id: 'a', title: 'QRL on CartPole', branch: MAIN.id }, done: true }),
      todo('t4', 'ana', 'About another Card', { card: { id: 'b', title: 'Data re-uploading', branch: MAIN.id } }),
      todo('t5', 'ana', 'About no Card'),
    ],
  })
}

beforeEach(() => {
  fake.reset()
  onClose.mockReset()
  usePagePanel.setState({ cardId: 'a', full: false })
  useBoardRequest.setState({ request: null })
  seed()
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

const open = (cardId = 'a') => render(<PagePanel cardId={cardId} full={false} onClose={onClose} />)
const panel = () => screen.getByTestId('page-panel')
const view = (n: number) => screen.getByRole('group', { name: `Block ${n}. Press Enter to edit.` })
const editor = (n: number) => screen.getByRole<HTMLTextAreaElement>('textbox', { name: `Block ${n}, Markdown` })
const blockIds = () => [...panel().querySelectorAll('[data-block]')].map((el) => el.getAttribute('data-block'))
const flush = () => act(async () => {})
const lastBatch = () => submit.mock.calls[submit.mock.calls.length - 1]![0]

describe('Page panel: frame', () => {
  it('is a labelled section, not a dialog, and takes focus on its heading', () => {
    open()
    const el = screen.getByRole('region', { name: 'Page of QRL on CartPole' })
    expect(el.tagName).toBe('SECTION')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(el).not.toHaveAttribute('aria-modal')
    expect(screen.getByRole('heading', { level: 1, name: 'QRL on CartPole' })).toHaveFocus()
  })

  it('shows the header: Frame › Page, status, sync text, full width and close', () => {
    open()
    const head = within(panel().querySelector('header')!)
    expect(head.getByText('Frame: QRL experiments')).toBeInTheDocument()
    expect(head.getByText('Page')).toBeInTheDocument()
    expect(head.getByRole('button', { name: 'Status: Open question. Change status' })).toHaveTextContent('Open question')
    expect(head.getByText('Synced')).toBeInTheDocument()
    expect(head.getByRole('button', { name: 'Open full width' })).toHaveAttribute('aria-pressed', 'false')
    expect(head.getByRole('button', { name: 'Close Page' })).toBeInTheDocument()

    act(() => boardStore.setState({ pending: 2 }))
    expect(head.getByText('Syncing…')).toBeInTheDocument()
  })

  it('leaves the Frame out when the Card sits in none', () => {
    act(() => boardStore.setState({ frames: [] }))
    open()
    expect(screen.queryByText(/^Frame:/)).toBeNull()
    expect(screen.getByText('Page')).toBeInTheDocument()
  })

  it('shows the meta row with counts, singular where it is one', () => {
    open()
    expect(screen.getByText('3 blocks · 3 Sources · 3 Connections')).toBeInTheDocument()
    cleanup()
    open('b')
    expect(screen.getByText('1 block · 1 Source · 2 Connections')).toBeInTheDocument()
  })

  it('⤢ toggles full width; ✕ closes', () => {
    const view = open()
    fireEvent.click(screen.getByRole('button', { name: 'Open full width' }))
    expect(usePagePanel.getState().full).toBe(true)
    view.rerender(<PagePanel cardId="a" full onClose={onClose} />)
    expect(panel()).toHaveClass('is-full')
    expect(screen.getByRole('button', { name: 'Open full width' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Close Page' }))
    expect(onClose).toHaveBeenCalledWith('a')
  })

  it('Esc closes when nothing is being edited — but not from a field, and not while a Block is edited', () => {
    open()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New To-do' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(view(1))
    fireEvent.keyDown(editor(1), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()

    fireEvent.keyDown(view(1), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('changes the status with the Board’s status menu', () => {
    open()
    const button = screen.getByRole('button', { name: 'Status: Open question. Change status' })
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(screen.getByRole('menu', { name: 'Status' })).getByRole('menuitemradio', { name: 'Understood' }))
    expect(submit).toHaveBeenCalledWith([ops.setStatus('a', 'understood')])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Status: Understood. Change status' })).toHaveFocus()
  })

  it('Esc in the status menu closes the menu, not the panel', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Change status/ }))
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Open question' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('Page panel: title', () => {
  it('edits in place: click, type, Enter', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'QRL on CartPole' }))
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Title' })
    expect(field).toHaveFocus()
    expect(field.value).toBe('QRL on CartPole')
    fireEvent.change(field, { target: { value: '  QRL on Acrobot ' } })
    expect(submit).not.toHaveBeenCalled() // the draft is local until it is confirmed
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith([ops.setText('a', 'title', 'QRL on Acrobot')])
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull()
    expect(screen.getByRole('button', { name: 'QRL on Acrobot' })).toHaveFocus()
    expect(panel()).toHaveAccessibleName('Page of QRL on Acrobot')
  })

  it('blur confirms; Esc cancels; an unchanged title sends nothing', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'QRL on CartPole' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Changed' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Escape' })
    expect(submit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'QRL on CartPole' }))
    fireEvent.blur(screen.getByRole('textbox', { name: 'Title' }))
    expect(submit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'QRL on CartPole' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'By blur' } })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Title' }))
    expect(submit).toHaveBeenCalledWith([ops.setText('a', 'title', 'By blur')])
  })

  it('shows "Untitled" for an empty title, and an empty title can be set', () => {
    act(() => boardStore.setState({ cards: [{ ...A, title: '' }, B, C] }))
    open()
    expect(panel()).toHaveAccessibleName('Page of Untitled')
    fireEvent.click(screen.getByRole('button', { name: 'Untitled' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Title' }).value).toBe('')
  })
})

describe('Page panel: Blocks', () => {
  it('renders the Blocks in order, as Markdown', () => {
    open()
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
    expect(within(view(1)).getByText('bold').tagName).toBe('STRONG')
    expect(within(view(2)).getByRole('heading', { level: 3, name: 'Method' })).toBeInTheDocument()
    expect(view(3).querySelector('.katex annotation')!.textContent).toBe('x^2')
    expect(screen.queryByText('On another Card')).toBeNull()
  })

  it('click opens the Markdown source with the hint; blur commits exactly one setBlockText', () => {
    open()
    fireEvent.click(view(1))
    const field = editor(1)
    expect(field).toHaveFocus()
    expect(field.value).toBe('First **bold** paragraph')
    expect(screen.getByText('Markdown · $math$ · ⌘Enter to finish · Esc to cancel')).toBeInTheDocument()
    expect(field).toHaveAccessibleDescription('Markdown · $math$ · ⌘Enter to finish · Esc to cancel')

    fireEvent.change(field, { target: { value: 'First *changed* paragraph\n' } })
    expect(submit).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith([{ fake: 'setBlockText', block: 'b1', text: 'First *changed* paragraph' }])
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(within(view(1)).getByText('changed').tagName).toBe('EM')
  })

  it('Enter on a focused Block opens it; ⌘Enter and Ctrl+Enter finish and return focus to the Block', () => {
    open()
    view(2).focus()
    fireEvent.keyDown(view(2), { key: 'Enter' })
    fireEvent.change(editor(2), { target: { value: 'Second, rewritten' } })
    fireEvent.keyDown(editor(2), { key: 'Enter' }) // a plain Enter is a new line
    expect(submit).not.toHaveBeenCalled()
    fireEvent.keyDown(editor(2), { key: 'Enter', metaKey: true })
    expect(submit).toHaveBeenCalledWith([{ fake: 'setBlockText', block: 'b2', text: 'Second, rewritten' }])
    expect(view(2)).toHaveFocus()

    fireEvent.keyDown(view(2), { key: 'Enter' })
    fireEvent.change(editor(2), { target: { value: 'Second, again' } })
    fireEvent.keyDown(editor(2), { key: 'Enter', ctrlKey: true })
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'b2', text: 'Second, again' }])
  })

  it('Esc cancels: nothing is sent and the text stays', () => {
    open()
    fireEvent.click(view(1))
    fireEvent.change(editor(1), { target: { value: 'thrown away' } })
    fireEvent.keyDown(editor(1), { key: 'Escape' })
    expect(submit).not.toHaveBeenCalled()
    expect(view(1)).toHaveTextContent('First bold paragraph')
    expect(view(1)).toHaveFocus()
  })

  it('an unchanged Block sends nothing', () => {
    open()
    fireEvent.click(view(3))
    fireEvent.blur(editor(3))
    expect(submit).not.toHaveBeenCalled()
  })

  it('a click on a link inside a Block follows the link instead of opening the editor', () => {
    act(() => pageStore.setState((s) => ({ blocks: [...s.blocks, block('b4', 'a', '4', 'See [the paper](https://example.org/p)')] })))
    open()
    fireEvent.click(screen.getByRole('link', { name: 'the paper' }))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
  })

  it('keeps the draft when the same Block changes remotely while it is being typed in', () => {
    open()
    fireEvent.click(view(1))
    fireEvent.change(editor(1), { target: { value: 'my words' } })
    act(() => pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'b1' ? { ...b, text: 'their words' } : b)) })))
    expect(editor(1).value).toBe('my words')
    fireEvent.blur(editor(1))
    expect(submit).toHaveBeenCalledWith([{ fake: 'setBlockText', block: 'b1', text: 'my words' }])
  })

  it('drops the editor without sending anything when the Block is removed elsewhere', () => {
    open()
    fireEvent.click(view(2))
    fireEvent.change(editor(2), { target: { value: 'lost' } })
    act(() => pageStore.setState({ deleted: new Set(['b2']) }))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(submit).not.toHaveBeenCalled()
    // …and it does not reopen by itself when the Block comes back.
    act(() => pageStore.setState({ deleted: new Set() }))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
  })

  it('adds a Block between two others and opens it; left empty, it is removed again without a toast', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block before block 2' }))
    expect(orderBetween).toHaveBeenCalledWith('1', '2')
    expect(submit).toHaveBeenCalledTimes(1)
    const added = lastBatch()[0] as { id: string }
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', text: '', order: '1.5' }])
    expect(blockIds()).toEqual(['b1', added.id, 'b2', 'b3'])
    expect(editor(2)).toHaveFocus()
    expect(editor(2).value).toBe('')

    fireEvent.blur(editor(2))
    expect(submit).toHaveBeenCalledTimes(2)
    expect(lastBatch()).toEqual([ops.remove(added.id)])
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('adds a Block at the end, and at the start', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    expect(orderBetween).toHaveBeenLastCalledWith('3', undefined)
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', text: '', order: '4' }])
    const id = (lastBatch()[0] as { id: string }).id
    fireEvent.change(editor(4), { target: { value: 'A new last paragraph' } })
    fireEvent.blur(editor(4))
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: id, text: 'A new last paragraph' }])
    expect(blockIds()).toEqual(['b1', 'b2', 'b3', id])

    fireEvent.click(screen.getByRole('button', { name: 'Add block at the start' }))
    expect(orderBetween).toHaveBeenLastCalledWith(undefined, '1')
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', text: '', order: '0' }])
    expect(editor(1)).toHaveFocus()
  })

  it('a new Block cancelled with Esc is removed too; whitespace counts as empty', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    const id = (lastBatch()[0] as { id: string }).id
    fireEvent.change(editor(4), { target: { value: 'typed, then cancelled' } })
    fireEvent.keyDown(editor(4), { key: 'Escape' })
    expect(lastBatch()).toEqual([ops.remove(id)])

    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    const id2 = (lastBatch()[0] as { id: string }).id
    fireEvent.change(editor(4), { target: { value: '  \n \n' } })
    fireEvent.blur(editor(4))
    expect(lastBatch()).toEqual([ops.remove(id2)])
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
  })

  it('emptying a Block that had text removes it, with Undo', async () => {
    open()
    fireEvent.click(view(1))
    fireEvent.change(editor(1), { target: { value: '' } })
    fireEvent.blur(editor(1))
    expect(lastBatch()).toEqual([ops.remove('b1')])
    expect(screen.getByTestId('toast')).toHaveTextContent('Deleted 1 block.')
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(lastBatch()).toEqual([ops.restore('b1')])
    expect(view(1)).toHaveTextContent('First bold paragraph')
  })

  it('an empty Page says so and offers the first Block', () => {
    act(() => pageStore.setState({ blocks: [] }))
    open()
    expect(screen.getByText('This Page is empty.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ Add block' }))
    expect(orderBetween).toHaveBeenCalledWith(undefined, undefined)
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', text: '', order: '1' }])
    expect(editor(1)).toHaveFocus()
  })

  it('moves a Block up and down with an order key between its new neighbours', () => {
    open()
    const tools = (n: number) => within(screen.getByRole('group', { name: `Block ${n}` }))

    fireEvent.click(tools(3).getByRole('button', { name: 'Move block up' }))
    expect(orderBetween).toHaveBeenLastCalledWith('1', '2')
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'b3', order: '1.5' }])
    expect(blockIds()).toEqual(['b1', 'b3', 'b2'])

    fireEvent.click(tools(1).getByRole('button', { name: 'Move block down' }))
    expect(orderBetween).toHaveBeenLastCalledWith('1.5', '2')
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'b1', order: '1.75' }])
    expect(blockIds()).toEqual(['b3', 'b1', 'b2'])
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('moving to the very top or bottom asks for a key before the first / after the last', () => {
    open()
    const tools = (n: number) => within(screen.getByRole('group', { name: `Block ${n}` }))

    fireEvent.click(tools(2).getByRole('button', { name: 'Move block up' }))
    expect(orderBetween).toHaveBeenLastCalledWith(undefined, '1')
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'b2', order: '0' }])
    expect(blockIds()).toEqual(['b2', 'b1', 'b3'])

    fireEvent.click(tools(2).getByRole('button', { name: 'Move block down' }))
    expect(orderBetween).toHaveBeenLastCalledWith('3', undefined)
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'b1', order: '4' }])
    expect(blockIds()).toEqual(['b2', 'b3', 'b1'])
  })

  it('the first Block cannot move up and the last cannot move down; focus stays on a usable button', () => {
    open()
    const tools = (n: number) => within(screen.getByRole('group', { name: `Block ${n}` }))
    expect(tools(1).getByRole('button', { name: 'Move block up' })).toBeDisabled()
    expect(tools(1).getByRole('button', { name: 'Move block down' })).toBeEnabled()
    expect(tools(3).getByRole('button', { name: 'Move block down' })).toBeDisabled()
    expect(tools(3).getByRole('button', { name: 'Move block up' })).toBeEnabled()

    const up = tools(2).getByRole('button', { name: 'Move block up' })
    up.focus()
    fireEvent.click(up)
    // b2 is first now: its "up" is disabled, so focus moves to its "down".
    expect(tools(1).getByRole('button', { name: 'Move block down' })).toHaveFocus()
  })

  it('deletes a Block at once, with an Undo toast that restores it', async () => {
    open()
    fireEvent.click(within(screen.getByRole('group', { name: 'Block 2' })).getByRole('button', { name: 'Delete block' }))
    expect(submit).toHaveBeenCalledWith([ops.remove('b2')])
    expect(blockIds()).toEqual(['b1', 'b3'])
    const toast = screen.getByTestId('toast')
    expect(toast).toHaveTextContent('Deleted 1 block.')
    await flush()
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await flush()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(lastBatch()).toEqual([ops.restore('b2')])
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
    expect(screen.queryByTestId('toast')).toBeNull()
  })
})

describe('Page panel: the soft lock claim', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('claims when the first editor opens and lets go after the last one closes', () => {
    open()
    expect(page.startEditing).not.toHaveBeenCalled()
    fireEvent.click(view(1))
    expect(page.startEditing).toHaveBeenCalledTimes(1)
    expect(page.startEditing).toHaveBeenCalledWith('a')
    fireEvent.blur(editor(1))
    expect(page.stopEditing).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
    expect(page.startEditing).toHaveBeenCalledTimes(1)
  })

  it('keeps the claim while moving from one Block to the next', () => {
    open()
    fireEvent.click(view(1))
    fireEvent.blur(editor(1))
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS - 50))
    fireEvent.click(view(2))
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 3))
    expect(page.startEditing).toHaveBeenCalledTimes(1)
    expect(page.stopEditing).not.toHaveBeenCalled()

    fireEvent.keyDown(editor(2), { key: 'Escape' })
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)

    // A later edit claims again.
    fireEvent.click(view(3))
    expect(page.startEditing).toHaveBeenCalledTimes(2)
  })

  it('lets go at once when the panel closes while an editor is open', () => {
    const rendered = open()
    fireEvent.click(view(1))
    rendered.unmount()
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
  })

  it('never claims or lets go when nothing was edited', () => {
    const rendered = open()
    rendered.unmount()
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
    expect(page.startEditing).not.toHaveBeenCalled()
    expect(page.stopEditing).not.toHaveBeenCalled()
  })

  it('a new Block claims too; removing it again lets go', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    expect(page.startEditing).toHaveBeenCalledTimes(1)
    fireEvent.blur(editor(4))
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
  })

  it('lets go when the Block being edited is removed elsewhere', () => {
    open()
    fireEvent.click(view(2))
    act(() => pageStore.setState({ deleted: new Set(['b2']) }))
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
  })

  describe('under StrictMode (effects run twice in development)', () => {
    const openStrict = () =>
      render(
        <StrictMode>
          <PagePanel cardId="a" full={false} onClose={onClose} />
        </StrictMode>,
      )

    it('mounting does not claim, let go, or close anything', () => {
      openStrict()
      act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
      expect(page.startEditing).not.toHaveBeenCalled()
      expect(page.stopEditing).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('an editor still finishes: blur commits once, Esc cancels, the confirm key works', () => {
      openStrict()
      fireEvent.click(view(1))
      expect(editor(1)).toHaveFocus()
      fireEvent.change(editor(1), { target: { value: 'Committed under StrictMode' } })
      fireEvent.blur(editor(1))
      expect(submit).toHaveBeenCalledTimes(1)
      expect(submit).toHaveBeenCalledWith([{ fake: 'setBlockText', block: 'b1', text: 'Committed under StrictMode' }])
      expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()

      fireEvent.click(view(2))
      fireEvent.change(editor(2), { target: { value: 'cancelled' } })
      fireEvent.keyDown(editor(2), { key: 'Escape' })
      expect(submit).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()

      fireEvent.click(view(3))
      fireEvent.change(editor(3), { target: { value: 'by key' } })
      fireEvent.keyDown(editor(3), { key: 'Enter', metaKey: true })
      expect(submit).toHaveBeenCalledTimes(2)
      expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'b3', text: 'by key' }])
    })

    it('the title editor still finishes too', () => {
      openStrict()
      fireEvent.click(screen.getByRole('button', { name: 'QRL on CartPole' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Strict title' } })
      fireEvent.blur(screen.getByRole('textbox', { name: 'Title' }))
      expect(submit).toHaveBeenCalledWith([ops.setText('a', 'title', 'Strict title')])
      expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull()
    })

    it('claims exactly once per editing spell and lets go exactly once', () => {
      const rendered = openStrict()
      fireEvent.click(view(1))
      expect(page.startEditing).toHaveBeenCalledTimes(1)
      expect(page.stopEditing).not.toHaveBeenCalled()
      act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
      expect(page.stopEditing).not.toHaveBeenCalled() // still editing: the doubled effect did not release it

      fireEvent.blur(editor(1))
      act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
      expect(page.stopEditing).toHaveBeenCalledTimes(1)

      fireEvent.click(view(2))
      expect(page.startEditing).toHaveBeenCalledTimes(2)
      rendered.unmount()
      expect(page.stopEditing).toHaveBeenCalledTimes(2)
      act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
      expect(page.stopEditing).toHaveBeenCalledTimes(2)
    })

    it('a new Block opens once and is added once', () => {
      openStrict()
      fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
      expect(submit).toHaveBeenCalledTimes(1)
      expect(blockIds()).toHaveLength(4)
      expect(editor(4)).toHaveFocus()
    })
  })
})

describe('Page panel: Sources', () => {
  const row = (id: string) => within(screen.getByTestId(`source-${id}`))
  const form = (name: string) => within(screen.getByRole('form', { name }))

  it('lists the Sources with their count, year, authors and identifier', () => {
    open()
    expect(screen.getByRole('heading', { level: 2, name: 'Sources 3' })).toBeInTheDocument()
    expect(row('s1').getByText('Parametrized quantum policies')).toBeInTheDocument()
    expect(row('s1').getByText('2021')).toBeInTheDocument()
    expect(row('s1').getByText('S. Jerbi, V. Dunjko')).toBeInTheDocument()
    expect(row('s3').getByText('Untitled Source')).toBeInTheDocument()
    expect(screen.queryByText('Scheme for reducing decoherence')).toBeNull() // not attached to this Card
  })

  it('shows a DOI as doi:…, an arXiv address as arXiv:…, anything else by its host — each a real link', () => {
    open()
    const arxiv = row('s1').getByRole('link', { name: 'arXiv:2103.05577' })
    expect(arxiv).toHaveAttribute('href', 'https://arxiv.org/abs/2103.05577')
    const doi = row('s2').getByRole('link', { name: 'doi:10.22331/q-2020-02-06-226' })
    expect(doi).toHaveAttribute('href', 'https://doi.org/10.22331/q-2020-02-06-226')
    const host = row('s3').getByRole('link', { name: 'nature.com' })
    expect(host).toHaveAttribute('href', 'https://www.nature.com/articles/s41586-019-1666-5')
    for (const a of [arxiv, doi, host]) {
      expect(a).toHaveAttribute('target', '_blank')
      expect(a).toHaveAttribute('rel', 'noreferrer noopener')
    }
  })

  it('adds a new Source: createSource and attach go out as one batch', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    const f = form('Add Source')
    expect(f.getByLabelText('URL or DOI')).toHaveFocus()
    expect(f.getByLabelText('URL or DOI')).toBeRequired()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: ' https://arxiv.org/abs/2103.15084#abstract ' } })
    fireEvent.change(f.getByLabelText('Title'), { target: { value: ' Quantum agents in the Gym ' } })
    fireEvent.change(f.getByLabelText('Authors'), { target: { value: 'A. Skolik, S. Jerbi, V. Dunjko' } })
    fireEvent.change(f.getByLabelText('Year'), { target: { value: '2022' } })
    fireEvent.click(f.getByRole('button', { name: 'Add Source' }))

    expect(submit).toHaveBeenCalledTimes(1)
    const [create, attach] = lastBatch() as [{ id: string }, unknown]
    expect(create).toEqual({
      fake: 'createSource',
      id: expect.any(String),
      url: 'https://arxiv.org/abs/2103.15084',
      title: 'Quantum agents in the Gym',
      authors: 'A. Skolik, S. Jerbi, V. Dunjko',
      year: '2022',
    })
    expect(attach).toEqual({ fake: 'attach', card: 'a', source: create.id })
    expect(lastBatch()).toHaveLength(2)
    expect(screen.queryByRole('form')).toBeNull()
    expect(row(create.id).getByRole('link', { name: 'arXiv:2103.15084' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add Source' })).toHaveFocus()
  })

  it('a DOI typed as a doi.org address is kept as a DOI; optional fields left empty are left out', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    fireEvent.change(form('Add Source').getByLabelText('URL or DOI'), { target: { value: 'https://doi.org/10.1038/S41586-019-1666-5' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Add Source' }))
    const [create] = lastBatch() as [{ id: string }]
    expect(create).toEqual({ fake: 'createSource', id: expect.any(String), doi: '10.1038/s41586-019-1666-5' })
  })

  it('refuses something that is neither a URL nor a DOI, in plain words', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    const f = form('Add Source')
    fireEvent.click(f.getByRole('button', { name: 'Add Source' }))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('This needs a URL starting with http:// or https://, or a DOI such as 10.1103/PhysRevA.52.R2493.')
    expect(f.getByLabelText('URL or DOI')).toHaveAttribute('aria-invalid', 'true')
    expect(f.getByLabelText('URL or DOI')).toHaveAccessibleDescription(/This needs a URL/)

    for (const bad of ['javascript:alert(1)', 'arxiv 2103.05577', 'ftp://example.org/paper.pdf']) {
      fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: bad } })
      fireEvent.click(f.getByRole('button', { name: 'Add Source' }))
    }
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('form', { name: 'Add Source' })).toBeInTheDocument()

    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: 'https://example.org/paper' } })
    expect(screen.queryByRole('alert')).toBeNull() // the error clears as soon as it is fixed
  })

  it('finds a Source that is already in Qoop and attaches that one instead of making a duplicate', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    const f = form('Add Source')
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: 'doi:10.1103/PhysRevA.52.R2493' } })
    expect(page.findSource).toHaveBeenLastCalledWith({ doi: '10.1103/physreva.52.r2493' })
    expect(f.getByRole('status')).toHaveTextContent('Already in Qoop: Scheme for reducing decoherence')
    expect(f.queryByLabelText('Title')).toBeNull()
    expect(f.queryByRole('button', { name: 'Add Source' })).toBeNull()
    fireEvent.click(f.getByRole('button', { name: 'Attach' }))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([{ fake: 'attach', card: 'a', source: 's4' }])
    expect(row('s4').getByText('Scheme for reducing decoherence')).toBeInTheDocument()
  })

  it('finds an existing Source by URL too, and says when it is already on this Card', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    const f = form('Add Source')
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: 'https://arxiv.org/abs/2103.05577/' } })
    expect(page.findSource).toHaveBeenLastCalledWith({ url: 'https://arxiv.org/abs/2103.05577' })
    expect(f.getByRole('status')).toHaveTextContent('Already on this Card: Parametrized quantum policies')
    expect(f.getByRole('button', { name: 'Attach' })).toBeDisabled()
    fireEvent.submit(screen.getByRole('form', { name: 'Add Source' }))
    expect(submit).not.toHaveBeenCalled()
  })

  it('Cancel and Esc close the form without sending; Esc does not close the panel', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    fireEvent.change(form('Add Source').getByLabelText('URL or DOI'), { target: { value: 'https://example.org' } })
    fireEvent.keyDown(form('Add Source').getByLabelText('URL or DOI'), { key: 'Escape' })
    expect(screen.queryByRole('form')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    fireEvent.click(form('Add Source').getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })

  it('edits a Source in place: only the fields that changed are set', () => {
    open()
    fireEvent.click(row('s1').getByRole('button', { name: 'Edit Source: Parametrized quantum policies' }))
    const f = form('Edit Source')
    expect(f.getByLabelText<HTMLInputElement>('URL or DOI').value).toBe('https://arxiv.org/abs/2103.05577')
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('Parametrized quantum policies')
    expect(f.getByLabelText<HTMLInputElement>('Authors').value).toBe('S. Jerbi, V. Dunjko')
    expect(f.getByLabelText<HTMLInputElement>('Year').value).toBe('2021')
    expect(f.queryByRole('status')).toBeNull() // finding itself is not a duplicate

    fireEvent.change(f.getByLabelText('Title'), { target: { value: 'Parametrized quantum policies for reinforcement learning' } })
    fireEvent.change(f.getByLabelText('Year'), { target: { value: '' } })
    fireEvent.click(f.getByRole('button', { name: 'Update Source' }))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([
      { fake: 'setSourceField', source: 's1', field: 'title', text: 'Parametrized quantum policies for reinforcement learning' },
      { fake: 'setSourceField', source: 's1', field: 'year', text: '' },
    ])
    expect(screen.queryByRole('form')).toBeNull()
    expect(row('s1').getByRole('button', { name: /^Edit Source/ })).toHaveFocus()
  })

  it('editing the identifier from a URL to a DOI sets the DOI and clears the URL', () => {
    open()
    fireEvent.click(row('s3').getByRole('button', { name: 'Edit Source: Untitled Source' }))
    fireEvent.change(form('Edit Source').getByLabelText('URL or DOI'), { target: { value: '10.1038/s41586-019-1666-5' } })
    fireEvent.click(form('Edit Source').getByRole('button', { name: 'Update Source' }))
    expect(lastBatch()).toEqual([
      { fake: 'setSourceField', source: 's3', field: 'doi', text: '10.1038/s41586-019-1666-5' },
      { fake: 'setSourceField', source: 's3', field: 'url', text: '' },
    ])
    expect(row('s3').getByRole('link', { name: 'doi:10.1038/s41586-019-1666-5' })).toBeInTheDocument()
  })

  it('an edit may not turn a Source into a duplicate of another; an unchanged edit sends nothing', () => {
    open()
    fireEvent.click(row('s1').getByRole('button', { name: /^Edit Source/ }))
    expect(form('Edit Source').queryByText(/on 2 Cards/)).toBeNull()
    fireEvent.change(form('Edit Source').getByLabelText('URL or DOI'), { target: { value: '10.1103/PhysRevA.52.R2493' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Another Source in Qoop already has this URL or DOI: Scheme for reducing decoherence.')
    fireEvent.click(form('Edit Source').getByRole('button', { name: 'Update Source' }))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(form('Edit Source').getByRole('button', { name: 'Cancel' }))

    fireEvent.click(row('s2').getByRole('button', { name: /^Edit Source/ }))
    expect(form('Edit Source').getByText('This Source is on 2 Cards; the changes show on all of them.')).toBeInTheDocument()
    fireEvent.click(form('Edit Source').getByRole('button', { name: 'Update Source' }))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('removes a Source from this Card by removing its Attachment, with Undo', async () => {
    open()
    fireEvent.click(row('s1').getByRole('button', { name: 'Remove from this Card: Parametrized quantum policies' }))
    expect(submit).toHaveBeenCalledWith([ops.remove('at1')])
    expect(screen.queryByTestId('source-s1')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Sources 2' })).toBeInTheDocument()
    const toast = screen.getByTestId('toast')
    expect(toast).toHaveTextContent('Removed Source Parametrized quantum policies from this Card.')
    await flush()
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await flush()
    expect(lastBatch()).toEqual([ops.restore('at1')])
    expect(screen.getByTestId('source-s1')).toBeInTheDocument()
  })

  it('a Card without Sources says so', () => {
    act(() => pageStore.setState({ attachments: [] }))
    open()
    expect(screen.getByRole('heading', { level: 2, name: 'Sources 0' })).toBeInTheDocument()
    expect(screen.getByText('No Sources on this Card yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add Source' })).toBeInTheDocument()
  })
})

describe('Page panel: To-dos on this Card', () => {
  const section = () => within(screen.getByRole('region', { name: /To-dos on this Card/ }))

  it('lists the open To-dos that point at this Card, with the owner’s first name', () => {
    open()
    expect(screen.getByRole('heading', { level: 2, name: 'To-dos on this Card · 2 open' })).toBeInTheDocument()
    const items = section().getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Try trainable β in the softmax readout')
    expect(items[0]).toHaveTextContent('Ana')
    expect(items[1]).toHaveTextContent('Re-run with 5 seeds')
    expect(items[1]).toHaveTextContent('Mei')
    expect(section().queryByText('Already done')).toBeNull()
    expect(section().queryByText('About another Card')).toBeNull()
  })

  it('only the owner can tick a To-do', () => {
    open()
    const mine = section().getByRole('checkbox', { name: 'Try trainable β in the softmax readout' })
    const theirs = section().getByRole('checkbox', { name: 'Re-run with 5 seeds' })
    expect(mine).toBeEnabled()
    expect(theirs).toBeDisabled()
    expect(theirs).toHaveAttribute('title', 'Only Mei can tick this')
    fireEvent.click(mine)
    expect(todos.setDone).toHaveBeenCalledTimes(1)
    expect(todos.setDone).toHaveBeenCalledWith('t1', true)
    expect(section().queryByText('Try trainable β in the softmax readout')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'To-dos on this Card · 1 open' })).toBeInTheDocument()
  })

  it('adds a To-do for yourself by default, pointing at this Card on the open Branch', () => {
    open()
    const input = section().getByRole('textbox', { name: 'New To-do' })
    expect(input).toHaveAttribute('placeholder', 'Add a To-do for…')
    const owner = section().getByRole<HTMLSelectElement>('combobox', { name: 'Owner of the new To-do' })
    expect(owner.value).toBe('ana')
    expect([...owner.options].map((o) => o.textContent)).toEqual(['Ana Ruiz (you)', 'Mei Tanaka'])

    fireEvent.change(input, { target: { value: '  Plot the reward curve ' } })
    fireEvent.submit(input.closest('form')!)
    expect(todos.add).toHaveBeenCalledTimes(1)
    expect(todos.add).toHaveBeenCalledWith({
      owner: 'ana',
      text: 'Plot the reward curve',
      card: { id: 'a', title: 'QRL on CartPole', branch: MAIN.id },
    })
    expect(input).toHaveValue('')
    expect(section().getByText('Plot the reward curve')).toBeInTheDocument()
  })

  it('adds a To-do for another Member; Guests are not offered; empty text adds nothing', () => {
    act(() => fake.membersStore.setState({ list: [ANA, MEI, GUEST] }))
    open()
    const input = section().getByRole('textbox', { name: 'New To-do' })
    fireEvent.submit(input.closest('form')!)
    expect(todos.add).not.toHaveBeenCalled()
    expect(section().getByRole('button', { name: 'Add To-do' })).toBeDisabled()

    const owner = section().getByRole<HTMLSelectElement>('combobox', { name: 'Owner of the new To-do' })
    expect([...owner.options].map((o) => o.value)).toEqual(['ana', 'mei'])
    fireEvent.change(owner, { target: { value: 'mei' } })
    fireEvent.change(input, { target: { value: 'Check the seeds' } })
    fireEvent.click(section().getByRole('button', { name: 'Add To-do' }))
    expect(todos.add).toHaveBeenCalledWith({ owner: 'mei', text: 'Check the seeds', card: { id: 'a', title: 'QRL on CartPole', branch: MAIN.id } })
  })

  it('says so in a toast when a To-do cannot be added, and gives the words back', async () => {
    todos.add.mockRejectedValueOnce(new Error('offline'))
    open()
    const input = section().getByRole('textbox', { name: 'New To-do' })
    fireEvent.change(input, { target: { value: 'Will fail' } })
    fireEvent.submit(input.closest('form')!)
    await flush()
    expect(screen.getByTestId('toast')).toHaveTextContent('That To-do could not be added. Try again in a moment.')
    expect(input).toHaveValue('Will fail')
  })
})

describe('Page panel: Connections', () => {
  it('lists them with direction and label; each focuses the other Card on the Board', () => {
    open()
    const section = within(screen.getByRole('region', { name: 'Connections' }))
    const buttons = section.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['uses → Data re-uploading', '← Reward plateaus at ~180', 'contradicts — Reward plateaus at ~180'])

    fireEvent.click(buttons[0]!)
    expect(useBoardRequest.getState().request).toMatchObject({ type: 'focus', target: 'card', id: 'b' })
    fireEvent.click(buttons[1]!)
    expect(useBoardRequest.getState().request).toMatchObject({ type: 'focus', target: 'card', id: 'c' })
    expect(onClose).not.toHaveBeenCalled() // the Page stays open beside the Board
  })

  it('says when there are none', () => {
    act(() => boardStore.setState({ connections: [] }))
    open()
    expect(within(screen.getByRole('region', { name: 'Connections' })).getByText('No Connections yet.')).toBeInTheDocument()
  })
})

describe('Page panel: soft lock (someone else is editing)', () => {
  beforeEach(() => {
    pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } })
  })

  it('shows the banner with who and since when', () => {
    open()
    const banner = screen.getByTestId('page-lock')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveTextContent(
      'Mei is editing this Page · since 14:03. You can read it and change the Card’s status; the Page opens for editing when they’re done.',
    )
    expect(within(banner).getByText('MT')).toBeInTheDocument()
    expect(within(panel().querySelector('header')!).getByText('Read-only while Mei edits')).toBeInTheDocument()
  })

  it('makes Blocks, Sources and the title read-only: no editors, no controls', () => {
    open()
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
    fireEvent.click(screen.getByText('bold'))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(screen.queryByRole('group', { name: /^Block/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Move block|Delete block|Add block/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'QRL on CartPole' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'QRL on CartPole' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit Source|Remove from this Card|Add Source/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'arXiv:2103.05577' })).toBeInTheDocument()
    expect(page.startEditing).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('still lets the status change, and To-dos and Connections work', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Change status/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Reading' }))
    expect(submit).toHaveBeenCalledWith([ops.setStatus('a', 'reading')])
    expect(screen.getByRole('textbox', { name: 'New To-do' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'uses → Data re-uploading' })).toBeInTheDocument()
  })

  it('names nobody it does not know', () => {
    act(() => pageStore.setState({ editors: { a: { member: null, memberId: 'gone', since: at(14, 9, 30) } } }))
    open()
    expect(screen.getByTestId('page-lock')).toHaveTextContent('Someone is editing this Page · since 09:30.')
  })

  it('closes an open editor without sending when the lock arrives, and opens for editing again when it lifts', () => {
    act(() => pageStore.setState({ editors: {} }))
    open()
    fireEvent.click(view(1))
    fireEvent.change(editor(1), { target: { value: 'half a sentence' } })
    act(() => pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } }))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(submit).not.toHaveBeenCalled()

    act(() => pageStore.setState({ editors: {} }))
    expect(screen.queryByTestId('page-lock')).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull() // it does not spring open again
    fireEvent.click(view(1))
    expect(editor(1)).toBeInTheDocument()
  })
})

describe('Page panel: Guest (read-only)', () => {
  beforeEach(() => {
    boardStore.setState({ readOnly: true })
    sessionStore.setState({ status: 'signed_in', member: GUEST })
  })

  it('reads everything, edits nothing, and sees no To-dos', () => {
    open()
    expect(within(panel().querySelector('header')!).getByText('Read-only')).toBeInTheDocument()
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
    fireEvent.click(screen.getByText('bold'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /Move block|Delete block|Add block|Add Source|Edit Source|Remove from this Card|Change status/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'QRL on CartPole' })).toBeNull()
    expect(screen.queryByRole('region', { name: /To-dos/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(panel().querySelector('header')!).toHaveTextContent('Open question')
    expect(screen.getByRole('link', { name: 'arXiv:2103.05577' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'uses → Data re-uploading' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close Page' })).toBeInTheDocument()
  })

  it('shows no banner even while a Member is editing', () => {
    pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } })
    open()
    expect(screen.queryByTestId('page-lock')).toBeNull()
    expect(within(panel().querySelector('header')!).getByText('Read-only')).toBeInTheDocument()
  })
})

describe('Page panel: the Card is gone', () => {
  it('says so when the Card is removed while its Page is open, and offers Close', () => {
    open()
    fireEvent.click(view(1))
    act(() => boardStore.setState({ cards: [B, C] }))
    expect(screen.getByRole('heading', { level: 1, name: 'This Card was removed.' })).toBeInTheDocument()
    expect(panel()).toHaveAccessibleName('Page of a removed Card')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByTestId('block-b1')).toBeNull()
    expect(screen.queryByText(/^Sources/)).toBeNull()
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledWith('a')
  })

  it('lets go of the soft lock when the Card goes while a Block is being edited', () => {
    open()
    fireEvent.click(view(1))
    act(() => boardStore.setState({ cards: [B, C] }))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
  })

  it('shows the Page again if the Card comes back', () => {
    open()
    act(() => boardStore.setState({ cards: [B, C] }))
    act(() => boardStore.setState({ cards: [A, B, C] }))
    expect(screen.getByRole('heading', { level: 1, name: 'QRL on CartPole' })).toBeInTheDocument()
    expect(blockIds()).toEqual(['b1', 'b2', 'b3'])
  })

  it('waits instead of saying "removed" while the Board is still loading', () => {
    act(() => boardStore.setState({ cards: [], status: 'loading' }))
    open()
    expect(screen.getByText('Loading Page…')).toBeInTheDocument()
    expect(screen.queryByText('This Card was removed.')).toBeNull()
    act(() => boardStore.setState({ cards: [A, B, C], status: 'live' }))
    expect(screen.getByRole('heading', { level: 1, name: 'QRL on CartPole' })).toBeInTheDocument()
  })
})
