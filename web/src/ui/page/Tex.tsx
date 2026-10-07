import 'katex/dist/katex.min.css'
import katex from 'katex'
import { memo, useMemo } from 'react'

type Props = { tex: string; display?: boolean }

/**
 * One formula. This is the only place in the Page that hands a string of HTML to the DOM, and the
 * string is KaTeX's own output: `trust: false` keeps \href, \url, \includegraphics and \html* out,
 * and KaTeX escapes everything else it copies from the source.
 */
export const Tex = memo(function Tex({ tex, display = false }: Props) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
        maxExpand: 500,
        maxSize: 30,
      })
    } catch {
      return null
    }
  }, [tex, display])

  const className = display ? 'qp-math qp-math--display' : 'qp-math'
  if (html === null) {
    return <code className={`${className} qp-math--raw`}>{display ? `$$${tex}$$` : `$${tex}$`}</code>
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
})
