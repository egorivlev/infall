// Settings (route /settings/<section>): a list of sections on the left, the chosen section's controls on the right.
// Every change applies at once. Appearance and Board are this device's (prefs.ts); AI access is the server's.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { runs, session, useRuns, useWorkspace, workspace } from '../../lib'
import type { Member } from '../../lib'
import { desktopSwitchWorkspace } from '../bridge'
import { saveBytesFile } from '../page/files'
import { describeError, errorStatus, serverSentence } from '../shell/errorMessages'
import { Field } from '../shell/Field'
import { Link } from '../shell/Link'
import { movedWords } from '../shell/moved'
import { settingsPath } from '../shell/router'
import type { SettingsSection } from '../shell/router'
import { clearSigningOut, noteSigningOut } from '../shell/sessionEnd'
import { handsOn, startTour, tourBlock, tutorialHoldsTour, TUTORIAL_PRESET, useHandsOn } from '../tutorial'
import { AiAccess } from './AiAccess'
import { PercentSelect, SectionHead, Segmented, SettingRow } from './controls'
import { BOARD_SCALES, DEFAULT_PREFS, INTERFACE_SCALES, prefs, TEXT_SIZES, usePrefs } from './prefs'
import type { MotionPref, Prefs, ThemePref } from './prefs'
import { SECTION_LABEL, sectionsFor } from './sections'
import './settings.css'

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
]
const MOTION: { value: MotionPref; label: string }[] = [
  { value: 'system', label: 'Match system' },
  { value: 'reduce', label: 'On' },
  { value: 'full', label: 'Off' },
]

const SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘,' : 'Ctrl+,'

export function Settings({ member, section }: { member: Member; section: SettingsSection }) {
  const shown = sectionsFor(member)
  const heading = useRef<HTMLHeadingElement>(null)
  // Choosing a section in the list moves focus to its heading (not on the first visit: focus stays where it was).
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    ;(heading.current ?? document.querySelector<HTMLElement>('.q-set-main h1'))?.focus({ preventScroll: true })
  }, [section])

  return (
    <div className="q-set">
      <nav className="q-set-nav" aria-label="Settings">
        <p className="q-set-nav__title">Settings</p>
        <p className="q-set-nav__hint q-mono">{SHORTCUT}</p>
        <ul className="q-set-nav__list">
          {shown.map((s) => (
            <li key={s}>
              <Link href={settingsPath(s)} className="q-set-nav__item" aria-current={s === section ? 'page' : undefined}>
                {SECTION_LABEL[s]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="q-set-main" data-section={section}>
        {section === 'appearance' && <Appearance headingRef={heading} />}
        {section === 'board' && <BoardSection headingRef={heading} />}
        {/* Keyed by Member: a token shown to one person never survives into another's session. */}
        {section === 'ai' && <AiAccess key={member.id} />}
        {section === 'runs' && <RunsSection headingRef={heading} />}
        {section === 'workspace' && <WorkspaceSection member={member} headingRef={heading} />}
        {section === 'about' && <About member={member} headingRef={heading} />}
      </div>
    </div>
  )
}

type HeadingProps = { headingRef: RefObject<HTMLHeadingElement | null> }

const differs = (p: Prefs, keys: (keyof Prefs)[]) => keys.some((k) => p[k] !== DEFAULT_PREFS[k])

const APPEARANCE: (keyof Prefs)[] = ['theme', 'interfaceScale', 'textSize', 'reduceMotion']

function Appearance({ headingRef }: HeadingProps) {
  const p = usePrefs()
  return (
    <section className="q-settings__inner q-set-section">
      <SectionHead
        title="Appearance"
        intro="Kept on this device only."
        headingRef={headingRef}
        canResetAll={differs(p, APPEARANCE)}
        onResetAll={() => prefs.reset(APPEARANCE)}
      />
      <div className="q-settings__card q-set-card">
        <SettingRow group label="Theme" description="Match system follows the light or dark setting of this computer." changed={p.theme !== DEFAULT_PREFS.theme} onReset={() => prefs.reset(['theme'])}>
          {({ labelId, descriptionId, controlId }) => (
            <Segmented id={controlId} labelId={labelId} descriptionId={descriptionId} value={p.theme} options={THEMES} onChange={(theme) => prefs.set({ theme })} />
          )}
        </SettingRow>
        <SettingRow
          label="Interface scale"
          description="Bars, panels, menus and Page text. The Board keeps its own scale (Board settings)."
          changed={p.interfaceScale !== DEFAULT_PREFS.interfaceScale}
          onReset={() => prefs.reset(['interfaceScale'])}
        >
          {({ descriptionId, controlId }) => (
            <PercentSelect id={controlId} descriptionId={descriptionId} value={p.interfaceScale} steps={INTERFACE_SCALES} defaultValue={DEFAULT_PREFS.interfaceScale} onChange={(interfaceScale) => prefs.set({ interfaceScale })} />
          )}
        </SettingRow>
        <SettingRow
          label="Text size"
          description="Text only — Page, Card and interface text — on top of the interface scale. Visuals keep their own sizes."
          changed={p.textSize !== DEFAULT_PREFS.textSize}
          onReset={() => prefs.reset(['textSize'])}
        >
          {({ descriptionId, controlId }) => (
            <PercentSelect id={controlId} descriptionId={descriptionId} value={p.textSize} steps={TEXT_SIZES} defaultValue={DEFAULT_PREFS.textSize} onChange={(textSize) => prefs.set({ textSize })} />
          )}
        </SettingRow>
        <SettingRow
          group
          label="Reduce motion"
          description="On: menus, panels and messages appear without animation. Match system follows this computer's setting."
          changed={p.reduceMotion !== DEFAULT_PREFS.reduceMotion}
          onReset={() => prefs.reset(['reduceMotion'])}
        >
          {({ labelId, descriptionId, controlId }) => (
            <Segmented id={controlId} labelId={labelId} descriptionId={descriptionId} value={p.reduceMotion} options={MOTION} onChange={(reduceMotion) => prefs.set({ reduceMotion })} />
          )}
        </SettingRow>
      </div>
    </section>
  )
}

function BoardSection({ headingRef }: HeadingProps) {
  const boardScale = usePrefs((s) => s.boardScale)
  return (
    <section className="q-settings__inner q-set-section">
      <SectionHead
        title="Board"
        intro="Kept on this device only."
        headingRef={headingRef}
        canResetAll={boardScale !== DEFAULT_PREFS.boardScale}
        onResetAll={() => prefs.reset(['boardScale'])}
      />
      <div className="q-settings__card q-set-card">
        <SettingRow
          label="Board scale"
          description="How large Cards, Frames and Connections are drawn at the Board's 100%. Zooming with scroll, pinch or the zoom control starts from here."
          changed={boardScale !== DEFAULT_PREFS.boardScale}
          onReset={() => prefs.reset(['boardScale'])}
        >
          {({ descriptionId, controlId }) => (
            <PercentSelect id={controlId} descriptionId={descriptionId} value={boardScale} steps={BOARD_SCALES} defaultValue={DEFAULT_PREFS.boardScale} onChange={(v) => prefs.set({ boardScale: v })} />
          )}
        </SettingRow>
        <dl className="q-set-keys">
          <div>
            <dt>
              <kbd>Shift</kbd> + <kbd>+</kbd>
            </dt>
            <dd>Larger</dd>
          </div>
          <div>
            <dt>
              <kbd>Shift</kbd> + <kbd>−</kbd>
            </dt>
            <dd>Smaller</dd>
          </div>
          <div>
            <dt>
              <kbd>Shift</kbd> + <kbd>0</kbd>
            </dt>
            <dd>Back to 100%</dd>
          </div>
        </dl>
        <p className="q-hint">These keys work on the Board whenever you are not typing in a field.</p>
      </div>
    </section>
  )
}

function RunsSection({ headingRef }: HeadingProps) {
  const runner = useRuns().runner
  return (
    <section className="q-settings__inner q-set-section">
      <SectionHead title="Runs" headingRef={headingRef} intro="Runs execute on your own computer, in the Infall desktop app, through its Runner." />
      <div className="q-settings__card q-set-card q-set-runs">
        {!runner.available && runner.reason === 'loading' && <p className="q-hint" role="status">Looking for the Runner…</p>}
        {!runner.available && runner.reason === 'browser' && (
          <p className="q-set-runs__line">Code can only run in the Infall desktop app. In the browser you can read every Run's captured output.</p>
        )}
        {!runner.available && runner.reason === 'old_app' && <p className="q-set-runs__line">This version of the desktop app cannot run code. Update the app.</p>}
        {runner.available && (
          <>
            <dl className="q-set-facts">
              <div>
                <dt>Python</dt>
                <dd>
                  {runner.python ? (
                    <>
                      <span className="q-mono">{runner.python.version}</span> · <span className="q-mono q-set-path">{runner.python.path}</span>
                    </>
                  ) : (
                    'Not chosen yet'
                  )}
                </dd>
              </div>
              {runner.folder && (
                <div>
                  <dt>Folder</dt>
                  <dd className="q-mono q-set-path">{runner.folder}</dd>
                </div>
              )}
              {runner.languages && (
                <div>
                  <dt>Languages</dt>
                  <dd>
                    {Object.keys(runner.languages).length === 0 ? (
                      'None set up yet'
                    ) : (
                      <ul className="q-set-runs__list" aria-label="Languages on this computer">
                        {Object.entries(runner.languages).map(([id, l]) => (
                          <li key={id}>
                            {l.name.trim() || id}
                            {l.version && <span className="q-mono q-set-runs__version"> {l.version}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              )}
              {runner.languages && (
                <div>
                  <dt>Environments</dt>
                  <dd>
                    {(runner.environments ?? []).length === 0 ? (
                      'Only the default Python'
                    ) : (
                      <ul className="q-set-runs__list" aria-label="Environments on this computer">
                        {(runner.environments ?? []).map((name) => (
                          <li key={name} className="q-mono">
                            {name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <div>
              <button type="button" className="q-btn" onClick={() => void runs.configure()}>
                Open Runner settings
              </button>
            </div>
            <p className="q-hint">
              The Runner's settings open in their own window of the desktop app: the Python, the environments Runs can name, and the languages this computer runs.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

const MAX_NAME = 100
const ROLE_LABEL = { admin: 'Admin', member: 'Member', guest: 'Guest' } as const

function WorkspaceSection({ member, headingRef }: { member: Member } & HeadingProps) {
  const ws = useWorkspace()
  const local = ws.kind === 'local'
  const switchWorkspace = desktopSwitchWorkspace()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function signOut() {
    if (busy) return
    setBusy(true)
    setError('')
    noteSigningOut()
    try {
      await session.logout()
    } catch (e) {
      clearSigningOut()
      setError(describeError(e))
      setBusy(false)
    }
  }

  return (
    <section className="q-settings__inner q-set-section">
      <SectionHead title="Workspace" headingRef={headingRef} />
      <div className="q-settings__card q-set-card">
        <dl className="q-set-facts">
          <div>
            <dt>Kind</dt>
            <dd>{local ? (ws.readOnly ? movedWords(ws.movedTo) : 'Local Workspace, kept on this computer') : <>Team Workspace at <span className="q-mono">{window.location.host}</span></>}</dd>
          </div>
          <div>
            <dt>You</dt>
            <dd>
              {member.name} · {ROLE_LABEL[member.role]}
            </dd>
          </div>
        </dl>
        {/* A moved copy is read-only: its Member's name is not changed here either. */}
        {local && !ws.readOnly && <ChangeName member={member} />}
        <div className="q-set-actions">
          {member.role === 'admin' && !local && (
            <Link href="/members" className="q-btn">
              Members
            </Link>
          )}
          {local && switchWorkspace && (
            <button type="button" className="q-btn" onClick={() => void switchWorkspace().catch(() => {})}>
              Switch workspace…
            </button>
          )}
          {!local && (
            <button type="button" className="q-btn" aria-disabled={busy} onClick={signOut}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          )}
        </div>
        {local && !switchWorkspace && <p className="q-hint">Other Workspaces open from the start screen of the Infall app.</p>}
        {error && (
          <p className="q-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!local && member.role === 'admin' && <ExportWorkspace />}
    </section>
  )
}

/** M18 (team-move.md, decision 5): an Admin takes the Team Workspace out as a Workspace file. */
function ExportWorkspace() {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string } | { kind: 'failed'; text: string }>({ kind: 'idle' })
  const busy = state.kind === 'busy'

  async function run() {
    if (busy) return
    setState({ kind: 'busy' })
    try {
      const file = await workspace.exportFile()
      const saved = await saveBytesFile(file.name, file.bytes, 'application/octet-stream')
      setState(
        saved === 'cancelled'
          ? { kind: 'idle' }
          : { kind: 'done', text: saved === 'saved' ? `Exported “${file.name}”.` : `Downloaded “${file.name}”.` },
      )
    } catch (e) {
      setState({ kind: 'failed', text: `The Workspace file could not be exported. ${serverSentence(e)}` })
    }
  }

  return (
    <div className="q-settings__card q-set-card" aria-labelledby="q-set-export-h" role="group">
      <h2 className="q-panel-title" id="q-set-export-h">
        Workspace file
      </h2>
      <p className="q-hint">
        One file with every Branch, the history, Checkpoints, To-dos and Comments. Members come as names only — no emails, passwords, invites, access tokens or AI keys. It can go onto
        another empty Team server, or open in the desktop app as a Local Workspace.
      </p>
      <div className="q-set-actions">
        <button type="button" className="q-btn" aria-disabled={busy} aria-busy={busy} onClick={() => void run()}>
          {busy ? 'Exporting…' : 'Export Workspace file…'}
        </button>
      </div>
      <p className={state.kind === 'failed' ? 'q-error' : 'q-hint'} role={state.kind === 'failed' ? 'alert' : 'status'}>
        {state.kind === 'done' || state.kind === 'failed' ? state.text : ''}
      </p>
    </div>
  )
}

/** "Change name" in a Local Workspace (there is no account to change it on elsewhere). */
function ChangeName({ member }: { member: Member }) {
  const [name, setName] = useState(member.name)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const check = (v: string) => (v.trim() === '' ? 'Enter a name.' : [...v.trim()].length > MAX_NAME ? 'A name is at most 100 characters long.' : '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const problem = check(name)
    setError(problem)
    setDone(false)
    if (problem || name.trim() === member.name) return
    setBusy(true)
    try {
      await workspace.rename(name)
      setDone(true)
    } catch (err) {
      setError(errorStatus(err) === 400 ? 'A name is 1 to 100 characters long.' : describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="q-settings__form" onSubmit={submit} noValidate>
      <Field
        label="Your name"
        name="name"
        autoComplete="name"
        value={name}
        error={error || undefined}
        hint={done ? 'Name changed.' : 'Shown beside everything you change.'}
        onChange={(v) => {
          setName(v)
          setDone(false)
          if (error) setError(check(v))
        }}
      />
      <button type="submit" className="q-btn q-settings__submit" aria-disabled={busy}>
        {busy ? 'Changing…' : 'Change name'}
      </button>
    </form>
  )
}

function desktopVersion(): string | null {
  const desk = (globalThis as { qoopDesktop?: { version?: unknown } }).qoopDesktop
  return typeof desk === 'object' && desk !== null && typeof desk.version === 'string' && desk.version ? desk.version : null
}

const LICENCES = [
  { font: 'IBM Plex Sans', file: '/licenses/LICENSE-IBM-Plex-Sans.txt' },
  { font: 'IBM Plex Mono', file: '/licenses/LICENSE-IBM-Plex-Mono.txt' },
  { font: 'Source Serif 4', file: '/licenses/LICENSE-Source-Serif-4.txt' },
]

/** M19: the PDF reader's renderer and what it ships with. */
const SOFTWARE = [
  { name: 'PDF.js', note: 'Apache License 2.0', file: '/licenses/LICENSE-pdf.js.txt' },
  { name: 'PDF.js standard fonts (Foxit, Liberation)', note: 'their own licences', file: '/licenses/LICENSE-pdf.js-fonts.txt' },
  { name: 'PDF.js image decoders (OpenJPEG, PDFium JBIG2)', note: 'BSD licences', file: '/licenses/LICENSE-pdf.js-decoders.txt' },
]

function About({ member, headingRef }: { member: Member } & HeadingProps) {
  const ws = useWorkspace()
  const tutorialWorkspace = ws.kind === 'local' && ws.preset === TUTORIAL_PRESET
  const lesson = useHandsOn((s) => s.phase)
  const showTour = !tutorialWorkspace || !tutorialHoldsTour(lesson)
  const version = desktopVersion()
  const blocked = tourBlock()
  return (
    <section className="q-settings__inner q-set-section">
      <SectionHead title="About" headingRef={headingRef} />
      <div className="q-settings__card q-set-card">
        <dl className="q-set-facts">
          <div>
            <dt>Infall</dt>
            <dd>{version ? <>Desktop app <span className="q-mono">{version}</span></> : 'In a browser'}</dd>
          </div>
        </dl>
        <div className="q-set-actions">
          {tutorialWorkspace && (
            <button type="button" className="q-btn" aria-disabled={lesson === 'off' || lesson === 'loading'} onClick={() => lesson !== 'off' && lesson !== 'loading' && handsOn.resume()}>
              Tutorial
            </button>
          )}
          {showTour && (
            <button
              type="button"
              className="q-btn"
              aria-disabled={blocked !== null}
              title={blocked === 'narrow' ? 'Make the window wider to take the tour' : undefined}
              onClick={() => blocked === null && startTour(member)}
            >
              Tour of Infall
            </button>
          )}
        </div>
      </div>
      <div className="q-settings__card q-set-card">
        <h2 className="q-panel-title">Font licences</h2>
        <p className="q-hint">All three fonts are under the SIL Open Font License 1.1.</p>
        <ul className="q-settings__list">
          {LICENCES.map((l) => (
            <li key={l.file}>
              <a href={l.file} target="_blank" rel="noreferrer noopener">
                {l.font}
              </a>
            </li>
          ))}
        </ul>
      </div>
      <div className="q-settings__card q-set-card">
        <h2 className="q-panel-title">Software licences</h2>
        <p className="q-hint">PDFs are read with PDF.js, which comes with Infall: nothing is fetched from the internet to show them.</p>
        <ul className="q-settings__list">
          {SOFTWARE.map((l) => (
            <li key={l.file}>
              <a href={l.file} target="_blank" rel="noreferrer noopener">
                {l.name}
              </a>{' '}
              <span className="q-hint">— {l.note}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
