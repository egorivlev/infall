import { ai } from '../../lib'
import type { AiSetup } from '../../lib'
import { Link } from '../shell/Link'
import { AI_ACCESS_PATH } from '../shell/router'
import { LockIcon, ScreenIcon } from './icons'

type None = Extract<AiSetup, { provider: 'none' }>

const SHIP = "Infall doesn't ship a model. In the desktop app this sidebar runs on your own Claude subscription."

/** Why there is no AI to ask, and what to do about it (screen 4b). */
export function NoAi({ setup }: { setup: None }) {
  const { reason } = setup
  if (reason === 'loading') {
    return (
      <div className="qa-none" role="status">
        <p className="qa-none__quiet">Checking what AI is set up…</p>
      </div>
    )
  }
  return (
    <div className="qa-none">
      <ScreenIcon />
      <h3 className="qa-none__h">{reason === 'desktop_no_claude' ? "AI isn't set up on this computer" : "AI isn't set up for you"}</h3>
      {reason === 'desktop_no_claude' && (
        <>
          <p className="qa-none__p">
            This sidebar runs on your own Claude subscription through Claude Code. Install Claude Code, sign in to it once in a terminal,
            then press Check again.
          </p>
          <div className="qa-none__actions">
            <button type="button" className="q-btn q-btn--primary" onClick={() => void ai.refresh()}>
              Check again
            </button>
          </div>
          <p className="qa-none__p">
            Or add an OpenRouter key in <Link href={AI_ACCESS_PATH}>AI access</Link>.
          </p>
        </>
      )}
      {(reason === 'browser_no_key' || reason === 'no_model') && (
        <>
          <p className="qa-none__p">{SHIP} In the browser, add an OpenRouter key in AI access.</p>
          {reason === 'no_model' && <p className="qa-none__p">Choose a model in AI access.</p>}
        </>
      )}
      {reason === 'server_off' && (
        <p className="qa-none__p">
          {SHIP} In the browser it needs an OpenRouter key, which this server is not set up to store. Ask your Admin, or use the desktop
          app.
        </p>
      )}
      {reason === 'guest' && <p className="qa-none__p">The AI sidebar is for Members.</p>}
      <p className="qa-none__p qa-none__private">
        <LockIcon />
        <span>Conversations are private. Other Members only see answers you Pin.</span>
      </p>
      {(reason === 'browser_no_key' || reason === 'no_model') && (
        <div className="qa-none__actions">
          <Link href={AI_ACCESS_PATH} className="q-btn q-btn--primary qa-none__link">
            Open AI access
          </Link>
        </div>
      )}
    </div>
  )
}
