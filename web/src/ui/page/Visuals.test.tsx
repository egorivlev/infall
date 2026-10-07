// Visual blocks in the Page panel (M6): adding one from a starter, reading it, editing it.
// The frame itself is covered in visuals/VisualFrame.test.tsx; here its window is only asked what
// source it would be sent.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Profiler, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { ops } = await import('../../lib')
const { PagePanel } = await import('./PagePanel')
const { RELEASE_GRACE_MS, editLock } = await import('./lock')
const { TEMPLATES } = await import('./visuals/templates')
const { toasts } = await import('../board/toastStore')
const { pagePanel, usePagePanel } = await import('../bridge')
const { GUEST, MEI, block, card, visual } = await import('./testkit')
const { at } = await import('../history/testkit')

const { boardStore, pageStore, sessionStore, submit, page } = fake

const SOURCE = '<canvas id="c"></canvas>\n<script>\n  draw()\n</script>\n'
const onClose = vi.fn<(cardId: string) => void>()
const commits = vi.fn()

beforeEach(() => {
  fake.reset()
  onClose.mockReset()
  commits.mockClear()
  usePagePanel.setState({ cardId: 'a', full: false })
  boardStore.setState({ cards: [card('a', 'QRL on CartPole')] })
  pageStore.setState({
    blocks: [block('b1', 'a', '1', 'First paragraph'), visual('v1', 'a', '2', 'Bloch sphere of one qubit', SOURCE), block('b3', 'a', '3', 'Third paragraph')],
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

const open = () =>
  render(
    <Profiler id="page" onRender={commits}>
      <PagePanel cardId="a" full={false} onClose={onClose} />
    </Profiler>,
  )
const openStrict = () =>
  render(
    <StrictMode>
      <PagePanel cardId="a" full={false} onClose={onClose} />
    </StrictMode>,
  )
const panel = () => screen.getByTestId('page-panel')
const row = (id = 'v1') => screen.getByTestId(`block-${id}`)
const blockIds = () => [...panel().querySelectorAll('[data-block]')].map((el) => el.getAttribute('data-block'))
const lastBatch = () => submit.mock.calls[submit.mock.calls.length - 1]![0]
const flush = () => act(async () => {})

const frameOf = (id = 'v1') => row(id).querySelector('iframe') as HTMLIFrameElement
/** What this frame is sent when it says it is ready. */
function sentTo(f: HTMLIFrameElement): string {
  const w = f.contentWindow as Window
  const post = vi.spyOn(w, 'postMessage').mockImplementation(() => {})
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { qoop: 'visual', type: 'ready' }, source: w }))
  })
  expect(post).toHaveBeenCalledTimes(1)
  const message = post.mock.calls[0]![0] as { html: string }
  post.mockRestore()
  return message.html
}

const edit = (id = 'v1') => fireEvent.click(within(row(id)).getByRole('button', { name: 'Edit' }))
const titleField = (id = 'v1') => within(row(id)).getByRole<HTMLInputElement>('textbox', { name: 'Title' })
const sourceField = (id = 'v1') => within(row(id)).getByRole<HTMLTextAreaElement>('textbox', { name: 'Source' })
const button = (name: string, id = 'v1') => within(row(id)).getByRole('button', { name })
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => fireEvent.input(field, { target: { value } })

describe('Visuals: adding a block', () => {
  const openMenu = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
  const choose = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }))

  it('"+ Add block" offers Text and Visual; nothing is added until one is chosen', () => {
    open()
    const add = screen.getByRole('button', { name: 'Add block at the end' })
    expect(add).toHaveAttribute('aria-haspopup', 'menu')
    expect(add).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(add)
    expect(add).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Add block' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Text', 'Visual'])
    expect(within(menu).getByRole('menuitem', { name: 'Text' })).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()
  })

  it('Text adds an empty text block there, as before', () => {
    open()
    openMenu('Add block before block 2')
    choose('Text')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', text: '', order: '1.5' }])
    expect(lastBatch()[0]).not.toHaveProperty('type')
    expect(lastBatch()[0]).not.toHaveProperty('title')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Block 2, Markdown' })).toHaveFocus()
  })

  it('Visual opens the starter picker: Blank, Bloch sphere, Function plot', () => {
    open()
    openMenu('Add block at the end')
    choose('Visual')
    const picker = screen.getByRole('menu', { name: 'Start the Visual from' })
    expect(within(picker).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Blank', 'Bloch sphere', 'Function plot'])
    expect(within(picker).getByRole('menuitem', { name: 'Blank' })).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()
  })

  it('a starter creates the Visual with its title and source at that place, in one op, and opens the editor', () => {
    open()
    openMenu('Add block at the end')
    choose('Visual')
    choose('Bloch sphere')
    const bloch = TEMPLATES.find((t) => t.id === 'bloch')!
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([
      { fake: 'addBlock', id: expect.any(String), card: 'a', type: 'visual', title: 'Bloch sphere', text: bloch.source, order: '4' },
    ])
    const id = (lastBatch()[0] as { id: string }).id
    expect(blockIds()).toEqual(['b1', 'v1', 'b3', id])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(titleField(id)).toHaveValue('Bloch sphere')
    expect(titleField(id)).toHaveFocus()
    expect(sourceField(id)).toHaveValue(bloch.source)
    // The preview is about to run the starter as it is.
    expect(sentTo(frameOf(id))).toBe(bloch.source)
  })

  it('places a Visual between two blocks with a key between them; Blank comes without a title', () => {
    open()
    openMenu('Add block before block 2')
    choose('Visual')
    choose('Blank')
    const blank = TEMPLATES.find((t) => t.id === 'blank')!
    expect(lastBatch()).toEqual([{ fake: 'addBlock', id: expect.any(String), card: 'a', type: 'visual', title: '', text: blank.source, order: '1.5' }])
    const id = (lastBatch()[0] as { id: string }).id
    expect(blockIds()).toEqual(['b1', id, 'v1', 'b3'])
    expect(titleField(id)).toHaveValue('')
    expect(titleField(id)).toHaveAttribute('placeholder', 'Untitled Visual')
  })

  it('Function plot at the start', () => {
    open()
    openMenu('Add block at the start')
    choose('Visual')
    choose('Function plot')
    const plot = TEMPLATES.find((t) => t.id === 'plot')!
    expect(lastBatch()).toEqual([
      { fake: 'addBlock', id: expect.any(String), card: 'a', type: 'visual', title: 'Function plot', text: plot.source, order: '0' },
    ])
  })

  it('an empty Page offers the same menu', () => {
    pageStore.setState({ blocks: [] })
    open()
    openMenu('+ Add block')
    choose('Visual')
    choose('Bloch sphere')
    expect(lastBatch()).toEqual([expect.objectContaining({ fake: 'addBlock', type: 'visual', title: 'Bloch sphere', order: '1' })])
  })

  it('arrow keys move through the menu; Esc closes it, not the panel, and focus returns to the button', () => {
    open()
    const add = screen.getByRole('button', { name: 'Add block at the end' })
    fireEvent.click(add)
    const text = screen.getByRole('menuitem', { name: 'Text' })
    const vis = screen.getByRole('menuitem', { name: 'Visual' })
    fireEvent.keyDown(text, { key: 'ArrowDown' })
    expect(vis).toHaveFocus()
    fireEvent.keyDown(vis, { key: 'ArrowDown' })
    expect(text).toHaveFocus()
    fireEvent.keyDown(text, { key: 'ArrowUp' })
    expect(vis).toHaveFocus()
    fireEvent.keyDown(vis, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(add).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()

    fireEvent.click(add)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Visual' }))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Blank' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a click elsewhere closes the menu', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    fireEvent.mouseDown(screen.getByText('First paragraph'))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })

  it('under StrictMode a starter is added once and its editor works', () => {
    openStrict()
    openMenu('Add block at the end')
    choose('Visual')
    choose('Function plot')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(blockIds()).toHaveLength(4)
    const id = (lastBatch()[0] as { id: string }).id
    type(titleField(id), 'Decay')
    fireEvent.click(button('Done', id))
    expect(submit).toHaveBeenCalledTimes(2)
    expect(lastBatch()).toEqual([{ fake: 'setBlockTitle', block: id, title: 'Decay' }])
  })
})

describe('Visuals: reading', () => {
  it('shows the header strip: VISUAL, the title as written, and what it is', () => {
    open()
    const head = row().querySelector('.qp-visual__head')!
    expect(within(row()).getByText('Visual')).toHaveClass('qp-visual__kind')
    const title = within(row()).getByText('Bloch sphere of one qubit')
    // The title has its own class and never the caps style: a person's words are not upper-cased.
    expect(title).toHaveClass('qp-visual__title')
    expect(title).not.toHaveClass('q-caps')
    expect(title.closest('.q-caps')).toBeNull()
    expect(head).toHaveTextContent('interactive · runs everywhere')
    expect(blockIds()).toEqual(['b1', 'v1', 'b3'])
  })

  it('runs the Visual in the sandboxed frame and sends it the block’s source', () => {
    open()
    const f = frameOf()
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('src')).toBe('/visual-frame')
    expect(f.getAttribute('title')).toBe('Visual: Bloch sphere of one qubit')
    expect(f.hasAttribute('srcdoc')).toBe(false)
    expect(sentTo(f)).toBe(SOURCE)
    expect(panel().innerHTML).not.toContain('draw()')
  })

  it('a Visual without a title reads "Untitled Visual"', () => {
    pageStore.setState({ blocks: [visual('v1', 'a', '1', '', SOURCE)] })
    open()
    expect(within(row()).getByText('Untitled Visual')).toHaveClass('is-empty')
    expect(frameOf().getAttribute('title')).toBe('Visual: Untitled')
  })

  it('a Visual without a source says so and starts no frame', () => {
    pageStore.setState({ blocks: [visual('v1', 'a', '1', 'Later', '  \n')] })
    open()
    expect(within(row()).getByText('This Visual has no source yet.')).toBeInTheDocument()
    expect(row().querySelector('iframe')).toBeNull()
  })

  it('loads the frame again when the source changes remotely; a new title only renames it', () => {
    open()
    const first = frameOf()
    act(() => pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'v1' ? { ...b, title: 'Renamed' } : b)) })))
    expect(frameOf()).toBe(first)
    expect(first.getAttribute('title')).toBe('Visual: Renamed')
    act(() => pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'v1' ? { ...b, text: '<p>new</p>' } : b)) })))
    expect(frameOf()).not.toBe(first)
    expect(sentTo(frameOf())).toBe('<p>new</p>')
  })

  it('counts as a block in the meta row, and text blocks around it still render', () => {
    open()
    expect(panel()).toHaveTextContent('3 blocks')
    expect(screen.getByText('First paragraph')).toBeInTheDocument()
    expect(screen.getByText('Third paragraph')).toBeInTheDocument()
  })
})

describe('Visuals: editing', () => {
  it('Edit opens the title and the source, with the hint and a preview of the current source', () => {
    open()
    edit()
    expect(titleField()).toHaveValue('Bloch sphere of one qubit')
    expect(titleField()).toHaveFocus()
    const source = sourceField()
    expect(source).toHaveValue(SOURCE)
    expect(Number(source.getAttribute('rows'))).toBeGreaterThanOrEqual(14)
    expect(source.getAttribute('spellcheck')).toBe('false')
    expect(row()).toHaveTextContent(
      'HTML, CSS and JavaScript. Runs in a sandbox: no network, no access to Qoop. Use the --q-* colour variables to follow the theme.',
    )
    expect(source).toHaveAccessibleDescription(/Runs in a sandbox/)
    for (const name of ['Run', 'Done', 'Cancel']) expect(button(name)).toBeInTheDocument()
    expect(within(row()).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(row()).queryByRole('button', { name: /Move block|Delete block/ })).toBeNull()
    const preview = frameOf()
    expect(preview.getAttribute('sandbox')).toBe('allow-scripts')
    expect(preview.getAttribute('title')).toBe('Visual: Bloch sphere of one qubit, preview')
    expect(sentTo(preview)).toBe(SOURCE)
    expect(submit).not.toHaveBeenCalled()
  })

  it('Enter on the focused block opens the editor too', () => {
    open()
    const view = screen.getByRole('group', { name: 'Block 2, Visual. Press Enter to edit.' })
    expect(view).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(view, { key: 'Enter' })
    expect(sourceField()).toBeInTheDocument()
  })

  it('a click on the block does not open the editor (clicks belong to the Visual)', () => {
    open()
    fireEvent.click(screen.getByRole('group', { name: 'Block 2, Visual. Press Enter to edit.' }))
    fireEvent.click(within(row()).getByText('Bloch sphere of one qubit'))
    expect(within(row()).queryByRole('textbox')).toBeNull()
  })

  it('Tab inserts two spaces at the caret and replaces a selection; Shift+Tab is left alone', () => {
    open()
    edit()
    const source = sourceField()
    type(source, 'ab')
    source.setSelectionRange(1, 1)
    const tab = fireEvent.keyDown(source, { key: 'Tab' })
    expect(tab).toBe(false) // default prevented: focus stays in the field
    expect(source.value).toBe('a  b')
    expect([source.selectionStart, source.selectionEnd]).toEqual([3, 3])

    source.setSelectionRange(0, 3)
    fireEvent.keyDown(source, { key: 'Tab' })
    expect(source.value).toBe('  b')

    expect(fireEvent.keyDown(source, { key: 'Tab', shiftKey: true })).toBe(true) // the way out of the field
    expect(source.value).toBe('  b')
    expect(fireEvent.keyDown(titleField(), { key: 'Tab' })).toBe(true) // only the source indents
    expect(submit).not.toHaveBeenCalled()
  })

  it('Run loads the preview again from the draft, without submitting anything', () => {
    open()
    edit()
    const before = frameOf()
    type(sourceField(), '<p>draft one</p>')
    expect(frameOf()).toBe(before) // typing alone does not touch the preview
    fireEvent.click(button('Run'))
    const after = frameOf()
    expect(after).not.toBe(before)
    expect(sentTo(after)).toBe('<p>draft one</p>')
    expect(submit).not.toHaveBeenCalled()
    expect(sourceField()).toHaveValue('<p>draft one</p>')

    // Run again with the same draft: a fresh frame all the same.
    fireEvent.click(button('Run'))
    expect(frameOf()).not.toBe(after)
    expect(sentTo(frameOf())).toBe('<p>draft one</p>')
    expect(submit).not.toHaveBeenCalled()
  })

  it('⌘Enter and Ctrl+Enter run, from the source and from the title', () => {
    open()
    edit()
    type(sourceField(), '<p>two</p>')
    let previous = frameOf()
    fireEvent.keyDown(sourceField(), { key: 'Enter', metaKey: true })
    expect(frameOf()).not.toBe(previous)
    expect(sentTo(frameOf())).toBe('<p>two</p>')

    type(sourceField(), '<p>three</p>')
    previous = frameOf()
    fireEvent.keyDown(titleField(), { key: 'Enter', ctrlKey: true })
    expect(frameOf()).not.toBe(previous)
    expect(sentTo(frameOf())).toBe('<p>three</p>')

    previous = frameOf()
    fireEvent.keyDown(sourceField(), { key: 'Enter' }) // a plain Enter is a new line
    expect(frameOf()).toBe(previous)
    expect(sourceField()).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
  })

  it('Done submits a changed title and source together, as one batch', () => {
    open()
    edit()
    type(titleField(), '  One qubit   on the sphere ')
    type(sourceField(), '<p>new source</p>\n')
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([
      { fake: 'setBlockTitle', block: 'v1', title: 'One qubit on the sphere' },
      { fake: 'setBlockText', block: 'v1', text: '<p>new source</p>\n' },
    ])
    expect(within(row()).queryByRole('textbox')).toBeNull()
    expect(within(row()).getByText('One qubit on the sphere')).toBeInTheDocument()
    expect(sentTo(frameOf())).toBe('<p>new source</p>\n')
  })

  it('Done submits only what changed: the title alone, the source alone, or nothing', () => {
    open()
    edit()
    type(titleField(), 'Renamed')
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([{ fake: 'setBlockTitle', block: 'v1', title: 'Renamed' }])

    edit()
    type(sourceField(), `${SOURCE}<!-- more -->`)
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(2)
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'v1', text: `${SOURCE}<!-- more -->` }])

    edit()
    fireEvent.click(button('Run')) // running is not a change
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('keeps the source exactly as typed (no trimming), and a title can be emptied', () => {
    open()
    edit()
    type(titleField(), '   ')
    type(sourceField(), '\n  <p>x</p>  \n\n')
    fireEvent.click(button('Done'))
    expect(lastBatch()).toEqual([
      { fake: 'setBlockTitle', block: 'v1', title: '' },
      { fake: 'setBlockText', block: 'v1', text: '\n  <p>x</p>  \n\n' },
    ])
  })

  it('Cancel discards the draft', () => {
    open()
    edit()
    type(titleField(), 'Thrown away')
    type(sourceField(), '<p>thrown away</p>')
    fireEvent.click(button('Run'))
    fireEvent.click(button('Cancel'))
    expect(submit).not.toHaveBeenCalled()
    expect(within(row()).queryByRole('textbox')).toBeNull()
    expect(within(row()).getByText('Bloch sphere of one qubit')).toBeInTheDocument()
    expect(sentTo(frameOf())).toBe(SOURCE)
    edit()
    expect(sourceField()).toHaveValue(SOURCE) // a new editor starts from the block, not the old draft
  })

  it('Esc discards too — from either field or a button — and does not close the panel', () => {
    open()
    for (const from of [() => sourceField(), () => titleField(), () => button('Run')]) {
      edit()
      type(sourceField(), '<p>thrown away</p>')
      fireEvent.keyDown(from(), { key: 'Escape' })
      expect(within(row()).queryByRole('textbox')).toBeNull()
    }
    expect(submit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // Focus is back on the block, so the keyboard carries on: Enter edits, Esc now closes the panel.
    const view = screen.getByRole('group', { name: 'Block 2, Visual. Press Enter to edit.' })
    expect(view).toHaveFocus()
    fireEvent.keyDown(view, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledWith('a')
  })

  it('leaving a field does not finish the editor', () => {
    open()
    edit()
    type(sourceField(), '<p>draft</p>')
    fireEvent.blur(sourceField())
    fireEvent.blur(titleField())
    expect(sourceField()).toHaveValue('<p>draft</p>')
    expect(submit).not.toHaveBeenCalled()
  })

  it('typing re-renders nothing — not the Page, not the Board — and sends nothing', () => {
    open()
    edit()
    commits.mockClear()
    const source = sourceField()
    for (const value of ['<', '<p', '<p>', '<p>h', '<p>hi', '<p>hi<', '<p>hi</p>']) {
      type(source, value)
      fireEvent.keyDown(source, { key: value.slice(-1) })
    }
    type(titleField(), 'A new name')
    expect(commits).not.toHaveBeenCalled() // React committed nothing: the draft lives in the fields
    expect(submit).not.toHaveBeenCalled()
    expect(source.value).toBe('<p>hi</p>')
  })

  it('keeps the draft when the same Visual changes remotely, and Done then sends only what was changed here', () => {
    open()
    edit()
    type(titleField(), 'Mine')
    act(() => pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'v1' ? { ...b, text: '<p>theirs</p>', title: 'Theirs' } : b)) })))
    expect(titleField()).toHaveValue('Mine')
    expect(sourceField()).toHaveValue(SOURCE)
    fireEvent.click(button('Done'))
    // The source was not touched here, so their newer source is not overwritten with the old one.
    expect(lastBatch()).toEqual([{ fake: 'setBlockTitle', block: 'v1', title: 'Mine' }])
    expect(sentTo(frameOf())).toBe('<p>theirs</p>')
  })

  it('drops the editor without sending when the Visual is removed elsewhere', () => {
    open()
    edit()
    type(sourceField(), '<p>lost</p>')
    act(() => pageStore.setState((s) => ({ deleted: new Set(s.deleted).add('v1') })))
    expect(blockIds()).toEqual(['b1', 'b3'])
    expect(submit).not.toHaveBeenCalled()
  })

  it('under StrictMode the editor still finishes: Done commits once, Esc and Cancel work, Run runs', () => {
    openStrict()
    edit()
    expect(titleField()).toHaveFocus()
    type(sourceField(), '<p>strict</p>')
    fireEvent.click(button('Run'))
    expect(sentTo(frameOf())).toBe('<p>strict</p>')
    fireEvent.click(button('Done'))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'v1', text: '<p>strict</p>' }])
    expect(sentTo(frameOf())).toBe('<p>strict</p>')

    edit()
    fireEvent.keyDown(sourceField(), { key: 'Escape' })
    expect(within(row()).queryByRole('textbox')).toBeNull()
    edit()
    fireEvent.click(button('Cancel'))
    expect(within(row()).queryByRole('textbox')).toBeNull()
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('Visuals: the soft lock claim', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('claims when the editor opens and lets go after Done', () => {
    open()
    expect(page.startEditing).not.toHaveBeenCalled()
    edit()
    expect(page.startEditing).toHaveBeenCalledTimes(1)
    expect(page.startEditing).toHaveBeenCalledWith('a')
    fireEvent.click(button('Run'))
    type(sourceField(), '<p>x</p>')
    fireEvent.click(button('Done'))
    expect(page.stopEditing).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
    expect(page.startEditing).toHaveBeenCalledTimes(1)
  })

  it('lets go after Cancel and after Esc too; reading alone never claims', () => {
    open()
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
    expect(page.startEditing).not.toHaveBeenCalled()
    edit()
    fireEvent.click(button('Cancel'))
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
    edit()
    fireEvent.keyDown(sourceField(), { key: 'Escape' })
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.startEditing).toHaveBeenCalledTimes(2)
    expect(page.stopEditing).toHaveBeenCalledTimes(2)
  })

  it('a new Visual claims too', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add block at the end' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Visual' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Blank' }))
    expect(page.startEditing).toHaveBeenCalledTimes(1)
  })

  it('lets go at once when the panel closes while the editor is open', () => {
    const { unmount } = open()
    edit()
    unmount()
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })

  it('under StrictMode: one claim and one release per editing spell', () => {
    openStrict()
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS * 2))
    expect(page.startEditing).not.toHaveBeenCalled()
    expect(page.stopEditing).not.toHaveBeenCalled()
    edit()
    expect(page.startEditing).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Done'))
    act(() => void vi.advanceTimersByTime(RELEASE_GRACE_MS))
    expect(page.stopEditing).toHaveBeenCalledTimes(1)
    expect(page.startEditing).toHaveBeenCalledTimes(1)
  })
})

describe('Visuals: move and delete', () => {
  const tools = () => within(within(row()).getByRole('group', { name: 'Block 2' }))

  it('moves a Visual up and down like any block', () => {
    open()
    fireEvent.click(tools().getByRole('button', { name: 'Move block up' }))
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'v1', order: '0' }])
    expect(blockIds()).toEqual(['v1', 'b1', 'b3'])
    fireEvent.click(within(row()).getByRole('button', { name: 'Move block down' }))
    fireEvent.click(within(row()).getByRole('button', { name: 'Move block down' }))
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'v1', order: '4' }])
    expect(blockIds()).toEqual(['b1', 'b3', 'v1'])
    expect(within(row()).getByRole('button', { name: 'Move block down' })).toBeDisabled()
    // Wherever it went, it still runs: a frame that loads again is sent its source again.
    expect(sentTo(frameOf())).toBe(SOURCE)
  })

  it('deletes a Visual at once, with an Undo toast that restores it', async () => {
    open()
    fireEvent.click(tools().getByRole('button', { name: 'Delete block' }))
    expect(submit).toHaveBeenCalledWith([ops.remove('v1')])
    expect(blockIds()).toEqual(['b1', 'b3'])
    const toast = screen.getByTestId('toast')
    expect(toast).toHaveTextContent('Deleted 1 block.')
    await flush()
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await flush()
    expect(lastBatch()).toEqual([ops.restore('v1')])
    expect(blockIds()).toEqual(['b1', 'v1', 'b3'])
    expect(sentTo(frameOf())).toBe(SOURCE)
  })
})

describe('Visuals: read-only', () => {
  const expectReadOnlyButRunning = () => {
    expect(within(row()).queryByRole('button')).toBeNull() // no Edit, no move, no delete
    expect(screen.queryByRole('button', { name: /Add block/ })).toBeNull()
    const view = screen.getByRole('group', { name: 'Block 2, Visual' })
    expect(view).not.toHaveAttribute('tabindex')
    fireEvent.keyDown(view, { key: 'Enter' })
    fireEvent.click(view)
    expect(within(row()).queryByRole('textbox')).toBeNull()
    // …while the Visual itself is there and gets its source like for anyone else.
    const f = frameOf()
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('src')).toBe('/visual-frame')
    expect(within(row()).getByText('Bloch sphere of one qubit')).toBeInTheDocument()
    expect(row()).toHaveTextContent('interactive · runs everywhere')
    expect(sentTo(f)).toBe(SOURCE)
    expect(submit).not.toHaveBeenCalled()
    expect(page.startEditing).not.toHaveBeenCalled()
  }

  it('a Guest gets a working Visual and no Edit', () => {
    boardStore.setState({ readOnly: true })
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    open()
    expectReadOnlyButRunning()
  })

  it('a read-only Board (History preview, lost connection) is the same for a Member', () => {
    boardStore.setState({ readOnly: true })
    open()
    expectReadOnlyButRunning()
  })

  it('under someone else’s soft lock the Visual runs but cannot be edited', () => {
    pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } })
    open()
    expect(screen.getByTestId('page-lock')).toBeInTheDocument()
    expectReadOnlyButRunning()
  })

  it('closes an open editor without sending when the lock arrives, and opens for editing again when it lifts', () => {
    open()
    edit()
    type(sourceField(), '<p>half done</p>')
    act(() => pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } }))
    expect(within(row()).queryByRole('textbox')).toBeNull()
    expect(within(row()).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(submit).not.toHaveBeenCalled()
    expect(sentTo(frameOf())).toBe(SOURCE)
    act(() => pageStore.setState({ editors: {} }))
    expect(within(row()).queryByRole('textbox')).toBeNull() // it does not reopen by itself
    edit()
    expect(sourceField()).toHaveValue(SOURCE)
  })
})
