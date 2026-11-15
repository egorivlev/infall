// M19's calls into the desktop app (window.qoopDesktop), feature-detected: a browser and an older app have none,
// and then nothing may offer them.

type OpenExternally = (file: { suggestedName: string; bytes: Uint8Array }) => Promise<void>

function bridge(): Record<string, unknown> | null {
  const d = (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : null
}

/** `openExternally`: the PDF handed to the system's own viewer (the app writes it to a private temp file first). */
export function desktopOpenExternally(): OpenExternally | null {
  const d = bridge()
  const fn = d?.openExternally
  return typeof fn === 'function' ? (file) => Promise.resolve((fn as OpenExternally).call(d, file)) : null
}

export type FolderAccess = {
  pick(): Promise<{ token: string; name: string } | null>
  read(token: string, path: string): Promise<Uint8Array>
}

/** `pickFolder` + `readFileIn` (Import BibTeX with files, decision 10): only when the app has both. */
export function desktopFolders(): FolderAccess | null {
  const d = bridge()
  const pick = d?.pickFolder
  const read = d?.readFileIn
  if (typeof pick !== 'function' || typeof read !== 'function') return null
  return {
    pick: () => Promise.resolve(pick.call(d) as Promise<{ token: string; name: string } | null>),
    read: (token, path) => Promise.resolve(read.call(d, token, path) as Promise<Uint8Array>),
  }
}
