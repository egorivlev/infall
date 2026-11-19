import { describe, expect, it } from 'vitest'
import { markedParts, snippetAround } from './searchPdf'

describe('the snippet of a PDF result', () => {
  // What the real server sent for a word on page 3 (up to 200 characters, the match well inside them).
  const page =
    'Page 3 of the integration test paper. The special word of this page is gammazebrafish. Line 0 on page 3: entanglement entropy and decoherence in open systems. Line 1 on page 3: entanglement entropy an'

  it('starts a little before the words found, so they are on the one line shown', () => {
    const s = snippetAround(page, 'gammazebrafish')
    expect(s.startsWith('…')).toBe(true)
    expect(s.indexOf('gammazebrafish')).toBeLessThan(30)
    expect(s.endsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(110)
    expect(markedParts(s, 'gammazebrafish').some((p) => p.hit)).toBe(true)
  })

  it('keeps a short snippet whole, and one that starts with the match from its start', () => {
    expect(snippetAround('short text with word', 'word')).toBe('short text with word')
    expect(snippetAround(page, 'Page 3').startsWith('Page 3 of')).toBe(true)
  })

  it('matches across runs of white space and ignores case', () => {
    expect(snippetAround(page, 'SPECIAL   word')).toContain('special word')
  })

  it('cuts a long snippet without the query at a word', () => {
    const s = snippetAround(page, 'absent')
    expect(s.startsWith('Page 3')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(91)
  })
})
