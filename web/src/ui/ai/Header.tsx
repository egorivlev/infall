import { useCallback, useId, useRef, useState } from 'react'
import { ai } from '../../lib'
import type { AiSnapshot } from '../../lib'
import { aiPanel } from '../bridge'
import { formatShortDate } from '../shell/dates'
import { Icon } from '../shell/Icon'
import { useDismiss } from '../shell/useDismiss'
import { CollapseIcon, CrossIcon, ListIcon } from './icons'
import { providerWords } from './words'

/** "AI", what answers, New Conversation, the Conversations menu, and collapse. */
export function Header({ snapshot }: { snapshot: AiSnapshot }) {
  const { setup, busy } = snapshot
  const provider = providerWords(setup)
  const ready = setup.provider !== 'none'
  return (
    <div className="qa-head">
      <h2 className="qa-head__title">AI</h2>
      <span className="qa-head__provider" title={provider.title}>
        {provider.label}
      </span>
      <span className="qa-head__space" />
      {ready && (
        <>
          <button
            type="button"
            className="qa-iconbtn"
            aria-label="New Conversation"
            title={busy ? 'New Conversation (after this answer)' : 'New Conversation'}
            disabled={busy}
            onClick={() => ai.newConversation()}
          >
            <Icon name="plus" size={13} />
          </button>
          <ConversationsMenu snapshot={snapshot} />
        </>
      )}
      <button type="button" className="qa-iconbtn" aria-label="Collapse the AI sidebar" title="Collapse the AI sidebar" onClick={() => aiPanel.close()}>
        <CollapseIcon />
      </button>
    </div>
  )
}

function ConversationsMenu({ snapshot }: { snapshot: AiSnapshot }) {
  const { conversations, current, busy } = snapshot
  const id = useId()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    setConfirming(null)
  }, [])
  useDismiss(open, close, box, trigger)

  return (
    <div className="qa-convs" ref={box}>
      <button
        ref={trigger}
        type="button"
        className="qa-iconbtn"
        aria-label="Conversations"
        title="Conversations"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ListIcon />
      </button>
      {open && (
        <div id={id} className="qa-convs__pop" role="group" aria-label="Conversations">
          <div className="q-caps qa-convs__label">Conversations</div>
          {conversations.length === 0 ? (
            <p className="q-hint qa-convs__empty">No Conversations yet. They are kept on this device only.</p>
          ) : (
            <ul className="qa-convs__list">
              {conversations.map((c) => {
                const title = c.title.trim() || 'New Conversation'
                return (
                  <li key={c.id} className="qa-convs__row">
                    {confirming === c.id ? (
                      <div className="qa-convs__confirm" role="group" aria-label={`Delete the Conversation “${title}”?`}>
                        <span className="qa-convs__ask">Delete this Conversation?</span>
                        <button
                          type="button"
                          className="q-btn q-btn--sm q-btn--danger"
                          autoFocus
                          onClick={() => {
                            ai.remove(c.id)
                            setConfirming(null)
                            trigger.current?.focus()
                          }}
                        >
                          Delete
                        </button>
                        <button type="button" className="q-btn q-btn--sm q-btn--quiet" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="qa-convs__open"
                          aria-current={current?.id === c.id ? 'true' : undefined}
                          disabled={busy}
                          onClick={() => {
                            ai.open(c.id)
                            close()
                            trigger.current?.focus()
                          }}
                        >
                          <span className="qa-convs__title">{title}</span>
                          <span className="qa-convs__date">{formatShortDate(c.updatedAt)}</span>
                        </button>
                        <button
                          type="button"
                          className="qa-iconbtn qa-convs__del"
                          aria-label={`Delete the Conversation “${title}”`}
                          title="Delete this Conversation"
                          disabled={busy && current?.id === c.id}
                          onClick={() => setConfirming(c.id)}
                        >
                          <CrossIcon />
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
