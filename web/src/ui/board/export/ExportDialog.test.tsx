import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardVM } from '../../../lib'
import { StatusGlyph } from '../StatusGlyph'
import { Toolbar } from '../Toolbar'
import { GLYPH } from './look'
import { ExportDialog } from './ExportDialog'
import type { BoardContent } from './svg'

const g = globalThis as { infallDesktop?: unknown }

afterEach(() => {
  cleanup()
  delete g.infallDesktop
  vi.restoreAllMocks()
})

const card = (id: string, x: number): CardVM => ({ id, title: `Card ${id}`, summary: '', status: 'idea', x, y: 0, w: 220, h: 110, blocks: 0, sources: 0 })
const content: BoardContent = { cards: [card('a', 0), card('b', 400)], frames: [], connections: [{ id: 'k', from: 'a', to: 'b', label: '', kind: 'related' }] }

describe('ExportDialog', () => {
  it('offers the options, says the size and the file, and closes on Escape', () => {
    const onClose = vi.fn()
    render(<ExportDialog format="png" content={content} branch="main" visibleArea={{ x: 0, y: 0, w: 300, h: 200 }} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Export the Board as PNG' })
    expect(dialog).toHaveAccessibleDescription('The whole Board of main, as it is now: 2 Cards, 0 Frames, 1 Connection.')
    expect(screen.getByRole('checkbox', { name: /Visible area only/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Light background/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: '2×' })).toBeChecked()
    // 620 + 2 × 32 by 110 + 2 × 32, at 2×.
    expect(screen.getByText('1 368 × 348 px')).toBeInTheDocument()
    expect(screen.getByText('Board of main.png')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export PNG' })).toHaveFocus()
    fireEvent.click(screen.getByRole('checkbox', { name: /Visible area only/ }))
    expect(screen.getByText('Board of main, visible area.png')).toBeInTheDocument()
    expect(screen.getByText('600 × 400 px')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    // Put the remembered choice back for the next test.
    cleanup()
    render(<ExportDialog format="svg" content={content} branch="main" visibleArea={{ x: 0, y: 0, w: 300, h: 200 }} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Visible area only/ }))
  })

  it('names the moment of a History preview', () => {
    const at = new Date(2026, 10, 24, 14, 3).getTime()
    render(<ExportDialog format="svg" content={content} branch="main" at={at} visibleArea={null} onClose={vi.fn()} />)
    expect(screen.getByText('Board of main at 2026-11-24 14.03.svg')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/the moment History shows/)
    expect(screen.getByRole('checkbox', { name: /Visible area only/ })).toBeDisabled()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('makes the SVG from the Board’s data and hands it to the desktop app’s save dialog', async () => {
    const saveFile = vi.fn().mockResolvedValue(true)
    g.infallDesktop = { saveFile }
    const onClose = vi.fn()
    render(<ExportDialog format="svg" content={content} branch="main" visibleArea={null} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export SVG' }))
    await waitFor(() => expect(saveFile).toHaveBeenCalledOnce())
    expect(onClose).toHaveBeenCalledOnce()
    const { suggestedName, text } = saveFile.mock.calls[0]![0] as { suggestedName: string; text: string }
    expect(suggestedName).toBe('Board of main.svg')
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.querySelectorAll('g.card')).toHaveLength(2)
    expect(doc.querySelectorAll('g.connection')).toHaveLength(1)
  })

  it('says in the desktop app that a PNG is offered as a download', () => {
    g.infallDesktop = { saveFile: vi.fn() }
    render(<ExportDialog format="png" content={content} branch="main" visibleArea={null} onClose={vi.fn()} />)
    expect(screen.getByRole('note')).toHaveTextContent(/saves text files only/)
  })

  it('M18: says nothing about downloads when the app can save bytes', () => {
    g.infallDesktop = { saveFile: vi.fn(), saveBinaryFile: vi.fn() }
    render(<ExportDialog format="png" content={content} branch="main" visibleArea={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('Toolbar: Export (M19)', () => {
  it('is there for a Guest, whose Board is read-only', () => {
    render(<Toolbar readOnly onAddCard={vi.fn()} onAddFrame={vi.fn()} exportMenu={<button type="button">Export</button>} />)
    expect(screen.getByRole('toolbar', { name: 'Export the Board' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'Add to the Board' })).toBeNull()
  })
})

describe('the exported status glyph', () => {
  it('has the shapes of StatusGlyph', () => {
    for (const status of Object.keys(GLYPH) as Array<keyof typeof GLYPH>) {
      const { container } = render(<StatusGlyph status={status} />)
      const shapes = [...container.querySelectorAll('path, circle')].map((el) =>
        el.tagName === 'path' ? el.getAttribute('d') : `${el.getAttribute('cx')} ${el.getAttribute('cy')} ${el.getAttribute('r')}`,
      )
      expect(shapes).toEqual(GLYPH[status].map((g) => (g.tag === 'path' ? g.d : `${g.cx} ${g.cy} ${g.r}`)))
      cleanup()
    }
  })
})
