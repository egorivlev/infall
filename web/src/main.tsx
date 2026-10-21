import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './ui/shell/App'
import { applyPrefs } from './ui/settings/apply'
import { prefs } from './ui/settings/prefs'

// This device's settings (theme, interface scale, text size, motion) before anything is drawn: no flash of the wrong ones.
applyPrefs(prefs.get())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
