import { forYou, useWorkspace } from '../../lib'
import type { ForYouItem } from '../../lib'
import { pagePanel } from '../bridge'
import { useOnBoard } from '../shell/useOnBoard'

/** Where a mention is: the Card's title on the open Branch, else that it was removed (its thread is kept). */
export function cardWords(card: string, cards: readonly { id: string; title: string }[]): string {
  const found = cards.find((c) => c.id === card)
  return found ? `the Card “${found.title || 'Untitled'}”` : 'a Card that was removed'
}

/** Opens the Page of the mention's Card at the Comment, and marks it (and every older one) as seen. */
export function useOpenMention(): (item: ForYouItem) => void {
  const onBoard = useOnBoard()
  const readOnly = useWorkspace().readOnly === true
  return (item: ForYouItem) => {
    onBoard(() => pagePanel.open(item.card, { comment: item.comment }))
    if (!item.seen && !readOnly) void Promise.resolve(forYou.seen(item.comment)).catch(() => {})
  }
}
