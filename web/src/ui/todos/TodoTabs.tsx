import { Link } from '../shell/Link'
import { FOR_YOU_PATH, TODOS_PATH } from '../shell/router'

/** To-dos and For you, side by side: two places, so links (with the one shown marked), not a tab widget. */
export function TodoTabs({ current, unseen }: { current: 'todos' | 'for-you'; unseen: number }) {
  return (
    <nav className="qt-tabs" aria-label="To-dos and mentions">
      <Link href={TODOS_PATH} className="qt-tabs__tab" aria-current={current === 'todos' ? 'page' : undefined}>
        To-dos
      </Link>
      <Link href={FOR_YOU_PATH} className="qt-tabs__tab" aria-current={current === 'for-you' ? 'page' : undefined} aria-label={`For you, ${unseen} unseen`}>
        For you
        {unseen > 0 && (
          <span className="qt-tabs__badge" aria-hidden="true">
            {unseen}
          </span>
        )}
      </Link>
    </nav>
  )
}
