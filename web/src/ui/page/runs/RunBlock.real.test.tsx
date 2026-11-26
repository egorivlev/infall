// A Run block against the real sync layer (nothing mocked). Nobody is signed in here, so the Runner's
// status is still unknown: the code and the captured output are read, and nothing can be pressed.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RunBlock } from './RunBlock'
import type { BlockVM, RunResult } from '../../../lib'

afterEach(cleanup)

const handlers = { edit: vi.fn(), finish: vi.fn(), finishVisual: vi.fn(), move: vi.fn(), remove: vi.fn() }
const result: RunResult = { v: 1, by: 'm1', at: Date.UTC(2026, 10, 12, 14, 2), code_sha256: '0'.repeat(64), exit: 0, duration_ms: 3000, output: 'hello from Infall\n', figures: [] }
const block: BlockVM = { id: 'r1', card: 'a', type: 'run', text: 'print("hello from Infall")\n', title: 'experiment.py', order: 'a', run: { result, broken: false } }

it('renders with the real useRuns / useRunStale: the output, a Run button at rest, and in time "code changed since"', async () => {
  render(<RunBlock block={block} index={0} last editing={false} canEdit={false} readOnly={false} branchId="main" handlers={handlers} />)
  expect(screen.getByRole('group', { name: 'Run experiment.py' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
  expect(screen.getByRole('group', { name: 'Output of Run experiment.py' })).toHaveTextContent('hello from Infall')
  // The recorded hash is not this code's: once the hash is known the record line says so.
  expect(await screen.findByText('· code changed since')).toBeInTheDocument()
})
