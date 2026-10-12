import { memo, useRef, useState } from 'react'
import { ops, useMembers, useSession } from '../../lib'
import type { BlockVM } from '../../lib'
import { useBoardActions } from '../board/useBoardActions'
import { formatShortDate } from '../shell/dates'
import { memberName } from './people'

type Ai = NonNullable<BlockVM['ai']>

/** A Member's name as written — or the plain words that stand in for one. */
function Who({ id }: { id: string }) {
  const { name, known } = memberName(useMembers(), id)
  return known ? <span className="qp-pin__name">{name}</span> : <>{name}</>
}

/**
 * The strip above a Block pinned from an AI Conversation. It comes first in the document, so a
 * screen reader says "AI-generated" before any of the text below it.
 */
export const PinHead = memo(function PinHead({ ai }: { ai: Ai }) {
  return (
    <div className="qp-pin__head">
      <span className="qp-pin__chip">AI-generated</span>
      <span className="q-sr"> by </span>
      <span className="qp-pin__model">{ai.model || 'unknown model'}</span>
      <span className="qp-pin__space" />
      <svg className="qp-pin__glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <path d="M4.5 1.5 H7.5 L7 5 L9 7 H3 L5 5 Z M6 7 V11" />
      </svg>
      <span className="qp-pin__by">
        Pinned by <Who id={ai.pinnedBy} /> · <time dateTime={new Date(ai.pinnedAt).toISOString()}>{formatShortDate(ai.pinnedAt)}</time>
      </span>
    </div>
  )
})

/** Under the text: whether a Member has reviewed it. Any Member who can change the Page can say they have. */
export const PinFoot = memo(function PinFoot({ block, ai, canReview }: { block: string; ai: Ai; canReview: boolean }) {
  const session = useSession()
  const actions = useBoardActions()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const me = session.status === 'signed_in' && session.member.role !== 'guest' ? session.member.id : null

  if (ai.reviewedBy) {
    return (
      <p className="qp-pin__foot">
        <span role="status">
          Reviewed by <Who id={ai.reviewedBy} />.
        </span>
      </p>
    )
  }

  const review = async () => {
    if (!me || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    await actions.submit([ops.markReviewed(block, me)])
    busyRef.current = false
    setBusy(false)
  }

  return (
    <p className="qp-pin__foot">
      <span role="status">Not reviewed by a Member.</span>
      {canReview && me && (
        <button type="button" className="qp-pin__review" aria-disabled={busy} onClick={() => void review()}>
          Mark reviewed
        </button>
      )}
    </p>
  )
})
