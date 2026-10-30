// The seventeen steps of the Tutorial (docs/specs/local.md, "The Tutorial (web UI)"): what each one says and what
// it points at. How each one notices that it has been done is in watch.tsx. The words are CONTEXT.md's.
import { SAMPLE } from './names'

export const STEP_IDS = [
  'look',
  'card',
  'page',
  'source',
  'connection',
  'frame',
  'search',
  'todo',
  'suggestion',
  'visual',
  'run',
  'checkpoint',
  'branch',
  'merge',
  'history',
  'ai',
  'end',
] as const

export type StepId = (typeof STEP_IDS)[number]

export type HandsOnStep = {
  id: StepId
  title: string
  /** One to three plain sentences: what this part of Infall is for. */
  body: string[]
  /** What to do, in one or two sentences. Empty for the last step. */
  todo: string
  /** `data-tour` names of the control to ring, in order of preference (the first one on screen). */
  anchor: string[]
  /** The step needs something on this computer that may be missing (decision 6). */
  tool?: 'runner' | 'ai'
}

const SEARCH_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

export const STEPS: HandsOnStep[] = [
  {
    id: 'look',
    title: 'The Board',
    body: [
      'This Tutorial Workspace is yours alone: what you do here are real Changes, and nobody else sees them.',
      'Drag empty space or scroll to move around the Board.',
    ],
    todo: `Find the Card “${SAMPLE.welcome}”, select it and press “Open Page”.`,
    anchor: ['welcome', 'board'],
  },
  {
    id: 'card',
    title: 'A Card of your own',
    body: ['A Card is one idea, paper or question.', 'Its status says where it stands: Idea, Reading, Understood, Open question or Dead end.'],
    todo: 'Press “+ Card” or double-click empty space, type a title, then give it a status other than Idea.',
    anchor: ['add'],
  },
  {
    id: 'page',
    title: 'Its Page',
    body: ['Behind every Card is its Page: the write-up of what the Card is about.', 'Text is Markdown, and math goes between dollar signs: $\\langle x^2 \\rangle = n$.'],
    todo: 'Open the Page of your Card and write a line of text with a formula in it.',
    anchor: ['page', 'made', 'board'],
  },
  {
    id: 'source',
    title: 'A Source',
    body: ['A Source is a paper, preprint or web page, known by its DOI or its address.', 'One Source can be attached to many Cards.'],
    todo: 'On a Page, under Sources, add one: paste a DOI or an address.',
    anchor: ['sources', 'page', 'board'],
  },
  {
    id: 'connection',
    title: 'A Connection',
    body: ['A Connection says how two Cards relate: related, directed or contradicts.', 'Its label says what the relation is.'],
    todo: 'Point at a Card, drag from a handle on its edge to another Card, then click the new line and give it a label.',
    anchor: ['board'],
  },
  {
    id: 'frame',
    title: 'A Frame',
    body: ['A Frame is a named region of the Board for the Cards of one theme. Connections may cross Frames.'],
    todo: 'Press “+ Frame”, then drag a Card into the new Frame.',
    anchor: ['add'],
  },
  {
    id: 'search',
    title: 'Search',
    body: ['Search finds Cards by their title or summary and takes you to the one you choose.', `${SEARCH_KEY} puts the cursor there from anywhere.`],
    todo: 'Search for a Card and choose it from the list.',
    anchor: ['search'],
  },
  {
    id: 'todo',
    title: 'To-dos',
    body: ['A To-do is a piece of real-world work, owned by one Member. It is the same on every Branch.'],
    todo: `Under To-dos, tick “${SAMPLE.todo}”, then add a To-do of your own.`,
    anchor: ['todos', 'rail'],
  },
  {
    id: 'suggestion',
    title: 'A Suggestion',
    body: ['An AI can propose a Source or a Connection.', 'It becomes part of the Board only when a Member accepts it.'],
    todo: 'Open Suggestions and accept or reject the one that is waiting.',
    anchor: ['suggestions', 'rail'],
  },
  {
    id: 'visual',
    title: 'A Visual',
    body: ['A Visual is a Simulation that works for anyone who opens the Page, with nothing to install.'],
    todo: `Open the Page of “${SAMPLE.visual}” and use its Visual.`,
    anchor: ['page', 'visual-card', 'board'],
  },
  {
    id: 'run',
    title: 'A Run',
    body: [
      'A Run is experiment code, kept with the output captured the last time someone executed it.',
      'The desktop app executes it on your own computer, after you have seen the code and approved it.',
    ],
    todo: `Open the Page of “${SAMPLE.run}” and press “Run”.`,
    anchor: ['page', 'run-card', 'board'],
    tool: 'runner',
  },
  {
    id: 'checkpoint',
    title: 'A Checkpoint',
    body: ['A Checkpoint names a moment of a Branch, so that it can be found again.'],
    todo: 'Press “Checkpoint”, give this moment a name and create it.',
    anchor: ['checkpoint'],
  },
  {
    id: 'branch',
    title: 'Branches',
    body: [
      'A Branch is a separate line of work: what changes on it stays there until it is merged.',
      `${SAMPLE.branch} was started from ${SAMPLE.main} at the Checkpoint “${SAMPLE.checkpoint}”.`,
    ],
    todo: `Switch to ${SAMPLE.branch} with the Branch switcher, look around, then switch back to ${SAMPLE.main}.`,
    anchor: ['branch'],
  },
  {
    id: 'merge',
    title: 'A Merge',
    body: [
      'A Merge brings the Changes of one Branch into another.',
      'Where both Branches changed the same thing there is a Conflict, and a Member decides it.',
    ],
    todo: `Under Branches, find the label of ${SAMPLE.branch} at the top of its line and press “Merge into ${SAMPLE.main}…”. Decide its Conflict, then press “Merge into ${SAMPLE.main}”.`,
    // The label's own button when the Branch Graph shows it; otherwise the way there.
    anchor: [`merge-into:${SAMPLE.branch}`, 'branches', 'rail'],
  },
  {
    id: 'history',
    title: 'History',
    body: [
      'History shows who changed what. You can look at the Board as it was at any moment, and Restore it.',
      'A Restore adds new Changes, so it can be undone too.',
    ],
    todo: `Open History and look back to “${SAMPLE.checkpoint}”. Restore to it if you like; looking is enough.`,
    anchor: ['history'],
  },
  {
    id: 'ai',
    title: 'The AI sidebar',
    body: ['Ask about the Board, or about the Card you have selected. A Conversation is private.', '“Pin to Page” copies an answer into a Page, marked as AI-generated.'],
    todo: 'Open the AI sidebar, ask something, and pin an answer to a Page.',
    anchor: ['ai-sidebar', 'ai'],
    tool: 'ai',
  },
  {
    id: 'end',
    title: 'The end',
    body: ['That was every part of Infall.'],
    todo: '',
    anchor: [],
  },
]

export function stepById(id: StepId): HandsOnStep {
  return STEPS.find((s) => s.id === id) ?? STEPS[0]!
}

export function stepIndex(id: StepId): number {
  return Math.max(0, STEP_IDS.indexOf(id))
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value)
}
