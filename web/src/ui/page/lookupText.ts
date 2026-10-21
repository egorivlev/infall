// What Look up says: the sentences for the Source form (M13). Pure.
import { ApiError } from '../../lib'
import type { LookupQuery } from '../../lib'

export const LOOKUP_NEEDS_ID = 'Look up works with a DOI, such as 10.1103/PhysRevA.52.R2493, or an arXiv address or id, such as 2103.05577.'
export const LOOKUP_OFFLINE =
  'Infall’s server cannot be reached right now, so Look up could not ask. Try again once the connection is back, or fill in the fields by hand.'

/** "title, authors and year" */
export function listWords(words: readonly string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : (words[0] ?? '')
}

/** The sentence for a lookup that did not work: the server's own, or one that says what to do next. */
export function lookupFailure(e: unknown, registry: string): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return LOOKUP_OFFLINE
    // The layer's stand-in when the server sent no sentence of its own.
    const own = e.message && !/^Request failed \(\d+\)\.$/.test(e.message) ? e.message : ''
    if (own) return own
    if (e.status === 404) return `${registry} does not know this one. Check it against the paper, or fill in the fields by hand.`
    if (e.status === 429) return 'That is many lookups in one minute. Wait a minute, then try again.'
    if (e.status === 400) return LOOKUP_NEEDS_ID
  }
  return `${registry} could not be asked just now. Try again in a minute, or fill in the fields by hand.`
}

export const registryOf = (q: LookupQuery) => ('doi' in q ? 'Crossref' : 'arXiv')

