// Answers go through the Page's real Markdown renderer: no raw HTML, http/https links only, opened in a new tab.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = await vi.hoisted(async () => (await import('./testkit')).createFakeAiLib())
vi.mock('../../lib', () => fake.module())

const { AiSidebar } = await import('./AiSidebar')
const { answer, asked } = await import('./testkit')

beforeEach(() => fake.reset())
afterEach(cleanup)

describe('what an answer may put on the screen', () => {
  it('renders Markdown, and raw HTML only as text', () => {
    fake.show([asked('q'), answer('**Bold** move\n\n<img src=x onerror="alert(1)"> <script>alert(2)</script>')])
    render(<AiSidebar branch="main" />)
    const log = screen.getByRole('log')
    expect(log.querySelector('strong')?.textContent).toBe('Bold')
    expect(log.querySelector('img, script, iframe')).toBeNull()
    expect(log.textContent).toContain('<script>alert(2)</script>')
  })

  it('links: http and https only, in a new tab, without a referrer', () => {
    fake.show([asked('q'), answer('[paper](https://arxiv.org/abs/1208.0928) and [trap](javascript:alert(1)) and [data](data:text/html,x)')])
    render(<AiSidebar branch="main" />)
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://arxiv.org/abs/1208.0928'])
    expect(links[0]).toHaveAttribute('target', '_blank')
    expect(links[0]?.getAttribute('rel')).toContain('noopener')
  })

  it('a Member’s own message is plain text, never Markdown or HTML', () => {
    fake.show([asked('**not bold** <b>x</b>')])
    render(<AiSidebar branch="main" />)
    const bubble = screen.getByRole('log').querySelector('.qa-bubble')!
    expect(bubble.children.length).toBe(0)
    expect(bubble.textContent).toBe('**not bold** <b>x</b>')
  })
})
