// The things the server seeds a Tutorial Workspace with (docs/specs/local.md, "The Tutorial sample Board"), by
// their exact names. The server keeps the same names as constants; the Tutorial finds things only by these.

export const SAMPLE = {
  frames: { start: 'Start here', papers: 'Papers', experiments: 'Experiments' },
  welcome: 'Welcome to Infall',
  run: 'Random walk experiment',
  visual: 'Watch a walk',
  todo: 'Read the welcome Card',
  checkpoint: 'Before the tutorial',
  branch: 'longer-walks',
  addedOnBranch: 'Walks of 10 000 steps',
  main: 'main',
} as const

/** The Preset id of a Tutorial Workspace (`GET /api/workspace`). */
export const TUTORIAL_PRESET = 'tutorial'
