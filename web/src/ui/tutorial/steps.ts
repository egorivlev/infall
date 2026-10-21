// The steps of the tour: what each one points at and what it says. The words are the project's (CONTEXT.md).
// A step points at real controls, found by their `data-tour` attribute.
import type { Role } from '../../lib'
import { aiPanel, desktopSwitchWorkspace, useAiPanel } from '../bridge'

export type TourStep = {
  id: string
  title: string
  /** One to three plain sentences. */
  body: string[]
  /** `data-tour` names, in order of preference: the first one on screen is the control the step points at. */
  anchor: string[]
  /** Point at all of the anchors that are on screen, as one. */
  together?: boolean
  /** What must be on screen for the step to be shown at all, when that is not the anchors (a panel the step opens itself). */
  needs?: string[]
  /**
   * Opens what the step is about, through the function the app's own control calls; returns how to put it back.
   * Never changes the Board, a Page or anything on the server.
   */
  enter?: () => (() => void) | void
  /** A button of the step's own, beside Back and Next (the last step's "Go to the start screen" in the desktop app). */
  action?: { label: string; run: () => void }
}

/**
 * Who takes the tour, and where. `local`: a Local Workspace, which has no Members screen. `startScreen`: the desktop
 * app can go back to its start screen (`window.qoopDesktop.switchWorkspace`), where a Tutorial Workspace is made.
 */
export type TourAudience = { role: Role; desktop: boolean; local?: boolean; startScreen?: boolean }

/** True inside the desktop app, which is known by the bridge it puts on the page (as in lib/runs and windowChrome). */
export function inDesktopApp(): boolean {
  const desktop = (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  return typeof desktop === 'object' && desktop !== null
}

const SEARCH_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

const BOARD: TourStep = {
  id: 'board',
  title: 'The Board',
  body: ['Each Card is one idea, paper or question of the team.', 'Drag a Card to move it. Drag empty space or scroll to pan.'],
  anchor: ['board'],
}

const SEARCH: TourStep = {
  id: 'search',
  title: 'Search',
  body: ['Finds Cards by their title or summary and takes you to the one you choose.', `${SEARCH_KEY} puts the cursor here from anywhere.`],
  anchor: ['search'],
}

const RUNS_FIRST = 'A Page can hold a Run: code, kept with the output of the last time someone ran it.'

function memberSteps(role: Role, desktop: boolean, local: boolean, startScreen: boolean): TourStep[] {
  const more: TourStep = {
    id: 'more',
    title: 'Where to read more',
    body: [
      role === 'admin'
        ? 'The written tutorial, docs/tutorial.md in the repository, goes through every part once in about fifteen minutes.'
        : 'The written tutorial your Admin can give you goes through every part once in about fifteen minutes.',
      'This tour stays here in the account menu, as “Tour of Infall”.',
    ],
    anchor: ['account'],
  }
  if (startScreen) {
    more.body.push('To try every part yourself, make a Tutorial Workspace from the start screen.')
    more.action = {
      label: 'Go to the start screen',
      run: () => {
        const go = desktopSwitchWorkspace()
        if (go) void go().catch(() => {})
      },
    }
  }
  return [
    BOARD,
    {
      id: 'add',
      title: 'New Cards and Frames',
      body: [
        '“+ Card” puts a new Card in the middle of what you see. Double-clicking empty space puts one where you click.',
        '“+ Frame” adds a Frame: a named region for the Cards of one theme.',
      ],
      anchor: ['add'],
    },
    {
      id: 'card',
      title: 'A Card',
      body: [
        'The top line of a Card is its status: Idea, Reading, Understood, Open question or Dead end.',
        'Select a Card and press “Open Page” to read and write its Page, the team’s write-up.',
      ],
      anchor: ['card', 'add'], // an empty Board has no Card yet: stay on "+ Card"
    },
    {
      id: 'connections',
      title: 'Connections',
      body: [
        'A Connection is a line from one Card to another.',
        'Point at a Card and drag from a handle on its edge to the other Card. Click the line to choose its kind and give it a label.',
      ],
      anchor: ['board'],
    },
    SEARCH,
    {
      id: 'rail',
      title: 'The rail',
      body: [
        'To-dos shows who is doing what.',
        'Suggestions holds Sources and Connections proposed by AI until someone accepts them.',
        role === 'admin' && !local ? 'Branches lists every Branch, and Members is where you invite people.' : 'Branches lists every Branch.',
      ],
      anchor: ['rail'],
    },
    {
      id: 'branch',
      title: 'The Branch switcher',
      body: ['A Branch is a separate line of work: what you change there stays there until you Merge.', 'main is the Branch everybody shares.'],
      anchor: ['branch'],
    },
    {
      id: 'history',
      title: 'Checkpoint and History',
      body: [
        'Checkpoint gives this moment of the Branch a name, so it can be found again.',
        'History shows who changed what, lets you look at the Board as it was, and Restore it.',
      ],
      anchor: ['checkpoint', 'history'],
      together: true,
    },
    {
      id: 'ai',
      title: 'The AI sidebar',
      body: [
        'Ask about the Board, or about the Card you have selected.',
        'A Conversation is private: only you see it.',
        '“Pin to Page” copies an answer into a Page, marked as AI-generated.',
      ],
      anchor: ['ai-sidebar', 'ai'],
      needs: ['ai'],
      // The same function the "AI" button calls. A sidebar that was open already is left as it is.
      enter: () => {
        if (useAiPanel.getState().open) return
        aiPanel.toggle()
        return () => aiPanel.close()
      },
    },
    {
      id: 'runs',
      title: 'Runs',
      body: desktop
        ? [RUNS_FIRST, 'In this app, “Run” executes the code on your own computer, after you have seen it and approved it.']
        : [
            RUNS_FIRST,
            'Code runs only in the Infall desktop app, on a Member’s own computer, after they approve it.',
            'Here in the browser you see the result of the last Run.',
          ],
      anchor: ['card', 'board'], // a Run lives on a Card's Page
    },
    more,
  ]
}

/** A Guest reads and does not change: nothing here points at a control a Guest does not have. */
function guestSteps(): TourStep[] {
  return [
    { ...BOARD, body: ['Each Card is one idea, paper or question of the team.', 'Drag empty space or scroll to pan.'] },
    {
      id: 'card',
      title: 'A Card and its Page',
      body: ['The top line of a Card is its status.', 'Select a Card and press “Open Page” to read its Page, the team’s write-up.'],
      anchor: ['card'],
    },
    SEARCH,
    {
      id: 'guest',
      title: 'Reading as a Guest',
      body: ['A Guest reads the Board and the Pages of main, and changes nothing.', 'Your access is for a limited time and ends by itself.'],
      anchor: ['guest'],
    },
  ]
}

/** Every step this person could get, in order. */
export function stepsFor({ role, desktop, local = false, startScreen = false }: TourAudience): TourStep[] {
  return role === 'guest' ? guestSteps() : memberSteps(role, desktop, local, startScreen)
}

function find(name: string, root: ParentNode): Element | null {
  return root.querySelector(`[data-tour="${name}"]`)
}

/** The control, or controls, a step points at right now. Empty when none of them is on screen. */
export function anchorsOf(step: TourStep, root: ParentNode = document): Element[] {
  const found = step.anchor.map((name) => find(name, root)).filter((el): el is Element => el !== null)
  return step.together ? found : found.slice(0, 1)
}

/** The steps whose control is on screen right now; the others are left out, not shown broken. */
export function availableSteps(steps: TourStep[], root: ParentNode = document): TourStep[] {
  return steps.filter((step) => (step.needs ?? step.anchor).some((name) => find(name, root) !== null))
}
