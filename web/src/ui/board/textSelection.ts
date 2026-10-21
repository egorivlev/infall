/**
 * Keeping the browser's own text selection off the Board.
 *
 * React Flow claims a press only when it starts a drag of its own (moving a Card or Frame, panning):
 * then d3 cancels `selectstart` for the length of the gesture. Every other press on the Board is left
 * to the browser, which starts a text selection there: Shift-drag on the background (React Flow's
 * selection box does not cancel the native selection when the press lands on the pane itself),
 * dragging from a Card's connect handle, a press on the zoom controls or the toolbar, Ctrl-drag.
 * Card text is `user-select: none`, so Chrome paints nothing, but the selection is live: it runs into
 * the inspector and the rail, and WebKit (the macOS desktop app) highlights the Cards it crosses.
 * A selection left over from elsewhere (the Page panel, the rail) is worse: Shift-click extends it
 * without any `selectstart`, and in WebKit a press inside a selection starts dragging that text
 * instead of the Card.
 *
 * So, on the Board: no selection may start outside the places where text is meant to be selected,
 * and a press there first drops any selection left over from elsewhere.
 */

/** Where a person expects to select text on the Board: fields being edited and the Card's side panel. */
export const SELECTABLE_ON_BOARD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .qb-inspector'

function elementOf(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

/** True when a press or a selection starting at `target` is meant to select text. */
export function selectsText(target: EventTarget | null): boolean {
  const el = elementOf(target)
  return el !== null && el.closest(SELECTABLE_ON_BOARD) !== null
}

function editingField(el: Element | null): boolean {
  return el !== null && el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null
}

/** `selectstart` on the Board: refused unless it starts where text is meant to be selected. */
export function refuseSelectStart(e: Event): void {
  if (!selectsText(e.target)) e.preventDefault()
}

/**
 * A press on the Board outside a selectable place drops any text selection left over from elsewhere,
 * so it can neither be extended (Shift) nor dragged (WebKit). A field being edited keeps its own.
 */
export function dropStaleSelection(e: Event): void {
  if (selectsText(e.target)) return
  if (editingField(document.activeElement)) return // its blur confirms the edit; leave it to the browser
  const s = document.getSelection()
  if (!s || s.rangeCount === 0) return
  if (editingField(elementOf(s.anchorNode))) return
  s.removeAllRanges()
}

/** Wires both onto the Board's root element; returns the cleanup. */
export function guardBoardSelection(root: HTMLElement): () => void {
  root.addEventListener('selectstart', refuseSelectStart)
  // Capture: React Flow stops some presses from bubbling (the selection box on Shift).
  root.addEventListener('pointerdown', dropStaleSelection, true)
  return () => {
    root.removeEventListener('selectstart', refuseSelectStart)
    root.removeEventListener('pointerdown', dropStaleSelection, true)
  }
}
