import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakeAiLib())
vi.mock('../../lib', () => fake.module())

// Counts how often an answer's text is rendered, to show that a delta renders one message only.
const md = vi.hoisted(() => ({ renders: [] as string[] }))
vi.mock('../page/MarkdownView', () => ({
  MarkdownView: ({ text }: { text: string }) => {
    md.renders.push(text)
    return <div className="qp-md">{text}</div>
  },
}))

const { AiSidebar } = await import('./AiSidebar')
const { sidebarState, useSidebarState } = await import('./state')
const { aiPanel, boardFocus, pagePanel, suggestionsPanel, useAiPanel, usePagePanel, useSuggestionsPanel } = await import('../bridge')
const { navigate } = await import('../shell/router')
const { BOARD_SCOPE, CLAUDE, OPENROUTER, TRY, answer, asked, cardScope, none } = await import('./testkit')

const { ai, aiStore, boardStore } = fake
const CARD = { id: 'c1', title: 'Surface code basics' }

const settle = () => act(async () => {})
const renderSidebar = () => render(<AiSidebar branch="main" />)
const composer = () => screen.getByLabelText<HTMLTextAreaElement>('Ask the AI')
const log = () => screen.getByRole('log')
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } })
const enter = (init: KeyboardEventInit = {}) => fireEvent.keyDown(composer(), { key: 'Enter', ...init })

beforeEach(() => {
  fake.reset()
  md.renders.length = 0
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  act(() => {
    sidebarState.reset()
    boardFocus.set(null)
    aiPanel.close()
    pagePanel.close()
    suggestionsPanel.close()
  })
})

describe('region and header', () => {
  it('is a complementary region called AI, not a dialog', () => {
    renderSidebar()
    expect(screen.getByRole('complementary', { name: 'AI' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says Claude Code answers, with the version in the tooltip', () => {
    renderSidebar()
    expect(screen.getByText('Claude Code')).toHaveAttribute('title', 'Claude Code 2.1.0')
  })

  it('says which OpenRouter model answers', () => {
    aiStore.setState({ setup: OPENROUTER })
    renderSidebar()
    expect(screen.getByText('Claude Sonnet 4.5')).toHaveAttribute('title', 'OpenRouter · anthropic/claude-sonnet-4.5')
  })

  it('always shows the privacy line', () => {
    renderSidebar()
    const line = screen.getByText(/only you can see this Conversation/)
    expect(line).toHaveTextContent('Private — only you can see this Conversation. Pin copies an answer into a Page.')
    cleanup()
    aiStore.setState({ setup: none('browser_no_key') })
    renderSidebar()
    expect(screen.getByText(/only you can see this Conversation/)).toBeInTheDocument()
  })

  it('never says "chat"', () => {
    fake.show([asked('Why?'), answer('Because.')])
    aiStore.setState({ conversations: [{ id: 'c1', title: 'Why?', updatedAt: 2 }] })
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Conversations' }))
    expect(document.body.textContent).not.toMatch(/chat/i)
  })

  it('the collapse button closes the sidebar', () => {
    useAiPanel.setState({ open: true })
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the AI sidebar' }))
    expect(useAiPanel.getState().open).toBe(false)
  })

  it('"+" starts a new Conversation, but not while an answer is being written', () => {
    renderSidebar()
    const plus = screen.getByRole('button', { name: 'New Conversation' })
    fireEvent.click(plus)
    expect(ai.newConversation).toHaveBeenCalledTimes(1)
    act(() => aiStore.setState({ busy: true }))
    expect(plus).toBeDisabled()
  })
})

describe('Conversations menu', () => {
  const list = [
    { id: 'c2', title: 'Is 1% the right threshold?', updatedAt: new Date(2026, 10, 20).getTime() },
    { id: 'c1', title: 'How fast does the error rate fall?', updatedAt: new Date(2026, 10, 14).getTime() },
  ]
  const openMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Conversations' }))
    return screen.getByRole('group', { name: 'Conversations' })
  }

  it('lists Conversations by title and date, in the order given (newest first), and opens one', () => {
    aiStore.setState({ conversations: list })
    renderSidebar()
    const trigger = screen.getByRole('button', { name: 'Conversations' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    const menu = openMenu()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const rows = within(menu).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Is 1% the right threshold?')
    expect(rows[0]).toHaveTextContent('20 Nov')
    expect(rows[1]).toHaveTextContent('14 Nov')
    fireEvent.click(within(menu).getByRole('button', { name: /^How fast does the error rate fall/ }))
    expect(ai.open).toHaveBeenCalledWith('c1')
    expect(screen.queryByRole('group', { name: 'Conversations' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('deleting asks first, inline; Cancel keeps it, Delete removes it', () => {
    aiStore.setState({ conversations: list })
    renderSidebar()
    const menu = openMenu()
    fireEvent.click(within(menu).getByRole('button', { name: 'Delete the Conversation “Is 1% the right threshold?”' }))
    expect(ai.remove).not.toHaveBeenCalled()
    expect(within(menu).getByText('Delete this Conversation?')).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('button', { name: 'Cancel' }))
    expect(within(menu).queryByText('Delete this Conversation?')).toBeNull()
    expect(ai.remove).not.toHaveBeenCalled()

    fireEvent.click(within(menu).getByRole('button', { name: 'Delete the Conversation “Is 1% the right threshold?”' }))
    fireEvent.click(within(menu).getByRole('button', { name: 'Delete' }))
    expect(ai.remove).toHaveBeenCalledWith('c2')
  })

  it('Esc closes the menu and returns focus to its button', () => {
    aiStore.setState({ conversations: list })
    renderSidebar()
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Conversations' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Conversations' })).toHaveFocus()
  })

  it('says so when there are none', () => {
    renderSidebar()
    expect(openMenu()).toHaveTextContent('No Conversations yet.')
  })
})

describe('messages', () => {
  it('shows what was asked and the answer', () => {
    fake.show([asked('How fast does it fall?'), answer('Roughly geometrically.')])
    renderSidebar()
    expect(within(log()).getByText('How fast does it fall?')).toHaveClass('qa-bubble')
    expect(within(log()).getByText('Roughly geometrically.')).toBeInTheDocument()
    expect(log()).toHaveAttribute('aria-live', 'polite')
  })

  it('shows what the Member was looking at only when it changes', () => {
    fake.show([
      asked('one', cardScope('c1', 'Surface code basics')),
      answer('A'),
      asked('two', cardScope('c1', 'Surface code basics')),
      answer('B'),
      asked('three', BOARD_SCOPE),
      answer('C'),
    ])
    renderSidebar()
    const chips = [...log().querySelectorAll('.qa-user__scope')].map((el) => el.textContent)
    expect(chips).toEqual(['Card: Surface code basics', 'Board: main'])
  })

  it('does not upper-case or otherwise restyle what the Member wrote', () => {
    fake.show([asked('why is pL so low?\nsecond line')])
    renderSidebar()
    expect(log().querySelector('.qa-bubble')?.textContent).toBe('why is pL so low?\nsecond line')
  })

  it('lists the tools an answer read with, each once', () => {
    fake.show([asked('q'), answer('A', { tools: ['list_cards', 'get_card', 'get_card'] })])
    renderSidebar()
    expect(within(log()).getByText('read: list_cards, get_card')).toBeInTheDocument()
    expect(within(log()).queryByText(/proposed a Suggestion/)).toBeNull()
  })

  it('says when a Suggestion was proposed, with a way to the Suggestions panel', async () => {
    vi.useFakeTimers()
    navigate('/todos')
    fake.show([asked('q'), answer('A', { tools: ['get_card', 'suggest_source'] })])
    renderSidebar()
    expect(within(log()).getByText(/proposed a Suggestion/)).toBeInTheDocument()
    fireEvent.click(within(log()).getByRole('button', { name: 'Open Suggestions' }))
    expect(window.location.pathname).toBe('/') // back to the Board first
    act(() => void vi.advanceTimersByTime(100))
    expect(useSuggestionsPanel.getState().open).toBe(true)
  })

  it('while streaming: a caret, no Pin or Copy, and Stop calls ai.stop()', () => {
    fake.show([asked('q'), answer('Rough', { id: 'a-live', status: 'streaming' })], { busy: true })
    renderSidebar()
    expect(log().querySelector('.qa-caret')).not.toBeNull()
    expect(within(log()).queryByRole('button', { name: /Pin to Page/ })).toBeNull()
    expect(within(log()).queryByRole('button', { name: 'Copy' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(ai.stop).toHaveBeenCalledTimes(1)
  })

  it('an error shows its sentence and "Try again" retries that message', () => {
    fake.show([asked('q'), answer('', { id: 'a-err', status: 'error', error: 'The answer was cut off.' })])
    renderSidebar()
    expect(within(log()).getByText('The answer was cut off.')).toHaveClass('qa-answer__error')
    fireEvent.click(within(log()).getByRole('button', { name: 'Try again' }))
    expect(ai.retry).toHaveBeenCalledWith('a-err')
  })

  it('says why when "Try again" cannot start', async () => {
    ai.retry.mockRejectedValueOnce({ status: 409, code: 'busy' })
    fake.show([asked('q'), answer('', { id: 'a-err', status: 'error', error: 'The answer was cut off.' })])
    renderSidebar()
    fireEvent.click(within(log()).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('An answer is still being written.')
  })

  it('"Try again" is offered on the last answer only', () => {
    fake.show([asked('q'), answer('', { status: 'error', error: 'First failure.' }), asked('q2'), answer('Fine.')])
    renderSidebar()
    expect(within(log()).getByText('First failure.')).toBeInTheDocument()
    expect(within(log()).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('a stopped answer keeps its text and says "Stopped."', () => {
    fake.show([asked('q'), answer('Half an ans', { status: 'stopped' })])
    renderSidebar()
    expect(within(log()).getByText('Half an ans')).toBeInTheDocument()
    expect(within(log()).getByText('Stopped.')).toBeInTheDocument()
    expect(within(log()).queryByRole('button', { name: 'Copy' })).toBeNull()
  })
})

describe('streaming', () => {
  it('a delta renders the streaming answer only, not the earlier ones', () => {
    fake.show([asked('q1'), answer('First answer.'), asked('q2'), answer('Sec', { id: 'a-live', status: 'streaming' })], { busy: true })
    renderSidebar()
    md.renders.length = 0
    act(() => fake.patch('a-live', { text: 'Second' }))
    act(() => fake.patch('a-live', { text: 'Second answer' }))
    expect(md.renders).toEqual(['Second', 'Second answer'])
  })

  it('keeps deltas out of the announcements; the finished answer is a new element in the log', () => {
    fake.show([asked('q'), answer('Sec', { id: 'a-live', status: 'streaming' })], { busy: true })
    renderSidebar()
    const live = log().querySelector('.qa-answer')!
    expect(live).toHaveAttribute('aria-live', 'off')
    act(() => fake.patch('a-live', { text: 'Second' }))
    expect(log().querySelector('.qa-answer')).toBe(live) // same element while it grows
    act(() => {
      fake.patch('a-live', { text: 'Second answer.', status: 'done' })
      aiStore.setState({ busy: false })
    })
    const done = log().querySelector('.qa-answer')!
    expect(done).not.toBe(live)
    expect(done).not.toHaveAttribute('aria-live')
    expect(done).toHaveTextContent('Second answer.')
  })
})

describe('auto-scroll', () => {
  /** jsdom has no layout: give the log a size and let the test move it. */
  function layout(el: HTMLElement, scrollHeight: number, clientHeight = 300) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  }

  it('follows the answer while the Member is at the bottom, stops when they scroll up, and jumps back on request', () => {
    fake.show([asked('q'), answer('S', { id: 'a-live', status: 'streaming' })], { busy: true })
    renderSidebar()
    const el = log()

    layout(el, 1000)
    act(() => fake.patch('a-live', { text: 'So' }))
    expect(el.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()

    // The Member scrolls up to read.
    el.scrollTop = 200
    fireEvent.scroll(el)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()
    layout(el, 1400)
    act(() => fake.patch('a-live', { text: 'Some more' }))
    expect(el.scrollTop).toBe(200)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(el.scrollTop).toBe(1400)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    layout(el, 1800)
    act(() => fake.patch('a-live', { text: 'Some more text' }))
    expect(el.scrollTop).toBe(1800)
  })

  it('scrolling back to the bottom by hand follows again', () => {
    fake.show([asked('q'), answer('S', { id: 'a-live', status: 'streaming' })], { busy: true })
    renderSidebar()
    const el = log()
    layout(el, 1000)
    el.scrollTop = 100
    fireEvent.scroll(el)
    el.scrollTop = 690 // within reach of the end (1000 - 300)
    fireEvent.scroll(el)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    layout(el, 1200)
    act(() => fake.patch('a-live', { text: 'So' }))
    expect(el.scrollTop).toBe(1200)
  })

  it('asking something new brings the Member back to the latest', () => {
    const first = [asked('q'), answer('A long answer.')]
    fake.show(first)
    renderSidebar()
    const el = log()
    layout(el, 1000)
    el.scrollTop = 100
    fireEvent.scroll(el)
    layout(el, 1300)
    act(() => fake.show([...first, asked('next'), answer('', { status: 'streaming' })], { busy: true }))
    expect(el.scrollTop).toBe(1300)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })
})

describe('Pin to Page', () => {
  it('with a Card in scope, pins the answer to that Card', async () => {
    boardFocus.set(CARD)
    fake.show([asked('q'), answer('Roughly geometrically.', { id: 'a1' })])
    renderSidebar()
    fireEvent.click(within(log()).getByRole('button', { name: 'Pin to Page · Surface code basics' }))
    expect(ai.pin).toHaveBeenCalledWith('a1', CARD)
    await settle()
  })

  it('once pinned, the button opens that Page', async () => {
    vi.useFakeTimers()
    navigate('/branches')
    boardFocus.set(CARD)
    fake.show([asked('q'), answer('A.', { id: 'a1', pinned: [{ card: 'c1', cardTitle: 'Surface code basics', block: 'blk-1' }] })])
    renderSidebar()
    expect(within(log()).queryByRole('button', { name: 'Pin to Page · Surface code basics' })).toBeNull()
    fireEvent.click(within(log()).getByRole('button', { name: /Pinned to Page · Surface code basics/ }))
    expect(window.location.pathname).toBe('/')
    act(() => void vi.advanceTimersByTime(100))
    expect(usePagePanel.getState().cardId).toBe('c1')
  })

  it('an answer pinned to one Card can be pinned to another', () => {
    boardFocus.set({ id: 'c2', title: 'MWPM decoder' })
    fake.show([asked('q'), answer('A.', { id: 'a1', pinned: [{ card: 'c1', cardTitle: 'Surface code basics', block: 'blk-1' }] })])
    renderSidebar()
    expect(within(log()).getByRole('button', { name: /Pinned to Page · Surface code basics/ })).toBeInTheDocument()
    fireEvent.click(within(log()).getByRole('button', { name: 'Pin to Page · MWPM decoder' }))
    expect(ai.pin).toHaveBeenCalledWith('a1', { id: 'c2', title: 'MWPM decoder' })
  })

  it('with no Card in scope it is unavailable and says why, also to the keyboard', () => {
    fake.show([asked('q'), answer('A.', { id: 'a1' })])
    renderSidebar()
    const pin = within(log()).getByRole('button', { name: 'Pin to Page' })
    expect(pin).toHaveAttribute('aria-disabled', 'true')
    expect(pin).toHaveAttribute('title', 'Select a Card to pin this to its Page')
    expect(pin).toHaveAccessibleDescription('Select a Card to pin this to its Page')
    fireEvent.click(pin)
    expect(ai.pin).not.toHaveBeenCalled()
  })

  it('says so in words when pinning fails', async () => {
    boardFocus.set(CARD)
    ai.pin.mockRejectedValueOnce(new Error('409'))
    fake.show([asked('q'), answer('A.', { id: 'a1' })])
    renderSidebar()
    fireEvent.click(within(log()).getByRole('button', { name: 'Pin to Page · Surface code basics' }))
    await settle()
    expect(within(log()).getByRole('status')).toHaveTextContent('That answer could not be pinned. Try again.')
    expect(within(log()).getByRole('button', { name: 'Pin to Page · Surface code basics' })).toBeEnabled()
  })
})

describe('Copy', () => {
  const stubClipboard = (writeText: (text: string) => Promise<void>) =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('copies the Markdown source', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    fake.show([asked('q'), answer('**Roughly** $p_L$', { id: 'a1' })])
    renderSidebar()
    fireEvent.click(within(log()).getByRole('button', { name: 'Copy' }))
    await settle()
    expect(writeText).toHaveBeenCalledWith('**Roughly** $p_L$')
    expect(within(log()).getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('says so in words when the clipboard refuses', async () => {
    stubClipboard(async () => {
      throw new Error('denied')
    })
    fake.show([asked('q'), answer('A.', { id: 'a1' })])
    renderSidebar()
    fireEvent.click(within(log()).getByRole('button', { name: 'Copy' }))
    await settle()
    expect(within(log()).getByRole('status')).toHaveTextContent('Could not copy. Select the text and copy it by hand.')
  })

  it('says so when there is no Clipboard API at all', async () => {
    fake.show([asked('q'), answer('A.', { id: 'a1' })])
    renderSidebar()
    fireEvent.click(within(log()).getByRole('button', { name: 'Copy' }))
    await settle()
    expect(within(log()).getByRole('status')).toHaveTextContent('Could not copy.')
  })
})

describe('composer', () => {
  it('asks about the Board of the open Branch when no Card is in focus', () => {
    boardStore.setState({ branch: TRY })
    renderSidebar()
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Board: try-QEC…')
    expect(screen.getByText('⏎ send · ⇧⏎ new line')).toBeInTheDocument()
  })

  it('asks about the Card in focus, and says the scope follows the selection', () => {
    boardFocus.set(CARD)
    renderSidebar()
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Card: Surface code basics…')
    expect(screen.getByText('follows your selection')).toBeInTheDocument()
    act(() => boardFocus.set({ id: 'c2', title: 'MWPM decoder' }))
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Card: MWPM decoder…')
  })

  it('✕ switches to the Board scope until the selection changes', () => {
    boardFocus.set(CARD)
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the whole Board instead' }))
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Board: main…')
    expect(composer()).toHaveFocus()
    type('What is open?')
    enter()
    expect(ai.send).toHaveBeenLastCalledWith('What is open?', BOARD_SCOPE)

    // The same Card published again (say, retitled) is not a new selection…
    act(() => boardFocus.set({ ...CARD }))
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Board: main…')
    // …another Card is.
    act(() => boardFocus.set({ id: 'c2', title: 'MWPM decoder' }))
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Card: MWPM decoder…')
  })

  it('after ✕, deselecting and selecting the same Card follows it again', () => {
    boardFocus.set(CARD)
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the whole Board instead' }))
    act(() => boardFocus.set(null))
    act(() => boardFocus.set(CARD))
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Card: Surface code basics…')
  })

  it('Enter sends with the scope and empties the field', () => {
    boardFocus.set(CARD)
    renderSidebar()
    type('  What is missing?  ')
    enter()
    expect(ai.send).toHaveBeenCalledWith('What is missing?', { branch: 'b-main', branchName: 'main', card: CARD })
    expect(composer()).toHaveValue('')
  })

  it('Shift+Enter does not send', () => {
    renderSidebar()
    type('line one')
    const notPrevented = enter({ shiftKey: true })
    expect(notPrevented).toBe(true) // the browser adds the new line
    expect(ai.send).not.toHaveBeenCalled()
  })

  it('an Enter that confirms an IME composition does not send', () => {
    renderSidebar()
    type('にほんご')
    enter({ isComposing: true })
    enter({ keyCode: 229 })
    expect(ai.send).not.toHaveBeenCalled()
    expect(composer()).toHaveValue('にほんご')
  })

  it('does not send nothing', () => {
    renderSidebar()
    type('   ')
    enter()
    expect(ai.send).not.toHaveBeenCalled()
  })

  it('Esc in the composer changes nothing', () => {
    useAiPanel.setState({ open: true })
    renderSidebar()
    type('half a question')
    fireEvent.keyDown(composer(), { key: 'Escape' })
    expect(composer()).toHaveValue('half a question')
    expect(useAiPanel.getState().open).toBe(true)
  })

  it('is disabled while an answer is being written, except for Stop', () => {
    fake.show([asked('q'), answer('', { status: 'streaming' })], { busy: true })
    renderSidebar()
    expect(composer()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    act(() => aiStore.setState({ busy: false }))
    expect(composer()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('hands focus to Stop while the answer is written and takes it back afterwards', () => {
    renderSidebar()
    composer().focus()
    type('q')
    enter()
    act(() => fake.show([asked('q'), answer('', { status: 'streaming' })], { busy: true }))
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveFocus()
    act(() => aiStore.setState({ busy: false }))
    expect(composer()).toHaveFocus()
  })

  it('gives the words back and says why when the question could not be sent', async () => {
    ai.send.mockRejectedValueOnce({ status: 409, code: 'busy' })
    renderSidebar()
    type('What is missing?')
    enter()
    await settle()
    expect(composer()).toHaveValue('What is missing?')
    expect(screen.getByRole('alert')).toHaveTextContent('An answer is still being written.')
    type('What is missing? ')
    expect(screen.getByRole('alert')).toBeEmptyDOMElement()
  })

  it('focus is in the composer when the sidebar opens, also under StrictMode', () => {
    render(
      <StrictMode>
        <AiSidebar branch="main" />
      </StrictMode>,
    )
    expect(composer()).toHaveFocus()
  })

  it('the draft survives closing and reopening the sidebar', () => {
    const first = renderSidebar()
    type('half a question')
    first.unmount()
    renderSidebar()
    expect(composer()).toHaveValue('half a question')
    expect(useSidebarState.getState().draft).toBe('half a question')
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0) // memory only
  })

  it('cannot send before the Branch is known', () => {
    boardStore.setState({ branch: undefined })
    render(<AiSidebar branch="try-QEC" />)
    expect(composer()).toHaveAttribute('placeholder', 'Ask about Board: try-QEC…')
    type('q')
    enter()
    expect(ai.send).not.toHaveBeenCalled()
    expect(composer()).toHaveValue('q')
  })
})

describe('starter prompts', () => {
  const starters = () => screen.getAllByRole('button').filter((b) => b.classList.contains('qa-starter')).map((b) => b.textContent)

  it('for the Board scope', () => {
    renderSidebar()
    expect(starters()).toEqual(['Summarise the state of this Board', 'Which Cards look related but are not connected?', 'Where are the open questions?'])
    fireEvent.click(screen.getByRole('button', { name: 'Where are the open questions?' }))
    expect(ai.send).toHaveBeenCalledWith('Where are the open questions?', { branch: 'b-main', branchName: 'main' })
  })

  it('for a Card scope, with the Branch id and name from the Board', () => {
    boardStore.setState({ branch: TRY })
    boardFocus.set(CARD)
    renderSidebar()
    expect(starters()).toEqual(['What is missing from this Page?', 'Which Sources should this Card cite?', 'What should connect to this Card?'])
    fireEvent.click(screen.getByRole('button', { name: 'Which Sources should this Card cite?' }))
    expect(ai.send).toHaveBeenCalledWith('Which Sources should this Card cite?', { branch: 'b-try', branchName: 'try-QEC', card: CARD })
  })

  it('are gone once the Conversation has messages', () => {
    fake.show([asked('q'), answer('A.')])
    renderSidebar()
    expect(starters()).toEqual([])
  })

  it('a starter that cannot be sent says why', async () => {
    ai.send.mockRejectedValueOnce({ status: 409, code: 'busy' })
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Where are the open questions?' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('An answer is still being written.')
  })
})

describe('no AI set up', () => {
  const show = (reason: Parameters<typeof none>[0], desktop = false) => {
    aiStore.setState({ setup: none(reason, desktop) })
    return renderSidebar()
  }

  it('desktop without Claude Code: how to set it up, "Check again", and the OpenRouter way', () => {
    show('desktop_no_claude', true)
    expect(screen.getByRole('heading', { name: "AI isn't set up on this computer" })).toBeInTheDocument()
    expect(
      screen.getByText(
        'This sidebar runs on your own Claude subscription through Claude Code. Install Claude Code, sign in to it once in a terminal, then press Check again.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(ai.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Or add an OpenRouter key in/)).toHaveTextContent('Or add an OpenRouter key in AI settings.')
    fireEvent.click(screen.getByRole('link', { name: 'AI settings' }))
    expect(window.location.pathname).toBe('/settings/ai')
  })

  it('browser without a key: where to add one', () => {
    show('browser_no_key')
    expect(screen.getByRole('heading', { name: "AI isn't set up for you" })).toBeInTheDocument()
    expect(
      screen.getByText(
        "Qoop doesn't ship a model. In the desktop app this sidebar runs on your own Claude subscription. In the browser, add an OpenRouter key in AI settings.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Choose a model in AI settings.')).toBeNull()
    const link = screen.getByRole('link', { name: 'Open AI settings' })
    expect(link).toHaveAttribute('href', '/settings/ai')
    fireEvent.click(link)
    expect(window.location.pathname).toBe('/settings/ai')
  })

  it('a key but no model: choose one', () => {
    show('no_model')
    expect(screen.getByRole('heading', { name: "AI isn't set up for you" })).toBeInTheDocument()
    expect(screen.getByText('Choose a model in AI settings.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open AI settings' })).toBeInTheDocument()
  })

  it('a server that stores no keys: ask the Admin, no link', () => {
    show('server_off')
    expect(
      screen.getByText(
        "Qoop doesn't ship a model. In the desktop app this sidebar runs on your own Claude subscription. In the browser it needs an OpenRouter key, which this server is not set up to store. Ask your Admin, or use the desktop app.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it.each(['desktop_no_claude', 'browser_no_key', 'no_model', 'server_off'] as const)('%s: the privacy note, and a composer that cannot be used', (reason) => {
    show(reason)
    expect(screen.getByText('Conversations are private. Other Members only see answers you Pin.')).toBeInTheDocument()
    expect(composer()).toBeDisabled()
    expect(composer()).toHaveAttribute('placeholder', 'Set up AI to ask about Board: main')
    expect(screen.queryByRole('button', { name: 'New Conversation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Conversations' })).toBeNull()
    expect(screen.getByText('no model')).toBeInTheDocument()
  })

  it('while the setup is being detected it only says so', () => {
    show('loading')
    expect(screen.getByRole('status')).toHaveTextContent('Checking what AI is set up…')
    expect(screen.queryByRole('heading', { name: /isn't set up/ })).toBeNull()
    expect(composer()).toBeDisabled()
  })

  it('becomes usable when the setup is found', () => {
    show('desktop_no_claude', true)
    act(() => aiStore.setState({ setup: CLAUDE }))
    expect(composer()).toBeEnabled()
    expect(screen.queryByRole('heading', { name: /isn't set up/ })).toBeNull()
  })
})
