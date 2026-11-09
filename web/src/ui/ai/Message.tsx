import { memo, useState } from 'react'
import { ai, useBoard } from '../../lib'
import type { AiMessage } from '../../lib'
import { pagePanel, suggestionsPanel } from '../bridge'
import { MarkdownView } from '../page/MarkdownView'
import { useOnBoard } from '../shell/useOnBoard'
import { PinIcon } from './icons'
import { sidebarState } from './state'
import { useCopy } from './useCopy'
import { proposed, readTools, scopeLabel, sendError, titleOf } from './words'

const NO_CARD_TITLE = 'Select a Card to pin this to its Page'
const READ_ONLY_TITLE = 'This copy is read-only. Open the Workspace on its server to pin answers.'

/** Asks the question behind a failed answer once more; if that cannot start, the composer says why. */
function retry(messageId: string) {
  sidebarState.setError('')
  Promise.resolve(ai.retry(messageId)).catch((e: unknown) => sidebarState.setError(sendError(e)))
}

/** What the Member asked: a bubble on the right, with what they were looking at when that changed. */
export const UserMessage = memo(function UserMessage({ message, showScope }: { message: AiMessage; showScope: boolean }) {
  return (
    <div className="qa-user">
      <span className="q-sr">You asked</span>
      {showScope && message.scope && <span className="qa-user__scope">{scopeLabel(message.scope)}</span>}
      <div className="qa-bubble">{message.text}</div>
    </div>
  )
})

type AnswerProps = {
  message: AiMessage
  /** The Card in scope right now: where "Pin to Page" would put this answer. */
  cardId: string | null
  cardTitle: string
  /** "Try again" is offered on the last answer only, and not while another is being written. */
  canRetry: boolean
}

/**
 * One answer. Memoised: while an answer streams only that message's object changes, so the others do not render.
 * The text goes through the Page's Markdown renderer and nothing else (no raw HTML, http/https links only).
 */
export const Answer = memo(function Answer({ message, cardId, cardTitle, canRetry }: AnswerProps) {
  const streaming = message.status === 'streaming'
  return (
    // A streaming answer is kept out of the log's announcements; the finished one is a new element, announced once.
    <div className="qa-answer" data-status={message.status} aria-live={streaming ? 'off' : undefined}>
      <span className="q-sr">AI answered</span>
      {message.text !== '' && <MarkdownView text={message.text} />}
      {streaming && <span className="qa-caret" aria-hidden="true" />}
      <Tools tools={message.tools} />
      {message.status === 'error' && (
        <div className="qa-answer__end">
          <span className="qa-answer__error">{message.error || 'The answer could not be completed.'}</span>
          {canRetry && (
            <button type="button" className="q-btn q-btn--sm" onClick={() => retry(message.id)}>
              Try again
            </button>
          )}
        </div>
      )}
      {message.status === 'stopped' && <span className="qa-answer__stopped">Stopped.</span>}
      {message.status === 'done' && <Actions message={message} cardId={cardId} cardTitle={cardTitle} />}
    </div>
  )
})

function Tools({ tools }: { tools: readonly string[] | undefined }) {
  const onBoard = useOnBoard()
  const read = readTools(tools)
  const suggested = proposed(tools)
  if (read.length === 0 && !suggested) return null
  return (
    <div className="qa-tools">
      {read.length > 0 && <span>read: {read.join(', ')}</span>}
      {suggested && (
        <span>
          proposed a Suggestion{' '}
          <button type="button" className="qa-link" onClick={() => onBoard(() => suggestionsPanel.open())}>
            Open Suggestions
          </button>
        </span>
      )}
    </div>
  )
}

function Actions({ message, cardId, cardTitle }: { message: AiMessage; cardId: string | null; cardTitle: string }) {
  const onBoard = useOnBoard()
  const { state: copied, copy } = useCopy()
  const [pinning, setPinning] = useState(false)
  // The failure belongs to the Card it was tried on: it goes away when the scope moves on.
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const pins = message.pinned ?? []
  // M18: a moved copy is read-only; so is the Board then (useBoard().readOnly).
  const readOnly = useBoard().readOnly
  const pinnedHere = cardId !== null && pins.some((p) => p.card === cardId)

  const pin = () => {
    if (cardId === null || pinning) return
    setPinning(true)
    setFailedFor(null)
    ai.pin(message.id, { id: cardId, title: cardTitle }).then(
      () => setPinning(false),
      () => {
        setPinning(false)
        setFailedFor(cardId)
      },
    )
  }

  return (
    <div className="qa-actions">
      {pins.map((p) => (
        <button
          key={p.block}
          type="button"
          className="qa-act qa-act--pinned"
          title="Open this Page"
          onClick={() => onBoard(() => pagePanel.open(p.card))}
        >
          <span aria-hidden="true">✓</span>
          <span className="qa-act__text">Pinned to Page · {titleOf({ title: p.cardTitle })}</span>
        </button>
      ))}
      {cardId === null || readOnly ? (
        // Not `disabled`: it stays reachable by keyboard, and the title (its description) says what is missing.
        <button type="button" className="qa-act qa-act--pin" aria-disabled="true" title={readOnly ? READ_ONLY_TITLE : NO_CARD_TITLE}>
          <PinIcon />
          <span className="qa-act__text">Pin to Page</span>
        </button>
      ) : (
        !pinnedHere && (
          <button type="button" className="qa-act qa-act--pin" disabled={pinning} onClick={pin}>
            <PinIcon />
            <span className="qa-act__text">Pin to Page · {titleOf({ title: cardTitle })}</span>
          </button>
        )
      )}
      <button type="button" className="qa-act qa-act--quiet" onClick={() => void copy(message.text)}>
        {copied === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span className="qa-actions__note" role="status">
        {copied === 'failed'
          ? 'Could not copy. Select the text and copy it by hand.'
          : failedFor !== null && failedFor === cardId
            ? 'That answer could not be pinned. Try again.'
            : ''}
      </span>
    </div>
  )
}
