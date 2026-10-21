import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_LIMIT, fileName, readFileText, saveTextFile } from './files'

let clicked: { href: string; download: string }[] = []

beforeEach(() => {
  clicked = []
  vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download })
  })
})

afterEach(() => {
  delete (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saveTextFile', () => {
  it('uses the desktop app’s save dialog when it has one', async () => {
    const saveFile = vi.fn(async () => true)
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', saveFile }
    await expect(saveTextFile('Page.md', '# Hi\n', 'text/markdown')).resolves.toBe('saved')
    expect(saveFile).toHaveBeenCalledWith({ suggestedName: 'Page.md', text: '# Hi\n' })
    expect(clicked).toEqual([])
  })

  it('says when the person cancelled the dialog', async () => {
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', saveFile: async () => false }
    await expect(saveTextFile('Page.md', 'x', 'text/markdown')).resolves.toBe('cancelled')
    expect(clicked).toEqual([])
  })

  it('passes a failure of the app on', async () => {
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', saveFile: async () => Promise.reject(new Error('The disk is full.')) }
    await expect(saveTextFile('Page.md', 'x', 'text/markdown')).rejects.toThrow('The disk is full.')
  })

  it('downloads in a browser, and in an app from before M13', async () => {
    await expect(saveTextFile('Sources.bib', '@misc{x}', 'application/x-bibtex')).resolves.toBe('downloaded')
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '0.9', switchWorkspace: async () => {} }
    await expect(saveTextFile('Sources.bib', '@misc{x}', 'application/x-bibtex')).resolves.toBe('downloaded')
    expect(clicked).toEqual([
      { href: 'blob:fake', download: 'Sources.bib' },
      { href: 'blob:fake', download: 'Sources.bib' },
    ])
    expect(document.querySelector('a[download]')).toBeNull() // the anchor is gone again
  })

  it('downloads what is larger than the app takes', async () => {
    const saveFile = vi.fn(async () => true)
    ;(globalThis as { qoopDesktop?: unknown }).qoopDesktop = { version: '1', saveFile }
    await expect(saveTextFile('big.md', 'x'.repeat(DESKTOP_LIMIT + 1), 'text/markdown')).resolves.toBe('downloaded')
    expect(saveFile).not.toHaveBeenCalled()
  })
})

describe('fileName', () => {
  it('keeps what file systems take', () => {
    expect(fileName('QRL on CartPole', 'md')).toBe('QRL on CartPole.md')
    expect(fileName('a/b\\c: d*?"<>|\u0007e', 'bib')).toBe('a b c d e.bib')
    expect(fileName('  ..hidden', 'md')).toBe('hidden.md')
    expect(fileName('', 'md')).toBe('Untitled.md')
    expect(fileName('x'.repeat(300), 'md')).toHaveLength(123)
  })
})

describe('readFileText', () => {
  it('reads UTF-8 text', async () => {
    await expect(readFileText(new Blob(['M{\\"u}ller · Müller'], { type: 'text/plain' }))).resolves.toBe('M{\\"u}ller · Müller')
  })
})
