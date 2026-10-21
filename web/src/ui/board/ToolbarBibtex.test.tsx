import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toolbar } from './Toolbar'

afterEach(cleanup)

const menu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'BibTeX: import or export the Sources on this Branch' }))
  return within(screen.getByRole('menu'))
}

describe('Toolbar: BibTeX (M13)', () => {
  it('offers Import and Export to Members, beside the add toolbar', () => {
    const onImport = vi.fn()
    const onExport = vi.fn()
    render(<Toolbar readOnly={false} onAddCard={vi.fn()} onAddFrame={vi.fn()} onImportBibtex={onImport} onExportBibtex={onExport} />)
    expect(screen.getByRole('toolbar', { name: 'Add to the Board' })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Sources on this Branch' })).toBeInTheDocument()
    const m = menu()
    expect(m.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Import BibTeX…', 'Export BibTeX'])
    fireEvent.click(m.getByRole('menuitem', { name: 'Import BibTeX…' }))
    expect(onImport).toHaveBeenCalledOnce()
    // The menu closes and focus is back on its button.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: /^BibTeX/ })).toHaveFocus()
  })

  it('opens from the keyboard and moves with the arrows', () => {
    render(<Toolbar readOnly={false} onAddCard={vi.fn()} onAddFrame={vi.fn()} onImportBibtex={vi.fn()} onExportBibtex={vi.fn()} />)
    const m = menu()
    const items = m.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('gives a Guest (read-only) Export only, and no add toolbar', () => {
    const onExport = vi.fn()
    render(<Toolbar readOnly onAddCard={vi.fn()} onAddFrame={vi.fn()} onImportBibtex={vi.fn()} onExportBibtex={onExport} />)
    expect(screen.queryByRole('toolbar', { name: 'Add to the Board' })).toBeNull()
    const m = menu()
    expect(m.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Export BibTeX'])
    fireEvent.click(m.getByRole('menuitem'))
    expect(onExport).toHaveBeenCalledOnce()
  })
})
