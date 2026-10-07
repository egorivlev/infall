// Typing in one Block must not re-render the others, and nothing may reach the Board until the
// draft is committed. MarkdownView is swapped for an unmemoised stand-in that counts its renders,
// so every render of a Block that shows text is counted.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('./MarkdownView', () => ({
  MarkdownView: ({ text }: { text: string }) => {
    renders.set(text, (renders.get(text) ?? 0) + 1)
    return <p>{text}</p>
  },
}))

const { Blocks } = await import('./Blocks')
const { editLock } = await import('./lock')
const { toasts } = await import('../board/toastStore')
const { block, card } = await import('./testkit')
const { boardStore, pageStore, submit } = fake

function Host() {
  const vm = fake.module({ ops: {} }).usePage('a')
  return <Blocks cardId="a" blocks={vm.blocks} canEdit />
}

const commits = vi.fn()

beforeEach(() => {
  fake.reset()
  renders.clear()
  commits.mockClear()
  boardStore.setState({ cards: [card('a', 'A')] })
  pageStore.setState({ blocks: [block('b1', 'a', '1', 'one'), block('b2', 'a', '2', 'two'), block('b3', 'a', '3', 'three')] })
})
afterEach(() => {
  cleanup()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
  })
})

const open = () =>
  render(
    <Profiler id="blocks" onRender={commits}>
      <Host />
    </Profiler>,
  )
const view = (n: number) => screen.getByRole('group', { name: `Block ${n}. Press Enter to edit.` })
const editor = (n: number) => screen.getByRole<HTMLTextAreaElement>('textbox', { name: `Block ${n}, Markdown` })
const count = (text: string) => renders.get(text) ?? 0

describe('Blocks: what re-renders', () => {
  it('renders each Block once to begin with', () => {
    open()
    expect([count('one'), count('two'), count('three')]).toEqual([1, 1, 1])
  })

  it('opening an editor re-renders only that Block', () => {
    open()
    fireEvent.click(view(2))
    expect([count('one'), count('two'), count('three')]).toEqual([1, 1, 1])
    expect(editor(2)).toBeInTheDocument()
  })

  it('typing re-renders nothing at all and sends nothing', () => {
    open()
    fireEvent.click(view(2))
    commits.mockClear()
    const field = editor(2)
    for (const value of ['t', 'tw', 'two', 'two ', 'two m', 'two mo', 'two mor', 'two more']) {
      fireEvent.input(field, { target: { value } })
      fireEvent.keyDown(field, { key: value.slice(-1) })
    }
    expect(commits).not.toHaveBeenCalled() // React committed nothing: the draft lives in the textarea
    expect(submit).not.toHaveBeenCalled()
    expect([count('one'), count('two'), count('three')]).toEqual([1, 1, 1])
    expect(field.value).toBe('two more')
  })

  it('committing re-renders only the Block that changed', () => {
    open()
    fireEvent.click(view(2))
    fireEvent.change(editor(2), { target: { value: 'two more' } })
    fireEvent.blur(editor(2))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(count('two more')).toBe(1)
    expect([count('one'), count('three')]).toEqual([1, 1])
  })

  it('a remote change to one Block leaves the others alone', () => {
    open()
    act(() => pageStore.setState((s) => ({ blocks: s.blocks.map((b) => (b.id === 'b3' ? { ...b, text: 'three, remotely' } : b)) })))
    expect(count('three, remotely')).toBe(1)
    expect([count('one'), count('two')]).toEqual([1, 1])
  })

  it('unrelated Board changes do not re-render any Block', () => {
    open()
    act(() => boardStore.setState({ pending: 3 }))
    act(() => boardStore.setState({ cards: [card('a', 'A'), card('z', 'Another Card')] }))
    expect([count('one'), count('two'), count('three')]).toEqual([1, 1, 1])
  })

  it('moving a Block re-renders only the Blocks whose place changed', () => {
    open()
    fireEvent.click(screen.getAllByRole('button', { name: 'Move block down' })[0]!)
    // b1 and b2 swapped; b3 kept its place, number and neighbours.
    expect(count('three')).toBe(1)
    expect(count('one')).toBe(2)
    expect(count('two')).toBe(2)
  })
})
