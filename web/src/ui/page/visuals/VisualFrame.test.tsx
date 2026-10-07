// The frame host. jsdom loads nothing into an iframe, so the frame's side of the protocol is
// played by hand: messages are dispatched with `source` set to the iframe's own window, and what
// the parent sends is seen by spying on that window's postMessage.
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib', () => ({ VISUAL_FRAME_PATH: '/visual-frame' }))

const { VisualFrame } = await import('./VisualFrame')

const SOURCE = '<p id="hello">Hello</p><script>document.title = "ran"</script>'
const root = document.documentElement

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  root.removeAttribute('data-theme')
  root.removeAttribute('style')
})

const frame = (title = 'Visual: Bloch sphere') => screen.getByTitle<HTMLIFrameElement>(title)
const win = (f: HTMLIFrameElement) => f.contentWindow as Window
const spyOn = (f: HTMLIFrameElement) => vi.spyOn(win(f), 'postMessage').mockImplementation(() => {})
/** A message arriving at the app's window, as if posted by `source` (default: the frame itself). */
const say = (f: HTMLIFrameElement, data: unknown, source: Window | null = win(f)) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })
const ready = (f: HTMLIFrameElement) => say(f, { qoop: 'visual', type: 'ready' })
const open = (source = SOURCE) => render(<VisualFrame source={source} title="Bloch sphere" />)

describe('VisualFrame: the frame', () => {
  it('is the sandboxed host page, exactly as the protocol says', () => {
    open()
    const f = frame()
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('src')).toBe('/visual-frame')
    expect(f.getAttribute('title')).toBe('Visual: Bloch sphere')
    expect(f.hasAttribute('srcdoc')).toBe(false)
    expect(f.hasAttribute('allow')).toBe(false)
  })

  it('names a Visual without a title "Untitled"', () => {
    render(<VisualFrame source={SOURCE} title="" />)
    expect(frame('Visual: Untitled')).toBeInTheDocument()
  })

  it('never puts the source into the app’s own document', () => {
    open()
    ready(frame())
    expect(document.documentElement.innerHTML).not.toContain('Hello')
    expect(document.getElementById('hello')).toBeNull()
    expect(document.title).not.toBe('ran')
  })

  it('is 240px high until the frame says otherwise', () => {
    open()
    expect(frame().style.height).toBe('240px')
  })
})

describe('VisualFrame: ready → render', () => {
  it('answers ready with one render: the source and the theme, to target "*"', () => {
    root.style.setProperty('--q-ink', 'oklch(0.94 0.006 255)')
    root.style.setProperty('--q-accent', 'oklch(0.80 0.10 195)')
    open()
    const post = spyOn(frame())
    expect(post).not.toHaveBeenCalled() // nothing is sent before the frame asks
    ready(frame())
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      {
        qoop: 'visual',
        type: 'render',
        html: SOURCE,
        theme: { '--q-ink': 'oklch(0.94 0.006 255)', '--q-accent': 'oklch(0.80 0.10 195)', 'color-scheme': 'dark' },
      },
      '*',
    )
  })

  it('sends the light colour scheme under the light theme', () => {
    root.setAttribute('data-theme', 'light')
    open()
    const post = spyOn(frame())
    ready(frame())
    expect(post.mock.calls[0]![0]).toMatchObject({ theme: { 'color-scheme': 'light' } })
  })

  it('answers a frame that loads again (React moved it, or it reloaded itself) once more', () => {
    open()
    const post = spyOn(frame())
    ready(frame())
    ready(frame())
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![0]).toMatchObject({ type: 'render', html: SOURCE })
  })

  it('under StrictMode a ready still gets exactly one render, and none after unmount', () => {
    const { unmount } = render(
      <StrictMode>
        <VisualFrame source={SOURCE} title="Bloch sphere" />
      </StrictMode>,
    )
    const f = frame()
    const post = spyOn(f)
    ready(f)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]![0]).toMatchObject({ type: 'render', html: SOURCE })
    const w = win(f)
    unmount()
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { qoop: 'visual', type: 'ready' }, source: w }))
    })
    expect(post).toHaveBeenCalledTimes(1) // the listener went with the component
  })
})

describe('VisualFrame: what it does not listen to', () => {
  it('ignores messages from any other source', () => {
    open()
    render(<VisualFrame source="<p>other</p>" title="Other" />)
    const f = frame()
    const other = frame('Visual: Other')
    const post = spyOn(f)
    const postOther = spyOn(other)
    say(f, { qoop: 'visual', type: 'ready' }, window) // the app's own window
    say(f, { qoop: 'visual', type: 'ready' }, null) // no source at all
    say(f, { qoop: 'visual', type: 'height', value: 500 }, window)
    say(f, { qoop: 'visual', type: 'error', message: 'not mine' }, null)
    expect(post).not.toHaveBeenCalled()
    expect(postOther).not.toHaveBeenCalled()
    expect(f.style.height).toBe('240px')
    expect(screen.queryByRole('status')).toBeNull()

    // Another Visual's frame speaks for itself only.
    say(f, { qoop: 'visual', type: 'ready' }, win(other))
    say(f, { qoop: 'visual', type: 'height', value: 500 }, win(other))
    expect(post).not.toHaveBeenCalled()
    expect(postOther).toHaveBeenCalledTimes(1)
    expect(postOther.mock.calls[0]![0]).toMatchObject({ html: '<p>other</p>' })
    expect(f.style.height).toBe('240px')
    expect(other.style.height).toBe('500px')
  })

  it('ignores messages of the wrong shape, even from its own frame', () => {
    open()
    const f = frame()
    const post = spyOn(f)
    for (const data of [
      null,
      'ready',
      { type: 'ready' },
      { qoop: 'other', type: 'ready' },
      { qoop: 'visual' },
      { qoop: 'visual', type: 'render', html: '<p>evil</p>', theme: {} },
      { qoop: 'visual', type: 'height', value: '500' },
      { qoop: 'visual', type: 'height', value: NaN },
      { qoop: 'visual', type: 'height', value: Infinity },
      { qoop: 'visual', type: 'error', message: { html: '<b>x</b>' } },
      { qoop: 'visual', type: 'error' },
    ]) {
      say(f, data)
    }
    expect(post).not.toHaveBeenCalled()
    expect(f.style.height).toBe('240px')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('VisualFrame: height', () => {
  it('follows the frame, clamped to 80–900px', () => {
    open()
    const f = frame()
    const height = (value: unknown) => {
      say(f, { qoop: 'visual', type: 'height', value })
      return f.style.height
    }
    expect(height(312)).toBe('312px')
    expect(height(300.4)).toBe('301px')
    expect(height(10)).toBe('80px')
    expect(height(0)).toBe('80px')
    expect(height(-5)).toBe('80px')
    expect(height(5000)).toBe('900px')
    expect(height('120')).toBe('900px') // not a number: ignored, the last good height stays
    expect(height(420)).toBe('420px')
  })
})

describe('VisualFrame: error', () => {
  it('shows a quiet strip under the frame, and the frame stays', () => {
    open()
    say(frame(), { qoop: 'visual', type: 'error', message: 'ReferenceError: theta is not defined' })
    expect(screen.getByRole('status')).toHaveTextContent('This Visual reported an error: ReferenceError: theta is not defined')
    expect(frame()).toBeInTheDocument()
  })

  it('cuts the message to 300 characters and shows markup as text', () => {
    open()
    const markup = '<img src=x onerror="alert(1)">'
    say(frame(), { qoop: 'visual', type: 'error', message: markup + 'y'.repeat(1000) })
    const strip = screen.getByRole('status')
    expect(strip.querySelector('img')).toBeNull()
    expect(strip.textContent).toBe(`This Visual reported an error: ${markup}${'y'.repeat(300 - markup.length)}`)
  })
})

describe('VisualFrame: rendering again means loading again', () => {
  it('loads a new frame when the source changes, and sends it the new source', () => {
    const { rerender } = open()
    const first = frame()
    const firstWindow = win(first)
    const postFirst = spyOn(first)
    ready(first)
    say(first, { qoop: 'visual', type: 'height', value: 400 })
    say(first, { qoop: 'visual', type: 'error', message: 'old error' })
    expect(screen.getByRole('status')).toBeInTheDocument()

    rerender(<VisualFrame source="<p>second</p>" title="Bloch sphere" />)
    const second = frame()
    expect(second).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(screen.queryByRole('status')).toBeNull() // the old error belonged to the old run
    expect(second.style.height).toBe('240px') // and so did the height
    expect(second.getAttribute('sandbox')).toBe('allow-scripts')

    // The old frame's window no longer counts; nothing is sent until the new frame is ready.
    const postSecond = spyOn(second)
    say(second, { qoop: 'visual', type: 'ready' }, firstWindow)
    expect(postFirst).toHaveBeenCalledTimes(1)
    expect(postSecond).not.toHaveBeenCalled()
    ready(second)
    expect(postSecond).toHaveBeenCalledTimes(1)
    expect(postSecond.mock.calls[0]![0]).toMatchObject({ type: 'render', html: '<p>second</p>' })
  })

  it('keeps the frame when nothing it shows changed', () => {
    const { rerender } = open()
    const first = frame()
    rerender(<VisualFrame source={SOURCE} title="Bloch sphere" />)
    rerender(<VisualFrame source={SOURCE} title="Renamed" />)
    expect(frame('Visual: Renamed')).toBe(first)
  })

  it('loads a new frame when the app theme changes, and sends it the new colours', async () => {
    root.setAttribute('data-theme', 'dark')
    root.style.setProperty('--q-ink', 'oklch(0.94 0.006 255)')
    open()
    const first = frame()
    await act(async () => {
      root.setAttribute('data-theme', 'light')
      root.style.setProperty('--q-ink', 'oklch(0.22 0.012 255)')
    })
    const second = frame()
    expect(second).not.toBe(first)
    const post = spyOn(second)
    ready(second)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]![0]).toMatchObject({
      html: SOURCE,
      theme: { '--q-ink': 'oklch(0.22 0.012 255)', 'color-scheme': 'light' },
    })
  })

  it('loads a new frame for each Run, even with the same source', () => {
    const { rerender } = render(<VisualFrame source={SOURCE} title="Bloch sphere" run={0} eager />)
    const first = frame()
    rerender(<VisualFrame source={SOURCE} title="Bloch sphere" run={1} eager />)
    expect(frame()).not.toBe(first)
  })
})

describe('VisualFrame: created lazily', () => {
  type Callback = (entries: { isIntersecting: boolean }[]) => void
  function stubObserver() {
    const seen: { callback: Callback; options?: IntersectionObserverInit; observed: Element[]; disconnected: boolean }[] = []
    class FakeObserver {
      private record: (typeof seen)[number]
      constructor(callback: Callback, options?: IntersectionObserverInit) {
        this.record = { callback, options, observed: [], disconnected: false }
        seen.push(this.record)
      }
      observe(el: Element) {
        this.record.observed.push(el)
      }
      disconnect() {
        this.record.disconnected = true
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    return seen
  }

  it('creates the frame at once where there is no IntersectionObserver', () => {
    expect(typeof IntersectionObserver).toBe('undefined') // jsdom has none
    open()
    expect(frame()).toBeInTheDocument()
  })

  it('waits until the block comes near the viewport, then creates the frame and stops watching', () => {
    const seen = stubObserver()
    open()
    expect(screen.queryByTitle('Visual: Bloch sphere')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    const placeholder = screen.getByTestId('visual-wait')
    expect(placeholder.style.height).toBe('240px')
    const watching = seen.filter((o) => !o.disconnected)
    expect(watching).toHaveLength(1)
    expect(watching[0]!.observed).toHaveLength(1)
    expect(watching[0]!.options?.rootMargin).toBe('600px 0px')

    act(() => watching[0]!.callback([{ isIntersecting: false }]))
    expect(document.querySelector('iframe')).toBeNull()
    act(() => watching[0]!.callback([{ isIntersecting: true }]))
    const f = frame()
    expect(seen.every((o) => o.disconnected)).toBe(true)

    // Only now can it be ready and get its source.
    const post = spyOn(f)
    ready(f)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('watches once under StrictMode too', () => {
    const seen = stubObserver()
    render(
      <StrictMode>
        <VisualFrame source={SOURCE} title="Bloch sphere" />
      </StrictMode>,
    )
    expect(seen.filter((o) => !o.disconnected)).toHaveLength(1)
    act(() => seen.find((o) => !o.disconnected)!.callback([{ isIntersecting: true }]))
    expect(frame()).toBeInTheDocument()
    expect(seen.every((o) => o.disconnected)).toBe(true)
  })

  it('the editor’s preview does not wait', () => {
    stubObserver()
    render(<VisualFrame source={SOURCE} title="Bloch sphere" eager />)
    expect(frame()).toBeInTheDocument()
  })
})
