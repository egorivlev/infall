import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const submit = vi.fn<(ops: unknown[]) => Promise<void>>()
vi.mock('../../lib', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib')>()
  return { ...real, board: { open: vi.fn(), close: vi.fn(), submit: (ops: unknown[]) => submit(ops) } }
})

const { ApiError, ops } = await import('../../lib')
const { FAILURE_MESSAGE, describeRemoval, useBoardActions } = await import('./useBoardActions')
const { Toast } = await import('./Toast')
const { toasts } = await import('./toastStore')

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  submit.mockReset()
  submit.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  act(() => toasts.clear())
})

describe('useBoardActions', () => {
  it('deletes with one batch of removes and offers Undo, which restores the same items', async () => {
    render(<Toast />)
    const { result } = renderHook(() => useBoardActions())
    act(() =>
      result.current.removeWithUndo([
        { id: 'c1', kind: 'Card' },
        { id: 'k1', kind: 'Connection' },
      ]),
    )
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith([ops.remove('c1'), ops.remove('k1')])
    await flush()

    const toast = screen.getByTestId('toast')
    expect(toast).toHaveTextContent('Deleted 1 Card and 1 Connection.')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith([ops.restore('c1'), ops.restore('k1')])
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('removes the Undo offer after 6 seconds', async () => {
    vi.useFakeTimers()
    try {
      render(<Toast />)
      const { result } = renderHook(() => useBoardActions())
      act(() => result.current.removeWithUndo([{ id: 'f1', kind: 'Frame' }]))
      expect(screen.getByTestId('toast')).toHaveTextContent('Deleted 1 Frame.')
      act(() => vi.advanceTimersByTime(5999))
      expect(screen.getByTestId('toast')).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.queryByTestId('toast')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('raises the failure toast, with the server message as its title, when a submit is rejected', async () => {
    submit.mockRejectedValueOnce(new ApiError(409, 'rejected', 'Card c9 does not exist', null))
    render(<Toast />)
    const { result } = renderHook(() => useBoardActions())
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.submit([ops.setStatus('c9', 'reading')])
    })
    expect(ok).toBe(false)
    const toast = screen.getByTestId('toast')
    expect(toast).toHaveTextContent(FAILURE_MESSAGE)
    expect(toast).toHaveAttribute('title', 'Card c9 does not exist')
  })

  it('splits a batch larger than the sync limit', async () => {
    const { result } = renderHook(() => useBoardActions())
    const many = Array.from({ length: 150 }, (_, i) => ops.move(`c${i}`, i, i)).flat()
    await act(async () => {
      await result.current.submit(many)
    })
    expect(submit.mock.calls.map((c) => c[0].length)).toEqual([200, 100])
  })

  it('describes mixed removals in plain words', () => {
    expect(
      describeRemoval([
        { id: 'a', kind: 'Card' },
        { id: 'b', kind: 'Card' },
        { id: 'c', kind: 'Frame' },
        { id: 'd', kind: 'Connection' },
      ]),
    ).toBe('Deleted 2 Cards, 1 Frame and 1 Connection.')
  })
})
