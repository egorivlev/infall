// public/boot.js: what index.html runs before the first paint. It is a same-origin file because the server's CSP
// (`default-src 'self'`) refuses inline scripts — an inline copy never ran on a real server.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Tests run in web/.
const source = readFileSync(resolve(process.cwd(), 'public/boot.js'), 'utf8')
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const root = document.documentElement

function boot() {
  // As a classic script, at the top level.
  new Function(source)()
}

afterEach(() => {
  localStorage.clear()
  root.setAttribute('data-theme', 'dark')
  root.removeAttribute('data-room')
  root.removeAttribute('style')
})

describe('before the first paint', () => {
  it('index.html loads it as a file, synchronously in <head>, with no inline script left', () => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    expect(head).toMatch(/<script src="\/boot\.js"><\/script>/)
    expect(html).not.toMatch(/<script>(?!<\/script>)/)
    expect(head).not.toMatch(/<script[^>]*(async|defer|type="module")[^>]*src="\/boot\.js"/)
  })

  it('applies the saved theme, interface scale and text size', () => {
    localStorage.setItem('infall-settings', JSON.stringify({ v: 1, theme: 'light', interfaceScale: 150, textSize: 120 }))
    boot()
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('1.5')
    expect(root.style.getPropertyValue('--q-text')).toBe('1.2')
    expect(root.getAttribute('data-room')).toMatch(/^(wide|medium|narrow)$/)
  })

  it('tells the desktop app the saved interface scale, when it has the member', () => {
    const said: unknown[] = []
    const page = globalThis as { infallDesktop?: unknown }
    try {
      localStorage.setItem('infall-settings', JSON.stringify({ v: 1, interfaceScale: 150 }))
      page.infallDesktop = { chromeScale: (scale: number) => (said.push(scale), Promise.resolve()) }
      boot()
      expect(said).toEqual([1.5])
      // 100 % too: the app may remember another scale.
      localStorage.setItem('infall-settings', JSON.stringify({ v: 1, interfaceScale: 100 }))
      boot()
      expect(said).toEqual([1.5, 1])
      // Nothing for a scale the app would not apply.
      localStorage.setItem('infall-settings', JSON.stringify({ v: 1, interfaceScale: 333 }))
      boot()
      expect(said).toEqual([1.5, 1])
      // A member that is not a function, throws or refuses spoils nothing.
      localStorage.setItem('infall-settings', JSON.stringify({ v: 1, interfaceScale: 80, textSize: 120 }))
      for (const chromeScale of [
        0.8,
        () => {
          throw new Error('bridge down')
        },
        () => Promise.reject(new Error('Not allowed.')),
      ]) {
        root.removeAttribute('style')
        page.infallDesktop = { chromeScale }
        expect(() => boot()).not.toThrow()
        expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('0.8')
        expect(root.style.getPropertyValue('--q-text')).toBe('1.2')
      }
    } finally {
      delete page.infallDesktop
    }
  })

  it('reads the old theme key, and leaves anything unreadable to the app', () => {
    localStorage.setItem('qoop-theme', 'light')
    boot()
    expect(root.getAttribute('data-theme')).toBe('light')
    root.setAttribute('data-theme', 'dark')
    localStorage.setItem('infall-settings', '{not json')
    expect(() => boot()).not.toThrow()
    expect(root.getAttribute('data-theme')).toBe('dark')
    localStorage.setItem('infall-settings', JSON.stringify({ v: 1, theme: 'purple', interfaceScale: 333 }))
    boot()
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('')
  })
})
