// Getting text out as a file: the desktop app's save dialog when it has one (Contract D), else the browser's
// download. And reading a file a person picked, for the importers.
import { desktopSaveFile } from '../bridge'

/** What became of a file: written where the person chose, not written (they cancelled), or handed to the browser. */
export type Saved = 'saved' | 'cancelled' | 'downloaded'

/** The desktop app writes at most this much through its dialog (Contract D); anything larger is downloaded. */
export const DESKTOP_LIMIT = 20 * 1024 * 1024

/** A name that every file system takes: no path separators or reserved characters, not empty, not too long. */
export function fileName(base: string, extension: string): string {
  const clean = [...base]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return `${clean || 'Untitled'}.${extension}`
}

function utf8Length(text: string): number {
  return new Blob([text]).size
}

function download(suggestedName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Some browsers start reading the file only after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Saves `text` under `suggestedName`. Rejects only when the desktop app could not write the file. */
export async function saveTextFile(suggestedName: string, text: string, type: string): Promise<Saved> {
  const save = desktopSaveFile()
  if (save && utf8Length(text) <= DESKTOP_LIMIT) return (await save({ suggestedName, text })) ? 'saved' : 'cancelled'
  download(suggestedName, text, type)
  return 'downloaded'
}

/** The text of a picked file, as UTF-8. Uses FileReader where `Blob.text` is missing (older webviews). */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'))
    reader.readAsText(file, 'utf-8')
  })
}
