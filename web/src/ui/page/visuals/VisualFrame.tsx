import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { VISUAL_FRAME_PATH } from '../../../lib'
import { DEFAULT_HEIGHT, parseFrameMessage, readTheme, renderMessage } from './protocol'

type Props = {
  /** The Visual's HTML/JavaScript. It leaves the app only inside the `render` message. */
  source: string
  title: string
  /** Changing it loads the frame again even when the source is the same (the editor's "Run"). */
  run?: number
  /** Create the frame at once instead of when it scrolls near (the editor's preview). */
  eager?: boolean
}

/** How far outside the Page's scroll area a Visual may be when its frame is created. */
const NEAR = '600px 0px'

// The app's theme is `data-theme` on the root element (ui/shell/theme.ts sets it).
function subscribeTheme(changed: () => void) {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}
const themeName = () => document.documentElement.getAttribute('data-theme') ?? ''

/**
 * The sandboxed frame a Visual runs in, and the parent side of its protocol (api.md §13).
 *
 * The source is never put into the app's own document: the frame loads the server's static host
 * page, says `ready`, and is sent the source in a `render` message. Every `ready` from this frame
 * is answered — there is no "already sent" flag that could be wrong after a StrictMode double
 * effect, after React moves the frame in the DOM (which loads it again), or after the frame
 * reloads itself. A Visual that fakes `ready` only gets its own source once more.
 */
export const VisualFrame = memo(function VisualFrame({ source, title, run = 0, eager = false }: Props) {
  const theme = useSyncExternalStore(subscribeTheme, themeName)
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [near, setNear] = useState(() => eager || typeof IntersectionObserver === 'undefined')
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [error, setError] = useState<string | null>(null)

  // "To render again the parent reloads the iframe": a new source, theme or Run gives a new frame.
  const [load, setLoad] = useState({ source, theme, run, n: 0 })
  if (load.source !== source || load.theme !== theme || load.run !== run) {
    setLoad({ source, theme, run, n: load.n + 1 })
    setError(null) // the error and the height belonged to the previous run
    setHeight(DEFAULT_HEIGHT)
  }

  const latest = useRef(source)
  useLayoutEffect(() => {
    latest.current = source
  })

  // A layout effect, so the listener is in place before the new frame can possibly say `ready`.
  useLayoutEffect(() => {
    if (!near) return
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current?.contentWindow
      if (!frame || e.source !== frame) return // only this Visual's own frame is listened to
      const message = parseFrameMessage(e.data)
      if (!message) return
      if (message.type === 'ready') {
        // The frame is sandboxed without `allow-same-origin`, so its origin is opaque ("null") and
        // cannot be named as the target: "*" is the only value that reaches it. The message holds
        // nothing secret — the Visual's own source and the theme colours.
        frame.postMessage(renderMessage(latest.current, readTheme()), '*')
      } else if (message.type === 'height') {
        setHeight(message.value)
      } else {
        setError(message.message)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [near])

  // Lazily: a long Page does not start all its Visuals at once. Once created, a frame stays.
  useEffect(() => {
    const el = hostRef.current
    if (near || !el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { root: el.closest('.qp-scroll'), rootMargin: NEAR },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])

  return (
    <div className="qp-vframe" ref={hostRef}>
      {near ? (
        <iframe
          key={load.n}
          ref={frameRef}
          className="qp-vframe__frame"
          sandbox="allow-scripts"
          src={VISUAL_FRAME_PATH}
          title={`Visual: ${title || 'Untitled'}`}
          style={{ height }}
        />
      ) : (
        <div className="qp-vframe__wait" style={{ height: DEFAULT_HEIGHT }} data-testid="visual-wait" />
      )}
      {error !== null && (
        <p className="qp-vframe__error" role="status">
          This Visual reported an error: {error}
        </p>
      )}
    </div>
  )
})
