// The To-dos screen (6a): one column per Member, ticking, adding and assigning, Card chips, edit, delete with Undo.
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, BranchInfo, CardVM, Member, Todo } from '../../lib'

// A small stand-in for the data layer's To-do cache: optimistic like the real one, and it can be told to fail.
// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
const h = vi.hoisted(() => ({
  list: [] as Todo[],
  listeners: new Set<() => void>(),
  people: [] as Member[],
  board: {} as unknown as BoardSnapshot,
  branches: [] as BranchInfo[],
  fail: null as null | { code: string; status: number },
  reload: (async () => {}) as () => Promise<void>,
  calls: { reload: 0, add: [] as unknown[], setDone: [] as unknown[], edit: [] as unknown[], remove: [] as unknown[] },
  next: 0,
  me: 'm',
}))
const setList = (list: Todo[]) => {
  h.list = list
  for (const l of [...h.listeners]) l()
}

vi.mock('../../lib', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (l: () => void) => {
    h.listeners.add(l)
    return () => void h.listeners.delete(l)
  }
  const guard = async () => {
    if (h.fail) throw Object.assign(new Error('nope'), h.fail)
  }
  return {
    useTodos: () => useSyncExternalStore(subscribe, () => h.list),
    useMembers: () => h.people,
    useBoard: () => h.board,
    useBranches: () => h.branches,
    useForYou: () => ({ status: 'ready', items: [], unseen: 0 }),
    todos: {
      reload: () => {
        h.calls.reload++
        return h.reload()
      },
      add: async (input: { owner: string; text: string; card?: Todo['card'] }) => {
        h.calls.add.push(input)
        await guard()
        const todo: Todo = { id: `new${++h.next}`, done: false, created_by: h.me, created_at: Date.now(), ...input }
        setList([...h.list, todo])
        return todo
      },
      setDone: async (id: string, done: boolean) => {
        h.calls.setDone.push([id, done])
        await guard()
        setList(h.list.map((t) => (t.id === id ? { ...t, done } : t)))
      },
      edit: async (id: string, patch: { text?: string }) => {
        h.calls.edit.push([id, patch])
        await guard()
        setList(h.list.map((t) => (t.id === id ? { ...t, ...(patch.text === undefined ? {} : { text: patch.text }) } : t)))
      },
      remove: async (id: string) => {
        h.calls.remove.push(id)
        await guard()
        setList(h.list.filter((t) => t.id !== id))
      },
    },
  }
})

import { boardBridge, useBoardRequest } from '../bridge'
import { rememberBranch } from '../shell/router'
import { cardRefOf, columnsOf, failure, firstName } from './model'
import { CARD_REMOVED_TITLE } from './TodoItem'
import { Todos } from './Todos'

const ELENA: Member = { id: 'a', name: 'Elena Varga', role: 'admin', color: '#aaa' }
const MEI: Member = { id: 'm', name: 'Mei Lin', role: 'member', color: '#bbb' }
const ANA: Member = { id: 'n', name: 'Ana Ruiz', role: 'member', color: '#ddd' }
const JONAS: Member = { id: 'j', name: 'Jonas Weber', role: 'member', color: '#eee' }
const PRIYA: Member = { id: 'g', name: 'Priya Nair', role: 'guest', color: '#ccc' }

const MAIN: BranchInfo = { id: 'b-main', name: 'main', seq: 40, checkpoints: 2 }
const QEC: BranchInfo = { id: 'b-qec', name: 'try-QEC', seq: 14, checkpoints: 0, parent: { branch: 'b-main', seq: 30 }, created_by: 'm' }

const at = (d: number) => new Date(new Date().getFullYear(), 10, d, 10, 2).getTime()
const card = (id: string, title: string): CardVM => ({ id, title, summary: '', status: 'idea', x: 0, y: 0, w: 224, h: 132, blocks: 0, sources: 0 })
const todo = (id: string, owner: string, text: string, over: Partial<Todo> = {}): Todo => ({
  id,
  owner,
  text,
  done: false,
  created_by: owner,
  created_at: at(10),
  ...over,
})

function board(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return { status: 'live', seq: 40, branch: MAIN, cards: [], frames: [], connections: [], presence: [], pending: 0, readOnly: false, ...over }
}

const column = (name: string) => within(screen.getByRole('region', { name }))
const columnNames = () => screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)
const item = (text: string) => within(screen.getByText(text).closest('li') as HTMLElement)
const go = (path: string) => window.history.replaceState(null, '', path)
const show = async (me: Member = MEI) => {
  h.me = me.id
  const view = render(<Todos me={me} />)
  await act(async () => {}) // the reload settles
  return view
}

beforeEach(() => {
  go('/todos')
  rememberBranch('main')
  useBoardRequest.setState({ request: null })
  h.list = []
  h.listeners.clear()
  h.people = [ELENA, MEI, ANA, JONAS, PRIYA]
  h.board = board()
  h.branches = [MAIN, QEC]
  h.fail = null
  h.reload = async () => {}
  h.calls = { reload: 0, add: [], setDone: [], edit: [], remove: [] }
  h.next = 0
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('columns', () => {
  it('gives every Member and Admin a column — you first, then by name — and Guests none', async () => {
    await show()
    expect(columnNames()).toEqual(['Mei Lin', 'Ana Ruiz', 'Elena Varga', 'Jonas Weber'])
    expect(column('Mei Lin').getByText('Member (you)')).toBeInTheDocument()
    expect(column('Elena Varga').getByText('Admin')).toBeInTheDocument()
    expect(column('Ana Ruiz').getByText('Member')).toBeInTheDocument()
    expect(screen.queryByText('Priya Nair')).not.toBeInTheDocument()
  })

  it('puts an Admin first in their own view, marked as you', async () => {
    await show(ELENA)
    expect(columnNames()).toEqual(['Elena Varga', 'Ana Ruiz', 'Jonas Weber', 'Mei Lin'])
    expect(column('Elena Varga').getByText('Admin (you)')).toBeInTheDocument()
  })

  it('still shows your column before the Member list has arrived', async () => {
    h.people = []
    await show()
    expect(columnNames()).toEqual(['Mei Lin'])
  })

  it('does not upper-case names and shows initials on the avatar', async () => {
    const { container } = await show()
    expect(column('Ana Ruiz').getByRole('heading', { name: 'Ana Ruiz' })).toBeInTheDocument()
    expect([...container.querySelectorAll('.q-avatar')].map((el) => el.textContent)).toEqual(['ML', 'AR', 'EV', 'JW'])
  })

  it('counts open To-dos in the header and in each column head', async () => {
    h.list = [
      todo('t1', 'm', 'Read Wang et al.'),
      todo('t2', 'm', 'Re-run CartPole', { done: true }),
      todo('t3', 'm', 'Fit Λ'),
      todo('t4', 'n', 'Layerwise training'),
      todo('t5', 'g', 'A Guest has no column'), // not counted either
    ]
    await show()
    expect(screen.getByText('3 open · 4 Members')).toBeInTheDocument()
    expect(column('Mei Lin').getByText('2 open')).toBeInTheDocument()
    expect(column('Ana Ruiz').getByText('1 open')).toBeInTheDocument()
    expect(column('Elena Varga').getByText('0 open')).toBeInTheDocument()
  })

  it('says "1 Member" for one', async () => {
    h.people = [MEI, PRIYA]
    await show()
    expect(screen.getByText('0 open · 1 Member')).toBeInTheDocument()
  })

  it('lists a column oldest first', async () => {
    h.list = [todo('t2', 'm', 'Second', { created_at: at(12) }), todo('t1', 'm', 'First', { created_at: at(11) })]
    await show()
    expect(column('Mei Lin').getAllByRole('listitem').map((li) => within(li).getByRole('checkbox').getAttribute('aria-labelledby'))).toHaveLength(2)
    const texts = column('Mei Lin').getAllByRole('listitem').map((li) => li.querySelector('.qt-item__text')?.textContent)
    expect(texts).toEqual(['First', 'Second'])
  })
})

describe('filter', () => {
  beforeEach(() => {
    h.list = [todo('t1', 'm', 'Open one'), todo('t2', 'm', 'Done one', { done: true }), todo('t3', 'n', 'Ana done', { done: true })]
  })

  it('is a radio group that starts at Open', async () => {
    await show()
    expect(screen.getByRole('group', { name: 'Show' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['open', 'done', 'all'])
    expect(screen.getByRole('radio', { name: 'Open' })).toBeChecked()
    expect(screen.getByText('Open one')).toBeInTheDocument()
    expect(screen.queryByText('Done one')).not.toBeInTheDocument()
    expect(column('Ana Ruiz').getByText('No open To-dos.')).toBeInTheDocument()
  })

  it('shows Done or All when chosen; the counts stay about open To-dos', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(screen.getByRole('radio', { name: 'Done' }))
    expect(screen.queryByText('Open one')).not.toBeInTheDocument()
    expect(screen.getByText('Done one')).toBeInTheDocument()
    expect(screen.getByText('Ana done')).toBeInTheDocument()
    expect(screen.getByText('1 open · 4 Members')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('Open one')).toBeInTheDocument()
    expect(screen.getByText('Done one')).toBeInTheDocument()
  })

  it('names what is missing when a column has nothing done', async () => {
    const user = userEvent.setup()
    h.list = [todo('t1', 'm', 'Open one')]
    await show()
    await user.click(screen.getByRole('radio', { name: 'Done' }))
    expect(column('Mei Lin').getByText('No done To-dos.')).toBeInTheDocument()
  })
})

describe('ticking', () => {
  beforeEach(() => {
    h.list = [todo('t1', 'm', 'Mine'), todo('t2', 'n', 'Hers'), todo('t3', 'm', 'Mine, done', { done: true })]
  })

  it('ticks your own through todos.setDone', async () => {
    const user = userEvent.setup()
    await show()
    const box = screen.getByRole('checkbox', { name: 'Mine' })
    expect(box).toBeEnabled()
    expect(box).toHaveAttribute('title', 'Mark done')
    await user.click(box)
    expect(h.calls.setDone).toEqual([['t1', true]])
  })

  it('unticks a done one', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(screen.getByRole('radio', { name: 'All' }))
    const box = screen.getByRole('checkbox', { name: 'Mine, done' })
    expect(box).toBeChecked()
    expect(box).toHaveAttribute('title', 'Mark not done')
    await user.click(box)
    expect(h.calls.setDone).toEqual([['t3', false]])
  })

  it("disables other people's checkboxes and says who can tick", async () => {
    const user = userEvent.setup()
    await show()
    const box = screen.getByRole('checkbox', { name: 'Hers' })
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute('title', 'Only Ana can tick this')
    await user.click(box)
    expect(h.calls.setDone).toEqual([])
  })

  it('marks done To-dos for styling (struck through, dimmed) and leaves open ones alone', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('Mine, done').closest('li')).toHaveClass('is-done')
    expect(screen.getByText('Mine').closest('li')).not.toHaveClass('is-done')
  })
})

describe('adding', () => {
  it('adds to your own column on Enter: you as the owner, no Card', async () => {
    const user = userEvent.setup()
    await show()
    const input = column('Mei Lin').getByRole('textbox', { name: 'Add a To-do' })
    expect(input).toHaveAttribute('placeholder', 'Add a To-do…')
    await user.type(input, '  Fit Λ for d = 3…9  {Enter}')
    expect(h.calls.add).toEqual([{ owner: 'm', text: 'Fit Λ for d = 3…9' }])
    expect(h.calls.add[0]).not.toHaveProperty('card')
    expect(input).toHaveValue('')
    expect(await column('Mei Lin').findByText('Fit Λ for d = 3…9')).toBeInTheDocument()
  })

  it("assigns in someone else's column: they are the owner", async () => {
    const user = userEvent.setup()
    await show()
    const input = column('Ana Ruiz').getByRole('textbox', { name: 'Assign to Ana' })
    expect(input).toHaveAttribute('placeholder', 'Assign to Ana…')
    await user.type(input, 'Try trainable β{Enter}')
    expect(h.calls.add).toEqual([{ owner: 'n', text: 'Try trainable β' }])
    expect(h.calls.add[0]).not.toHaveProperty('card')
    expect(await column('Ana Ruiz').findByText(/^Assigned by Mei · /)).toBeInTheDocument()
  })

  it('ignores an empty line', async () => {
    const user = userEvent.setup()
    await show()
    await user.type(column('Mei Lin').getByRole('textbox'), '   {Enter}')
    expect(h.calls.add).toEqual([])
  })

  it('says so in plain words when adding fails, and gives the words back', async () => {
    const user = userEvent.setup()
    h.fail = { code: 'forbidden', status: 403 }
    await show()
    const input = column('Ana Ruiz').getByRole('textbox')
    await user.type(input, 'Read §10.5{Enter}')
    const alert = await column('Ana Ruiz').findByRole('alert')
    expect(alert).toHaveTextContent('That To-do could not be added. Try again.')
    expect(alert.textContent).not.toMatch(/forbidden|403|nope/)
    expect(input).toHaveValue('Read §10.5')
    expect(column('Mei Lin').queryByRole('alert')).not.toBeInTheDocument()

    // The next success in that column clears the sentence.
    h.fail = null
    await user.type(input, '{Enter}')
    await waitFor(() => expect(column('Ana Ruiz').queryByRole('alert')).not.toBeInTheDocument())
  })
})

describe('"Assigned by"', () => {
  it('shows who assigned it and when, only when that is not the owner', async () => {
    h.list = [todo('t1', 'm', 'From Ana', { created_by: 'n', created_at: at(20) }), todo('t2', 'm', 'My own')]
    await show()
    expect(item('From Ana').getByText('Assigned by Ana · 20 Nov')).toBeInTheDocument()
    expect(item('My own').queryByText(/Assigned by/)).not.toBeInTheDocument()
  })

  it('does not invent a name for someone who is no longer a Member', async () => {
    h.list = [todo('t1', 'm', 'From someone', { created_by: 'gone', created_at: at(20) })]
    await show()
    expect(item('From someone').getByText('Assigned by a former Member · 20 Nov')).toBeInTheDocument()
  })
})

describe('Card chip', () => {
  it('live on the open Branch: a button with the current title that goes to the Board and focuses the Card', async () => {
    const user = userEvent.setup()
    const focus = vi.spyOn(boardBridge, 'focus')
    h.board = board({ cards: [card('c1', 'Noise-induced plateaus (renamed)')] })
    h.list = [todo('t1', 'm', 'Read Wang et al.', { card: { id: 'c1', title: 'Noise-induced plateaus', branch: 'b-main' } })]
    await show()
    const chip = item('Read Wang et al.').getByRole('button', { name: 'Card: Noise-induced plateaus (renamed)' })
    await user.click(chip)
    expect(window.location.pathname).toBe('/')
    await waitFor(() => expect(focus).toHaveBeenCalledWith('card', 'c1'))
  })

  it('goes back to the Branch that is open, not always to main', async () => {
    const user = userEvent.setup()
    rememberBranch('try-QEC')
    h.board = board({ branch: QEC, cards: [card('c1', 'Union-find decoder')] })
    // Made on main, and also live on the Branch that is open: the open Branch wins.
    h.list = [todo('t1', 'm', 'Benchmark', { card: { id: 'c1', title: 'Union-find decoder', branch: 'b-main' } })]
    await show()
    await user.click(item('Benchmark').getByRole('button', { name: 'Card: Union-find decoder' }))
    expect(window.location.pathname).toBe('/b/try-QEC')
  })

  it('on another Branch: a link to that Branch with the stored title, and the Card is focused once it opens', async () => {
    const user = userEvent.setup()
    const focus = vi.spyOn(boardBridge, 'focus')
    h.list = [todo('t1', 'm', 'Benchmark union-find', { card: { id: 'c9', title: 'Union-find decoder', branch: 'b-qec' } })]
    await show()
    const link = item('Benchmark union-find').getByRole('link')
    expect(link).toHaveAttribute('href', '/b/try-QEC')
    expect(link).toHaveAttribute('title', 'Opens try-QEC and selects the Card')
    expect(link).toHaveTextContent('⑂ Branch try-QEC · Card: Union-find decoder ↗')
    expect(item('Benchmark union-find').queryByRole('button', { name: /^Card:/ })).not.toBeInTheDocument()
    await user.click(link)
    expect(window.location.pathname).toBe('/b/try-QEC')
    expect(focus).toHaveBeenCalledWith('card', 'c9')
  })

  it('removed: a dashed chip that keeps the stored title and explains itself', async () => {
    h.list = [
      todo('t1', 'm', 'Write up shadow tomography', { card: { id: 'c7', title: 'Shadow tomography notes', branch: 'b-main' } }),
      todo('t2', 'm', 'Branch is gone too', { card: { id: 'c8', title: 'Lost', branch: 'b-deleted' } }),
    ]
    await show()
    const chip = item('Write up shadow tomography').getByTitle(CARD_REMOVED_TITLE)
    expect(CARD_REMOVED_TITLE).toBe('The To-do is kept; the Card it pointed to was removed.')
    expect(chip).toHaveClass('qt-chip--gone')
    expect(chip).toHaveTextContent('Card removed · Shadow tomography notes')
    expect(chip.tagName).toBe('SPAN')
    expect(item('Write up shadow tomography').queryByRole('link')).not.toBeInTheDocument()
    expect(item('Branch is gone too').getByTitle(CARD_REMOVED_TITLE)).toHaveTextContent('Lost')
  })

  it('does not call a Card removed while the Board is still loading', async () => {
    h.board = board({ status: 'loading', branch: undefined })
    h.branches = []
    h.list = [todo('t1', 'm', 'Read', { card: { id: 'c1', title: 'Barren plateaus', branch: 'b-main' } })]
    await show()
    expect(item('Read').getByText('Barren plateaus')).toBeInTheDocument()
    expect(item('Read').queryByTitle(CARD_REMOVED_TITLE)).not.toBeInTheDocument()
    expect(item('Read').queryByRole('button', { name: /^Card:/ })).not.toBeInTheDocument()
  })

  it('shows no chip for a To-do without a Card, and "Untitled" for a Card without a title', async () => {
    h.board = board({ cards: [card('c1', '')] })
    h.list = [todo('t1', 'm', 'Plain'), todo('t2', 'm', 'Points at untitled', { card: { id: 'c1', title: '', branch: 'b-main' } })]
    const { container } = await show()
    expect(container.querySelectorAll('.qt-chip')).toHaveLength(1)
    expect(item('Points at untitled').getByRole('button', { name: 'Card: Untitled' })).toBeInTheDocument()
  })
})

describe('edit and delete', () => {
  beforeEach(() => {
    h.list = [
      todo('own', 'm', 'My own'),
      todo('assigned-to-me', 'm', 'Given to me', { created_by: 'n' }),
      todo('by-me', 'n', 'I gave this to Ana', { created_by: 'm' }),
      todo('hers', 'n', 'Her own'),
      todo('theirs', 'j', 'Elena gave this to Jonas', { created_by: 'a' }),
    ]
  })

  it('offers Edit and Delete on your own and on the ones you created, and nothing otherwise', async () => {
    await show()
    for (const text of ['My own', 'Given to me', 'I gave this to Ana']) {
      expect(item(text).getByRole('button', { name: `Edit To-do: ${text}` })).toHaveTextContent('Edit')
      expect(item(text).getByRole('button', { name: `Delete To-do: ${text}` })).toHaveTextContent('Delete')
    }
    for (const text of ['Her own', 'Elena gave this to Jonas']) {
      expect(item(text).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
      expect(item(text).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
    }
  })

  it('edits in place: Enter confirms through todos.edit and focus returns to Edit', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(item('My own').getByRole('button', { name: /^Edit/ }))
    const box = screen.getByRole('textbox', { name: 'To-do text' })
    expect(box).toHaveFocus()
    expect(box).toHaveValue('My own')
    await user.clear(box)
    await user.type(box, '  My own, reworded {Enter}')
    expect(h.calls.edit).toEqual([['own', { text: 'My own, reworded' }]])
    expect(screen.queryByRole('textbox', { name: 'To-do text' })).not.toBeInTheDocument()
    expect(await screen.findByText('My own, reworded')).toBeInTheDocument()
    expect(item('My own, reworded').getByRole('button', { name: /^Edit/ })).toHaveFocus()
  })

  it('confirms on blur, cancels on Esc, and sends nothing for an unchanged or empty text', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(item('I gave this to Ana').getByRole('button', { name: /^Edit/ }))
    await user.type(screen.getByRole('textbox', { name: 'To-do text' }), ' today')
    await user.click(screen.getByRole('heading', { name: 'To-dos' }))
    expect(h.calls.edit).toEqual([['by-me', { text: 'I gave this to Ana today' }]])

    await user.click(item('My own').getByRole('button', { name: /^Edit/ }))
    await user.type(screen.getByRole('textbox', { name: 'To-do text' }), ' nope{Escape}')
    expect(screen.queryByRole('textbox', { name: 'To-do text' })).not.toBeInTheDocument()
    expect(screen.getByText('My own')).toBeInTheDocument()

    await user.click(item('My own').getByRole('button', { name: /^Edit/ }))
    await user.keyboard('{Enter}')
    await user.click(item('My own').getByRole('button', { name: /^Edit/ }))
    await user.clear(screen.getByRole('textbox', { name: 'To-do text' }))
    await user.keyboard('{Enter}')
    expect(h.calls.edit).toHaveLength(1)
  })

  it('keeps the draft when the same To-do changes elsewhere while typing', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(item('My own').getByRole('button', { name: /^Edit/ }))
    const box = screen.getByRole('textbox', { name: 'To-do text' })
    await user.type(box, ' — draft')
    act(() => setList(h.list.map((t) => (t.id === 'own' ? { ...t, text: 'Changed by a socket frame' } : t))))
    expect(box).toHaveValue('My own — draft')
  })

  it('edits under StrictMode too (effects run twice in development)', async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <Todos me={MEI} />
      </StrictMode>,
    )
    await act(async () => {})
    await user.click(item('My own').getByRole('button', { name: /^Edit/ }))
    await user.type(screen.getByRole('textbox', { name: 'To-do text' }), '!{Enter}')
    expect(h.calls.edit).toEqual([['own', { text: 'My own!' }]])
    expect(screen.queryByRole('textbox', { name: 'To-do text' })).not.toBeInTheDocument()
  })

  it('deletes at once, without a dialog, and Undo adds it again', async () => {
    const user = userEvent.setup()
    h.list = [todo('own', 'm', 'My own', { card: { id: 'c1', title: 'Barren plateaus', branch: 'b-main' } })]
    await show()
    await user.click(item('My own').getByRole('button', { name: /^Delete/ }))
    expect(h.calls.remove).toEqual(['own'])
    await waitFor(() => expect(screen.queryByText('My own')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const row = column('Mei Lin').getByRole('status')
    expect(row).toHaveTextContent('Deleted.')
    await user.click(within(row).getByRole('button', { name: 'Undo' }))
    expect(h.calls.add).toEqual([{ owner: 'm', text: 'My own', card: { id: 'c1', title: 'Barren plateaus', branch: 'b-main' } }])
    expect(await screen.findByText('My own')).toBeInTheDocument()
    expect(column('Mei Lin').queryByRole('status')).not.toBeInTheDocument()
  })

  it('Undo re-adds one you assigned to its owner, without a card key when it had none', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(item('I gave this to Ana').getByRole('button', { name: /^Delete/ }))
    expect(h.calls.remove).toEqual(['by-me'])
    await user.click(column('Ana Ruiz').getByRole('button', { name: 'Undo' }))
    expect(h.calls.add).toEqual([{ owner: 'n', text: 'I gave this to Ana' }])
    expect(h.calls.add[0]).not.toHaveProperty('card')
    expect(h.calls.setDone).toEqual([])
  })

  it('brings a done To-do of your own back done', async () => {
    const user = userEvent.setup()
    h.list = [todo('own', 'm', 'Finished', { done: true })]
    await show()
    await user.click(screen.getByRole('radio', { name: 'All' }))
    await user.click(item('Finished').getByRole('button', { name: /^Delete/ }))
    await user.click(column('Mei Lin').getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(h.calls.setDone).toEqual([['new1', true]]))
  })

  it('withdraws the Undo offer after six seconds, or when dismissed', async () => {
    vi.useFakeTimers()
    await show()
    fireEvent.click(item('My own').getByRole('button', { name: /^Delete/ }))
    await act(async () => {})
    expect(column('Mei Lin').getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(5900))
    expect(column('Mei Lin').getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(200))
    expect(column('Mei Lin').queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()

    fireEvent.click(item('Given to me').getByRole('button', { name: /^Delete/ }))
    await act(async () => {})
    fireEvent.click(column('Mei Lin').getByRole('button', { name: 'Dismiss' }))
    expect(column('Mei Lin').queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(h.calls.add).toEqual([])
  })
})

describe('failures', () => {
  beforeEach(() => {
    h.list = [todo('own', 'm', 'My own'), todo('by-me', 'n', 'I gave this to Ana', { created_by: 'm' })]
  })

  it('shows a plain sentence in the column when ticking fails', async () => {
    const user = userEvent.setup()
    await show()
    h.fail = { code: 'network', status: -1 }
    await user.click(screen.getByRole('checkbox', { name: 'My own' }))
    expect(await column('Mei Lin').findByRole('alert')).toHaveTextContent('That To-do could not be updated. Check your connection and try again.')
  })

  it('shows one when an edit fails', async () => {
    const user = userEvent.setup()
    await show()
    h.fail = { code: 'forbidden', status: 403 }
    await user.click(item('I gave this to Ana').getByRole('button', { name: /^Edit/ }))
    await user.type(screen.getByRole('textbox', { name: 'To-do text' }), '!{Enter}')
    expect(await column('Ana Ruiz').findByRole('alert')).toHaveTextContent('That To-do could not be changed. Try again.')
  })

  it('shows one when a delete fails, and offers no Undo for something that was not deleted', async () => {
    const user = userEvent.setup()
    await show()
    h.fail = { code: 'server', status: 500 }
    await user.click(item('My own').getByRole('button', { name: /^Delete/ }))
    expect(await column('Mei Lin').findByRole('alert')).toHaveTextContent('That To-do could not be deleted. Try again.')
    expect(column('Mei Lin').queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.getByText('My own')).toBeInTheDocument()
  })

  it('shows one when Undo fails', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(item('My own').getByRole('button', { name: /^Delete/ }))
    h.fail = { code: 'server', status: 500 }
    await user.click(await column('Mei Lin').findByRole('button', { name: 'Undo' }))
    expect(await column('Mei Lin').findByRole('alert')).toHaveTextContent('That To-do could not be brought back. Try again.')
  })
})

describe('empty and loading', () => {
  it('asks the data layer for the list when the screen opens', async () => {
    await show()
    expect(h.calls.reload).toBe(1)
  })

  it('says there are no To-dos yet, with the add field below', async () => {
    await show()
    expect(column('Mei Lin').getByText('No To-dos yet. Add one below.')).toBeInTheDocument()
    expect(column('Mei Lin').getByRole('textbox', { name: 'Add a To-do' })).toBeInTheDocument()
    expect(screen.getByText('0 open · 4 Members')).toBeInTheDocument()
  })

  it('shows nothing for the first 150 ms of loading, then "Loading To-dos…", then the columns', async () => {
    vi.useFakeTimers()
    let done = () => {}
    h.reload = () => new Promise<void>((resolve) => (done = resolve))
    render(<Todos me={MEI} />)
    await act(async () => {}) // the request has gone out
    expect(screen.queryByText('Loading To-dos…')).not.toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(140))
    expect(screen.queryByText('Loading To-dos…')).not.toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(20))
    expect(screen.getByRole('status')).toHaveTextContent('Loading To-dos…')
    expect(screen.queryByText(/No To-dos yet/)).not.toBeInTheDocument()

    await act(async () => {
      done()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(screen.queryByText('Loading To-dos…')).not.toBeInTheDocument()
    expect(columnNames()).toHaveLength(4)
  })

  it('does not wait for the reload when the list is already there', () => {
    h.reload = () => new Promise<void>(() => {})
    h.list = [todo('t1', 'm', 'Already cached')]
    render(<Todos me={MEI} />)
    expect(screen.getByText('Already cached')).toBeInTheDocument()
  })

  it('leaves "loading" under StrictMode as well', async () => {
    render(
      <StrictMode>
        <Todos me={MEI} />
      </StrictMode>,
    )
    await act(async () => {})
    expect(columnNames()).toHaveLength(4)
  })

  it('says in plain words when the list cannot be loaded, and tries again on request', async () => {
    const user = userEvent.setup()
    h.reload = async () => {
      throw Object.assign(new Error('boom'), { code: 'network', status: -1 })
    }
    await show()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('To-dos could not be loaded. Check your connection. Try again')
    h.reload = async () => {}
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(h.calls.reload).toBe(2)
  })
})

describe('model', () => {
  it('firstName takes the first word', () => {
    expect(firstName('Ana Ruiz')).toBe('Ana')
    expect(firstName('  Cher ')).toBe('Cher')
    expect(firstName('')).toBe('')
  })

  it('columnsOf leaves a Guest viewer without a column of their own', () => {
    expect(columnsOf(PRIYA, [ELENA, MEI, PRIYA], []).map((c) => c.member.name)).toEqual(['Elena Varga', 'Mei Lin'])
  })

  it('cardRefOf tells the four cases apart', () => {
    const ref = { id: 'c1', title: 'Stored', branch: 'b-qec' }
    expect(cardRefOf(ref, board({ cards: [card('c1', 'Now')] }), [MAIN, QEC])).toEqual({ kind: 'live', id: 'c1', title: 'Now' })
    expect(cardRefOf(ref, board(), [MAIN, QEC])).toEqual({ kind: 'branch', id: 'c1', title: 'Stored', branch: 'try-QEC' })
    expect(cardRefOf(ref, board({ branch: QEC }), [MAIN, QEC])).toEqual({ kind: 'removed', title: 'Stored' })
    expect(cardRefOf(ref, board(), [MAIN])).toEqual({ kind: 'removed', title: 'Stored' })
    expect(cardRefOf(ref, board({ status: 'loading', branch: undefined }), [])).toEqual({ kind: 'pending', title: 'Stored' })
  })

  it('failure never shows a code', () => {
    expect(failure('added', { code: 'rejected', status: 400 })).toBe('That To-do could not be added. Try again.')
    expect(failure('loaded', 'what')).toBe('To-dos could not be loaded.')
  })
})
