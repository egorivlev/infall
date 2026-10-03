import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InlineText } from './InlineText'

describe('InlineText', () => {
  // Regression: under StrictMode (development) the effect cleanup ran once on mount and left
  // the editor permanently "finished", so a typed title was silently dropped on Enter.
  it('commits what was typed when Enter is pressed, also under StrictMode', async () => {
    const onCommit = vi.fn()
    const onDone = vi.fn()
    render(
      <StrictMode>
        <InlineText initial="" confirm="enter" label="Card title" onCommit={onCommit} onDone={onDone} />
      </StrictMode>,
    )
    await userEvent.type(screen.getByLabelText('Card title'), 'Surface codes{Enter}')
    expect(onCommit).toHaveBeenCalledWith('Surface codes')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('does not commit on Escape', async () => {
    const onCommit = vi.fn()
    const onDone = vi.fn()
    render(<InlineText initial="A" confirm="enter" label="Card title" onCommit={onCommit} onDone={onDone} />)
    await userEvent.type(screen.getByLabelText('Card title'), 'B{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
