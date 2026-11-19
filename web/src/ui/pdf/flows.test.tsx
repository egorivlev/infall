// M19 Part 1 end to end in the UI, against the real data layer and the fake server: attaching, replacing and
// removing a PDF as Undo steps with their names; Fetch the PDF from arXiv; Guests; the reader (windowing, keys, the
// remembered page, find, a PDF without text); search results from PDF text. pdf.js is replaced (no canvas here).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ pages: 3, texts: null as string[] | null, opened: [] as unknown[], openError: null as unknown }))
vi.mock('./engine', () => {
  const doc = () => ({
    numPages: engine.pages,
    pageSize: async () => ({ width: 612, height: 792 }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    textLayer: (n: number, container: HTMLElement) => {
      const span = document.createElement('span')
      span.textContent = engine.texts?.[n - 1] ?? `text of page ${n}`
      container.replaceChildren(span)
      return { promise: Promise.resolve([span]), cancel() {} }
    },
    pageText: async (n: number) => engine.texts?.[n - 1] ?? `text of page ${n}`,
    data: async () => new Uint8Array([37, 80, 68, 70, 45]),
    destroy() {},
  })
  return {
    loadEngine: async () => ({}),
    openPdf: async (source: unknown) => {
      engine.opened.push(source)
      if (engine.openError) throw engine.openError
      return { doc: doc(), cancel() {} }
    },
    countPages: async () => engine.pages,
    extractText: async (d: { numPages: number; pageText(n: number): Promise<string> }) => {
      const out: string[] = []
      for (let n = 1; n <= d.numPages; n++) out.push(await d.pageText(n))
      return out
    },
    hasNoText: (p: string[]) => p.every((x) => x.trim() === ''),
  }
})

const { board, ops, pdfOps, undo, usePage, useUndo } = await import('../../lib')
const { membersStore } = await import('../../lib/people')
const { sessionStore } = await import('../../lib/session-store')
const { FakeServer, FakeSocket, GUEST, ME, settle, tinyPdf } = await import('../../lib/testing')
const { Sources } = await import('../page/Sources')
const { PagePanel } = await import('../page/PagePanel')
const { SearchBox } = await import('../shell/SearchBox')
const { toasts } = await import('../board/toastStore')
const { usePagePanel, pagePanel } = await import('../bridge')
const { pdfReader, usePdfReader } = await import('./readerStore')
const { forgetTexts } = await import('./text')
const { NO_TEXT, PDF_NOT_INCLUDED } = await import('./PdfReader')
const { rememberedPage } = await import('./remember')

let server: InstanceType<typeof FakeServer>
const field = (id: string, name: string) => server.entities[id]?.fields[name]
const flush = () => act(async () => settle())

async function openBoard() {
  await act(async () => board.open())
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
  await flush()
}

function Harness({ canEdit = true }: { canEdit?: boolean }) {
  const vm = usePage('c1')
  const u = useUndo()
  return (
    <>
      <Sources cardId="c1" cardTitle={vm.card?.title ?? ''} sources={vm.sources} canEdit={canEdit} />
      <output data-testid="undo-name">{u.undo ?? ''}</output>
    </>
  )
}

const pdfFile = (label: string, name = `${label}.pdf`) => new File([tinyPdf(label) as BlobPart], name, { type: 'application/pdf' })

beforeEach(async () => {
  engine.pages = 3
  engine.texts = null
  engine.opened = []
  engine.openError = null
  forgetTexts()
  localStorage.clear()
  server = new FakeServer()
  server.members = [ME]
  server.commit(
    [
      ops.createCard({ id: 'c1', x: 0, y: 0, title: 'QRL' }),
      ops.createSource({ id: 's1', url: 'https://arxiv.org/abs/2103.05577', title: 'Parametrized quantum policies' }),
      ops.attach({ id: 'a1', card: 'c1', source: 's1' }),
    ],
    ME.id,
  )
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('XMLHttpRequest', server.xhr())
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME] })
})

afterEach(() => {
  cleanup()
  act(() => {
    toasts.clear()
    pdfReader.close()
    pagePanel.close()
  })
  board.close()
  act(() => sessionStore.setState({ status: 'signed_out' }, true))
  vi.unstubAllGlobals()
})

async function attach(file: File, source = 's1') {
  fireEvent.change(screen.getByTestId(`pdf-input-${source}`), { target: { files: [file] } })
  for (let i = 0; i < 4; i++) await flush()
}

describe('a PDF on a Source', () => {
  it('Attach PDF… stores the file, shows size and pages, and is one Undo step "Attach a PDF to <title>"', async () => {
    await openBoard()
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Attach PDF… to Parametrized quantum policies' })).toBeInTheDocument()
    await attach(pdfFile('one', 'Jerbi 2021.pdf'))
    const hash = [...server.pdf.files.keys()][0]!
    expect(field('s1', 'pdf')).toEqual({ Text: hash })
    expect(field('s1', 'pdf_name')).toEqual({ Text: 'Jerbi 2021.pdf' })
    expect(field('s1', 'pdf_pages')).toEqual({ Float: 3 })
    const row = within(screen.getByTestId('source-s1'))
    expect(row.getByText('Jerbi 2021.pdf')).toBeInTheDocument()
    expect(row.getByText(/^3 pages · \d+ bytes$/)).toBeInTheDocument()
    expect(row.getByRole('button', { name: 'Open PDF: Parametrized quantum policies' })).toBeInTheDocument()
    expect(screen.getByTestId('undo-name')).toHaveTextContent('Attach a PDF to Parametrized quantum policies')
    // The text was read and sent for search (decision 8).
    await waitFor(() => expect(server.pdf.texts.get(hash)).toEqual(['text of page 1', 'text of page 2', 'text of page 3']))
    await act(async () => void (await undo.undo()))
    await flush()
    expect(field('s1', 'pdf')).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Attach PDF… to Parametrized quantum policies' })).toBeInTheDocument()
    await act(async () => void (await undo.redo()))
    await flush()
    expect(field('s1', 'pdf')).toEqual({ Text: hash })
  })

  it('Replace… asks first, then is the step "Replace the PDF of <title>"; Undo brings the old one back', async () => {
    await openBoard()
    render(<Harness />)
    await attach(pdfFile('old'))
    const old = field('s1', 'pdf')
    await attach(pdfFile('new'))
    expect(screen.getByRole('group', { name: 'Replace the PDF' })).toHaveTextContent('Replace “old.pdf” with “new.pdf”? Undo brings the old one back.')
    expect(field('s1', 'pdf')).toEqual(old)
    fireEvent.click(screen.getByRole('button', { name: 'Keep the old one' }))
    expect(screen.queryByRole('group', { name: 'Replace the PDF' })).toBeNull()
    await attach(pdfFile('new'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    for (let i = 0; i < 4; i++) await flush()
    expect(field('s1', 'pdf')).not.toEqual(old)
    expect(field('s1', 'pdf_name')).toEqual({ Text: 'new.pdf' })
    expect(screen.getByTestId('undo-name')).toHaveTextContent('Replace the PDF of Parametrized quantum policies')
    await act(async () => void (await undo.undo()))
    await flush()
    expect(field('s1', 'pdf')).toEqual(old)
    expect(field('s1', 'pdf_name')).toEqual({ Text: 'old.pdf' })
  })

  it('Remove PDF is the step "Remove the PDF from <title>", with an Undo on its note', async () => {
    await openBoard()
    render(<Harness />)
    await attach(pdfFile('x'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the PDF from Parametrized quantum policies' }))
    await flush()
    expect(field('s1', 'pdf')).toBeUndefined()
    expect(field('s1', 'pdf_size')).toBeUndefined()
    expect(screen.getByTestId('undo-name')).toHaveTextContent('Remove the PDF from Parametrized quantum policies')
    expect(toasts).toBeTruthy()
    await act(async () => void (await undo.undo()))
    await flush()
    expect(field('s1', 'pdf')).toBeDefined()
  })

  it('the server’s refusal is said in the row, and nothing changes', async () => {
    await openBoard()
    render(<Harness />)
    server.pdf.fail = { status: 413, code: 'too_large', message: 'This PDF is larger than 100 MB, the most this server takes.' }
    await attach(pdfFile('big'))
    expect(screen.getByRole('alert')).toHaveTextContent('This PDF is larger than 100 MB, the most this server takes.')
    expect(field('s1', 'pdf')).toBeUndefined()
    await attach(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    expect(screen.getByRole('alert')).toHaveTextContent('“notes.txt” is not a PDF. Attach a .pdf file.')
  })

  it('dropping a PDF on the Sources section attaches it to the only Source', async () => {
    await openBoard()
    render(<Harness />)
    const section = screen.getByRole('region', { name: /Sources/ })
    const file = pdfFile('dropped')
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }
    fireEvent.dragOver(section, { dataTransfer })
    expect(section).toHaveClass('is-drop')
    fireEvent.drop(section, { dataTransfer })
    for (let i = 0; i < 4; i++) await flush()
    expect(field('s1', 'pdf_name')).toEqual({ Text: 'dropped.pdf' })
    expect(screen.getByTestId('undo-name')).toHaveTextContent('Attach a PDF to Parametrized quantum policies')
  })

  it('Guests: Open PDF only', async () => {
    const hash = server.pdf.store(tinyPdf('g'))
    server.commit(pdfOps.attach('s1', { hash, name: 'g.pdf', size: 10, pages: 2 }), ME.id)
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
    await openBoard()
    render(<Harness canEdit={false} />)
    const row = within(screen.getByTestId('source-s1'))
    expect(row.getByRole('button', { name: 'Open PDF: Parametrized quantum policies' })).toBeInTheDocument()
    expect(row.queryByText('Replace…')).toBeNull()
    expect(row.queryByText('Remove PDF')).toBeNull()
    expect(row.queryByText('Attach PDF…')).toBeNull()
    expect(screen.queryByTestId('pdf-input-s1')).toBeNull()
  })
})

describe('Fetch the PDF from arXiv', () => {
  it('after Look up answered an arXiv id: asking, then ready, then attached with Add Source', async () => {
    server.lookups['2007.14384'] = { title: 'Quantum policies', authors: 'A, B', year: '2020', doi: null, url: 'https://arxiv.org/abs/2007.14384' }
    server.pdf.arxiv['2007.14384'] = tinyPdf('arxiv')
    await openBoard()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    fireEvent.change(screen.getByLabelText('URL or DOI'), { target: { value: '2007.14384' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await flush()
    const fetchButton = screen.getByRole('button', { name: 'Fetch the PDF from arXiv' })
    fireEvent.click(fetchButton)
    expect(screen.getByRole('button', { name: 'Fetching the PDF…' })).toBeInTheDocument()
    for (let i = 0; i < 4; i++) await flush()
    expect(server.pdf.fetched).toEqual(['2007.14384'])
    expect(screen.getByText(/The PDF from arXiv is ready \(3 pages · \d+ bytes\)\. It is attached when you press Add Source\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add Source' }))
    await flush()
    const made = Object.entries(server.entities).find(([, e]) => e.kind === 'Source' && JSON.stringify(e.fields.title) === JSON.stringify({ Text: 'Quantum policies' }))
    expect(made?.[1].fields.pdf_name).toEqual({ Text: '2007.14384.pdf' })
  })

  it('arXiv not answering: the server’s sentence, and the button to try again', async () => {
    server.lookups['2007.14384'] = { title: 'Q', authors: '', year: '', doi: null, url: 'https://arxiv.org/abs/2007.14384' }
    await openBoard()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    fireEvent.change(screen.getByLabelText('URL or DOI'), { target: { value: '2007.14384' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Fetch the PDF from arXiv' }))
    for (let i = 0; i < 3; i++) await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('arXiv did not answer. Try again in a minute.')
    expect(screen.getByRole('button', { name: 'Try fetching the PDF again' })).toBeInTheDocument()
  })

  it('a DOI gets no such offer', async () => {
    server.lookups['10.1000/x'] = { title: 'T', authors: '', year: '', doi: '10.1000/x', url: null }
    await openBoard()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add Source' }))
    fireEvent.change(screen.getByLabelText('URL or DOI'), { target: { value: '10.1000/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await flush()
    expect(screen.queryByRole('button', { name: 'Fetch the PDF from arXiv' })).toBeNull()
  })
})

// ---- the reader ----

let scrollTops = new WeakMap<Element, number>()
function shimLayout() {
  scrollTops = new WeakMap()
  const proto = HTMLElement.prototype
  const restore = [
    ['scrollTop', Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')],
    ['clientHeight', Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')],
    ['clientWidth', Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')],
  ] as const
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0
    },
    set(this: Element, v: number) {
      scrollTops.set(this, v)
    },
  })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 900 })
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 740 })
  return () => {
    delete (proto as unknown as Record<string, unknown>).scrollTop
    delete (proto as unknown as Record<string, unknown>).clientHeight
    delete (proto as unknown as Record<string, unknown>).clientWidth
    void restore
  }
}

describe('the reader', () => {
  let unshim = () => {}
  beforeEach(() => {
    unshim = shimLayout()
  })
  afterEach(() => unshim())

  async function openReader(pages: number, extra: { page?: number; find?: string } = {}) {
    engine.pages = pages
    const hash = server.pdf.store(tinyPdf(`r${pages}`))
    server.commit(pdfOps.attach('s1', { hash, name: 'long.pdf', size: 1000, pages }), ME.id)
    await openBoard()
    act(() => usePagePanel.setState({ cardId: 'c1', full: false }))
    render(<PagePanel cardId="c1" full={false} onClose={() => {}} />)
    if (extra.page === undefined && extra.find === undefined) fireEvent.click(screen.getByRole('button', { name: 'Open PDF: Parametrized quantum policies' }))
    else act(() => pdfReader.open({ cardId: 'c1', sourceId: 's1', hash, name: 'long.pdf', title: 'Parametrized quantum policies', ...extra }))
    for (let i = 0; i < 4; i++) await flush()
    return hash
  }

  const drawn = () => [...document.querySelectorAll('[data-page]')].map((el) => Number(el.getAttribute('data-page')))
  const pageInput = () => screen.getByRole('textbox', { name: /^Page, of/ }) as HTMLInputElement

  it('opens in the Page panel’s place; a 300-page PDF draws a handful of pages', async () => {
    await openReader(300)
    expect(screen.getByTestId('pdf-reader')).toBeInTheDocument()
    expect(screen.queryByTestId('page-panel')).toBeNull()
    expect(screen.getByRole('heading', { name: /Parametrized quantum policies/ })).toHaveTextContent('long.pdf')
    expect(screen.getByText('of 300')).toBeInTheDocument()
    expect(drawn().length).toBeGreaterThan(0)
    expect(drawn().length).toBeLessThanOrEqual(6)
    expect(engine.opened[0]).toEqual({ url: expect.stringMatching(/^\/api\/files\/pdf\/[0-9a-f]{64}$/) })
  })

  it('keys: → / PageDown next page, ← / PageUp back, End and Home; the page is remembered; Esc closes', async () => {
    const hash = await openReader(300)
    const scroller = screen.getByTestId('pdf-scroll')
    fireEvent.keyDown(scroller, { key: 'ArrowRight' })
    await flush()
    expect(pageInput().value).toBe('2')
    fireEvent.keyDown(scroller, { key: 'PageDown' })
    await flush()
    expect(pageInput().value).toBe('3')
    fireEvent.keyDown(scroller, { key: 'PageUp' })
    await flush()
    expect(pageInput().value).toBe('2')
    fireEvent.keyDown(scroller, { key: 'End' })
    await flush()
    expect(pageInput().value).toBe('300')
    expect(drawn()).toContain(300)
    expect(drawn()).not.toContain(1)
    await waitFor(() => expect(rememberedPage(hash)).toBe(300))
    fireEvent.keyDown(scroller, { key: 'Escape' })
    expect(usePdfReader.getState().target).toBeNull()
  })

  it('opens at the remembered page next time', async () => {
    const hash = server.pdf.store(tinyPdf('r40'))
    localStorage.setItem('infall-pdf-pages', JSON.stringify({ v: 1, pages: [[hash, 40]] }))
    engine.pages = 40
    server.commit(pdfOps.attach('s1', { hash, name: 'long.pdf', size: 1000, pages: 40 }), ME.id)
    await openBoard()
    act(() => usePagePanel.setState({ cardId: 'c1', full: false }))
    render(<PagePanel cardId="c1" full={false} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open PDF: Parametrized quantum policies' }))
    for (let i = 0; i < 4; i++) await flush()
    expect(pageInput().value).toBe('40')
  })

  it('the page field goes to a page', async () => {
    await openReader(50)
    const input = pageInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '17' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(pageInput().value).toBe('17')
  })

  it('⌘F / Ctrl+F opens Find; matches counted from the stored text, marked on the page; Enter steps', async () => {
    engine.texts = ['alpha threshold', 'none', 'threshold and threshold']
    await openReader(3)
    const scroller = screen.getByTestId('pdf-scroll')
    fireEvent.keyDown(scroller, { key: 'f', ctrlKey: true, metaKey: true })
    const find = screen.getByRole('searchbox', { name: 'Find in this PDF' })
    fireEvent.change(find, { target: { value: 'threshold' } })
    await flush()
    expect(screen.getByRole('search')).toHaveTextContent('1 of 3')
    expect(document.querySelectorAll('mark.qr-hit').length).toBeGreaterThan(0)
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(screen.getByRole('search')).toHaveTextContent('2 of 3')
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('search')).toHaveTextContent('1 of 3')
    fireEvent.change(find, { target: { value: 'nowhere' } })
    expect(screen.getByRole('search')).toHaveTextContent('No matches')
    fireEvent.keyDown(find, { key: 'Escape' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(screen.getByTestId('pdf-reader')).toBeInTheDocument()
  })

  it('a PDF without text says so', async () => {
    engine.texts = ['', ' ', '']
    await openReader(3)
    expect(screen.getByText(NO_TEXT)).toBeInTheDocument()
  })

  it('a file left out of the Workspace file (404 file_missing) says so', async () => {
    // pdf.js rejects a 404 with a ResponseException carrying the status.
    engine.openError = Object.assign(new Error('Unexpected server response (404)'), { name: 'ResponseException', status: 404 })
    await openReader(3)
    expect(screen.getByRole('alert')).toHaveTextContent(PDF_NOT_INCLUDED)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('Save a copy in a browser; Open in the system viewer in the desktop app', async () => {
    const openExternally = vi.fn(async () => {})
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', openExternally }
    try {
      await openReader(2)
      fireEvent.click(screen.getByRole('button', { name: 'Open in the system viewer' }))
      await flush()
      expect(openExternally).toHaveBeenCalledWith({ suggestedName: 'long.pdf', bytes: expect.any(Uint8Array) })
    } finally {
      delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
    }
  })

  it('opened from a search result: at that page, with the word found', async () => {
    engine.texts = ['x', 'y', 'the threshold', 'threshold again']
    await openReader(4, { page: 4, find: 'threshold' })
    expect(screen.getByRole('searchbox', { name: 'Find in this PDF' })).toHaveValue('threshold')
    expect(screen.getByRole('search')).toHaveTextContent('2 of 2')
    expect(pageInput().value).toBe('4')
  })
})

describe('search', () => {
  it('finds words from a PDF: "in the PDF of <Source title>, page N"; choosing opens the Page and the reader there', async () => {
    const hash = server.pdf.store(tinyPdf('s'))
    server.commit(pdfOps.attach('s1', { hash, name: 'p.pdf', size: 10, pages: 3 }), ME.id)
    server.pdf.texts.set(hash, ['intro', 'nothing', 'the surface code threshold'])
    await openBoard()
    render(<SearchBox />)
    const box = screen.getByRole('combobox', { name: 'Search Cards' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'threshold' } })
    await waitFor(() => expect(screen.getByRole('option', { name: /in the PDF of Parametrized quantum policies, page 3/ })).toBeInTheDocument())
    expect(screen.getByText('In PDFs')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.click(screen.getByRole('option', { name: /page 3/ }))
    await waitFor(() => expect(usePdfReader.getState().target).toMatchObject({ cardId: 'c1', hash, page: 3, find: 'threshold' }))
    expect(usePagePanel.getState().cardId).toBe('c1')
  })

  it('a PDF no live Card shows is not a result', async () => {
    const hash = server.pdf.store(tinyPdf('t'))
    server.pdf.texts.set(hash, ['threshold'])
    await openBoard()
    render(<SearchBox />)
    const box = screen.getByRole('combobox', { name: 'Search Cards' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'threshold' } })
    await waitFor(() => expect(server.pdf.searches).toContain('threshold'))
    await flush()
    expect(screen.queryByText('In PDFs')).toBeNull()
  })
})
