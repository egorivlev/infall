import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiMessage, AiScope } from '../../lib'
import { Answer, UserMessage } from './Message'
import { sameScope } from './words'

/** How close to the end still counts as "at the bottom". */
const NEAR = 32

type Props = {
  messages: readonly AiMessage[]
  cardId: string | null
  cardTitle: string
  busy: boolean
}

/**
 * The Conversation. The view follows a growing answer only while the Member is at the bottom;
 * once they scroll up it stays put and offers "Jump to latest".
 */
export function Messages({ messages, cardId, cardTitle, busy }: Props) {
  const log = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const seen = useRef(0)
  const [away, setAway] = useState(false)

  useLayoutEffect(() => {
    const el = log.current
    if (!el) return
    // Asking something new brings the Member back to the latest.
    if (messages.slice(seen.current).some((m) => m.role === 'user')) {
      following.current = true
      setAway(false)
    }
    seen.current = messages.length
    if (following.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = useCallback(() => {
    const el = log.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR
    following.current = atBottom
    setAway(!atBottom)
  }, [])

  const jump = () => {
    const el = log.current
    if (!el) return
    following.current = true
    setAway(false)
    el.scrollTop = el.scrollHeight
    el.focus({ preventScroll: true }) // the button is about to go away
  }

  const rows: ReactNode[] = []
  let asked: AiScope | undefined
  let first = true
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      rows.push(<UserMessage key={m.id} message={m} showScope={first || !sameScope(asked, m.scope)} />)
      asked = m.scope
      first = false
      return
    }
    const last = i === messages.length - 1
    rows.push(
      <Answer
        // A finished answer is a new element in the log, so it is announced once, whole; its deltas never are.
        key={m.status === 'streaming' ? `${m.id}:streaming` : m.id}
        message={m}
        cardId={cardId}
        cardTitle={cardTitle}
        canRetry={last && !busy}
      />,
    )
  })

  return (
    <div className="qa-body">
      <div className="qa-log" ref={log} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0} onScroll={onScroll}>
        {rows}
      </div>
      {away && (
        <button type="button" className="q-btn q-btn--sm qa-jump" onClick={jump}>
          Jump to latest
        </button>
      )}
    </div>
  )
}
