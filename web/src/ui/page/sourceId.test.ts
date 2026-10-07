import { describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakePageLib())
vi.mock('../../lib', async (orig) => fake.module(await orig<typeof import('../../lib')>()))

const { identifierText, parseIdentifier, sourceLink } = await import('./sourceId')

const link = (url: string, doi = '') => sourceLink({ url, doi })

describe('sourceLink', () => {
  it('shows a DOI as doi:… and points at doi.org', () => {
    expect(link('', '10.22331/q-2020-02-06-226')).toEqual({ href: 'https://doi.org/10.22331/q-2020-02-06-226', text: 'doi:10.22331/q-2020-02-06-226' })
  })

  it('prefers the DOI when a Source has both', () => {
    expect(link('https://example.org/paper', '10.1103/physreva.52.r2493')?.text).toBe('doi:10.1103/physreva.52.r2493')
  })

  it('escapes what a DOI may contain so it cannot change the address', () => {
    expect(link('', '10.1002/(sici)1097-4539<a>?x=1#y')?.href).toBe('https://doi.org/10.1002/(sici)1097-4539%3Ca%3E%3Fx%3D1%23y')
  })

  it('shows arXiv addresses as arXiv:<id>, whatever the form', () => {
    expect(link('https://arxiv.org/abs/2103.05577')).toEqual({ href: 'https://arxiv.org/abs/2103.05577', text: 'arXiv:2103.05577' })
    expect(link('https://arxiv.org/abs/2103.05577v2')?.text).toBe('arXiv:2103.05577v2')
    expect(link('https://arxiv.org/pdf/2103.05577.pdf')?.text).toBe('arXiv:2103.05577')
    expect(link('https://www.arxiv.org/abs/quant-ph/9512032')?.text).toBe('arXiv:quant-ph/9512032')
    expect(link('http://export.arxiv.org/abs/2103.05577/')?.text).toBe('arXiv:2103.05577')
    expect(link('https://arxiv.org/list/quant-ph/new')?.text).toBe('arxiv.org')
    expect(link('https://notarxiv.org/abs/2103.05577')?.text).toBe('notarxiv.org')
  })

  it('shows any other address by its host name, without www.', () => {
    expect(link('https://www.nature.com/articles/s41586-019-1666-5')).toEqual({
      href: 'https://www.nature.com/articles/s41586-019-1666-5',
      text: 'nature.com',
    })
    expect(link('http://journals.aps.org/pra/abstract/10.1103/PhysRevA.52.R2493')?.text).toBe('journals.aps.org')
  })

  it('gives no link for nothing, or for an address that is not http(s)', () => {
    expect(link('')).toBeNull()
    expect(link('javascript:alert(1)')).toBeNull()
    expect(link('data:text/html,x')).toBeNull()
    expect(link('ftp://example.org/x')).toBeNull()
    expect(link('not an address')).toBeNull()
  })
})

describe('parseIdentifier', () => {
  it('recognises a DOI in its three spellings, before trying a URL', () => {
    expect(parseIdentifier('10.1103/PhysRevA.52.R2493')).toEqual({ doi: '10.1103/physreva.52.r2493' })
    expect(parseIdentifier('doi:10.1103/PhysRevA.52.R2493')).toEqual({ doi: '10.1103/physreva.52.r2493' })
    expect(parseIdentifier(' https://doi.org/10.1103/PhysRevA.52.R2493 ')).toEqual({ doi: '10.1103/physreva.52.r2493' })
  })

  it('otherwise takes an http(s) URL, normalised', () => {
    expect(parseIdentifier('https://arxiv.org/abs/2103.05577/#top')).toEqual({ url: 'https://arxiv.org/abs/2103.05577' })
  })

  it('refuses everything else', () => {
    for (const text of ['', '   ', 'arxiv 2103.05577', 'javascript:alert(1)', 'ftp://example.org', 'www.example.org']) {
      expect(parseIdentifier(text), text).toBeNull()
    }
  })
})

describe('identifierText', () => {
  it('shows the DOI with its prefix, else the URL', () => {
    expect(identifierText({ url: '', doi: '10.1/x' })).toBe('doi:10.1/x')
    expect(identifierText({ url: 'https://example.org', doi: '' })).toBe('https://example.org')
    expect(identifierText({ url: '', doi: '' })).toBe('')
  })
})
