/**
 * True in the macOS desktop app, whose window has no title bar of its own: the traffic lights are drawn over the left
 * end of the top bar's first row, which leaves room for them. The desktop app is known by the bridge it puts on the page.
 */
export function macDesktopWindow(): boolean {
  if (typeof navigator === 'undefined') return false
  const desktop = (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  return typeof desktop === 'object' && desktop !== null && /Mac/.test(navigator.platform)
}
