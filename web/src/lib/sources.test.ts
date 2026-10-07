import { describe, expect, it } from 'vitest'
import { findSourceIn, normalizeDoi, normalizeUrl } from './sources'
import type { SourceVM } from './types'

describe('normalizeDoi', () => {
  it('reads a DOI however it is written', () => {
    const want = '10.1103/physreva.52.r2493'
    for (const text of [
      '10.1103/PhysRevA.52.R2493',
      '  10.1103/PhysRevA.52.R2493 \n',
      'doi:10.1103/PhysRevA.52.R2493',
      'DOI: 10.1103/PhysRevA.52.R2493',
      'https://doi.org/10.1103/PhysRevA.52.R2493',
      'http://dx.doi.org/10.1103/PhysRevA.52.R2493',
      'doi.org/10.1103/PhysRevA.52.R2493',
      'https://www.doi.org/10.1103%2FPhysRevA.52.R2493',
      '10.1103/PhysRevA.52.R2493.',
    ]) {
      expect(normalizeDoi(text), text).toBe(want)
    }
  })
  it('keeps what belongs to the DOI', () => {
    expect(normalizeDoi('10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O')).toBe(
      '10.1002/(sici)1097-4571(199806)49:8<693::aid-asi4>3.0.co;2-o',
    )
  })
  it('gives nothing for what is not a DOI', () => {
    for (const text of ['', '   ', 'hello', '10.1/x', '11.1234/x', '10.1234/', 'https://example.com/10.1234/abc', '10.1234/a b']) {
      expect(normalizeDoi(text), text).toBe('')
    }
  })
})

describe('normalizeUrl', () => {
  it('trims, lower-cases the host, and drops the fragment, the default port and trailing slashes', () => {
    expect(normalizeUrl('  HTTPS://ArXiv.org/abs/quant-ph/9705052/#refs ')).toBe('https://arxiv.org/abs/quant-ph/9705052')
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://example.com:80/a//')).toBe('http://example.com/a')
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a')
  })
  it('keeps the path as written and the query', () => {
    expect(normalizeUrl('https://example.com/Paper/?id=7&v=2#top')).toBe('https://example.com/Paper?id=7&v=2')
  })
  it('gives nothing for what is not an http(s) address', () => {
    for (const text of ['', 'example.com/a', 'ftp://example.com/a', 'mailto:a@b.c', 'javascript:alert(1)', 'https://', 'http:// x']) {
      expect(normalizeUrl(text), text).toBe('')
    }
  })
})

describe('findSourceIn', () => {
  const source = (id: string, fields: Partial<SourceVM>): SourceVM => ({
    id,
    url: '',
    doi: '',
    title: '',
    authors: '',
    year: '',
    note: '',
    cards: [],
    ...fields,
  })
  const list = [
    source('s1', { doi: '10.1103/PhysRevA.52.R2493', url: 'https://journals.aps.org/pra/abstract/10.1103/PhysRevA.52.R2493' }),
    source('s2', { url: 'https://arxiv.org/abs/quant-ph/9705052/' }),
    source('s3', { url: 'https://doi.org/10.1038/Nature23460' }),
    source('s4', { title: 'No identifier' }),
  ]

  it('matches a DOI written another way', () => {
    expect(findSourceIn(list, { doi: 'doi:10.1103/physreva.52.r2493' })?.id).toBe('s1')
    expect(findSourceIn(list, { doi: ' https://doi.org/10.1103/PhysRevA.52.R2493 ' })?.id).toBe('s1')
  })
  it('matches a DOI given or stored as a doi.org address', () => {
    expect(findSourceIn(list, { url: 'http://dx.doi.org/10.1103/PHYSREVA.52.R2493' })?.id).toBe('s1')
    expect(findSourceIn(list, { doi: '10.1038/nature23460' })?.id).toBe('s3')
  })
  it('matches an address written another way', () => {
    expect(findSourceIn(list, { url: 'HTTPS://arxiv.org/abs/quant-ph/9705052#page=3' })?.id).toBe('s2')
  })
  it('prefers the DOI, and falls back to the address when no Source has that DOI', () => {
    expect(findSourceIn(list, { doi: '10.1103/PhysRevA.52.R2493', url: 'https://arxiv.org/abs/quant-ph/9705052' })?.id).toBe('s1')
    expect(findSourceIn(list, { doi: '10.9999/unknown', url: 'https://arxiv.org/abs/quant-ph/9705052' })?.id).toBe('s2')
  })
  it('finds nothing for an unknown or unreadable reference', () => {
    expect(findSourceIn(list, { doi: '10.9999/unknown' })).toBeUndefined()
    expect(findSourceIn(list, { url: 'https://arxiv.org/abs/other' })).toBeUndefined()
    expect(findSourceIn(list, { url: 'not a url', doi: 'not a doi' })).toBeUndefined()
    expect(findSourceIn(list, {})).toBeUndefined()
  })
})
