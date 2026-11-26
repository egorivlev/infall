// M18: the short notice when someone mentions you while you are here (decision 9). One at a time, for 8 s; it
// stays while hovered or focused. Announced politely; "Open" goes to the Comment.
import { useEffect, useRef, useState } from 'react'
import { forYou, useBoard, useMembers } from '../../lib'
import type { ForYouItem } from '../../lib'
import { firstName, memberName } from '../page/people'
import { MentionSnippet } from '../todos/MentionSnippet'
import { cardWords, useOpenMention } from '../todos/openMention'

export const NOTICE_MS = 8000

export function MentionNotice() {
  const [item, setItem] = useState<ForYouItem | null>(null)
  const [held, setHeld] = useState(false)
  const people = useMembers()
  const cards = useBoard().cards
  const open = useOpenMention()
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => forYou.onMention((i) => setItem(i)), [])
  useEffect(() => {
    window.clearTimeout(timer.current)
    if (item && !held) timer.current = window.setTimeout(() => setItem(null), NOTICE_MS)
    return () => window.clearTimeout(timer.current)
  }, [item, held])

  return (
    <div className="q-notice-region" role="status" aria-live="polite">
      {item && (
        <div
          className="q-notice"
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <span className="q-notice__text">
            <b>{firstName(memberName(people, item.author).name)}</b> mentioned you on {cardWords(item.card, cards)}.
            <MentionSnippet snippet={item.snippet} className="q-notice__snippet" />
          </span>
          <button
            type="button"
            className="q-btn q-btn--sm"
            onClick={() => {
              setItem(null)
              setHeld(false)
              open(item)
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="q-notice__close"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => {
              setItem(null)
              setHeld(false)
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
