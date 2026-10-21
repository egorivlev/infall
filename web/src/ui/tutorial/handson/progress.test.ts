import { describe, expect, it } from 'vitest'
import { freshProgress, readProgress } from './progress'
import { STEP_IDS, STEPS } from './steps'

describe('the stored progress', () => {
  it('reads what was written', () => {
    const p = { v: 1, status: 'left', step: 'merge', results: { look: 'done', run: 'not_tried', ai: 'skipped' }, card: 'c1' }
    expect(readProgress(p)).toEqual(p)
    expect(readProgress(JSON.parse(JSON.stringify(p)))).toEqual(p) // it is plain JSON
  })

  it('reads nothing, another version or a wrong shape as never started', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { v: 2, status: 'running', step: 'look', results: {} }, { v: 1, status: 'paused', step: 'look' }, { v: 1, status: 'running', step: 'dance' }]) {
      expect(readProgress(bad)).toBeNull()
    }
  })

  it('drops unknown steps and results, and a card that is not an id', () => {
    expect(readProgress({ v: 1, status: 'running', step: 'card', results: { look: 'done', fly: 'done', card: 'won' }, card: 7, extra: 1 })).toEqual({
      v: 1,
      status: 'running',
      step: 'card',
      results: { look: 'done' },
    })
  })

  it('is small: every step ended, with a card, stays far under the server’s 16 KiB', () => {
    const results = Object.fromEntries(STEP_IDS.map((id) => [id, 'not_tried']))
    expect(JSON.stringify({ state: { ...freshProgress(), results, card: 'x'.repeat(36) } }).length).toBeLessThan(1024)
  })

  it('a fresh start is step 1 with nothing done', () => {
    expect(freshProgress()).toEqual({ v: 1, status: 'running', step: 'look', results: {} })
  })
})

describe('the steps', () => {
  it('are the seventeen of the contract, in order', () => {
    expect(STEPS.map((s) => s.id)).toEqual(STEP_IDS)
    expect(STEPS).toHaveLength(17)
  })

  it('each has a title, one to three sentences, and something to do (the last one excepted), in the project’s words', () => {
    for (const step of STEPS) {
      expect(step.title).not.toBe('')
      expect(step.body.length).toBeGreaterThanOrEqual(1)
      expect(step.body.length).toBeLessThanOrEqual(3)
      if (step.id !== 'end') expect(step.todo).not.toBe('')
      expect(`${step.title} ${step.body.join(' ')} ${step.todo}`).not.toMatch(/\b(users?|tasks?|jobs?|notebooks?|sessions?|cells?|canvas|chat|links?|nodes?|commits?|onboarding|walkthrough|wizard|Qoop)\b/i)
    }
  })

  it('only the Run and the AI sidebar need something on this computer', () => {
    expect(STEPS.filter((s) => s.tool).map((s) => [s.id, s.tool])).toEqual([
      ['run', 'runner'],
      ['ai', 'ai'],
    ])
  })
})
