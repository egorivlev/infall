import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HEIGHT, THEME_KEYS, clampHeight, cleanError, collectTheme, parseFrameMessage, readTheme, renderMessage } from './protocol'

describe('Visual protocol: messages from the frame', () => {
  it('reads the three messages of the protocol', () => {
    expect(parseFrameMessage({ infall: 'visual', type: 'ready' })).toEqual({ type: 'ready' })
    expect(parseFrameMessage({ infall: 'visual', type: 'height', value: 312 })).toEqual({ type: 'height', value: 312 })
    expect(parseFrameMessage({ infall: 'visual', type: 'error', message: 'x is not defined' })).toEqual({ type: 'error', message: 'x is not defined' })
  })

  it('ignores anything that is not tagged infall: "visual"', () => {
    for (const data of [
      null,
      undefined,
      'ready',
      42,
      true,
      [],
      [{ infall: 'visual', type: 'ready' }],
      {},
      { type: 'ready' },
      { infall: 'Visual', type: 'ready' },
      { infall: true, type: 'ready' },
      { infall: 'board', type: 'ready' },
      '{"infall":"visual","type":"ready"}',
    ]) {
      expect(parseFrameMessage(data), JSON.stringify(data)).toBeNull()
    }
  })

  it('ignores unknown types — also the parent’s own render message', () => {
    expect(parseFrameMessage({ infall: 'visual' })).toBeNull()
    expect(parseFrameMessage({ infall: 'visual', type: 'render', html: '<p>', theme: {} })).toBeNull()
    expect(parseFrameMessage({ infall: 'visual', type: 'navigate', url: 'https://example.org' })).toBeNull()
    expect(parseFrameMessage({ infall: 'visual', type: ['ready'] })).toBeNull()
  })

  it('takes a height only as a finite number, and clamps it', () => {
    expect(parseFrameMessage({ infall: 'visual', type: 'height', value: 12 })).toEqual({ type: 'height', value: 80 })
    expect(parseFrameMessage({ infall: 'visual', type: 'height', value: 1e9 })).toEqual({ type: 'height', value: 900 })
    expect(parseFrameMessage({ infall: 'visual', type: 'height', value: -40 })).toEqual({ type: 'height', value: 80 })
    for (const value of [NaN, Infinity, -Infinity, '300', null, undefined, {}, [300], true]) {
      expect(parseFrameMessage({ infall: 'visual', type: 'height', value }), String(value)).toBeNull()
    }
  })

  it('takes an error only as a string, cut to 300 characters on one line', () => {
    const long = parseFrameMessage({ infall: 'visual', type: 'error', message: 'e'.repeat(5000) })
    expect(long).toEqual({ type: 'error', message: 'e'.repeat(300) })
    expect(parseFrameMessage({ infall: 'visual', type: 'error', message: 'line one\n\tline two\u0000 end' })).toEqual({
      type: 'error',
      message: 'line one line two end',
    })
    expect(parseFrameMessage({ infall: 'visual', type: 'error', message: '   ' })).toEqual({ type: 'error', message: 'Unknown error' })
    for (const message of [undefined, null, 5, { toString: () => 'x' }, ['x']]) {
      expect(parseFrameMessage({ infall: 'visual', type: 'error', message })).toBeNull()
    }
  })
})

describe('Visual protocol: height', () => {
  it('clamps to 80–900 whole pixels', () => {
    expect(clampHeight(240)).toBe(240)
    expect(clampHeight(79.2)).toBe(80)
    expect(clampHeight(0)).toBe(80)
    expect(clampHeight(300.2)).toBe(301)
    expect(clampHeight(900.01)).toBe(900)
    expect(clampHeight(123456)).toBe(900)
  })

  it('gives the default for what is not a finite number', () => {
    expect(DEFAULT_HEIGHT).toBe(240)
    for (const value of [NaN, Infinity, -Infinity, '500', null, undefined, {}]) expect(clampHeight(value)).toBe(240)
  })
})

describe('Visual protocol: error text', () => {
  it('keeps markup as plain characters (it is only ever shown as text)', () => {
    expect(cleanError('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('Visual protocol: theme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('style')
  })

  it('names the colours the design asks for', () => {
    for (const key of [
      '--q-ink',
      '--q-ink-2',
      '--q-ink-3',
      '--q-line',
      '--q-line-soft',
      '--q-accent',
      '--q-accent-soft',
      '--q-surface',
      '--q-raised',
      '--q-st-idea',
      '--q-st-reading',
      '--q-st-understood',
      '--q-st-question',
      '--q-st-dead',
    ]) {
      expect(THEME_KEYS).toContain(key)
    }
    // The frame only accepts names like these.
    for (const key of THEME_KEYS) expect(key).toMatch(/^--q-[a-z0-9-]+$/)
  })

  it('collects every variable that has a value, trimmed, plus color-scheme', () => {
    const values: Record<string, string> = { '--q-ink': ' oklch(0.94 0.006 255) ', '--q-accent': 'oklch(0.80 0.10 195)', '--q-line': '' }
    const theme = collectTheme((name) => values[name] ?? '', 'light')
    expect(theme).toEqual({ '--q-ink': 'oklch(0.94 0.006 255)', '--q-accent': 'oklch(0.80 0.10 195)', 'color-scheme': 'light' })
  })

  it('leaves out values the frame would refuse, and knows only two colour schemes', () => {
    const values: Record<string, string> = {
      '--q-ink': 'red; } body { display: none',
      '--q-ink-2': 'url(<svg>)',
      '--q-ink-3': '{',
      '--q-line': 'oklch(0.34 0.01 255 / 0.5)',
    }
    const theme = collectTheme((name) => values[name] ?? '', 'dark; background: red')
    expect(theme).toEqual({ '--q-line': 'oklch(0.34 0.01 255 / 0.5)', 'color-scheme': 'dark' })
  })

  it('reads the document: its variables and data-theme', () => {
    document.documentElement.style.setProperty('--q-ink', 'oklch(0.22 0.012 255)')
    document.documentElement.setAttribute('data-theme', 'light')
    expect(readTheme()).toEqual({ '--q-ink': 'oklch(0.22 0.012 255)', 'color-scheme': 'light' })
    document.documentElement.setAttribute('data-theme', 'dark')
    expect(readTheme()['color-scheme']).toBe('dark')
    document.documentElement.removeAttribute('data-theme')
    expect(readTheme()['color-scheme']).toBe('dark') // dark is the app's default
  })

  it('builds the one message the parent sends', () => {
    expect(renderMessage('<p>hi</p>', { 'color-scheme': 'dark' })).toEqual({
      infall: 'visual',
      type: 'render',
      html: '<p>hi</p>',
      theme: { 'color-scheme': 'dark' },
    })
  })
})
