import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUSES } from '../../lib'
import { StatusGlyph } from './StatusGlyph'

afterEach(cleanup)

describe('StatusGlyph', () => {
  it('names each status and draws a distinct shape for it', () => {
    const shapes = new Set<string>()
    for (const s of STATUSES) {
      const { unmount } = render(<StatusGlyph status={s} />)
      const names = { idea: 'Idea', reading: 'Reading', understood: 'Understood', open_question: 'Open question', dead_end: 'Dead end · kept' }
      const svg = screen.getByRole('img', { name: names[s] })
      expect(svg).toHaveAttribute('data-shape', s)
      shapes.add(svg.innerHTML)
      unmount()
    }
    expect(shapes.size).toBe(STATUSES.length)
  })

  it('draws the specified primitives', () => {
    const { container, rerender } = render(<StatusGlyph status="idea" />)
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/Z$/) // closed diamond outline
    expect(container.querySelector('circle')).toBeNull()
    rerender(<StatusGlyph status="understood" />)
    expect(container.querySelector('circle')).toHaveAttribute('fill', 'currentColor')
    rerender(<StatusGlyph status="open_question" />)
    expect(container.querySelectorAll('circle')).toHaveLength(2) // ring + the dot of the "?"
    rerender(<StatusGlyph status="dead_end" />)
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/H.*V/) // dash + bar
  })

  it('is hidden from assistive tech when a visible word accompanies it', () => {
    const { container } = render(<StatusGlyph status="reading" label={null} />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
