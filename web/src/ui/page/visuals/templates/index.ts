// The starters offered when a Visual is added. Each is a complete source that works under the
// frame's rules: no network, no external files, inline <style> and <script>, colours from --q-*.
import { BLANK } from './blank'
import { BLOCH } from './bloch'
import { PLOT } from './plot'

export type VisualTemplate = {
  id: 'blank' | 'bloch' | 'plot'
  /** As offered in the starter picker. */
  name: string
  /** The title the new Visual gets; '' leaves it for the person to name. */
  title: string
  source: string
}

export const TEMPLATES: readonly VisualTemplate[] = [
  { id: 'blank', name: 'Blank', title: '', source: BLANK },
  { id: 'bloch', name: 'Bloch sphere', title: 'Bloch sphere', source: BLOCH },
  { id: 'plot', name: 'Function plot', title: 'Function plot', source: PLOT },
]
