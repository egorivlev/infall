import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBlocks, renderInline, renderMarkdown, safeHref } from './markdown'

afterEach(cleanup)

/** Renders a Block's text and hands back its container. */
function md(text: string): HTMLElement {
  return render(<div>{renderMarkdown(text)}</div>).container.firstElementChild as HTMLElement
}
const html = (text: string) => md(text).innerHTML
const inlineHtml = (text: string) => (render(<p>{renderInline(text)}</p>).container.firstElementChild as HTMLElement).innerHTML

describe('blocks', () => {
  it('renders paragraphs separated by blank lines; a single line break is just a space', () => {
    const el = md('First line\nsame paragraph\n\nSecond paragraph')
    const ps = el.querySelectorAll('p')
    expect(ps).toHaveLength(2)
    expect(ps[0]).toHaveTextContent('First line same paragraph')
    expect(ps[1]).toHaveTextContent('Second paragraph')
  })

  it('renders #, ## and ### one level below the Page title', () => {
    const el = md('# One\n## Two\n### Three')
    expect(el.querySelector('h2')).toHaveTextContent('One')
    expect(el.querySelector('h3')).toHaveTextContent('Two')
    expect(el.querySelector('h4')).toHaveTextContent('Three')
    expect(el.querySelector('h1')).toBeNull()
  })

  it('leaves #### and a # without a space as plain text', () => {
    expect(md('#### Four').querySelector('p')).toHaveTextContent('#### Four')
    expect(md('#hashtag').querySelector('p')).toHaveTextContent('#hashtag')
    expect(md('#### Four').querySelector('h2, h3, h4, h5')).toBeNull()
  })

  it('renders "-" lists and "1." lists, with continuation lines', () => {
    const el = md('- one\n- two\n  still two\n- three\n\n3. c\n4. d')
    const ul = el.querySelector('ul')!
    expect(ul.querySelectorAll('li')).toHaveLength(3)
    expect(ul.querySelectorAll('li')[1]).toHaveTextContent('two still two')
    const ol = el.querySelector('ol')!
    expect(ol.querySelectorAll('li')).toHaveLength(2)
    expect(ol).toHaveAttribute('start', '3')
  })

  it('does not treat "*" or "+" bullets, "-5", "---" or "1)" as lists', () => {
    for (const text of ['* star', '+ plus', '-5 dB', '---', '1) one']) {
      const el = md(text)
      expect(el.querySelector('ul, ol, hr'), text).toBeNull()
      expect(el.querySelector('p'), text).toHaveTextContent(text)
    }
  })

  it('renders "> " quotes, with their own paragraphs and inline marks', () => {
    const el = md('> quoted **text**\n> more\n>\n> second\nafter')
    const q = el.querySelector('blockquote')!
    expect(q.querySelectorAll('p')).toHaveLength(2)
    expect(q.querySelector('strong')).toHaveTextContent('text')
    expect(el.querySelector(':scope > p')).toHaveTextContent('after')
  })

  it('renders fenced code verbatim: no Markdown, no math, no HTML inside', () => {
    const el = md('```python\nx = a*b*c  # $5\n<b>not bold</b>\n```\nafter')
    const pre = el.querySelector('pre')!
    expect(pre).toHaveAttribute('data-lang', 'python')
    expect(pre.querySelector('code')!.textContent).toBe('x = a*b*c  # $5\n<b>not bold</b>')
    expect(pre.querySelector('em, b, .katex')).toBeNull()
    expect(el.querySelector(':scope > p')).toHaveTextContent('after')
  })

  it('an unclosed fence runs to the end instead of swallowing nothing or throwing', () => {
    const el = md('before\n```\ncode\nmore')
    expect(el.querySelector('p')).toHaveTextContent('before')
    expect(el.querySelector('pre code')!.textContent).toBe('code\nmore')
  })

  it('renders display math written on its own lines, and on one line', () => {
    const el = md('Text\n$$\n\\frac{a}{b}\n$$\nmore\n\n$$E = mc^2$$')
    const display = el.querySelectorAll('.qp-math--display')
    expect(display).toHaveLength(2)
    expect(display[0]!.querySelector('.katex-display')).not.toBeNull()
    expect(display[0]!.querySelector('annotation')!.textContent).toBe('\\frac{a}{b}')
    expect(display[1]!.querySelector('annotation')!.textContent).toBe('E = mc^2')
    expect(el.querySelectorAll(':scope > p')).toHaveLength(2)
  })

  it('shows an unclosed or empty $$ as plain text', () => {
    expect(md('$$\nx + y').querySelector('.katex')).toBeNull()
    expect(md('$$\nx + y')).toHaveTextContent('$$ x + y')
    expect(md('$$\n$$').querySelector('.katex')).toBeNull()
    expect(md('$$$$')).toHaveTextContent('$$$$')
  })

  it('handles Windows line endings and empty text', () => {
    expect(md('a\r\n\r\nb').querySelectorAll('p')).toHaveLength(2)
    expect(parseBlocks('')).toEqual([])
    expect(parseBlocks('  \n\n \t ')).toEqual([])
  })

  it('parseBlocks reports the structure', () => {
    expect(parseBlocks('# T\ntext\n- a\n1. b\n> q\n```\nc\n```')).toEqual([
      { type: 'heading', level: 1, text: 'T' },
      { type: 'paragraph', text: 'text' },
      { type: 'list', ordered: false, start: 1, items: ['a'] },
      { type: 'list', ordered: true, start: 1, items: ['b'] },
      { type: 'quote', text: 'q' },
      { type: 'code', lang: '', text: 'c' },
    ])
  })

  it('only "1." may interrupt a paragraph, so a year at a line start stays text', () => {
    expect(parseBlocks('It was published in\n1995. A good year.')).toEqual([
      { type: 'paragraph', text: 'It was published in\n1995. A good year.' },
    ])
  })
})

describe('inline', () => {
  it('renders bold, italic and code', () => {
    expect(inlineHtml('a **b** *c* `d`')).toBe('a <strong>b</strong> <em>c</em> <code>d</code>')
  })

  it('nests emphasis both ways', () => {
    expect(inlineHtml('**bold *both* bold**')).toBe('<strong>bold <em>both</em> bold</strong>')
    expect(inlineHtml('*it **both** it*')).toBe('<em>it <strong>both</strong> it</em>')
    expect(inlineHtml('***all***')).toBe('<strong><em>all</em></strong>')
  })

  it('leaves unbalanced markers as the characters that were typed', () => {
    expect(inlineHtml('**never closed')).toBe('**never closed')
    expect(inlineHtml('*never closed')).toBe('*never closed')
    expect(inlineHtml('closed never**')).toBe('closed never**')
    expect(inlineHtml('a * b * c')).toBe('a * b * c')
    expect(inlineHtml('`open code')).toBe('`open code')
    expect(inlineHtml('**a* b')).toBe('**a* b')
    expect(inlineHtml('[text](https://example.org')).toBe('[text](https://example.org')
    expect(inlineHtml('[text] (https://example.org)')).toBe('[text] (https://example.org)')
    expect(inlineHtml('2 * 3 = 6 and 4 * 5 = 20')).toBe('2 * 3 = 6 and 4 * 5 = 20')
  })

  it('does not use underscores for emphasis (x_i stays x_i)', () => {
    expect(inlineHtml('x_i and y_j, __init__')).toBe('x_i and y_j, __init__')
  })

  it('keeps code literal', () => {
    expect(inlineHtml('`a*b*c $x$ [t](https://e.org)`')).toBe('<code>a*b*c $x$ [t](https://e.org)</code>')
  })

  it('does not end emphasis inside code or math', () => {
    const el = render(<p>{renderInline('*the product $a*b$ is `x*y`*')}</p>).container
    expect(el.querySelectorAll('em')).toHaveLength(1)
    expect(el.querySelector('em .katex annotation')!.textContent).toBe('a*b')
    expect(el.querySelector('em code')!.textContent).toBe('x*y')
  })

  it('backslash escapes the markers', () => {
    expect(inlineHtml('\\*not italic\\* and \\$5 and \\`tick\\` and \\[x\\](y)')).toBe('*not italic* and $5 and `tick` and [x](y)')
    expect(inlineHtml('a \\ b \\n')).toBe('a \\ b \\n')
  })

  it('renders inline math with KaTeX', () => {
    const el = render(<p>{renderInline('Energy $E = mc^2$ here')}</p>).container
    expect(el.querySelectorAll('.katex')).toHaveLength(1)
    expect(el.querySelector('.katex-display')).toBeNull()
    expect(el.querySelector('annotation')!.textContent).toBe('E = mc^2')
    expect(el.textContent).toContain('Energy ')
    expect(el.textContent).toContain(' here')
  })

  it('keeps backslashes and escaped dollars inside math for TeX', () => {
    const el = render(<p>{renderInline('$\\alpha + \\$1$')}</p>).container
    expect(el.querySelector('annotation')!.textContent).toBe('\\alpha + \\$1')
  })

  it('does not take currency for math', () => {
    for (const text of [
      'It costs $5',
      'It costs $5 and then $10 more',
      'Between $5 and $10, or $ 20',
      'from $5-$10 per unit',
      'a lone $ sign',
      'costs 5$ and 10$',
      '$ x $',
    ]) {
      const el = render(<p>{renderInline(text)}</p>).container
      expect(el.querySelector('.katex'), text).toBeNull()
      expect(el.textContent, text).toBe(text)
      cleanup()
    }
  })

  it('still finds math after a price', () => {
    const el = render(<p>{renderInline('It costs $5 but $x^2$ is free')}</p>).container
    expect(el.querySelectorAll('.katex')).toHaveLength(1)
    expect(el.querySelector('annotation')!.textContent).toBe('x^2')
    expect(el.textContent).toContain('It costs $5 but ')
  })

  it('a bad formula is shown by KaTeX as an error, never thrown', () => {
    expect(() => md('$\\frac{$ and $\\notacommand{x}$ and $$\\begin{matrix}$$')).not.toThrow()
    expect(md('$\\notacommand$').querySelector('.katex-error, .katex')).not.toBeNull()
  })

  it('renders http and https links, opened safely in a new tab', () => {
    const a = md('See [the *paper*](https://arxiv.org/abs/2103.05577) and [wiki](http://en.wikipedia.org/wiki/Toric_code_(physics)).').querySelectorAll('a')
    expect(a).toHaveLength(2)
    expect(a[0]).toHaveAttribute('href', 'https://arxiv.org/abs/2103.05577')
    expect(a[0]).toHaveAttribute('target', '_blank')
    expect(a[0]).toHaveAttribute('rel', 'noreferrer noopener')
    expect(a[0]!.querySelector('em')).toHaveTextContent('paper')
    expect(a[1]).toHaveAttribute('href', 'http://en.wikipedia.org/wiki/Toric_code_(physics)')
  })

  it('does not link a bare address or <address>', () => {
    expect(md('https://example.org and <https://example.org>').querySelector('a')).toBeNull()
  })
})

describe('hostile input', () => {
  it('never turns typed HTML into elements', () => {
    const text = [
      '<script>window.pwned = 1</script>',
      '<img src=x onerror="window.pwned = 1">',
      '<b>bold?</b> <iframe src="https://evil.example"></iframe>',
      '- <svg onload=alert(1)>',
      '> <a href="javascript:alert(1)">x</a>',
      '# <h1 onclick=alert(1)>T</h1>',
      '**<u>u</u>** *<i>i</i>* `<code>` &lt;b&gt; &amp;',
      '<!-- comment --> <style>* { display: none }</style>',
    ].join('\n\n')
    const el = md(text)
    expect(el.querySelector('script, img, iframe, svg, a, u, i, style, b, h1')).toBeNull()
    for (const tag of el.querySelectorAll('*')) {
      expect(['P', 'UL', 'LI', 'BLOCKQUOTE', 'H2', 'STRONG', 'EM', 'CODE']).toContain(tag.tagName)
      expect([...tag.attributes].map((a) => a.name).filter((n) => n !== 'class')).toEqual([])
    }
    expect(el.textContent).toContain('<script>window.pwned = 1</script>')
    expect(el.textContent).toContain('&lt;b&gt; &amp;') // entities are not decoded either
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
  })

  it('refuses every link that is not http or https, and shows it as text', () => {
    const bad = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.org/x',
      'mailto:a@b.c',
      '//evil.example/x',
      '/relative',
      '#fragment',
      'https:evil.example',
      'https://',
      'http:///x',
      'example.org',
    ]
    for (const url of bad) {
      expect(safeHref(url), url).toBeNull()
      const el = md(`[click](${url})`)
      expect(el.querySelector('a'), url).toBeNull()
      expect(el.textContent, url).toContain('[click](')
      cleanup()
    }
    expect(safeHref('https://example.org/a?b=c#d')).toBe('https://example.org/a?b=c#d')
    expect(safeHref('HTTP://Example.org')).toBe('http://example.org/')
    expect(safeHref(`https://example.org/${'a'.repeat(3000)}`)).toBeNull()
  })

  it('cannot break out of the href or add attributes through the address or the text', () => {
    const el = md('[x" onmouseover="alert(1)](https://example.org/"onclick="alert(1))')
    const a = el.querySelector('a')!
    expect([...a.attributes].map((x) => x.name).sort()).toEqual(['href', 'rel', 'target'])
    expect(a.getAttribute('href')).toBe('https://example.org/%22onclick=%22alert(1)')
    expect(a.textContent).toBe('x" onmouseover="alert(1)')
  })

  it('math cannot smuggle links, HTML or scripts: KaTeX runs untrusted', () => {
    const el = md(
      [
        '$\\href{javascript:alert(1)}{click}$',
        '$\\url{javascript:alert(1)}$',
        '$\\htmlData{onclick=alert(1)}{x}$ $\\htmlClass{evil}{x}$ $\\htmlStyle{position:fixed}{x}$',
        '$\\includegraphics{https://evil.example/x.png}$',
        '$<script>alert(1)</script>$',
        '$$</span><img src=x onerror=alert(1)>$$',
      ].join('\n\n'),
    )
    expect(el.querySelector('a, script, img, [onclick], [data-onclick], .evil, [href]')).toBeNull()
    for (const node of el.querySelectorAll('[style]')) expect(node.getAttribute('style')).not.toContain('fixed')
  })

  it('a macro bomb in math is stopped by KaTeX, not by the browser tab', () => {
    const started = performance.now()
    expect(() => md('$\\def\\a{\\a\\a}\\a$ and $\\edef\\x{x}\\x$')).not.toThrow()
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('handles very long lines in linear time', () => {
    const cases = [
      'word '.repeat(40_000),
      '*a '.repeat(20_000),
      '**a '.repeat(20_000),
      '*'.repeat(50_000),
      '`'.repeat(50_001),
      '$'.repeat(50_001),
      '$a '.repeat(20_000),
      '['.repeat(50_000),
      '[a]('.repeat(20_000),
      `[a](${'('.repeat(50_000)}`,
      '\\'.repeat(50_001),
      '*a `b '.repeat(10_000),
      `${'*a '.repeat(5_000)}${'a* '.repeat(5_000)}`,
      `${'**a '.repeat(5_000)}${'a** '.repeat(5_000)}`,
      '<'.repeat(50_000),
    ]
    for (const text of cases) {
      const started = performance.now()
      const nodes = renderMarkdown(text)
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(1500)
      expect(nodes.length).toBeGreaterThan(0)
    }
  })

  it('handles very many lines and deep quotes without recursion trouble', () => {
    const started = performance.now()
    expect(() => renderMarkdown('>'.repeat(20_000) + ' deep')).not.toThrow()
    expect(() => renderMarkdown('- item\n'.repeat(20_000))).not.toThrow()
    expect(() => renderMarkdown('$$\n'.repeat(20_001))).not.toThrow()
    expect(() => renderMarkdown('> a\n\n'.repeat(10_000))).not.toThrow()
    expect(() => renderMarkdown('```\n'.repeat(20_001))).not.toThrow()
    expect(performance.now() - started).toBeLessThan(4000)
  })

  it('deeply nested emphasis stops nesting instead of overflowing the stack', () => {
    const text = `${'*a '.repeat(200)}x${' a*'.repeat(200)}`
    const el = render(<p>{renderInline(text)}</p>).container
    expect(el.querySelectorAll('em').length).toBeLessThanOrEqual(6)
    expect(el.textContent!.replace(/\*/g, '')).toBe(text.replace(/\*/g, ''))
  })

  it('keeps odd characters as text', () => {
    const text = 'null \u0000 rtl \u202e override, emoji 🧪, zero-width \u200b, tab\there'
    expect(md(text).textContent).toBe(text.replace('\t', '\t'))
    expect(html('a & b < c > d "e"')).toBe('<p>a &amp; b &lt; c &gt; d "e"</p>')
  })
})
