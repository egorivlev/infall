// M13 in the Page: Export as Markdown, Print…, Export BibTeX, Import BibTeX…, Look up.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { ApiError } = await import('../../lib')
const { PagePanel } = await import('./PagePanel')
const { ImportBibtex } = await import('./bibtex/ImportBibtex')
const { editLock } = await import('./lock')
const { toasts } = await import('../board/toastStore')
const { pagePanel, usePagePanel } = await import('../bridge')
const { GUEST, block, card, pinned, run, runResult, source, visual } = await import('./testkit')
const { LOOKUP_NEEDS_ID, LOOKUP_OFFLINE } = await import('./lookupText')

const { boardStore, pageStore, sessionStore, submit, lookupSource } = fake

const A = card('a', 'QRL on CartPole', { summary: 'Does it learn?' })

function seed() {
  boardStore.setState({ cards: [A, card('b', 'Other')], frames: [], connections: [] })
  pageStore.setState({
    blocks: [
      block('b1', 'a', '1', 'Intro with $x^2$'),
      visual('v1', 'a', '2', 'Bloch sphere', '<p>hi</p>'),
      run('r1', 'a', '3', 'experiment.py', 'print(1)', runResult({ output: 'reward 176\n' })),
      pinned('p1', 'a', '4', 'AI says hi', { model: 'm1', pinnedBy: 'mei', pinnedAt: 0 }),
    ],
    sources: [
      source('s1', { title: 'Parametrized quantum policies', authors: 'Sofiene Jerbi, Vedran Dunjko', year: '2021', url: 'https://arxiv.org/abs/2103.05577', cards: ['a'] }),
      source('s9', { title: 'Known elsewhere', doi: '10.1000/known', cards: ['b'] }),
    ],
    attachments: [
      { id: 'at1', card: 'a', source: 's1' },
      { id: 'at9', card: 'b', source: 's9' },
    ],
  })
}

const desktop = (saveFile: (f: { suggestedName: string; text: string }) => Promise<boolean>) => {
  ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', saveFile }
}

beforeEach(() => {
  fake.reset()
  usePagePanel.setState({ cardId: 'a', full: false })
  seed()
})
afterEach(() => {
  cleanup()
  act(() => {
    editLock.releaseNow()
    toasts.clear()
    pagePanel.close()
  })
  delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const open = () => render(<PagePanel cardId="a" full={false} onClose={() => {}} />)
const tools = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Page tools' }))
  return within(screen.getByRole('menu', { name: 'Page tools' }))
}
/** Lets promises and the import's pauses between batches run. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

describe('Page tools', () => {
  it('Export as Markdown goes through the desktop app’s save dialog', async () => {
    const saveFile = vi.fn(async (_f: { suggestedName: string; text: string }) => true)
    desktop(saveFile)
    open()
    const menu = tools()
    expect(menu.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Export as Markdown', 'Print…'])
    fireEvent.click(menu.getByRole('menuitem', { name: 'Export as Markdown' }))
    await flush()
    const call = saveFile.mock.calls[0]![0] as { suggestedName: string; text: string }
    expect(call.suggestedName).toBe('QRL on CartPole.md')
    expect(call.text.startsWith('# QRL on CartPole\n\nDoes it learn?\n\nIntro with $x^2$\n\n*Visual: Bloch sphere.')).toBe(true)
    expect(call.text).toContain('reward 176')
    expect(call.text).toContain('> **AI-generated** · m1 · pinned by Mei')
    expect(call.text).toContain('## Sources\n\n1. Sofiene Jerbi, Vedran Dunjko (2021). *Parametrized quantum policies*.')
    expect(screen.getByText('Exported “QRL on CartPole.md”.')).toBeInTheDocument()
    // Focus is back on the tools button.
    expect(screen.getByRole('button', { name: 'Page tools' })).toHaveFocus()
  })

  it('says nothing when the save dialog was cancelled, and the sentence when writing failed', async () => {
    desktop(async () => false)
    open()
    fireEvent.click(tools().getByRole('menuitem', { name: 'Export as Markdown' }))
    await flush()
    expect(screen.queryByTestId('toast')).toBeNull()
    desktop(async () => Promise.reject(new Error('The disk is full.')))
    fireEvent.click(tools().getByRole('menuitem', { name: 'Export as Markdown' }))
    await flush()
    expect(screen.getByText('“QRL on CartPole.md” could not be written. The disk is full.')).toBeInTheDocument()
  })

  it('downloads in a browser', async () => {
    const createObjectURL = vi.fn((_b: Blob) => 'blob:x')
    vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    open()
    fireEvent.click(tools().getByRole('menuitem', { name: 'Export as Markdown' }))
    await flush()
    expect(click).toHaveBeenCalledOnce()
    expect(createObjectURL.mock.calls[0]![0].type).toBe('text/markdown;charset=utf-8')
    expect(screen.getByText('Downloaded “QRL on CartPole.md”.')).toBeInTheDocument()
  })

  it('Print… prints a copy of the Page alone, then takes it away', async () => {
    const print = vi.fn()
    vi.stubGlobal('print', print)
    open()
    fireEvent.click(tools().getByRole('menuitem', { name: 'Print…' }))
    const copy = screen.getByTestId('page-print')
    expect(copy.parentElement).toBe(document.body) // outside the app, so the print stylesheet can show it alone
    expect(within(copy).getByRole('heading', { level: 1 })).toHaveTextContent('QRL on CartPole')
    expect(copy.querySelector('.katex')).not.toBeNull() // formulas typeset
    expect(within(copy).getByText('print(1)')).toBeInTheDocument()
    expect(within(copy).getByText('reward 176')).toBeInTheDocument()
    expect(within(copy).getByText(/Visual: Bloch sphere/)).toBeInTheDocument()
    expect(within(copy).getByText('AI-generated')).toBeInTheDocument()
    expect(within(copy).getByText('Parametrized quantum policies')).toBeInTheDocument()
    await flush()
    expect(print).toHaveBeenCalledOnce()
    act(() => {
      window.dispatchEvent(new Event('afterprint'))
    })
    expect(screen.queryByTestId('page-print')).toBeNull()
  })

  it('Guests can export and print what they read', () => {
    boardStore.setState({ readOnly: true })
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    open()
    expect(tools().getAllByRole('menuitem')).toHaveLength(2)
  })
})

describe('Sources: BibTeX', () => {
  it('Export BibTeX writes this Card’s Sources', async () => {
    const saveFile = vi.fn(async (_f: { suggestedName: string; text: string }) => true)
    desktop(saveFile)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Export BibTeX' }))
    await flush()
    const call = saveFile.mock.calls[0]![0] as { suggestedName: string; text: string }
    expect(call.suggestedName).toBe('QRL on CartPole - Sources.bib')
    expect(call.text).toContain('@misc{jerbi2021parametrized,')
    expect(call.text).toContain('author        = {Jerbi, Sofiene and Dunjko, Vedran}')
    expect(call.text).not.toContain('Known elsewhere')
  })

  it('a Guest sees Export but not Import', () => {
    boardStore.setState({ readOnly: true })
    sessionStore.setState({ status: 'signed_in', member: GUEST })
    open()
    expect(screen.getByRole('button', { name: 'Export BibTeX' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import BibTeX…' })).toBeNull()
  })

  const PASTE = `@article{new1, title = {Brand new}, author = {Ruiz, Ana}, year = 2024, doi = {10.1000/new}}
@misc{again, title = {Known}, doi = {10.1000/known}}
@misc{broken, title = {Never closed
@misc{mine, title = {Already here}, url = {https://arxiv.org/abs/2103.05577}}`

  it('Import BibTeX… attaches pasted entries to this Card and reports what happened', async () => {
    open()
    const opener = screen.getByRole('button', { name: 'Import BibTeX…' })
    fireEvent.click(opener)
    const dialog = within(screen.getByRole('dialog', { name: 'Import BibTeX' }))
    expect(dialog.getByLabelText('BibTeX file')).toHaveFocus()
    expect(dialog.getByRole('button', { name: 'Import' })).toBeDisabled()
    fireEvent.change(dialog.getByLabelText('Or paste the entries'), { target: { value: PASTE } })
    expect(dialog.getByText('3 entries found. 1 entry could not be read.')).toBeInTheDocument()
    expect(dialog.getByText(/Line 3 \(broken\): a brace is opened and never closed\./)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: 'Import 3 entries' }))
    await flush()
    // One batch: the new Source with its Attachment, and an Attachment for the known one; "mine" is already here.
    expect(submit).toHaveBeenCalledOnce()
    const batch = submit.mock.calls[0]![0] as { fake?: string; source?: string; title?: string; authors?: string }[]
    expect(batch.map((o) => o.fake)).toEqual(['createSource', 'attach', 'attach'])
    expect(batch[0]).toMatchObject({ title: 'Brand new', authors: 'Ana Ruiz', year: '2024', doi: '10.1000/new' })
    expect(batch[2]).toMatchObject({ card: 'a', source: 's9' })
    expect(dialog.getByText('Imported 3 entries.')).toBeInTheDocument()
    expect(dialog.getByText('1 new Source.')).toBeInTheDocument()
    expect(dialog.getByText('Reused 2 Sources already in Infall.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Done' })).toHaveFocus()
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
    expect(screen.getByText('Brand new')).toBeInTheDocument()
  })

  it('reads a picked file', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Import BibTeX…' }))
    const dialog = within(screen.getByRole('dialog'))
    const file = new File(['@misc{f, title = {From a file}}'], 'library.bib', { type: 'text/x-bibtex' })
    fireEvent.change(dialog.getByLabelText('BibTeX file'), { target: { files: [file] } })
    await flush()
    expect(dialog.getByText('1 entry found in “library.bib”.')).toBeInTheDocument()
    expect(dialog.getByLabelText<HTMLTextAreaElement>('Or paste the entries').value).toBe('@misc{f, title = {From a file}}')
  })

  it('refuses a file far too large to be references', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Import BibTeX…' }))
    const dialog = within(screen.getByRole('dialog'))
    const file = new File(['x'], 'movie.bib')
    Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 })
    fireEvent.change(dialog.getByLabelText('BibTeX file'), { target: { files: [file] } })
    await flush()
    expect(dialog.getByRole('alert')).toHaveTextContent('“movie.bib” is larger than 10 MB')
  })

  it('Esc and Cancel close it without changing anything', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Import BibTeX…' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('page-panel')).toBeInTheDocument() // the Page stays open
    expect(submit).not.toHaveBeenCalled()
  })

  it('500 entries go in batches the server takes, with progress', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Import BibTeX…' }))
    const dialog = within(screen.getByRole('dialog'))
    const many = Array.from({ length: 500 }, (_, i) => `@misc{k${i}, title = {Paper ${i}}, doi = {10.1000/p${i}}}`).join('\n')
    fireEvent.change(dialog.getByLabelText('Or paste the entries'), { target: { value: many } })
    let release: () => void = () => {}
    submit.mockImplementationOnce(async (batch: unknown[]) => {
      for (const op of batch) void op
      await new Promise<void>((r) => (release = r))
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Import 500 entries' }))
    await flush()
    expect(dialog.getByText('Importing… 0 of 500')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Importing…' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }) // not while importing
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    release()
    for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(dialog.getByText('Imported 500 entries.')).toBeInTheDocument()
    expect(submit.mock.calls.length).toBe(5) // 1000 ops, 200 a batch
    for (const [batch] of submit.mock.calls) expect((batch as unknown[]).length).toBeLessThanOrEqual(200)
  })

  it('says where an import stopped and that what arrived is kept', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Import BibTeX…' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Or paste the entries'), { target: { value: '@misc{x, doi = {10.1000/x}}' } })
    submit.mockImplementationOnce(async () => {
      throw new ApiError(0, 'network', 'Cannot reach the server.')
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Import 1 entry' }))
    await flush()
    expect(dialog.getByText('The import stopped after 0 of 1 entry: the server could not be reached. Check the connection, then import the rest again.')).toBeInTheDocument()
    expect(dialog.getByText('Nothing was added.')).toBeInTheDocument()
  })
})

describe('Board: Import BibTeX…', () => {
  it('makes a Frame named after the file with one Card per entry, then shows it', async () => {
    const onFrame = vi.fn()
    render(<ImportBibtex target={{ kind: 'board', place: () => ({ x: 500, y: 40 }), onFrame }} onClose={() => {}} />)
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(/Each entry becomes a Card with its Source/)).toBeInTheDocument()
    const file = new File(['@misc{a, title = {One}, doi = {10.1000/known}}\n@misc{b, title = {Two}}'], 'thesis refs.bib')
    fireEvent.change(dialog.getByLabelText('BibTeX file'), { target: { files: [file] } })
    await flush()
    fireEvent.click(dialog.getByRole('button', { name: 'Import 2 entries' }))
    await flush()
    const batch = submit.mock.calls[0]![0] as Record<string, unknown>[]
    const frame = batch[0] as { Create: { kind: string; fields: { title: { Text: string }; x: { Float: number } } } }
    expect(frame.Create.kind).toBe('Frame')
    expect(frame.Create.fields.title).toEqual({ Text: 'thesis refs' })
    expect(frame.Create.fields.x).toEqual({ Float: 500 })
    const kinds = batch.map((o) => (o as { fake?: string }).fake ?? (o as { Create: { kind: string } }).Create.kind)
    expect(kinds).toEqual(['Frame', 'Card', 'attach', 'Card', 'createSource', 'attach'])
    expect(batch[2]).toMatchObject({ source: 's9' }) // the known DOI reuses its Source
    expect(dialog.getByText('Imported 2 entries as 2 Cards.')).toBeInTheDocument()
    expect(onFrame).toHaveBeenCalledWith((frame as unknown as { Create: { entity: string } }).Create.entity)
  })
})

describe('Look up', () => {
  const addForm = () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    return within(screen.getByRole('form', { name: 'Add Source' }))
  }
  const found = { title: 'Scheme for reducing decoherence', authors: 'Peter W. Shor', year: '1995', doi: '10.1103/physreva.52.r2493', url: null }

  it('fills the empty fields, says from where, and saves nothing by itself', async () => {
    let answer: (r: typeof found) => void = () => {}
    lookupSource.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: 'doi:10.1103/PhysRevA.52.R2493' } })
    fireEvent.change(f.getByLabelText('Year'), { target: { value: '1995' } })
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    expect(lookupSource).toHaveBeenCalledWith({ doi: '10.1103/physreva.52.r2493' })
    // Asking: the button says so, the form stays usable.
    const btn = f.getByRole('button', { name: 'Looking up…' })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(f.getByText('Asking Crossref… The form stays usable meanwhile.')).toBeInTheDocument()
    fireEvent.change(f.getByLabelText('Authors'), { target: { value: '' } })
    expect(f.getByLabelText('Title')).toBeEnabled()
    await act(async () => answer(found))
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('Scheme for reducing decoherence')
    expect(f.getByLabelText<HTMLInputElement>('Authors').value).toBe('Peter W. Shor')
    expect(f.getByText('Filled in the title and authors from Crossref. Nothing is added until you press Add Source.')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
  })

  it('asks before replacing what was typed', async () => {
    lookupSource.mockResolvedValueOnce(found)
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: '10.1103/PhysRevA.52.R2493' } })
    fireEvent.change(f.getByLabelText('Title'), { target: { value: 'My own title' } })
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    await flush()
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('My own title')
    expect(f.getByLabelText<HTMLInputElement>('Authors').value).toBe('Peter W. Shor') // empty ones are filled anyway
    expect(f.getByText('Crossref has other details than the ones in the form:')).toBeInTheDocument()
    fireEvent.click(f.getByRole('button', { name: 'Keep mine' }))
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('My own title')

    lookupSource.mockResolvedValueOnce(found)
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    await flush()
    fireEvent.click(f.getByRole('button', { name: 'Use these' }))
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('Scheme for reducing decoherence')
    expect(f.getByText('Replaced the title with what Crossref has.')).toBeInTheDocument()
  })

  it('puts the arXiv address in place of a bare id, so the Source can be added', async () => {
    lookupSource.mockResolvedValueOnce({ title: 'Parametrized', authors: 'Sofiene Jerbi', year: '2021', doi: null, url: 'https://arxiv.org/abs/2103.99999' })
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: 'arXiv:2103.99999v2' } })
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    expect(lookupSource).toHaveBeenCalledWith({ arxiv: '2103.99999' })
    await flush()
    expect(f.getByLabelText<HTMLInputElement>('URL or DOI').value).toBe('https://arxiv.org/abs/2103.99999')
    fireEvent.click(f.getByRole('button', { name: 'Add Source' }))
    expect(submit.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ fake: 'createSource', url: 'https://arxiv.org/abs/2103.99999', title: 'Parametrized', authors: 'Sofiene Jerbi', year: '2021' }),
      expect.objectContaining({ fake: 'attach', card: 'a' }),
    ])
  })

  it.each([
    ['not known', new ApiError(404, 'not_found', 'Crossref does not know the DOI 10.1/x. Check it, or fill in the fields by hand.'), 'Crossref does not know the DOI 10.1/x. Check it, or fill in the fields by hand.'],
    ['registry down', new ApiError(502, 'lookup_failed', 'Crossref did not answer in time. Try again in a minute, or fill in the fields by hand.'), 'Crossref did not answer in time. Try again in a minute, or fill in the fields by hand.'],
    ['rate-limited', new ApiError(429, 'too_many_requests', 'Request failed (429).'), 'That is many lookups in one minute. Wait a minute, then try again.'],
    ['offline', new ApiError(0, 'network', 'Cannot reach the server.'), LOOKUP_OFFLINE],
  ])('%s: says what to do next and leaves the form as it was', async (_name, error, sentence) => {
    lookupSource.mockRejectedValueOnce(error)
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: '10.1000/x' } })
    fireEvent.change(f.getByLabelText('Title'), { target: { value: 'Typed' } })
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    await flush()
    expect(f.getByText(sentence)).toBeInTheDocument()
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('Typed')
    expect(f.getByLabelText<HTMLInputElement>('URL or DOI').value).toBe('10.1000/x')
    expect(f.getByRole('button', { name: 'Look up' })).not.toHaveAttribute('aria-disabled')
  })

  it('says what it needs when the field holds neither a DOI nor an arXiv id', () => {
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: 'https://example.org/paper' } })
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    expect(lookupSource).not.toHaveBeenCalled()
    expect(f.getByText(LOOKUP_NEEDS_ID)).toBeInTheDocument()
  })

  it('drops an answer for an identifier that was changed meanwhile', async () => {
    let answer: (r: typeof found) => void = () => {}
    lookupSource.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: '10.1000/old' } })
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: '10.1000/new' } })
    await act(async () => answer(found))
    expect(f.getByLabelText<HTMLInputElement>('Title').value).toBe('')
  })

  it('is not offered when the Source is already in Infall', () => {
    const f = addForm()
    fireEvent.change(f.getByLabelText('URL or DOI'), { target: { value: '10.1000/known' } })
    expect(f.queryByRole('button', { name: 'Look up' })).toBeNull()
  })

  it('works when editing a Source', async () => {
    lookupSource.mockResolvedValueOnce({ title: 'Parametrized quantum policies for RL', authors: 'Sofiene Jerbi, Vedran Dunjko', year: '2021', doi: null, url: 'https://arxiv.org/abs/2103.05577' })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Source: Parametrized quantum policies' }))
    const f = within(screen.getByRole('form', { name: 'Edit Source' }))
    fireEvent.click(f.getByRole('button', { name: 'Look up' }))
    expect(lookupSource).toHaveBeenCalledWith({ arxiv: '2103.05577' })
    await flush()
    expect(f.getByText('arXiv has other details than the ones in the form:')).toBeInTheDocument()
  })
})
