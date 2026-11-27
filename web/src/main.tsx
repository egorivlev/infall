import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import { App } from './ui/shell/App'
import { applyPrefs } from './ui/settings/apply'
import { prefs } from './ui/settings/prefs'
import { carryOverRenamedKeys } from './ui/settings/renamedKeys'

// What this device kept under the names from before the rename, under the new ones, before anything reads them.
carryOverRenamedKeys()

// This device's settings (theme, interface scale, text size, motion) before anything is drawn: no flash of the wrong ones.
applyPrefs(prefs.get())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
