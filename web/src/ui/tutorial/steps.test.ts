import { afterEach, describe, expect, it } from 'vitest'
import { aiPanel, useAiPanel } from '../bridge'
import { anchorsOf, availableSteps, inDesktopApp, stepsFor } from './steps'

function screenWith(...names: string[]): HTMLElement {
  const root = document.createElement('div')
  for (const name of names) {
    const el = document.createElement('div')
    el.setAttribute('data-tour', name)
    root.append(el)
  }
  return root
}

const ALL = ['board', 'add', 'card', 'search', 'rail', 'branch', 'checkpoint', 'history', 'ai', 'account']
const ids = (steps: { id: string }[]) => steps.map((s) => s.id)

afterEach(() => {
  aiPanel.close()
  delete (globalThis as { infallDesktop?: unknown }).infallDesktop
})

describe('the steps', () => {
  it('a Member gets the eleven steps in order', () => {
    expect(ids(stepsFor({ role: 'member', desktop: false }))).toEqual(['board', 'add', 'card', 'connections', 'search', 'rail', 'branch', 'history', 'ai', 'runs', 'more'])
  })

  it('an Admin gets the same steps, and the rail step names Members', () => {
    const admin = stepsFor({ role: 'admin', desktop: false })
    const member = stepsFor({ role: 'member', desktop: false })
    expect(ids(admin)).toEqual(ids(member))
    const rail = (steps: typeof admin) => steps.find((s) => s.id === 'rail')!.body.join(' ')
    expect(rail(admin)).toContain('Members')
    expect(rail(member)).not.toContain('Members')
  })

  it('the step at the Board’s toolbar names its Undo and Redo, and the Tour has no step of its own for them', () => {
    const add = stepsFor({ role: 'member', desktop: false }).find((s) => s.id === 'add')!
    expect(add.body.at(-1)).toBe('The arrows beside them are Undo and Redo of your own latest gestures.')
    expect(add.anchor).toEqual(['add'])
  })

  it('the Runs step says something else in a browser than in the desktop app', () => {
    const runs = (desktop: boolean) => stepsFor({ role: 'member', desktop }).find((s) => s.id === 'runs')!.body.join(' ')
    expect(runs(false)).toContain('only in the Infall desktop app')
    expect(runs(false)).toContain('the result of the last Run')
    expect(runs(true)).toContain('on your own computer')
    expect(runs(true)).toContain('approved')
    expect(runs(true)).not.toContain('browser')
    expect(runs(true)).not.toEqual(runs(false))
  })

  it('no step’s text has Markdown or TeX in it: the Tour shows its words as they are', () => {
    const audiences = [
      { role: 'admin', desktop: true, local: true, startScreen: true },
      { role: 'admin', desktop: false },
      { role: 'member', desktop: true },
      { role: 'member', desktop: false },
      { role: 'guest', desktop: false },
    ] as const
    const words = audiences.flatMap((a) => stepsFor(a).flatMap((s) => [s.title, ...s.body]))
    expect(words.length).toBeGreaterThan(30)
    for (const text of words) expect(text).not.toMatch(/[$`\\*]|\]\(/)
  })

  it('the last step names the start screen only when the app can go there', () => {
    const more = (startScreen: boolean) => stepsFor({ role: 'member', desktop: true, startScreen }).find((s) => s.id === 'more')!
    expect(more(false).body).toHaveLength(2)
    expect(more(false).action).toBeUndefined()
    expect(more(true).body).toHaveLength(3)
    expect(more(true).body[2]).toContain('Tutorial Workspace')
    expect(more(true).action?.label).toBe('Go to the start screen')
  })

  it('in a Local Workspace the rail step does not name Members, which it does not have', () => {
    const rail = stepsFor({ role: 'admin', desktop: true, local: true }).find((s) => s.id === 'rail')!
    expect(rail.body.join(' ')).not.toContain('Members')
  })

  it('knows the desktop app by its bridge', () => {
    expect(inDesktopApp()).toBe(false)
    ;(globalThis as { infallDesktop?: unknown }).infallDesktop = {}
    expect(inDesktopApp()).toBe(true)
  })

  it('a Guest gets the short tour, pointing only at what a Guest has', () => {
    const guest = stepsFor({ role: 'guest', desktop: false })
    expect(ids(guest)).toEqual(['board', 'card', 'search', 'guest'])
    const pointedAt = new Set(guest.flatMap((s) => [...s.anchor, ...(s.needs ?? [])]))
    for (const name of ['add', 'rail', 'branch', 'checkpoint', 'history', 'ai', 'ai-sidebar', 'account']) expect(pointedAt.has(name)).toBe(false)
    expect(guest.every((s) => s.enter === undefined)).toBe(true)
    expect(guest.at(-1)!.body.join(' ')).toContain('changes nothing')
  })

  it('every step has a title and one to three sentences, in the project’s words', () => {
    for (const role of ['member', 'admin', 'guest'] as const) {
      for (const desktop of [false, true]) {
        for (const step of stepsFor({ role, desktop })) {
          expect(step.title).not.toBe('')
          expect(step.body.length).toBeGreaterThanOrEqual(1)
          expect(step.body.length).toBeLessThanOrEqual(3)
          expect(`${step.title} ${step.body.join(' ')}`).not.toMatch(/\b(users?|tasks?|jobs?|notebooks?|sessions?|cells?|canvas|chat|Qoop)\b/i)
        }
      }
    }
  })
})

describe('what is on screen', () => {
  it('keeps every step when every control is there', () => {
    const steps = stepsFor({ role: 'member', desktop: false })
    expect(availableSteps(steps, screenWith(...ALL))).toHaveLength(11)
  })

  it('leaves out a step whose control is missing', () => {
    const steps = stepsFor({ role: 'member', desktop: false })
    const without = (name: string) => ids(availableSteps(steps, screenWith(...ALL.filter((n) => n !== name))))
    expect(without('search')).not.toContain('search')
    expect(without('rail')).not.toContain('rail')
    expect(without('ai')).not.toContain('ai') // the sidebar step needs the button that opens it
    expect(without('checkpoint')).toContain('history') // History alone is enough
    expect(ids(availableSteps(steps, screenWith(...ALL.filter((n) => n !== 'checkpoint' && n !== 'history'))))).not.toContain('history')
  })

  it('the Card step stays on "+ Card" when the Board has no Card', () => {
    const steps = stepsFor({ role: 'member', desktop: false })
    const empty = screenWith(...ALL.filter((n) => n !== 'card'))
    const card = availableSteps(steps, empty).find((s) => s.id === 'card')!
    expect(anchorsOf(card, empty).map((el) => el.getAttribute('data-tour'))).toEqual(['add'])
    const full = screenWith(...ALL)
    expect(anchorsOf(card, full).map((el) => el.getAttribute('data-tour'))).toEqual(['card'])
  })

  it('a Guest on a Board without Cards loses the Card step', () => {
    const guest = stepsFor({ role: 'guest', desktop: false })
    expect(ids(availableSteps(guest, screenWith('board', 'search', 'guest')))).toEqual(['board', 'search', 'guest'])
  })

  it('Checkpoint and History are pointed at together', () => {
    const step = stepsFor({ role: 'member', desktop: false }).find((s) => s.id === 'history')!
    expect(anchorsOf(step, screenWith(...ALL))).toHaveLength(2)
  })

  it('the AI step opens the sidebar and closes it again, and leaves an open one alone', () => {
    const step = stepsFor({ role: 'member', desktop: false }).find((s) => s.id === 'ai')!
    const undo = step.enter!()
    expect(useAiPanel.getState().open).toBe(true)
    if (undo) undo()
    expect(useAiPanel.getState().open).toBe(false)

    aiPanel.toggle() // the Member had it open
    expect(step.enter!()).toBeUndefined()
    expect(useAiPanel.getState().open).toBe(true)
  })
})
