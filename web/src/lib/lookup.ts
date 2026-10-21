// M13 (docs/specs/portability.md, Contract B): asking the server for a Source's details by DOI or arXiv id.
// The server asks Crossref or arXiv; this layer only recognises what was typed and passes the answer on.
import { ApiError, request } from './http'
import { normalizeDoi } from './sources'
import { sessionStore } from './session-store'
import type { LookupQuery, LookupResult } from './types'

// New-style arXiv ids (2103.05577, 0704.0001) and old-style ones (quant-ph/0101001, math.GT/0309136).
const NEW_ID = /^(\d{4}\.\d{4,5})(?:v\d+)?$/
const OLD_ID = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/
const ARXIV_HOST = /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i
// arXiv's own DOIs (10.48550/arXiv.2103.05577) are registered at DataCite, which Crossref does not answer for.
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i

function arxivId(text: string): string {
  const s = text.trim()
  const m = NEW_ID.exec(s) ?? OLD_ID.exec(s)
  return m ? m[1]! : ''
}

/**
 * What Look up would ask for, or null: a DOI (bare, `doi:…` or a doi.org address) or an arXiv id
 * (`2103.05577`, `arXiv:2103.05577v2`, `quant-ph/0101001`, an arxiv.org address). Versions are dropped: the
 * registry answers for the paper.
 */
export function lookupQuery(text: string): LookupQuery | null {
  const s = text.trim()
  const doi = normalizeDoi(s)
  if (doi) {
    const fromArxiv = ARXIV_DOI.exec(doi)
    const id = fromArxiv ? arxivId(fromArxiv[1]!) : ''
    return id ? { arxiv: id } : { doi }
  }
  const page = ARXIV_HOST.exec(s)
  const id = arxivId(page ? decodeURIComponent(page[1]!) : s.replace(/^arxiv\s*:\s*/i, ''))
  return id ? { arxiv: id } : null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/**
 * `POST /api/sources/lookup`. Resolves with the registry's details (fields it lacks are ''). Rejects with an
 * ApiError whose message is a sentence fit to show: 404 not known, 502 the registry did not answer, 429 too many
 * lookups, 400 not a DOI / arXiv id, 403 for a Guest (refused locally), status 0 when the server cannot be reached.
 */
export async function lookupSource(query: LookupQuery): Promise<LookupResult> {
  const s = sessionStore.getState()
  if (s.status === 'signed_in' && s.member.role === 'guest') throw new ApiError(403, 'forbidden', 'Guests cannot look up Sources.')
  const body = 'doi' in query ? { doi: query.doi } : { arxiv: query.arxiv }
  const answer = await request<Record<string, unknown>>('POST', '/api/sources/lookup', body)
  return {
    title: text(answer.title),
    authors: text(answer.authors),
    year: text(answer.year),
    doi: textOrNull(answer.doi),
    url: textOrNull(answer.url),
  }
}
