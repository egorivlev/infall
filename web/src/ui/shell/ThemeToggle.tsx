import { Icon } from './Icon'
import { nextThemePref, THEME_LABEL } from './theme'
import { useThemePref } from './useTheme'

const ICON = { dark: 'moon', light: 'sun', system: 'monitor' } as const

export function ThemeToggle() {
  const [pref, setPref] = useThemePref()
  const label = `Theme: ${THEME_LABEL[pref]}. Switch to ${THEME_LABEL[nextThemePref(pref)]}.`
  return (
    <button type="button" className="q-btn q-btn--icon q-btn--quiet" aria-label={label} title={label} onClick={() => setPref(nextThemePref(pref))}>
      <Icon name={ICON[pref]} size={15} />
    </button>
  )
}
