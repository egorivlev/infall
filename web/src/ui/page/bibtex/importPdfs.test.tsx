// Decision 10: Import BibTeX with Zotero's `file` fields — the PDFs attached from a picked folder in the desktop app,
// in the same Undo step as the import; in a browser the entries come in without them and the report says so.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../pdf/engine', () => ({
  countPages: async () => 7,
  openPdf: async () => ({
    doc: { numPages: 1, pageText: async () => 'words', destroy() {} },
    cancel() {},
  }),
  extractText: async () => ['words'],
  hasNoText: () => false,
  loadEngine: async () => ({}),
}))

const { ApiError, board, ops, pdfOps, undo, useUndo } = await import('../../../lib')
const { membersStore } = await import('../../../lib/people')
const { sessionStore } = await import('../../../lib/session-store')
const { FakeServer, FakeSocket, ME, settle, tinyPdf } = await import('../../../lib/testing')
const { ImportBibtex } = await import('./ImportBibtex')
const { addPdfOps, emptyOutcome, entriesWithPdf, gatherPdfs, outcomeLines } = await import('./importPdfs')
const { planCardImport } = await import('./importPlan')
const { parseBibtex } = await import('./parse')

const BIB = String.raw`@article{jerbi2021,
  title = {Parametrized quantum policies},
  author = {Jerbi, Sofiene},
  year = {2021},
  url = {https://arxiv.org/abs/2103.05577},
  file = {Full Text PDF:files/12/Jerbi - 2021.pdf:application/pdf;Snapshot:files/13/page.html:text/html}
}
@article{missing2020,
  title = {A missing file},
  doi = {10.1000/missing},
  file = {Full Text PDF:C\:\\Users\\ana\\Zotero\\storage\\ZZ\\gone.pdf:application/pdf}
}
@misc{plain, title = {No file at all}, url = {https://example.org/plain}}`

const prepared = (name: string, hash = 'b'.repeat(64)) => ({ hash, name, size: 10, pages: 2, bytes: new Uint8Array([1]) })

describe('gathering the PDFs', () => {
  const entries = parseBibtex(BIB).entries

  it('counts the entries that name a PDF', () => {
    expect(entriesWithPdf(entries)).toBe(2)
  })

  it('reads each from the folder (shorter forms of the path too) and sorts out what could not be had', async () => {
    const asked: string[] = []
    const read = async (path: string) => {
      asked.push(path)
      if (path === 'files/12/Jerbi - 2021.pdf') return tinyPdf('jerbi')
      throw new Error('not in the folder')
    }
    const progress: [number, number][] = []
    const { byEntry, outcome } = await gatherPdfs(entries, read, async (_b, name) => prepared(name), (d, t) => progress.push([d, t]))
    expect([...byEntry.keys()]).toEqual([0])
    expect(outcome.notFound).toEqual(['gone.pdf'])
    expect(asked).toContain('C:/Users/ana/Zotero/storage/ZZ/gone.pdf')
    expect(asked).toContain('ZZ/gone.pdf')
    expect(asked).toContain('gone.pdf')
    expect(asked.some((p) => p.endsWith('.html'))).toBe(false)
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })

  it('too large (here, or the server’s 413) and other failures', async () => {
    const read = async () => tinyPdf('x')
    const big = await gatherPdfs(entries, read, async (_b, n) => prepared(n), () => {}, 5)
    expect(big.outcome.tooLarge).toEqual(['Jerbi - 2021.pdf', 'gone.pdf'])
    const refused = await gatherPdfs(entries.slice(0, 1), read, async () => {
      throw new ApiError(413, 'too_large', 'Too large.')
    })
    expect(refused.outcome.tooLarge).toEqual(['Jerbi - 2021.pdf'])
    const failed = await gatherPdfs(entries.slice(0, 1), read, async () => {
      throw new ApiError(415, 'not_a_pdf', 'This file is not a PDF.')
    })
    expect(failed.outcome.failed).toEqual([{ name: 'Jerbi - 2021.pdf', why: 'This file is not a PDF.' }])
  })

  it('joins each PDF to its entry’s group; a Source that has a PDF keeps it', () => {
    const plan = planCardImport(entries, 'c1', (input) => (input.doi === '10.1000/missing' ? { id: 'old', cards: [], pdf: 'c'.repeat(64) } : undefined))
    const outcome = emptyOutcome()
    addPdfOps(plan, new Map([[0, prepared('a.pdf')], [1, prepared('b.pdf')]]), outcome)
    expect(outcome.attached).toEqual(['a.pdf'])
    expect(outcome.kept).toBe(1)
    const first = plan.groups[0]!
    expect(first.some((op) => 'Set' in op && op.Set.field === 'pdf')).toBe(true)
    expect(plan.groups[1]!.some((op) => 'Set' in op)).toBe(false)
  })

  it('the report’s words', () => {
    expect(outcomeLines({ attached: ['a', 'b'], notFound: ['c.pdf'], tooLarge: ['d.pdf'], failed: [{ name: 'e.pdf', why: 'nope.' }], kept: 2 }, 'Zotero export')).toEqual([
      'Attached 2 PDFs.',
      '1 PDF was not found in “Zotero export”: “c.pdf”.',
      '1 PDF is larger than the server takes and was left out: “d.pdf”.',
      '“e.pdf” could not be attached: nope.',
      '2 Sources already had a PDF; theirs were kept.',
    ])
  })
})

describe('the dialog', () => {
  let server: InstanceType<typeof FakeServer>

  function Name() {
    return <output data-testid="undo-name">{useUndo().undo ?? ''}</output>
  }

  beforeEach(async () => {
    server = new FakeServer()
    server.members = [ME]
    server.commit([ops.createCard({ id: 'c1', x: 0, y: 0, title: 'QRL' })], ME.id)
    FakeSocket.all = []
    vi.stubGlobal('fetch', server.fetch)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('XMLHttpRequest', server.xhr())
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    membersStore.setState({ members: [ME] })
    await act(async () => board.open())
    const ws = FakeSocket.last()
    ws.open()
    ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
    await act(async () => settle())
  })
  afterEach(() => {
    cleanup()
    board.close()
    delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
    act(() => sessionStore.setState({ status: 'signed_out' }, true))
    vi.unstubAllGlobals()
  })

  const paste = () => fireEvent.change(screen.getByLabelText('Or paste the entries'), { target: { value: BIB } })
  const finish = async () => {
    for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  }
  const sources = () => Object.values(server.entities).filter((e) => e.kind === 'Source')

  it('in a browser: imports without files and says how many entries had one', async () => {
    render(<ImportBibtex target={{ kind: 'card', cardId: 'c1' }} onClose={() => {}} />)
    paste()
    expect(screen.getByTestId('bibtex-pdfs')).toHaveTextContent('2 entries name a PDF in its file field. In a browser the entries come in without their PDFs; the desktop app can attach them.')
    expect(screen.queryByRole('button', { name: 'Attach the PDFs…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 entries' }))
    await finish()
    expect(screen.getByText('2 entries had a PDF in their file field; in a browser no PDF is attached (the desktop app can attach them).')).toBeInTheDocument()
    expect(sources()).toHaveLength(3)
    expect(sources().some((s) => s.fields.pdf)).toBe(false)
  })

  it('in the desktop app: Attach the PDFs… → the folder → each PDF on its Source, in the import’s one Undo step', async () => {
    const files: Record<string, Uint8Array> = { 'files/12/Jerbi - 2021.pdf': tinyPdf('jerbi') }
    const pickFolder = vi.fn(async () => ({ token: 'tok-1', name: 'Zotero export' }))
    const readFileIn = vi.fn(async (token: string, path: string) => {
      expect(token).toBe('tok-1')
      const f = files[path]
      if (!f) throw new Error('No such file in the folder.')
      return f
    })
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', pickFolder, readFileIn }
    render(
      <>
        <ImportBibtex target={{ kind: 'card', cardId: 'c1' }} onClose={() => {}} />
        <Name />
      </>,
    )
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Attach the PDFs…' }))
    await act(async () => settle())
    expect(screen.getByTestId('bibtex-pdfs')).toHaveTextContent('PDFs from “Zotero export” are attached to their Sources.')
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 entries' }))
    await finish()
    expect(screen.getByText('Attached 1 PDF.')).toBeInTheDocument()
    expect(screen.getByText('1 PDF was not found in “Zotero export”: “gone.pdf”.')).toBeInTheDocument()
    const withPdf = sources().filter((s) => s.fields.pdf)
    expect(withPdf).toHaveLength(1)
    expect(withPdf[0]!.fields.pdf_name).toEqual({ Text: 'Jerbi - 2021.pdf' })
    expect(withPdf[0]!.fields.pdf_pages).toEqual({ Float: 7 })
    expect(screen.getByTestId('undo-name')).toHaveTextContent('Import 3 entries from BibTeX')
    await act(async () => void (await undo.undo()))
    await act(async () => settle())
    expect(Object.values(server.entities).filter((e) => e.kind === 'Source' && !e.deleted)).toHaveLength(0)
  })

  it('a Source already on the Branch with its own PDF keeps it', async () => {
    server.commit([ops.createSource({ id: 'old', url: 'https://arxiv.org/abs/2103.05577' }), ...pdfOps.attach('old', { hash: 'd'.repeat(64), name: 'mine.pdf', size: 1, pages: 1 })], ME.id)
    board.close()
    await act(async () => board.open())
    const ws = FakeSocket.last()
    ws.open()
    ws.receive({ type: 'subscribed', branch: 'main-id', seq: server.seq })
    await act(async () => settle())
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = {
      version: '1',
      pickFolder: async () => ({ token: 't', name: 'F' }),
      readFileIn: async () => tinyPdf('new'),
    }
    render(<ImportBibtex target={{ kind: 'card', cardId: 'c1' }} onClose={() => {}} />)
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Attach the PDFs…' }))
    await act(async () => settle())
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 entries' }))
    await finish()
    expect(server.entities.old!.fields.pdf_name).toEqual({ Text: 'mine.pdf' })
    expect(screen.getByText('1 Source already had a PDF; it was kept.')).toBeInTheDocument()
  })
})
