// The sidebar's wording, in one place.
import type { AiScope, AiSetup } from '../../lib'

export const UNTITLED = 'Untitled'
export const titleOf = (card: { title: string }): string => card.title.trim() || UNTITLED

/** "Card: Surface code basics" / "Board: main". */
export function scopeLabel(scope: Pick<AiScope, 'branchName' | 'card'>): string {
  return scope.card ? `Card: ${titleOf(scope.card)}` : `Board: ${scope.branchName}`
}

export function sameScope(a: AiScope | undefined, b: AiScope | undefined): boolean {
  return a?.branch === b?.branch && a?.card?.id === b?.card?.id
}

export const CARD_STARTERS = ['What is missing from this Page?', 'Which Sources should this Card cite?', 'What should connect to this Card?']
export const BOARD_STARTERS = ['Summarise the state of this Board', 'Which Cards look related but are not connected?', 'Where are the open questions?']

const isSuggest = (tool: string) => tool.startsWith('suggest_')

/** The tools an answer read with, each once, in the order first used. */
export function readTools(tools: readonly string[] | undefined): string[] {
  return [...new Set((tools ?? []).filter((t) => !isSuggest(t)))]
}
export function proposed(tools: readonly string[] | undefined): boolean {
  return (tools ?? []).some(isSuggest)
}

/** What answers, for the header: the label, and what the tooltip adds. */
export function providerWords(setup: AiSetup): { label: string; title?: string } {
  if (setup.provider === 'claude-code') return { label: setup.label, title: setup.version ? `${setup.label} ${setup.version}` : undefined }
  if (setup.provider === 'openrouter') return { label: setup.label, title: `OpenRouter · ${setup.model}` }
  return { label: setup.reason === 'loading' ? 'checking…' : 'no model' }
}

type ErrorLike = { code?: unknown; status?: unknown }
/** Why a question could not be sent, in plain words. */
export function sendError(e: unknown): string {
  const o: ErrorLike = typeof e === 'object' && e !== null ? e : {}
  if (o.code === 'busy') return 'An answer is still being written. Wait for it, or stop it.'
  if (o.code === 'no_ai') return 'AI is not set up, so nothing was sent.'
  if (o.code === 'network') return "Can't reach the server. Check your connection and try again."
  if (o.status === 400) return 'That could not be sent: a question needs some text, and at most 20 000 characters.'
  return 'That could not be sent. Try again.'
}
