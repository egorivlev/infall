// M18: For you — the Comments that mention you, newest first, beside To-dos (the same screen pattern). Opening one
// opens that Card's Page at the Comment and marks the mentions up to it as seen.
import { useEffect, useState } from 'react'
import { forYou, useBoard, useForYou, useMembers, useWorkspace } from '../../lib'
import type { Member } from '../../lib'
import { formatWhen } from '../history/format'
import { firstName, memberName } from '../page/people'
import { initials } from '../shell/initials'
import { useDelayedFlag } from '../shell/useDelayedFlag'
import { cardWords, useOpenMention } from './openMention'
import { TodoTabs } from './TodoTabs'
import './todos.css'

export function ForYou({ me }: { me: Member }) {
  const snap = useForYou()
  const people = useMembers()
  const board = useBoard()
  const open = useOpenMention()
  const readOnly = useWorkspace().readOnly === true
  const [failed, setFailed] = useState('')

  useEffect(() => {
    void Promise.resolve(forYou.reload()).catch(() => setFailed('The mentions could not be loaded.'))
  }, [])

  const waiting = snap.status !== 'ready' && snap.items.length === 0 && failed === ''
  const showLoading = useDelayedFlag(waiting, 150)
  const newest = snap.items.find((i) => !i.seen)

  const retry = () => {
    setFailed('')
    void Promise.resolve(forYou.reload()).catch(() => setFailed('The mentions could not be loaded.'))
  }
  const markAll = () => {
    const first = snap.items[0]
    if (first) void Promise.resolve(forYou.seen(first.comment)).catch(() => setFailed('The mentions could not be marked as seen. Try again.'))
  }

  return (
    <div className="qt qf">
      <header className="qt__head">
        <TodoTabs current="for-you" unseen={snap.unseen} />
        {/* The tab above names the screen; the heading is for screen readers (it read twice). */}
        <h1 className="qt__title q-sr">For you</h1>
        <span className="qt__count">
          {snap.unseen} unseen · {snap.items.length} {snap.items.length === 1 ? 'mention' : 'mentions'}
        </span>
        <span className="qt__grow" />
        {newest && !readOnly && (
          <button type="button" className="q-btn q-btn--sm" onClick={markAll}>
            Mark all as seen
          </button>
        )}
      </header>
      {failed && (
        <p className="qt__note q-error" role="alert">
          {failed}{' '}
          <button type="button" className="qt-ctl" onClick={retry}>
            Try again
          </button>
        </p>
      )}
      {waiting ? (
        showLoading && (
          <p className="qt__loading" role="status">
            Loading mentions…
          </p>
        )
      ) : snap.items.length === 0 && !failed ? (
        <div className="qf__empty">
          <p className="qf__empty-title">No mentions yet</p>
          <p className="q-hint">When a Member writes @{me.name} in a Comment, it shows here, newest first.</p>
        </div>
      ) : (
        <ol className="qf__list" aria-label="Mentions, newest first">
          {snap.items.map((item) => {
            const author = memberName(people, item.author)
            const who = people.find((m) => m.id === item.author)
            const where = cardWords(item.card, board.cards)
            return (
              <li key={item.comment}>
                <button type="button" className={item.seen ? 'qf-item' : 'qf-item is-new'} onClick={() => open(item)}>
                  <span className="q-avatar qf-item__avatar" style={{ background: who?.color ?? 'var(--q-ink-3)' }} aria-hidden="true">
                    {initials(author.name)}
                  </span>
                  <span className="qf-item__text">
                    <span className="qf-item__line">
                      <b>{firstName(author.name)}</b> mentioned you on {where}
                    </span>
                    <span className="qf-item__when">{formatWhen(item.at)}</span>
                  </span>
                  {!item.seen && (
                    <span className="qf-item__new">
                      <span className="qf-item__dot" aria-hidden="true" />
                      New
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
