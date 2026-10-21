// How each step notices that it has been done: from the app's own state — the Board, the Pages, To-dos,
// Suggestions, the Merge, History, Runs, the AI — never from clicks on particular controls. One watcher is mounted
// for the step that is showing; what was there when it was mounted is its baseline, per Branch, so that switching
// Branch never reads another Branch's Cards as new ones. Watchers only look: they never make a Change.
import { useEffect, useState } from 'react'
import { ai, runs, useAi, useBoard, useBranches, useMerge, usePage, useRuns, useSuggestions, useTodos } from '../../../lib'
import type { AiSetup, BoardSnapshot, CardVM, PageVM, RunnerSetup } from '../../../lib'
import { useHistoryPanel, usePagePanel, useSearchUse } from '../../bridge'
import { frameCounts } from '../../shell/frameCounts'
import { AI_ACCESS_PATH, navigate } from '../../shell/router'
import { SAMPLE } from './names'
import type { StepId } from './steps'
import { handsOn } from './store'
import type { StepCheck, ToolCheck } from './store'

/** How long a missing thing must stay missing before the step says so (a list still loading is not "gone"). */
export const MISSING_AFTER_MS = 800

type Report = { done: boolean; made?: { card?: string }; missing?: string | null; tool?: ToolCheck | null; cards?: Record<string, string> }

/** The Board is loaded and listening: only then can "new since the step began" be told apart from "still loading". */
function ready(b: BoardSnapshot): boolean {
  return (b.status === 'live' || b.status === 'reconnecting') && b.branch !== undefined
}

/** What was there the first time this watcher saw the open Branch loaded — kept per Branch id. */
function useBaseline<T>(b: BoardSnapshot, take: () => T): T | null {
  const [seen] = useState(() => new Map<string, T>()) // a container kept for the watcher's life, filled while rendering
  if (!ready(b)) return null
  const key = b.branch!.id
  if (!seen.has(key)) seen.set(key, take())
  return seen.get(key)!
}

/** The same value, but a non-null one only after it has stood for MISSING_AFTER_MS. */
function useSettled(value: string | null): string | null {
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (value === null) return
    const t = setTimeout(() => setSettled(value), MISSING_AFTER_MS)
    return () => clearTimeout(t)
  }, [value])
  return value !== null && settled === value ? value : null
}

function byTitle(cards: CardVM[], title: string): CardVM | undefined {
  return cards.find((c) => c.title === title)
}

const gone = (title: string) => `There is no Card called “${title}” on this Board any more, so this step cannot be done here. Skip it to go on.`

/** A formula, and some text besides it. */
const FORMULA = /\$\$[^$]+\$\$|\$[^$\s][^$\n]*\$/
function hasFormulaAndText(text: string): boolean {
  if (!FORMULA.test(text)) return false
  return /\p{L}{2,}/u.test(text.replace(/\$\$[^$]+\$\$|\$[^$\n]*\$/g, ' '))
}

// ---- one watcher per step ----

function useLook(): Report {
  const b = useBoard()
  const open = usePagePanel((s) => s.cardId)
  const welcome = byTitle(b.cards, SAMPLE.welcome)
  return {
    done: welcome !== undefined && open === welcome.id,
    missing: ready(b) && !welcome ? gone(SAMPLE.welcome) : null,
    cards: welcome ? { welcome: welcome.id } : {},
  }
}

function useNewCard(): Report {
  const b = useBoard()
  const base = useBaseline(b, () => new Set(b.cards.map((c) => c.id)))
  const made = base ? b.cards.find((c) => !base.has(c.id) && c.title.trim() !== '' && c.status !== 'idea') : undefined
  return { done: made !== undefined, made: made ? { card: made.id } : undefined }
}

/** Blocks of a Page as they were when this watcher first saw that Page. */
function usePageBaseline(page: PageVM): Map<string, string> | null {
  const [seen] = useState(() => new Map<string, Map<string, string>>())
  const id = page.card?.id
  if (!id) return null
  if (!seen.has(id)) seen.set(id, new Map(page.blocks.map((bl) => [bl.id, bl.text])))
  return seen.get(id)!
}

function wroteFormula(page: PageVM, base: Map<string, string> | null): boolean {
  if (base === null) return false
  return page.blocks.some((bl) => bl.type === 'text' && bl.ai === undefined && hasFormulaAndText(bl.text) && base.get(bl.id) !== bl.text)
}

function useWrite(card: string | null): Report {
  const b = useBoard()
  const open = usePagePanel((s) => s.cardId)
  const madeLive = card !== null && b.cards.some((c) => c.id === card)
  const mine = usePage(madeLive ? card : null)
  const opened = usePage(open !== card ? open : null)
  const baseMine = usePageBaseline(mine)
  const baseOpened = usePageBaseline(opened)
  return { done: wroteFormula(mine, baseMine) || wroteFormula(opened, baseOpened), cards: madeLive ? { made: card } : {} }
}

function useSource(): Report {
  const b = useBoard()
  const base = useBaseline(b, () => new Map(b.cards.map((c) => [c.id, c.sources])))
  return { done: base !== null && b.cards.some((c) => c.sources > (base.get(c.id) ?? 0)) }
}

function useConnection(): Report {
  const b = useBoard()
  const base = useBaseline(b, () => new Set(b.connections.map((c) => c.id)))
  return { done: base !== null && b.connections.some((c) => !base.has(c.id) && c.label.trim() !== '') }
}

function useFrame(): Report {
  const b = useBoard()
  const base = useBaseline(b, () => new Set(b.frames.map((f) => f.id)))
  if (base === null) return { done: false }
  const fresh = b.frames.filter((f) => !base.has(f.id))
  const counts = frameCounts(fresh, b.cards)
  return { done: fresh.some((f) => (counts[f.id] ?? 0) > 0) }
}

function useSearch(): Report {
  const chosen = useSearchUse((s) => s.chosen)
  const [base] = useState(chosen)
  return { done: chosen > base }
}

function useTodo(): Report {
  const list = useTodos()
  const [since] = useState(() => Date.now() - 1000)
  const seeded = list.find((t) => t.text === SAMPLE.todo)
  const added = list.some((t) => t !== seeded && t.text !== SAMPLE.todo && t.created_at >= since)
  return {
    done: added && (seeded === undefined || seeded.done),
    missing: seeded === undefined ? `The To-do “${SAMPLE.todo}” is not there any more, so adding one of your own is enough.` : null,
  }
}

function useSuggestion(): Report {
  const b = useBoard()
  const list = useSuggestions()
  const [waiting] = useState(() => new Set<string>()) // every Suggestion seen waiting while this step showed
  for (const s of list) if (s.suggestion.state === 'pending') waiting.add(s.suggestion.id)
  const decided = list.some((s) => waiting.has(s.suggestion.id) && s.suggestion.state !== 'pending')
  const none = ready(b) && waiting.size === 0
  return {
    done: decided,
    missing: none
      ? b.branch?.name === SAMPLE.main
        ? 'No Suggestion is waiting on this Branch any more, so this step cannot be done here. Skip it to go on.'
        : `Suggestions belong to a Branch: the one waiting is on ${SAMPLE.main}. Switch to ${SAMPLE.main} to find it.`
      : null,
  }
}

/** True once focus has gone into a Visual's frame on the open Page — which is what using a Visual does. */
function useVisualFocused(): boolean {
  const [used, setUsed] = useState(false)
  useEffect(() => {
    const look = () => {
      const at = document.activeElement
      if (at instanceof HTMLIFrameElement && at.classList.contains('qp-vframe__frame') && at.closest('[data-tour="page"]')) setUsed(true)
    }
    // Clicking into a frame takes focus from this window: the frame is then the active element.
    const onBlur = () => setTimeout(look, 0)
    window.addEventListener('blur', onBlur)
    document.addEventListener('focusin', look)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('focusin', look)
    }
  }, [])
  return used
}

function useVisual(): Report {
  const b = useBoard()
  const open = usePagePanel((s) => s.cardId)
  const card = byTitle(b.cards, SAMPLE.visual)
  const page = usePage(card?.id ?? null)
  const used = useVisualFocused()
  const hasVisual = page.blocks.some((bl) => bl.type === 'visual')
  const onPage = card !== undefined && open === card.id
  return {
    done: onPage && hasVisual && used,
    missing: !ready(b) ? null : !card ? gone(SAMPLE.visual) : page.card && !hasVisual ? `The Page of “${SAMPLE.visual}” has no Visual any more. Skip this step to go on.` : null,
    cards: card ? { 'visual-card': card.id } : {},
  }
}

function runnerCheck(runner: RunnerSetup): ToolCheck {
  const recheck = () => void runs.refresh()
  const instead = `The output captured the last time it was executed is already on the Page of “${SAMPLE.run}”: open it to read it.`
  if (runner.available) {
    if (runner.python) return { state: 'ready', lines: [], recheck }
    return {
      state: 'missing',
      lines: ['The desktop app found no Python on this computer.', 'Install Python 3, then choose it in the Runner settings.'],
      instead,
      action: { label: 'Runner settings', run: () => void runs.configure() },
      recheck,
    }
  }
  if (runner.reason === 'loading') return { state: 'checking', lines: [], recheck }
  if (runner.reason === 'old_app') return { state: 'missing', lines: ['This version of the desktop app cannot execute Runs.', 'Install the latest Infall desktop app.'], instead, recheck }
  return { state: 'missing', lines: ['Runs are executed only by the Infall desktop app, on your own computer.', 'Install the desktop app to execute one.'], instead, recheck }
}

function useRun(): Report {
  const b = useBoard()
  const card = byTitle(b.cards, SAMPLE.run)
  const page = usePage(card?.id ?? null)
  const block = page.blocks.find((bl) => bl.type === 'run')
  const at = block?.run?.result?.at ?? null
  const [bases] = useState(() => new Map<string, number | null>()) // when each Run was last executed, as first seen
  if (block && !bases.has(block.id)) bases.set(block.id, at)
  const { runner } = useRuns()
  return {
    done: block !== undefined && at !== null && at !== bases.get(block.id),
    missing: !ready(b) ? null : !card ? gone(SAMPLE.run) : page.card && !block ? `The Page of “${SAMPLE.run}” has no Run any more. Skip this step to go on.` : null,
    tool: runnerCheck(runner),
    cards: card ? { 'run-card': card.id } : {},
  }
}

function useCheckpoint(): Report {
  const b = useBoard()
  const base = useBaseline(b, () => b.branch!.checkpoints)
  return { done: base !== null && (b.branch?.checkpoints ?? 0) > base }
}

function useNoBranch(): string | null {
  const list = useBranches()
  return list.length > 0 && !list.some((x) => x.name === SAMPLE.branch)
    ? `There is no Branch called ${SAMPLE.branch} any more, so this step cannot be done here. Skip it to go on.`
    : null
}

function useSwitch(): Report {
  const b = useBoard()
  const missing = useNoBranch()
  const [away, setAway] = useState(false)
  const name = ready(b) ? b.branch!.name : null
  if (name === SAMPLE.branch && !away) setAway(true)
  return { done: away && name === SAMPLE.main, missing }
}

function useMergeDone(): Report {
  const m = useMerge()
  const missing = useNoBranch()
  return { done: m.status === 'merged' && m.source?.name === SAMPLE.branch && m.target?.name === SAMPLE.main, missing: m.status === 'merged' ? null : missing }
}

function useHistoryOpen(): Report {
  return { done: useHistoryPanel((s) => s.open) }
}

function aiCheck(setup: AiSetup): ToolCheck {
  const recheck = () => void ai.refresh()
  const instead = 'An answer would appear in the sidebar, and “Pin to Page” would copy it into the Page of the Card you have selected, marked as AI-generated and not yet reviewed.'
  const access = { label: 'AI access', run: () => navigate(AI_ACCESS_PATH) }
  if (setup.provider !== 'none') return { state: 'ready', lines: [], recheck }
  switch (setup.reason) {
    case 'loading':
      return { state: 'checking', lines: [], recheck }
    case 'desktop_no_claude':
      return { state: 'missing', lines: ['Answers come from Claude Code on this computer, or from OpenRouter.', 'Install Claude Code, or add an OpenRouter key under AI access.'], instead, action: access, recheck }
    case 'browser_no_key':
      return { state: 'missing', lines: ['Answers here come from OpenRouter.', 'Add an OpenRouter key under AI access.'], instead, action: access, recheck }
    case 'no_model':
      return { state: 'missing', lines: ['Choose a model under AI access.'], instead, action: access, recheck }
    default:
      return { state: 'missing', lines: ['No AI is set up for this Workspace.'], instead, recheck }
  }
}

function useAiPin(): Report {
  const { setup, current } = useAi()
  // Answers already pinned when the step began (per Conversation, the first time it is seen) do not count.
  const [base] = useState(() => new Map<string, Set<string>>())
  const keys = (current?.messages ?? []).flatMap((m) => (m.pinned ?? []).map((p) => `${m.id}:${p.block}`))
  if (current && !base.has(current.id)) base.set(current.id, new Set(keys))
  const before = current ? base.get(current.id)! : new Set<string>()
  return { done: keys.some((k) => !before.has(k)), tool: aiCheck(setup) }
}

const NOTHING = (): Report => ({ done: false })

const WATCHERS: Record<StepId, (card: string | null) => Report> = {
  look: useLook,
  card: useNewCard,
  page: useWrite,
  source: useSource,
  connection: useConnection,
  frame: useFrame,
  search: useSearch,
  todo: useTodo,
  suggestion: useSuggestion,
  visual: useVisual,
  run: useRun,
  checkpoint: useCheckpoint,
  branch: useSwitch,
  merge: useMergeDone,
  history: useHistoryOpen,
  ai: useAiPin,
  end: NOTHING,
}

/**
 * Watches the step that is showing and tells the Tutorial when it has been done and what it found missing. Mount
 * it keyed by the step, so each step begins with its own baseline.
 */
export function StepWatch({ step, card }: { step: StepId; card: string | null }) {
  const [watcher] = useState(() => WATCHERS[step]) // one watcher for the life of this element: hooks stay in order
  const r = watcher(card)
  const missing = useSettled(r.missing ?? null)
  const done = r.done
  const made = r.made?.card

  useEffect(() => {
    if (done) handsOn.done(step, made ? { card: made } : undefined)
  }, [done, made, step])

  const check: StepCheck = { missing, tool: r.tool ?? null, cards: r.cards ?? {} }
  useEffect(() => {
    handsOn.report(step, check)
  })
  return null
}
