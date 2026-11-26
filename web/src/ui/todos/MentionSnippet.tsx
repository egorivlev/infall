// The first line of the Comment behind a mention, as the server gives it (plain text, already cut short), for a For
// you row and the short notice. Shown as a text node only. A deleted Comment says so; a server before 1.0 gives none.
export function MentionSnippet({ snippet, className }: { snippet: string | null | undefined; className: string }) {
  if (snippet === undefined || snippet === '') return null
  if (snippet === null) return <span className={`${className} is-gone`}>That Comment was deleted.</span>
  return <span className={className}>“{snippet}”</span>
}
