// How a Source's identifier reads and where it points. Pure.
import { normalizeDoi, normalizeUrl } from '../../lib'
import { safeHref } from './markdown'

export type SourceLink = { href: string; text: string }

const ARXIV_PATH = /^\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/

/** DOI → "doi:10.…" at doi.org; an arXiv address → "arXiv:2103.05577"; any other address → its host name. */
export function sourceLink(source: { url: string; doi: string }): SourceLink | null {
  const doi = source.doi.trim()
  if (doi) return { href: `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`, text: `doi:${doi}` }
  const href = safeHref(source.url)
  if (!href) return null
  const url = new URL(href)
  const host = url.hostname.replace(/^www\./i, '')
  const arxiv = /(?:^|\.)arxiv\.org$/i.test(host) ? ARXIV_PATH.exec(url.pathname) : null
  return { href, text: arxiv ? `arXiv:${arxiv[1]}` : host }
}

export type Identifier = { doi: string } | { url: string }

/** What was typed into "URL or DOI": a DOI if it is one (also as doi:… or a doi.org address), else an http(s) URL, else null. */
export function parseIdentifier(text: string): Identifier | null {
  const doi = normalizeDoi(text)
  if (doi) return { doi }
  const url = normalizeUrl(text)
  return url ? { url } : null
}

/** The identifier as it is shown in the field when editing a Source. */
export function identifierText(source: { url: string; doi: string }): string {
  return source.doi ? `doi:${source.doi}` : source.url
}
