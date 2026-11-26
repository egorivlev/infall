// This device's storage under the names from before the rename (docs/specs/desktop.md, "Names before the rename").
// Each value kept under an old key is copied to its new key, once, when the new key is not there yet: the AI sidebar's
// Conversations and whether the tour was offered survive the rename. The old keys are left as they are. The theme's
// key from before Settings (`qoop-theme`, prefs.ts) is still read where it always was and is not copied here.

/** Old key prefix, new key prefix. A key is the prefix and a Member's id. */
export const RENAMED_KEY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['qoop.ai.', 'infall.ai.'],
  ['qoop-tour:', 'infall-tour:'],
]

function defaultStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null // blocked (a sandboxed frame, a privacy setting)
  }
}

/** Copies every old key's value to its new key where that is absent. Returns how many were copied; never throws. */
export function carryOverRenamedKeys(storage: Storage | null = defaultStorage()): number {
  if (!storage) return 0
  const keys: string[] = []
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null) keys.push(key)
    }
  } catch {
    return 0
  }
  let copied = 0
  for (const key of keys) {
    const rename = RENAMED_KEY_PREFIXES.find(([old]) => key.startsWith(old) && key.length > old.length)
    if (!rename) continue
    const newKey = rename[1] + key.slice(rename[0].length)
    try {
      const value = storage.getItem(key)
      if (value === null || storage.getItem(newKey) !== null) continue
      storage.setItem(newKey, value)
      copied++
    } catch {
      // Full or blocked: the old value stays where it is, and the next start tries again.
    }
  }
  return copied
}
