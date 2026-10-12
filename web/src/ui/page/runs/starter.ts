/** What a new Run starts with: a name and three lines that work as they are. */
export type RunStarter = { run: true; title: string; source: string }

export const RUN_STARTER: RunStarter = {
  run: true,
  title: 'experiment.py',
  source: [
    '# A Run: Python that runs on the computer of whoever presses Run, in the Qoop desktop app.',
    '# The output of the last time it ran, with any matplotlib figures, stays here for everyone to read.',
    'print("hello from Qoop")',
    '',
  ].join('\n'),
}
