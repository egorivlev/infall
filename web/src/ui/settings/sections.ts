import type { Member } from '../../lib'
import { SETTINGS_SECTIONS } from '../shell/router'
import type { SettingsSection } from '../shell/router'

export const SECTION_LABEL: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  board: 'Board',
  ai: 'AI access',
  runs: 'Runs',
  workspace: 'Workspace',
  about: 'About',
}

/** The sections this person sees: a Guest has no AI and runs nothing. */
export function sectionsFor(member: Member): SettingsSection[] {
  const guest = member.role === 'guest'
  return SETTINGS_SECTIONS.filter((s) => !(guest && (s === 'ai' || s === 'runs')))
}

