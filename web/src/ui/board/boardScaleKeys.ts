// Shift + "+" / Shift + "−" / Shift + 0: the Board scale (Settings → Board), from the keyboard.
//
// Matched on the key a layout produces, not on one physical key: "+" is Shift + "=" on a US keyboard and a key of
// its own on a German one; "_" is what Shift + "-" produces almost everywhere; the number pad's + and − count too.
// Shift + 0 is matched on the physical key (`code`), because what it produces differs: ")" in the US, "=" in
// Germany, "0" on AZERTY. With ⌘, Ctrl or Alt held nothing matches: those belong to the browser's or the app's own
// zoom. Nothing typed into a field is ever taken.

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>

/** 1 larger, -1 smaller, 0 back to the default, null not a Board scale key. */
export function boardScaleKey(e: KeyLike): 1 | -1 | 0 | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null
  if (!e.shiftKey) return e.key === '+' ? 1 : null // a layout where "+" needs no Shift
  if (e.code === 'Digit0' || e.code === 'Numpad0' || (!e.code && (e.key === ')' || e.key === '0'))) return 0
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 1
  if (e.key === '_' || e.key === '-' || e.key === '−' || e.code === 'NumpadSubtract') return -1
  return null
}

/** True for a place where keys are text: a field, a text area, a list box, anything editable. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return true
  const input = target.closest('input')
  if (!input) return false
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(input.type)
}
