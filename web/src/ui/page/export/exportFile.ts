// Handing an exported file to the person, with one quiet line saying what became of it.
import { toasts } from '../../board/toastStore'
import { saveTextFile } from '../files'
import type { Saved } from '../files'

export async function exportFile(name: string, text: string, type: string): Promise<Saved | 'failed'> {
  try {
    const saved = await saveTextFile(name, text, type)
    if (saved === 'saved') toasts.show({ message: `Exported “${name}”.` })
    else if (saved === 'downloaded') toasts.show({ message: `Downloaded “${name}”.` })
    return saved
  } catch (e) {
    const why = e instanceof Error && e.message ? ` ${e.message}` : ''
    toasts.show({ message: `“${name}” could not be written.${why}`.trim() }, 10_000)
    return 'failed'
  }
}
