import { describe, expect, it } from 'vitest'
import type { BlockVM, RunResult } from '../../../lib'
import { fenced, pageMarkdown, plain, sourceLine } from './markdown'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const AT = new Date(2026, 10, 12, 14, 2).getTime()
const names: Record<string, string> = { mei: 'Mei Tanaka', ana: 'Ana Ruiz' }
const nameOf = (id: string) => names[id] ?? 'a former Member'

const text = (id: string, t: string, extra: Partial<BlockVM> = {}): BlockVM => ({ id, card: 'c', type: 'text', text: t, title: '', order: id, ...extra })
const result = (extra: Partial<RunResult> = {}): RunResult => ({
  v: 1,
  by: 'mei',
  at: AT,
  code_sha256: 'a'.repeat(64),
  exit: 0,
  duration_ms: 3000,
  output: 'episode 500  reward 176.4\n',
  figures: [],
  ...extra,
})

describe('pageMarkdown', () => {
  it('tags the fence of a Run with its language id (M19b), python when it names none', () => {
    const runOf = (id: string, lang?: string): BlockVM => ({
      id,
      card: 'c',
      type: 'run',
      text: 'x = 1\n',
      title: `r${id}`,
      order: id,
      run: { result: null, broken: false, ...(lang ? { lang } : {}) },
    })
    const md = pageMarkdown({ title: 'T', summary: '', blocks: [runOf('1'), runOf('2', 'julia'), runOf('3', 'qsharp'), runOf('4', 'Not An Id')], sources: [], nameOf })
    expect(md).toContain('```python\nx = 1\n```')
    expect(md).toContain('```julia\nx = 1\n```')
    expect(md).toContain('```qsharp\nx = 1\n```')
    expect(md).toContain('**Run: r4**\n\n```\nx = 1\n```')
  })
  it('writes every kind of block, in order, with the Sources at the end', () => {
    const md = pageMarkdown({
      title: 'QRL on CartPole',
      summary: 'Does a quantum policy learn CartPole?',
      blocks: [
        text('1', '## Method\n\nWe use $\\beta$ in the softmax:\n\n$$\n\\pi(a|s) = \\frac{e^{\\beta x}}{Z}\n$$'),
        { id: '2', card: 'c', type: 'visual', text: '<canvas></canvas>', title: 'Bloch sphere', order: '2' },
        { id: '3', card: 'c', type: 'run', text: 'print("hi")\n', title: 'experiment.py', order: '3', run: { result: result(), broken: false } },
        { id: '4', card: 'c', type: 'run', text: 'x = 1', title: '', order: '4', run: { result: null, broken: false } },
        text('5', 'The policy looks **stable**.', { ai: { model: 'claude-opus', pinnedBy: 'ana', pinnedAt: AT } }),
        text('6', '', {}),
      ],
      sources: [
        { title: 'Parametrized quantum policies', authors: 'Sofiene Jerbi, Vedran Dunjko', year: '2021', doi: '', url: 'https://arxiv.org/abs/2103.05577', note: '' },
        { title: 'Scheme for reducing decoherence', authors: 'Peter W. Shor', year: '1995', doi: '10.1103/PhysRevA.52.R2493', url: '', note: 'the first code' },
      ],
      nameOf,
    })
    expect(md).toBe(`# QRL on CartPole

Does a quantum policy learn CartPole?

## Method

We use $\\beta$ in the softmax:

$$
\\pi(a|s) = \\frac{e^{\\beta x}}{Z}
$$

*Visual: Bloch sphere. It is interactive — open this Page in Infall to use it.*

**Run: experiment.py**

\`\`\`python
print("hi")
\`\`\`

*Output — Last run by Mei Tanaka, 12 Nov 2026, 14:02:*

\`\`\`text
episode 500  reward 176.4
\`\`\`

**Run: Run**

\`\`\`python
x = 1
\`\`\`

*Not executed yet.*

> **AI-generated** · claude-opus · pinned by Ana Ruiz, 12 Nov 2026 · not reviewed by a Member
>
> The policy looks **stable**.

## Sources

1. Sofiene Jerbi, Vedran Dunjko (2021). *Parametrized quantum policies*. [arXiv:2103.05577](https://arxiv.org/abs/2103.05577)
2. Peter W. Shor (1995). *Scheme for reducing decoherence*. [doi:10.1103/PhysRevA.52.R2493](https://doi.org/10.1103/PhysRevA.52.R2493) — the first code
`)
  })

  it('writes a Run’s figures, a stopped or failed end, a cut output and a broken result', () => {
    const run = (r: RunResult | null, broken = false): BlockVM => ({ id: 'r', card: 'c', type: 'run', text: 'x', title: 'plot.py', order: '1', run: { result: r, broken } })
    const md = (b: BlockVM) => pageMarkdown({ title: 'T', summary: '', blocks: [b], sources: [], nameOf })
    const withFigure = md(run(result({ output: '', figures: [{ png: PNG }, { png: 'not base64!' }] })))
    expect(withFigure).toContain(`![Figure 1 of Run plot.py](data:image/png;base64,${PNG})`)
    expect(withFigure).not.toContain('Figure 2')
    expect(md(run(result({ exit: 3 })))).toContain('14:02 · exit 3:*')
    expect(md(run(result({ exit: null, stopped: true })))).toContain('· stopped:*')
    expect(md(run(result({ output_truncated: true })))).toContain('*Part of the output was left out.*')
    expect(md(run(result({ output: '' })))).toContain('*The Run printed nothing.*')
    expect(md(run(null, true))).toContain('*This result cannot be shown.*')
    expect(md(run(result({ by: 'gone' })))).toContain('Last run by a former Member')
  })

  it('marks reviewed pinned text, and pins without text', () => {
    const ai = { model: '', pinnedBy: 'ana', pinnedAt: AT, reviewedBy: 'mei' }
    const md = pageMarkdown({ title: 'T', summary: '', blocks: [text('1', 'Line one\n\nLine two', { ai })], sources: [], nameOf })
    expect(md).toContain('> **AI-generated** · unknown model · pinned by Ana Ruiz, 12 Nov 2026 · reviewed by Mei Tanaka\n>\n> Line one\n>\n> Line two')
  })

  it('writes an empty Page as its title only', () => {
    expect(pageMarkdown({ title: '', summary: '  ', blocks: [], sources: [], nameOf })).toBe('# Untitled\n')
  })

  it('keeps a title that looks like markup plain', () => {
    expect(pageMarkdown({ title: '*Not* a [link] #1', summary: '', blocks: [], sources: [], nameOf })).toBe('# \\*Not\\* a \\[link\\] \\#1\n')
    expect(plain('a_b $x$')).toBe('a\\_b \\$x\\$')
  })
})

describe('fenced', () => {
  it('uses a fence longer than any backticks inside', () => {
    expect(fenced('a ``` b', 'text')).toBe('````text\na ``` b\n````')
    expect(fenced('plain\n')).toBe('```\nplain\n```')
  })
})

describe('sourceLine', () => {
  it('writes what is known and the address as its host', () => {
    expect(sourceLine({ title: '', authors: '', year: '', doi: '', url: 'https://www.nature.com/articles/x', note: '' })).toBe(
      '*Untitled Source*. [nature.com](https://www.nature.com/articles/x)',
    )
    expect(sourceLine({ title: 'T', authors: '', year: '2020', doi: '', url: '', note: '' })).toBe('(2020). *T*.')
  })
})
