// The `file = {…}` field of a BibTeX entry (decision 10): where the reference manager kept the entry's files. Pure.
//
// Zotero writes `Description:path:mime`, items separated by `;`, with `\`, `:` and `;` escaped by a backslash:
//   file = {Full Text PDF:files/12/Jerbi - 2021.pdf:application/pdf;Snapshot:files/13/arxiv.html:text/html}
//   file = {Full Text PDF:C\:\\Users\\ana\\Zotero\\storage\\AB12CD34\\Jerbi - 2021.pdf:application/pdf}
// JabRef writes the same shape with an empty description and a short type (`:paper.pdf:PDF`); Mendeley writes the
// backslash as `$\backslash$` (`:C$\backslash$:/Users/ana/Mendeley/Jerbi.pdf:pdf`).

export type BibFile = { description: string; path: string; mime: string }

/** Splits at `sep` where it is not escaped by a backslash; the parts keep their escapes. */
function splitEscaped(text: string, sep: string): string[] {
  const parts: string[] = []
  let at = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === sep) {
      parts.push(text.slice(at, i))
      at = i + 1
    }
  }
  parts.push(text.slice(at))
  return parts
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1')

/** A part that names a type, not a file: `application/pdf`, `PDF`, `text/html`, `URL`. */
const isType = (s: string) => /^[a-z]+\/[\w.+-]+$/i.test(s) || /^[a-z]{2,6}$/i.test(s)

export function parseFileField(raw: string): BibFile[] {
  // Mendeley's backslash, and braces BibTeX keeps around parts (`{C:}` …), which are not part of the path.
  const text = raw.replace(/\$\\backslash\$/g, '\\').replace(/(?<!\\)[{}]/g, '').trim()
  if (!text) return []
  const out: BibFile[] = []
  for (const item of splitEscaped(text, ';')) {
    if (!item.trim()) continue
    const f = splitEscaped(item, ':')
    let description = ''
    let path = ''
    let mime = ''
    if (f.length >= 3) {
      description = f[0]!
      mime = f[f.length - 1]!
      // A drive letter's colon left unescaped (`C:/Users/…`) splits the path: join it again.
      path = f.slice(1, -1).join(':')
      if (!isType(unescape(mime).trim())) {
        path = f.slice(1).join(':')
        mime = ''
      }
    } else if (f.length === 2) {
      if (isType(unescape(f[1]!).trim()) && !/\.\w{2,5}$/.test(f[1]!)) {
        path = f[0]!
        mime = f[1]!
      } else if (/^[A-Za-z]$/.test(f[0]!.trim())) path = f.join(':')
      else {
        description = f[0]!
        path = f[1]!
      }
    } else path = f[0]!
    path = unescape(path).trim()
    if (!path) continue
    out.push({ description: unescape(description).trim(), path, mime: unescape(mime).trim() })
  }
  return out
}

/** Whether a file of the field is a PDF: by its type, or by the end of its name. */
export function isPdfFile(f: BibFile): boolean {
  return /pdf/i.test(f.mime) || /\.pdf$/i.test(f.path)
}

/** The PDFs an entry's `file` field names, in order (a Snapshot or other file is left out). */
export function pdfPathsOf(raw: string | undefined): string[] {
  if (!raw) return []
  return parseFileField(raw)
    .filter(isPdfFile)
    .map((f) => f.path)
}

/**
 * The paths to try inside the folder the person picked, best first: the path as the field gives it (relative to the
 * folder — Zotero's "Export Files" — or absolute, which the app takes when it is inside the folder), then its last
 * three, two and one parts (an absolute path into Zotero's storage, with the storage folder or the item's folder
 * picked). Separators become `/`; never a path that climbs out with `..`.
 */
export function candidatePaths(path: string): string[] {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = p.split('/').filter((x) => x !== '' && x !== '.')
  if (parts.length === 0 || parts.includes('..')) return []
  const out = [p]
  for (const n of [3, 2, 1]) if (parts.length > n) out.push(parts.slice(-n).join('/'))
  if (parts.length === 1 && p !== parts[0]) out.push(parts[0]!)
  return [...new Set(out)]
}

/** The file's own name, for the report. */
export function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
}
