/**
 * After a field is confirmed or cancelled from the keyboard, put focus back where Board keys work:
 * the Card the field belongs to, else the Board itself. Never used after a blur caused by a click.
 */
export function returnFocus(from: Element | null) {
  const target = from?.closest<HTMLElement>('.react-flow__node[tabindex]') ?? from?.closest<HTMLElement>('.qb-board')
  if (target) queueMicrotask(() => target.isConnected && target.focus({ preventScroll: true }))
}
