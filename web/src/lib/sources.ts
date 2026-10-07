// Pure helpers for Sources: a Source is identified by its DOI or its URL, however it was typed or pasted.
import type { SourceVM } from './types'

const DOI = /^10\.\d{4,9}\/\S+$/
const DOI_HOST = /^(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\//i
const DOI_LABEL = /^doi\s*:?\s*/i

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * The DOI in `text`, lower-cased, or '' when it is not one. Accepts a bare DOI ("10.1103/PhysRevA.52.R2493"),
 * "doi:…" / "DOI: …", and a doi.org address (http or https, with or without "dx." and percent-encoding).
 * Whitespace around it and a full stop, comma or semicolon after it are dropped.
 */
export function normalizeDoi(text: string): string {
  let s = text.trim()
  if (DOI_HOST.test(s)) s = decoded(s.replace(DOI_HOST, ''))
  else s = s.replace(DOI_LABEL, '')
  s = s.trim().replace(/[.,;]+$/, '')
  return DOI.test(s) ? s.toLowerCase() : ''
}

/**
 * An http(s) address in one spelling, or '' when `text` is not one: trimmed, scheme and host lower-cased, the
 * default port, the fragment and trailing slashes dropped. The query is kept.
 */
export function normalizeUrl(text: string): string {
  const s = text.trim()
  if (!/^https?:\/\//i.test(s)) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  if (u.hostname === '') return ''
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

// What identifies a Source: its DOI (also when it sits in the URL as a doi.org address), else its address.
function keysOf(input: { url?: string; doi?: string }): { doi: string; url: string } {
  const doi = normalizeDoi(input.doi ?? '') || normalizeDoi(DOI_HOST.test((input.url ?? '').trim()) ? input.url! : '')
  return { doi, url: normalizeUrl(input.url ?? '') }
}

/** The first of `sources` that is the same reference as `input`: same DOI, else same address. */
export function findSourceIn(sources: readonly SourceVM[], input: { url?: string; doi?: string }): SourceVM | undefined {
  const want = keysOf(input)
  if (want.doi !== '') {
    const hit = sources.find((s) => keysOf(s).doi === want.doi)
    if (hit) return hit
  }
  if (want.url === '') return undefined
  return sources.find((s) => normalizeUrl(s.url) === want.url)
}
