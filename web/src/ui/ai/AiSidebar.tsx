import './ai.css'
import { ai, useAi } from '../../lib'
import type { AiScope } from '../../lib'
import { Composer } from './Composer'
import { Header } from './Header'
import { LockIcon } from './icons'
import { Messages } from './Messages'
import { NoAi } from './NoAi'
import { sidebarState } from './state'
import { useScope } from './useScope'
import { BOARD_STARTERS, CARD_STARTERS, sendError } from './words'

const NO_MESSAGES: never[] = []

/**
 * The AI sidebar: a Member's private Conversation with an AI about what they are looking at.
 * A complementary region at the right edge of the shell, on every screen — not a dialog: the rest of the app stays usable.
 * `branch` is the Branch the shell shows, used for the wording until the Board has loaded it.
 */
export function AiSidebar({ branch }: { branch: string }) {
  const snapshot = useAi()
  const { setup, current, busy } = snapshot
  const scope = useScope(branch)
  const ready = setup.provider !== 'none'
  const messages = current?.messages ?? NO_MESSAGES

  return (
    <aside className="qa-side" aria-label="AI" data-tour="ai-sidebar">
      <Header snapshot={snapshot} />
      <p className="qa-private">
        <LockIcon />
        <span>
          <b>Private</b> — only you can see this Conversation. Pin copies an answer into a Page.
        </span>
      </p>
      {setup.provider === 'none' ? (
        <NoAi setup={setup} />
      ) : messages.length === 0 ? (
        <Starters scope={scope.scope} forCard={scope.card !== null} />
      ) : (
        // Keyed by Conversation: opening another one starts at its latest message.
        <Messages key={current?.id} messages={messages} cardId={scope.card?.id ?? null} cardTitle={scope.card?.title ?? ''} busy={busy} />
      )}
      <Composer scope={scope} busy={busy} ready={ready} />
    </aside>
  )
}

/** An empty Conversation: three quiet ways to begin, by scope. */
function Starters({ scope, forCard }: { scope: AiScope | null; forCard: boolean }) {
  return (
    <div className="qa-starters">
      <p className="qa-starters__lead">{forCard ? 'Ask about this Card, or start with one of these.' : 'Ask about this Board, or start with one of these.'}</p>
      <ul className="qa-starters__list">
        {(forCard ? CARD_STARTERS : BOARD_STARTERS).map((text) => (
          <li key={text}>
            <button
              type="button"
              className="qa-starter"
              disabled={scope === null}
              onClick={() => {
                if (!scope) return
                sidebarState.setError('')
                // If it cannot start, the composer says why.
                Promise.resolve(ai.send(text, scope)).catch((e: unknown) => sidebarState.setError(sendError(e)))
              }}
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
