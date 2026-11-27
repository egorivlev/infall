// M18 (team-move.md, decision 4): an empty Team server greets its Admin with a choice — Start empty, or Bring in a
// Workspace file. When the desktop app is handing over a move to this server, the file is already there: one press.
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { board, branches, comments, forYou, todos, useMembers, workspace } from '../../lib'
import type { ImportResult } from '../../lib'
import { desktopMove } from '../bridge'
import { serverSentence } from './errorMessages'
import { initials } from './initials'
import { Link } from './Link'
import { formatSize, useFirstScreen } from './moved'
import { navigate } from './router'

type Stage =
  | { kind: 'choose' }
  | { kind: 'sending'; what: string; sent: number; total: number }
  | { kind: 'failed'; text: string; fromDesktop: boolean }
  | { kind: 'done'; result: ImportResult }

/** After the file is in: the Board, its Branches, To-dos, Comments and mentions are fetched again. */
function reloadEverything() {
  void Promise.resolve(board.open('main')).catch(() => {})
  void Promise.resolve(branches.reload()).catch(() => {})
  void Promise.resolve(todos.reload()).catch(() => {})
  void Promise.resolve(comments.reloadCounts()).catch(() => {})
  void Promise.resolve(forYou.reload()).catch(() => {})
}

export function FirstScreen() {
  const [stage, setStage] = useState<Stage>({ kind: 'choose' })
  const [handover, setHandover] = useState<{ name: string; size: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stop = useRef<AbortController | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const move = desktopMove()

  useEffect(() => {
    useFirstScreen.setState({ holding: true })
  }, [])
  useEffect(() => () => stop.current?.abort(), [])

  // A move started in the desktop app: ask once what it holds for this server.
  useEffect(() => {
    const bridge = desktopMove()
    if (!bridge) return
    let stale = false
    bridge.handover().then(
      (h) => {
        if (!stale && h && typeof h.name === 'string') setHandover({ name: h.name, size: Number(h.size) || 0 })
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [])

  useEffect(() => {
    if (stage.kind === 'done' || stage.kind === 'failed') headingRef.current?.focus({ preventScroll: true })
  }, [stage.kind])

  async function send(what: string, file: () => Promise<Blob | Uint8Array>, fromDesktop: boolean) {
    const control = new AbortController()
    stop.current = control
    setStage({ kind: 'sending', what, sent: 0, total: 0 })
    try {
      const bytes = await file()
      const total = bytes instanceof Uint8Array ? bytes.byteLength : bytes.size
      setStage({ kind: 'sending', what, sent: 0, total })
      const result = await workspace.importFile(bytes, {
        signal: control.signal,
        onProgress: (sent, all) => !control.signal.aborted && setStage({ kind: 'sending', what, sent, total: all || total }),
      })
      if (fromDesktop) await move?.done({ ok: true }).catch(() => {})
      useFirstScreen.setState({ imported: true })
      setStage({ kind: 'done', result })
      reloadEverything()
    } catch (e) {
      if (fromDesktop) await move?.done({ ok: false }).catch(() => {})
      if ((e as { code?: unknown } | null)?.code === 'aborted') return setStage({ kind: 'choose' })
      setStage({ kind: 'failed', text: serverSentence(e), fromDesktop })
    } finally {
      if (stop.current === control) stop.current = null
    }
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again after a failure
    if (file) void send(file.name, async () => file, false)
  }

  const pick = () => fileRef.current?.click()
  const startEmpty = () => {
    useFirstScreen.setState({ holding: false })
    workspace.startEmpty()
  }
  const goOn = () => {
    useFirstScreen.setState({ holding: false })
    navigate('/')
  }

  const unclaimed = stage.kind === 'done' ? stage.result.members.filter((m) => !m.claimed) : []
  // Their colours, once the Members are read again after the import; until then a neutral disc.
  const colors = new Map(useMembers().map((m) => [m.id, m.color]))
  const percent = stage.kind === 'sending' && stage.total > 0 ? Math.min(100, Math.round((stage.sent / stage.total) * 100)) : null

  const host = window.location.host
  const where = (
    <p className="q-lab q-first__where">
      Team Workspace · <span className="q-mono">{host}</span>
    </p>
  )

  return (
    <div className="q-first" data-testid="first-screen">
      <div className="q-first__card">
        {stage.kind === 'done' ? (
          <>
            {where}
            <h1 className="q-title q-first__title" ref={headingRef} tabIndex={-1}>
              The Workspace is in
            </h1>
            <p className="q-first__text" role="status">
              {stage.result.you_were ? `Your earlier work as ${stage.result.you_were} is now yours.` : 'Your earlier work is now yours.'}
            </p>
            {unclaimed.length > 0 && (
              <section className="q-card q-first__names" aria-labelledby="q-first-names-h">
                <div>
                  <h2 className="q-first__names-h" id="q-first-names-h">
                    Names that came with the file
                  </h2>
                  <p className="q-first__line">Each person signs in by taking over their name. Invite them with their email, and their Changes and To-dos become theirs.</p>
                </div>
                <ul className="q-first__list">
                  {unclaimed.map((m) => (
                    <li key={m.id} className="q-first__name">
                      <span className="q-avatar q-first__avatar" style={{ background: colors.get(m.id) ?? 'var(--q-hover)' }} aria-hidden="true">
                        {initials(m.name)}
                      </span>
                      <span className="q-first__who">
                        {m.name} <span className="q-first__unclaimed">· not signed in yet</span>
                      </span>
                      <Link href={`/members?claim=${encodeURIComponent(m.id)}`} className="q-btn q-btn--sm q-btn--soft" aria-label={`Invite ${m.name}`} onClick={() => useFirstScreen.setState({ holding: false })}>
                        Invite
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="q-first__actions">
              <button type="button" className="q-btn q-btn--primary q-btn--lg" onClick={goOn}>
                Open the Board
              </button>
            </div>
          </>
        ) : (
          <>
            {where}
            <h1 className="q-title q-first__title" ref={headingRef} tabIndex={-1}>
              Set up this Team Workspace
            </h1>
            <p className="q-first__text">
              Nothing is here yet. Start with an empty Board, or bring in a Workspace you already have, from the desktop app or another server, as a Workspace file.
            </p>
            {stage.kind === 'sending' ? (
              <div className="q-card q-progress q-first__progress">
                <p className="q-progress__what q-first__sending" id="q-first-sending">
                  Bringing in {stage.what}…
                </p>
                <div
                  className={percent !== null && percent < 100 ? 'q-progress__bar' : 'q-progress__bar q-progress__bar--still'}
                  role="progressbar"
                  aria-labelledby="q-first-sending"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                  aria-valuetext={percent === null ? 'Starting' : percent >= 100 ? 'Sent; the server is reading the file' : `${percent} %`}
                >
                  {/* At 100 % the line is not left full: it becomes the still track, and the words say what happens. */}
                  {percent !== null && percent < 100 && <span className="q-progress__fill" style={{ width: `${percent}%` }} />}
                </div>
                <div className="q-progress__foot">
                  <span className="q-progress__said" aria-hidden="true">
                    {percent === null ? '…' : percent >= 100 ? 'Sent. The server is reading the file…' : `${formatSize(stage.sent)} of ${formatSize(stage.total)}`}
                  </span>
                  <button type="button" className="q-btn q-btn--sm q-btn--soft q-first__stop" onClick={() => stop.current?.abort()}>
                    Stop
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* One option per row: what it does, then one short button. Exactly one primary (M17, B2). */}
                <div className="q-card q-card--rows q-first__options">
                  {handover && (
                    <div className="q-first__option">
                      <div className="q-first__about">
                        <p className="q-first__name-of" id="q-first-move">
                          {handover.name}
                        </p>
                        <p className="q-first__line" id="q-first-move-line">
                          From this computer, {formatSize(handover.size)}. The move you started in the desktop app.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="q-btn q-btn--primary q-btn--lg"
                        aria-label={`Bring in ${handover.name} from this computer (${formatSize(handover.size)})`}
                        aria-describedby="q-first-move-line"
                        onClick={() => void send(handover.name, () => move!.file(), true)}
                      >
                        Bring in this Workspace
                      </button>
                    </div>
                  )}
                  <div className="q-first__option">
                    <div className="q-first__about">
                      <p className="q-first__name-of">Bring in a Workspace file</p>
                      <p className="q-first__line" id="q-first-file-line">
                        A file ending in .infall, exported from the desktop app or from another Team server.
                      </p>
                    </div>
                    <button type="button" className={handover ? 'q-btn q-btn--soft q-btn--lg' : 'q-btn q-btn--primary q-btn--lg'} aria-describedby="q-first-file-line" onClick={pick}>
                      Bring in a Workspace file…
                    </button>
                  </div>
                  <div className="q-first__option">
                    <div className="q-first__about">
                      <p className="q-first__name-of">Start empty</p>
                      <p className="q-first__line" id="q-first-empty-line">
                        One empty Board on the Branch main.
                      </p>
                    </div>
                    <button type="button" className="q-btn q-btn--soft q-btn--lg" aria-describedby="q-first-empty-line" onClick={startEmpty}>
                      Start empty
                    </button>
                  </div>
                </div>
                <input ref={fileRef} type="file" className="q-sr" tabIndex={-1} aria-label="Workspace file" accept=".infall,application/octet-stream" onChange={onPick} />
                {stage.kind === 'failed' && (
                  <p className="q-error q-first__error" role="alert">
                    {/* The app handed the file over: there was no file to choose, so only trying again is offered. */}
                    {stage.text} {stage.fromDesktop ? 'Try again, or bring in a Workspace file exported from the desktop app.' : 'Choose another file, or try again.'}
                  </p>
                )}
                <p className="q-hint">
                  A Workspace file brings every Branch, its history, Checkpoints, To-dos and Comments. Its Members come as names; you invite each person to take theirs over.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
