import { describe, expect, it } from 'vitest'
import { baseName, candidatePaths, parseFileField, pdfPathsOf } from './fileField'
import { parseBibtex } from './parse'

describe('the file field', () => {
  it('Zotero with exported files: relative paths, a PDF and a snapshot', () => {
    const raw = 'Full Text PDF:files/12/Jerbi et al. - 2021 - Parametrized quantum policies.pdf:application/pdf;Snapshot:files/13/2103.html:text/html'
    expect(parseFileField(raw)).toEqual([
      { description: 'Full Text PDF', path: 'files/12/Jerbi et al. - 2021 - Parametrized quantum policies.pdf', mime: 'application/pdf' },
      { description: 'Snapshot', path: 'files/13/2103.html', mime: 'text/html' },
    ])
    expect(pdfPathsOf(raw)).toEqual(['files/12/Jerbi et al. - 2021 - Parametrized quantum policies.pdf'])
  })

  it('Zotero on Windows: escaped drive colon and backslashes', () => {
    const raw = String.raw`Full Text PDF:C\:\\Users\\ana\\Zotero\\storage\\AB12CD34\\Jerbi - 2021.pdf:application/pdf`
    expect(pdfPathsOf(raw)).toEqual([String.raw`C:\Users\ana\Zotero\storage\AB12CD34\Jerbi - 2021.pdf`])
  })

  it('Zotero on macOS / Linux: absolute POSIX paths, several PDFs', () => {
    const raw = 'Preprint PDF:/Users/ana/Zotero/storage/K9Q2/2103.05577.pdf:application/pdf;Accepted Version:/Users/ana/Zotero/storage/Z7Z7/jerbi.pdf:application/pdf'
    expect(pdfPathsOf(raw)).toEqual(['/Users/ana/Zotero/storage/K9Q2/2103.05577.pdf', '/Users/ana/Zotero/storage/Z7Z7/jerbi.pdf'])
  })

  it('escaped ; and : inside a name', () => {
    const raw = String.raw`Full Text:files/1/Part 1\; notes\: draft.pdf:application/pdf`
    expect(pdfPathsOf(raw)).toEqual(['files/1/Part 1; notes: draft.pdf'])
  })

  it('JabRef: empty description, short type', () => {
    expect(parseFileField(':papers/jerbi2021.pdf:PDF')).toEqual([{ description: '', path: 'papers/jerbi2021.pdf', mime: 'PDF' }])
    expect(pdfPathsOf(String.raw`:C\:\\papers\\jerbi.pdf:PDF`)).toEqual([String.raw`C:\papers\jerbi.pdf`])
  })

  it('Mendeley: $\\backslash$ for the backslash', () => {
    const raw = String.raw`:C$\backslash$:/Users/ana/Documents/Mendeley Desktop/Jerbi - 2021.pdf:pdf`
    expect(pdfPathsOf(raw)).toEqual(['C:/Users/ana/Documents/Mendeley Desktop/Jerbi - 2021.pdf'])
  })

  it('an unescaped drive letter, a bare path, nothing at all', () => {
    expect(pdfPathsOf('Full Text:C:/papers/x.pdf:application/pdf')).toEqual(['C:/papers/x.pdf'])
    expect(pdfPathsOf('papers/x.pdf')).toEqual(['papers/x.pdf'])
    expect(pdfPathsOf('')).toEqual([])
    expect(pdfPathsOf(undefined)).toEqual([])
    expect(pdfPathsOf('Snapshot:files/2/page.html:text/html')).toEqual([])
  })

  it('reaches the entry through the BibTeX reader, braces and all', () => {
    const bib = `@article{jerbi2021,
  title = {Parametrized quantum policies},
  author = {Jerbi, Sofiene},
  year = {2021},
  file = {Full Text PDF:files/12/Jerbi - 2021.pdf:application/pdf}
}
@misc{nofile, title = {No file}}`
    const { entries } = parseBibtex(bib)
    expect(entries[0]!.file).toBe('Full Text PDF:files/12/Jerbi - 2021.pdf:application/pdf')
    expect(entries[1]!.file).toBeUndefined()
    expect(pdfPathsOf(entries[0]!.file)).toEqual(['files/12/Jerbi - 2021.pdf'])
  })
})

describe('where to look for a file', () => {
  it('the path itself, then its last parts', () => {
    expect(candidatePaths('/Users/ana/Zotero/storage/K9Q2/x.pdf')).toEqual(['/Users/ana/Zotero/storage/K9Q2/x.pdf', 'storage/K9Q2/x.pdf', 'K9Q2/x.pdf', 'x.pdf'])
    expect(candidatePaths(String.raw`C:\Users\ana\Zotero\storage\K9\x.pdf`)).toEqual(['C:/Users/ana/Zotero/storage/K9/x.pdf', 'storage/K9/x.pdf', 'K9/x.pdf', 'x.pdf'])
    expect(candidatePaths('files/12/x.pdf')).toEqual(['files/12/x.pdf', '12/x.pdf', 'x.pdf'])
    expect(candidatePaths('./x.pdf')).toEqual(['x.pdf'])
  })

  it('never a path that climbs out', () => {
    expect(candidatePaths('../../etc/passwd.pdf')).toEqual([])
    expect(candidatePaths('')).toEqual([])
  })

  it('baseName', () => {
    expect(baseName(String.raw`C:\a\b.pdf`)).toBe('b.pdf')
    expect(baseName('files/1/c.pdf')).toBe('c.pdf')
  })
})
