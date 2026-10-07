import { memo } from 'react'
import { renderMarkdown } from './markdown'

/** The rendered text of one Block. Re-renders only when the text itself changes. */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return <div className="qp-md">{renderMarkdown(text)}</div>
})
