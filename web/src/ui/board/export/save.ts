// Where an exported Board goes, and what it is called.
//
// SVG is text: it goes through the desktop app's save dialog when there is one (docs/specs/portability.md,
// Contract D), else the browser downloads it — exportFile does both. PNG is not text, and Contract D's saveFile
// writes UTF-8 text only (desktop/src-tauri/src/shell.rs `save_file`), so a PNG is always handed over as a browser
// download. In the desktop app that download is up to the webview: the shell registers no download handler, and on
// macOS wry then cancels the download (wry 0.57 wkwebview/navigation.rs), so nothing is written; WebView2 and
// WebKitGTK save to Downloads by their defaults (not checked here). Until the bridge has a binary save, the dialog
// says so in the desktop app. M18: an app with `saveBinaryFile` writes the PNG through its save dialog instead, and
// the dialog says nothing about downloads there.
import { desktopSaveBinaryFile } from '../../bridge'
import { formatWhen } from '../../history/format'
import { exportFile } from '../../page/export/exportFile'
import { fileName } from '../../page/files'
import type { Saved } from '../../page/files'
import { toasts } from '../toastStore'

/** Whether this page runs inside the desktop app (which has `window.infallDesktop`). */
export function inDesktopApp(): boolean {
  const d = (globalThis as { infallDesktop?: unknown }).infallDesktop
  return typeof d === 'object' && d !== null
}

function pad(v: number): string {
  return String(v).padStart(2, '0')
}

/** "2026-11-24 14.03": a moment for a file name (no colons, which some systems refuse), in local time. */
export function fileMoment(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
}

export type NameParts = {
  branch: string
  /** The moment a History preview shows: its time, or null for the very start. Undefined for the Board as it is now. */
  at?: number | null
  visibleOnly: boolean
  extension: 'svg' | 'png'
}

/** "Board of main.svg", "Board of main at 2026-11-24 14.03.png", "Board of exp-A, visible area.svg". */
export function boardFileName({ branch, at, visibleOnly, extension }: NameParts): string {
  let base = `Board of ${branch}`
  if (at !== undefined) base += at === null ? ' at the start' : ` at ${fileMoment(at)}`
  if (visibleOnly) base += ', visible area'
  return fileName(base, extension)
}

/** The moment a preview shows, in words for the dialog. */
export function momentWords(at: number | null): string {
  return at === null ? 'the start of the Branch' : formatWhen(at)
}

/** Saves the SVG, with one quiet line saying where it went (exportFile). */
export function saveSvg(name: string, svg: string): Promise<Saved | 'failed'> {
  return exportFile(name, svg, 'image/svg+xml')
}

/** Hands `blob` to the browser as a download. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Some browsers start reading the file only after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * What became of a PNG: written where the person chose through the app's binary save (M18), not written (they
 * cancelled), downloaded by the browser, or offered to an older desktop app's webview as a download.
 */
export type PngSaved = 'saved' | 'cancelled' | 'downloaded' | 'offered' | 'failed'

/** Whether the desktop app can write bytes through its own save dialog (M18's `saveBinaryFile`). */
export function canSaveBinary(): boolean {
  return desktopSaveBinaryFile() !== null
}

/** Saves the PNG: through the app's save dialog when it can write bytes, else as a download (see the top of this file), and says so. */
export async function savePng(name: string, blob: Blob): Promise<PngSaved> {
  const save = desktopSaveBinaryFile()
  if (save) {
    try {
      const ok = await save({ suggestedName: name, bytes: new Uint8Array(await blob.arrayBuffer()) })
      if (ok) toasts.show({ message: `Exported “${name}”.` })
      return ok ? 'saved' : 'cancelled'
    } catch (e) {
      const why = e instanceof Error && e.message ? ` ${e.message}` : ''
      toasts.show({ message: `“${name}” could not be written.${why} Try again, or choose another folder.` }, 10_000)
      return 'failed'
    }
  }
  downloadBlob(name, blob)
  if (inDesktopApp()) {
    toasts.show({ message: `Offered “${name}” as a download. This version of the app may not keep it; Board as SVG… is saved where you choose.` }, 10_000)
    return 'offered'
  }
  toasts.show({ message: `Downloaded “${name}”.` })
  return 'downloaded'
}
