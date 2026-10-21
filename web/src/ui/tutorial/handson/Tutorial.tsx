import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { desktopSwitchWorkspace } from '../../bridge'
import { useFollow } from '../follow'
import { ringBox } from '../position'
import { tour } from '../store'
import type { StepResult } from './progress'
import { STEP_IDS, STEPS, stepById, stepIndex } from './steps'
import type { HandsOnStep, StepId } from './steps'
import { handsOn, useHandsOn } from './store'
import type { StepCheck } from './store'
import { StepWatch } from './watch'
import '../tutorial.css'
import './handson.css'

const COUNT = STEP_IDS.length
const RESULT_WORD: Record<StepResult, string> = { done: 'Done', skipped: 'Skipped', not_tried: 'Not tried' }
const noop = () => {}

/** Anchors that name a Card the watcher found, rather than a control. */
const CARD_ANCHORS = new Set(['welcome', 'made', 'visual-card', 'run-card'])

function cardElement(id: string): Element | null {
  for (const el of document.querySelectorAll('[data-card]')) if (el.getAttribute('data-card') === id) return el
  return null
}

/** The control a step points at right now, if it is on screen: the first of its anchors that is. */
function anchorOf(step: HandsOnStep, cards: Record<string, string>): Element | null {
  for (const name of step.anchor) {
    const card = cards[name]
    const el = CARD_ANCHORS.has(name) ? (card ? cardElement(card) : null) : document.querySelector(`[data-tour="${name}"]`)
    if (el) return el
  }
  return null
}

function ToolPanel({ check }: { check: StepCheck }) {
  const tool = check.tool
  if (tool === null || tool.state === 'ready') return null
  if (tool.state === 'checking') return <p className="q-lesson__note">Looking for what this step needs on this computer…</p>
  return (
    <div className="q-lesson__tool" role="group" aria-label="Missing on this computer">
      {tool.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {tool.instead && <p className="q-lesson__instead">{tool.instead}</p>}
      <p className="q-lesson__instead">You can pass this step; it is listed as not tried at the end.</p>
      <div className="q-lesson__tool-actions">
        <button type="button" className="q-btn q-btn--sm" onClick={tool.recheck}>
          Check again
        </button>
        {tool.action && (
          <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={tool.action.run}>
            {tool.action.label}
          </button>
        )}
      </div>
    </div>
  )
}

function Summary({ results }: { results: Partial<Record<StepId, StepResult>> }) {
  const of = (want: StepResult) => STEPS.filter((s) => s.id !== 'end' && results[s.id] === want)
  const open = STEPS.filter((s) => s.id !== 'end' && results[s.id] === undefined)
  const groups: [string, HandsOnStep[]][] = [
    ['Tried', of('done')],
    ['Skipped', of('skipped')],
    ['Not tried: something was missing on this computer', of('not_tried')],
    ['Not reached', open],
  ]
  return (
    <div className="q-lesson__summary">
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([head, list]) => (
          <section key={head} aria-label={head}>
            <h4 className="q-caps">{head}</h4>
            <p>{list.map((s) => s.title).join(' · ')}</p>
          </section>
        ))}
      <section aria-label="What a Team Workspace adds">
        <h4 className="q-caps">In a Team Workspace</h4>
        <p>
          A Team Workspace is kept on a server your team runs. Several Members share its Board; an Admin invites them and can invite Guests, who read main for a
          limited time.
        </p>
      </section>
      <p className="q-lesson__instead">This Tutorial Workspace stays on this computer. The tutorial is in the account menu, as “Tutorial”.</p>
    </div>
  )
}

/**
 * The ring around the control or Card the step is about. Only an outline (it lets every click through): the step's
 * text stays in the rail, so nothing covers the Board or the control itself.
 */
function StepRing({ step, cards }: { step: HandsOnStep; cards: Record<string, string> }) {
  const cardsKey = JSON.stringify(cards)
  const find = useCallback(() => {
    const el = anchorOf(step, JSON.parse(cardsKey) as Record<string, string>)
    return el ? [el] : []
  }, [step, cardsKey])
  const at = useFollow(find, noop, { clear: true })
  if (!at || step.id === 'end') return null
  const ring = ringBox(at.target, at.view)
  return <div className="q-tour-ring" aria-hidden="true" style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }} />
}

/** The step itself, inside the rail's progress section: what it is for, what to do, and Skip / Hide / Leave. */
function StepText({ step, check, results, box }: { step: HandsOnStep; check: StepCheck; results: Partial<Record<StepId, StepResult>>; box: RefObject<HTMLElement | null> }) {
  const id = useId()
  const last = step.id === 'end'
  const back = desktopSwitchWorkspace()

  const hadFocus = () => box.current?.contains(document.activeElement) ?? false
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    handsOn.hide(hadFocus())
  }
  const toAccount = () => {
    if (hadFocus()) document.querySelector<HTMLElement>('[data-tour="account"]')?.focus({ preventScroll: true })
  }

  const n = stepIndex(step.id) + 1
  return (
    <section
      ref={box}
      className="q-lesson"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-count ${id}-body`}
      tabIndex={-1}
      data-tutorial="step"
      data-step={step.id}
      onKeyDown={onKeyDown}
    >
      <p className="q-sr" id={`${id}-count`}>
        Tutorial, step {n} of {COUNT}
      </p>
      <h3 className="q-lesson__title" id={`${id}-title`}>
        {step.title}
      </h3>
      <div className="q-lesson__body" id={`${id}-body`}>
        {step.body.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
      {step.todo && (
        <p className="q-lesson__todo">
          <span className="q-caps">Try it</span> {step.todo}
        </p>
      )}
      {check.missing && (
        <p className="q-lesson__note" role="note">
          {check.missing}
        </p>
      )}
      <ToolPanel check={check} />
      {last && <Summary results={results} />}
      <div className="q-lesson__actions">
        {last ? (
          <>
            <button
              type="button"
              className="q-btn q-btn--sm q-btn--primary"
              onClick={() => {
                toAccount()
                handsOn.finish()
              }}
            >
              Finish
            </button>
            {back && (
              <button type="button" className="q-btn q-btn--sm" onClick={() => void back().catch(noop)}>
                Back to workspaces
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="q-btn q-btn--sm" onClick={() => handsOn.skip()}>
              Skip this step
            </button>
            <button type="button" className="q-btn q-btn--sm q-btn--quiet" title="Fold the step away; it stays here in the rail" onClick={() => handsOn.hide(hadFocus())}>
              Hide
            </button>
            <button
              type="button"
              className="q-btn q-btn--sm q-btn--quiet"
              onClick={() => {
                toAccount()
                handsOn.leave()
              }}
            >
              Leave the tutorial
            </button>
          </>
        )}
      </div>
    </section>
  )
}

/**
 * The hands-on Tutorial of a Tutorial Workspace, mounted once in the shell while one is open: it asks the server
 * where the person was, watches the step that is showing and rings the control it is about. The step's text is in
 * the rail (TutorialProgress), so it never lies over the Board, a panel or a screen. Not a modal: the whole app stays
 * usable. It never makes a Change itself — the person does everything.
 */
export function Tutorial() {
  const phase = useHandsOn((s) => s.phase)
  const stepId = useHandsOn((s) => s.step)
  const card = useHandsOn((s) => s.card)
  const check = useHandsOn((s) => s.check)
  const said = useHandsOn((s) => s.said)

  useEffect(() => {
    void handsOn.init()
    return () => handsOn.reset()
  }, [])

  // The Tour and the Tutorial are not shown together.
  const running = phase === 'running'
  useEffect(() => {
    if (running) tour.end()
  }, [running])

  return (
    <>
      {running && <StepWatch key={stepId} step={stepId} card={card} />}
      {running && <StepRing step={stepById(stepId)} cards={check.cards} />}
      <div className="q-sr" role="status" aria-live="polite">
        {said}
      </div>
    </>
  )
}

/**
 * The Tutorial in the rail, while it runs: the step (unless it is folded away), how far along it is, and every step
 * to go to. It lives in the rail's own column so that it covers nothing the person needs.
 */
export function TutorialProgress() {
  const phase = useHandsOn((s) => s.phase)
  const stepId = useHandsOn((s) => s.step)
  const results = useHandsOn((s) => s.results)
  const hidden = useHandsOn((s) => s.hidden)
  const check = useHandsOn((s) => s.check)
  const focus = useHandsOn((s) => s.focus)
  const focusShow = useHandsOn((s) => s.focusShow)
  const [listOpen, setListOpen] = useState(false)
  const listId = useId()
  const showRef = useRef<HTMLButtonElement>(null)
  const stepRef = useRef<HTMLElement>(null)
  const shown = useRef(focusShow)
  useEffect(() => {
    if (focusShow === shown.current) return
    shown.current = focusShow
    showRef.current?.focus({ preventScroll: true })
  }, [focusShow])
  // A step the person chose (start, resume, skip, the list of steps) takes focus; one reached by doing does not.
  const focused = useRef(focus)
  useEffect(() => {
    if (focus === focused.current) return
    focused.current = focus
    stepRef.current?.focus({ preventScroll: true })
    const bar = stepRef.current?.closest('.q-lesson-bar')
    if (bar) bar.scrollTop = 0 // the step from its title, with the count above it
  }, [focus])
  if (phase !== 'running') return null
  const step = stepById(stepId)
  const n = stepIndex(stepId) + 1
  const finished = STEP_IDS.filter((id) => results[id] !== undefined).length
  return (
    <section className={hidden ? 'q-lesson-bar is-folded' : 'q-lesson-bar'} data-tutorial="progress" aria-labelledby={`${listId}-h`}>
      <div className="q-lesson-bar__head">
        <h2 className="q-caps" id={`${listId}-h`}>
          Tutorial
        </h2>
        <span className="q-lesson-bar__count" aria-label={`Step ${n} of ${COUNT}`}>
          {n} / {COUNT}
        </span>
      </div>
      <ol className="q-lesson-bar__track" aria-label={`${finished} of ${COUNT - 1} steps passed`}>
        {STEPS.map((s) => (
          <li key={s.id} className="q-lesson-bar__seg" data-state={s.id === stepId ? 'current' : (results[s.id] ?? 'open')} aria-hidden="true" />
        ))}
      </ol>
      {hidden ? (
        <>
          <p className="q-lesson-bar__title">{step.title}</p>
          <div className="q-lesson-bar__actions">
            <button type="button" ref={showRef} className="q-btn q-btn--sm" data-tutorial="show" onClick={() => handsOn.show()}>
              Show step
            </button>
          </div>
        </>
      ) : (
        <StepText key={step.id} step={step} check={check} results={results} box={stepRef} />
      )}
      <button type="button" className="q-lesson-bar__more" aria-expanded={listOpen} aria-controls={listId} onClick={() => setListOpen((o) => !o)}>
        {listOpen ? 'Hide steps' : 'All steps'}
      </button>
      {listOpen && (
        <ol className="q-lesson-bar__list" id={listId} aria-label="Steps of the tutorial">
          {STEPS.map((s, i) => {
            const result = results[s.id]
            const current = s.id === stepId
            const word = current ? 'Showing' : result ? RESULT_WORD[result] : s.id === 'end' ? '' : 'To do'
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className="q-lesson-bar__item"
                  data-state={current ? 'current' : (result ?? 'open')}
                  aria-current={current ? 'step' : undefined}
                  onClick={() => handsOn.goTo(s.id)}
                >
                  <span className="q-lesson-bar__mark" aria-hidden="true">
                    {current ? '›' : result === 'done' ? '✓' : result === 'skipped' ? '–' : result === 'not_tried' ? '○' : ''}
                  </span>
                  <span className="q-lesson-bar__name">
                    {i + 1}. {s.title}
                  </span>
                  {word && <span className="q-lesson-bar__state">{word}</span>}
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
