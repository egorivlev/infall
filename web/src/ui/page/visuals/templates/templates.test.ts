// The starters must be complete and work with no network: checked here as text and as parsed
// HTML. (What they draw is checked by hand in a browser — see ../README.md.)
import { describe, expect, it } from 'vitest'
import { THEME_KEYS } from '../protocol'
import { TEMPLATES } from './index'

const FORBIDDEN = ['http://', 'https://', 'fetch(', 'XMLHttpRequest', 'import(', '<script src', 'WebSocket', 'EventSource', 'sendBeacon', '@import', 'url(']

const parse = (source: string) => new DOMParser().parseFromString(source, 'text/html')

describe('Visual starters', () => {
  it('are Blank, Bloch sphere and Function plot, in that order', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(['Blank', 'Bloch sphere', 'Function plot'])
    expect(TEMPLATES.map((t) => t.title)).toEqual(['', 'Bloch sphere', 'Function plot'])
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(3)
  })

  describe.each(TEMPLATES.map((t) => [t.name, t] as const))('%s', (_name, template) => {
    const { source } = template
    const doc = parse(source)

    it('reaches for nothing outside itself', () => {
      for (const word of FORBIDDEN) expect(source, word).not.toContain(word)
      expect(doc.querySelectorAll('script[src], link, img, iframe, object, embed, form, a[href], audio, video, base, meta')).toHaveLength(0)
    })

    it('parses as HTML with one inline style and one inline script, both closed', () => {
      expect(doc.querySelectorAll('style')).toHaveLength(1)
      const scripts = doc.querySelectorAll('script')
      expect(scripts).toHaveLength(1)
      expect(scripts[0]!.attributes).toHaveLength(0)
      expect(source.trimEnd().endsWith('</script>')).toBe(true)
      // Nothing after the script ended up inside it, and nothing visible spilled out of the markup.
      expect(scripts[0]!.textContent).not.toMatch(/<\/?script/i)
      expect(doc.body.textContent).not.toContain('<script')
    })

    it('has a script that is valid JavaScript', () => {
      const code = doc.querySelector('script')!.textContent ?? ''
      // Parsed only, never run: `new Function` compiles the body and throws on a syntax error.
      expect(() => new Function(code)).not.toThrow()
    })

    it('takes its colours from the --q-* variables only', () => {
      const used = new Set(source.match(/--q-[a-z0-9-]+/g) ?? [])
      expect(used.size).toBeGreaterThan(2)
      for (const name of used) expect(THEME_KEYS, name).toContain(name)
      const css = doc.querySelector('style')!.textContent ?? ''
      const code = doc.querySelector('script')!.textContent ?? ''
      expect(css + code).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i)
      expect(css).not.toMatch(/:\s*(white|black|red|blue|green|gray|grey)\b/)
    })

    it('labels every control and every drawing', () => {
      for (const input of doc.querySelectorAll('input, select, textarea, button')) {
        const id = input.getAttribute('id')
        const labelled = (id && doc.querySelector(`label[for="${id}"]`)) || input.getAttribute('aria-label') || input.closest('label')
        expect(labelled, input.outerHTML).toBeTruthy()
      }
      for (const drawing of doc.querySelectorAll('canvas, svg')) {
        expect(drawing.getAttribute('role'), drawing.outerHTML).toBe('img')
        expect(drawing.getAttribute('aria-label'), drawing.outerHTML).toBeTruthy()
      }
      // Controls are native elements (keyboard-operable by themselves); nothing is made clickable by script alone.
      expect(source).not.toMatch(/onclick|addEventListener\('(click|mousedown|pointerdown)'/)
    })

    it('draws again when the frame is resized', () => {
      expect(source).toContain("window.addEventListener('resize', draw)")
    })

    it('stays a readable size and free of what would break the source string', () => {
      expect(source.split('\n').length).toBeLessThanOrEqual(150)
      expect(source).not.toContain('`')
      expect(source).not.toContain('${')
    })
  })

  it('Blank explains itself: the colour variables and a canvas', () => {
    const { source } = TEMPLATES[0]!
    expect(source.trimStart().startsWith('<!--')).toBe(true)
    for (const name of ['--q-ink', '--q-line', '--q-accent', '--q-surface', '--q-st-question']) expect(source).toContain(name)
    expect(parse(source).querySelector('canvas')).not.toBeNull()
  })

  it('Bloch sphere has the two angle sliders and the three read-outs', () => {
    const doc = parse(TEMPLATES[1]!.source)
    const theta = doc.querySelector('input#theta')!
    const phi = doc.querySelector('input#phi')!
    expect([theta.getAttribute('type'), theta.getAttribute('min'), theta.getAttribute('max')]).toEqual(['range', '0', '180'])
    expect([phi.getAttribute('type'), phi.getAttribute('min'), phi.getAttribute('max')]).toEqual(['range', '0', '360'])
    expect(doc.querySelector('label[for="theta"]')!.textContent).toBe('θ')
    expect(doc.querySelector('label[for="phi"]')!.textContent).toBe('φ')
    expect(doc.querySelector('svg')).not.toBeNull()
    for (const text of ['⟨X⟩ = ', '⟨Y⟩ = ', '⟨Z⟩ = ']) expect(TEMPLATES[1]!.source).toContain(text)
  })

  it('Function plot has an expression field, two range sliders, a canvas and a place for errors', () => {
    const doc = parse(TEMPLATES[2]!.source)
    expect(doc.querySelector('input#expr')!.getAttribute('type')).toBe('text')
    expect(doc.querySelector('label[for="expr"]')!.textContent).toBe('f(x) =')
    expect(doc.querySelectorAll('input[type="range"]')).toHaveLength(2)
    expect(doc.querySelector('canvas')).not.toBeNull()
    expect(doc.querySelector('#message')!.getAttribute('role')).toBe('status')
    // The expression is compiled and run inside try/catch: a mistake becomes text.
    const code = doc.querySelector('script')!.textContent ?? ''
    expect(code.indexOf('try {')).toBeLessThan(code.indexOf('new Function('))
    expect(code.indexOf('new Function(')).toBeLessThan(code.indexOf('} catch (error)'))
    expect(code).toContain("say('This expression cannot be plotted: '")
  })
})
