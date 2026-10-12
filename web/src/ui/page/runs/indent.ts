const INDENT = '    '

/**
 * Tab in the code field: four spaces at the caret, or every selected line moved in; Shift+Tab takes
 * up to four leading spaces (or one tab) off the lines the selection touches.
 */
export function indentSelection(el: HTMLTextAreaElement, back: boolean): void {
  const { selectionStart: a, selectionEnd: b, value } = el
  if (!back && a === b) {
    el.setRangeText(INDENT, a, b, 'end')
    return
  }
  const from = value.lastIndexOf('\n', a - 1) + 1
  // A selection that ends right after a line break does not include the line that follows.
  const to = b > a && value[b - 1] === '\n' ? b - 1 : b
  const next = value.indexOf('\n', to)
  const end = next === -1 ? value.length : next
  const before = value.slice(from, end).split('\n')
  const after = before.map((line) => (back ? line.replace(/^(?: {1,4}|\t)/, '') : line === '' ? line : INDENT + line))
  const block = after.join('\n')
  const grown = block.length - (end - from)
  if (grown === 0) return
  el.setRangeText(block, from, end, 'preserve')
  const first = after[0]!.length - before[0]!.length
  const start = Math.max(from, a + first)
  if (a === b) el.setSelectionRange(start, start)
  else el.setSelectionRange(start, Math.max(start, b + grown))
}
