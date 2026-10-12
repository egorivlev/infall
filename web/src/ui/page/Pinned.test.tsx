// M7: a text Block pinned from an AI Conversation, as the Page panel shows it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { ops } = await import('../../lib')
const { PagePanel } = await import('./PagePanel')
const { editLock } = await import('./lock')
const { memberName } = await import('./people')
const { toasts } = await import('../board/toastStore')
const { pagePanel, useBoardRequest, usePagePanel } = await import('../bridge')
const { ANA, GUEST, MEI, block, card, pinned } = await import('./testkit')
const { at } = await import('../history/testkit')

const { boardStore, pageStore, sessionStore, membersStore, submit } = fake

const MODEL = 'anthropic/claude-sonnet-4.5'
const PINNED_AT = new Date(2030, 10, 14, 9, 30).getTime()
const ANSWER = 'The plateau looks like **limited expressivity**, since $\\langle O_a\\rangle\\in[-1,1]$.\n\n- test a trainable beta'
const AI = { model: MODEL, pinnedBy: 'mei', pinnedAt: PINNED_AT }

function seed(ai: Parameters<typeof pinned>[4] = AI) {
  boardStore.setState({ cards: [card('a', 'QRL on CartPole')] })
  pageStore.setState({
    blocks: [block('b1', 'a', '1', 'First **bold** paragraph'), pinned('p1', 'a', '2', ANSWER, ai), block('b3', 'a', '3', 'Third')],
  })
}

beforeEach(() => {
  fake.reset()
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
})

const open = () => render(<PagePanel cardId="a" full={false} onClose={() => {}} />)
const row = () => screen.getByTestId('block-p1')
const frame = () => within(row()).getByRole('group', { name: 'Block 2, AI-generated' })
const body = () => screen.getByRole('group', { name: 'Block 2, AI-generated. Press Enter to edit.' })
const editor = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Block 2, Markdown' })
const reviewButton = () => screen.queryByRole('button', { name: 'Mark reviewed' })
const blockIds = () => [...screen.getByTestId('page-panel').querySelectorAll('[data-block]')].map((el) => el.getAttribute('data-block'))
const lastBatch = () => submit.mock.calls[submit.mock.calls.length - 1]![0]
const flush = () => act(async () => {})
const precedes = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('Pinned block: reading', () => {
  it('shows the chip, the model, who pinned it and when, and the answer as Markdown', () => {
    open()
    const f = within(frame())
    expect(f.getByText('AI-generated')).toHaveClass('qp-pin__chip')
    expect(f.getByText(MODEL)).toBeInTheDocument()
    expect(row().querySelector('.qp-pin__by')).toHaveTextContent(/^Pinned by Mei Tanaka · 14 Nov 2030$/)
    expect(row().querySelector('time')).toHaveAttribute('datetime', new Date(PINNED_AT).toISOString())
    // The same renderer as any text Block: bold, math, a list — and no raw Markdown left.
    const md = row().querySelector('.qp-md')!
    expect(md.querySelector('strong')).toHaveTextContent('limited expressivity')
    expect(md.querySelector('.katex')).not.toBeNull()
    expect(md.querySelector('li')).toHaveTextContent('test a trainable beta')
    expect(md.textContent).not.toContain('**')
  })

  it('shows the model and the Member name as written, in elements that opt out of upper-casing', () => {
    open()
    expect(within(row()).getByText(MODEL)).toHaveClass('qp-pin__model')
    expect(within(row()).getByText('Mei Tanaka')).toHaveClass('qp-pin__name')
    expect(row().textContent).toContain('Mei Tanaka')
    expect(row().textContent).not.toContain('MEI TANAKA')
  })

  it('says "AI-generated" before the answer: in the document order and in the accessible names', () => {
    open()
    const chip = within(row()).getByText('AI-generated')
    const md = row().querySelector('.qp-md')!
    expect(precedes(chip, md)).toBe(true)
    expect(precedes(chip, within(row()).getByText(MODEL))).toBe(true)
    expect(row().textContent!.indexOf('AI-generated')).toBeLessThan(row().textContent!.indexOf('The plateau'))
    expect(frame()).toContainElement(body())
    expect(body()).toHaveAccessibleName('Block 2, AI-generated. Press Enter to edit.')
    expect(body()).toHaveAttribute('tabindex', '0')
    // The chip is real text, not a picture or a pseudo-element.
    expect(chip.textContent).toBe('AI-generated')
    expect(chip).not.toHaveAttribute('aria-hidden')
  })

  it('leaves a text Block without `ai` exactly as it was', () => {
    open()
    const plain = screen.getByTestId('block-b1')
    expect(plain.querySelector('.qp-pin')).toBeNull()
    expect(within(plain).queryByText('AI-generated')).toBeNull()
    expect(within(plain).queryByText(/Not reviewed/)).toBeNull()
    expect(within(plain).getByRole('group', { name: 'Block 1. Press Enter to edit.' })).toHaveClass('qp-block__view', 'is-editable')
    expect(plain.querySelector('.qp-block__view > .qp-md strong')).toHaveTextContent('bold')
    expect(screen.getAllByText('AI-generated')).toHaveLength(1)
  })

  it('works under StrictMode', () => {
    render(
      <StrictMode>
        <PagePanel cardId="a" full={false} onClose={() => {}} />
      </StrictMode>,
    )
    expect(screen.getAllByText('AI-generated')).toHaveLength(1)
    fireEvent.click(reviewButton()!)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('Pinned block: review', () => {
  it('"Not reviewed by a Member." and "Mark reviewed" submit exactly the review op, as the signed-in Member', async () => {
    open()
    expect(within(frame()).getByRole('status')).toHaveTextContent('Not reviewed by a Member.')
    fireEvent.click(reviewButton()!)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(lastBatch()).toEqual([ops.markReviewed('p1', ANA.id)])
    expect(lastBatch()).toEqual([{ fake: 'markReviewed', block: 'p1', member: 'ana' }])
    await flush()
    expect(within(frame()).getByRole('status')).toHaveTextContent(/^Reviewed by Ana Ruiz\.$/)
    expect(reviewButton()).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull() // pressing the button does not open the editor
  })

  it('shows the reviewer once set, with no button', () => {
    seed({ ...AI, reviewedBy: 'ana' })
    open()
    expect(within(frame()).getByRole('status')).toHaveTextContent(/^Reviewed by Ana Ruiz\.$/)
    expect(within(row()).getByText('Ana Ruiz')).toHaveClass('qp-pin__name')
    expect(screen.queryByText(/Not reviewed/)).toBeNull()
    expect(reviewButton()).toBeNull()
  })

  it('says "a former Member" for someone who is no longer in the Member list', () => {
    seed({ model: MODEL, pinnedBy: 'gone', pinnedAt: PINNED_AT, reviewedBy: 'gone-too' })
    open()
    expect(row().querySelector('.qp-pin__by')).toHaveTextContent(/^Pinned by a former Member · 14 Nov 2030$/)
    expect(within(frame()).getByRole('status')).toHaveTextContent(/^Reviewed by a former Member\.$/)
  })

  it('memberName: the name; "a former Member" when unknown; "a Member" while there is no list at all', () => {
    expect(memberName([ANA, MEI], 'mei')).toEqual({ name: 'Mei Tanaka', known: true })
    expect(memberName([ANA, MEI], 'gone')).toEqual({ name: 'a former Member', known: false })
    expect(memberName([], 'mei')).toEqual({ name: 'a Member', known: false })
  })

  it('a Guest sees it read-only: marking and text, no button, no editing', () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    boardStore.setState({ readOnly: true })
    act(() => membersStore.setState({ list: [] })) // Guests are not given the Member list
    open()
    expect(within(frame()).getByText('AI-generated')).toBeInTheDocument()
    expect(row().querySelector('.qp-pin__by')).toHaveTextContent(/^Pinned by a Member · 14 Nov 2030$/)
    expect(row().querySelector('.qp-md strong')).toHaveTextContent('limited expressivity')
    expect(within(frame()).getByText('Not reviewed by a Member.')).toBeInTheDocument()
    expect(reviewButton()).toBeNull()
    expect(screen.queryByRole('group', { name: /Press Enter to edit/ })).toBeNull()
    expect(within(row()).queryByRole('button')).toBeNull()
    fireEvent.click(row().querySelector('.qp-md')!)
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })

  it('no button on a read-only Board, even for a Member', () => {
    boardStore.setState({ readOnly: true })
    open()
    expect(within(frame()).getByText('Not reviewed by a Member.')).toBeInTheDocument()
    expect(reviewButton()).toBeNull()
  })

  it('no button while another Member holds the Page (soft lock); it comes back when they are done', () => {
    pageStore.setState({ editors: { a: { member: MEI, memberId: 'mei', since: at(14, 14, 3) } } })
    open()
    expect(within(frame()).getByText('Not reviewed by a Member.')).toBeInTheDocument()
    expect(reviewButton()).toBeNull()
    expect(within(row()).queryByRole('button')).toBeNull()
    act(() => pageStore.setState({ editors: {} }))
    expect(reviewButton()).not.toBeNull()
  })
})

describe('Pinned block: still a Block', () => {
  it('opens for editing on click and on Enter, commits the text, and keeps the marking', async () => {
    open()
    fireEvent.click(body())
    expect(editor().value).toBe(ANSWER)
    // The strip stays on while the editor is open.
    expect(within(row()).getByText('AI-generated')).toBeInTheDocument()
    expect(within(row()).getByText(MODEL)).toBeInTheDocument()
    fireEvent.input(editor(), { target: { value: 'Edited by a person' } })
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    await flush()
    expect(lastBatch()).toEqual([{ fake: 'setBlockText', block: 'p1', text: 'Edited by a person' }])
    expect(row().querySelector('.qp-md')).toHaveTextContent('Edited by a person')
    expect(within(frame()).getByText('AI-generated')).toBeInTheDocument()
    expect(within(frame()).getByText('Not reviewed by a Member.')).toBeInTheDocument()

    fireEvent.keyDown(body(), { key: 'Enter' })
    expect(editor().value).toBe('Edited by a person')
    fireEvent.keyDown(editor(), { key: 'Escape' })
    await flush()
    expect(submit).toHaveBeenCalledTimes(1) // Esc sent nothing
  })

  it('moves up and down like any Block', async () => {
    open()
    const tools = within(within(row()).getByRole('group', { name: 'Block 2' }))
    fireEvent.click(tools.getByRole('button', { name: 'Move block up' }))
    await flush()
    expect(lastBatch()).toEqual([{ fake: 'moveBlock', block: 'p1', order: '0' }])
    expect(blockIds()).toEqual(['p1', 'b1', 'b3'])
    fireEvent.click(within(screen.getByTestId('block-p1')).getByRole('button', { name: 'Move block down' }))
    await flush()
    expect(blockIds()).toEqual(['b1', 'p1', 'b3'])
  })

  it('is deleted like any Block, with Undo', async () => {
    open()
    fireEvent.click(within(row()).getByRole('button', { name: 'Delete block' }))
    await flush()
    expect(lastBatch()).toEqual([ops.remove('p1')])
    expect(blockIds()).toEqual(['b1', 'b3'])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(blockIds()).toEqual(['b1', 'p1', 'b3'])
    expect(within(screen.getByTestId('block-p1')).getByText('AI-generated')).toBeInTheDocument()
  })
})
