/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPrefs, applyRoom, interfacePxPerScreenPx, motionAllowed, roomFor } from './apply'
import { DEFAULT_PREFS, LEGACY_THEME_KEY, parsePrefs, prefs, PREFS_KEY, readPrefs, stepBoardScale, usePrefs } from './prefs'

beforeEach(() => {
  window.localStorage.clear()
  prefs.reload()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-motion')
  document.documentElement.removeAttribute('style')
})

describe('the settings store', () => {
  it('starts from the defaults', () => {
    expect(readPrefs()).toEqual({ theme: 'dark', interfaceScale: 100, textSize: 100, reduceMotion: 'system', boardScale: 100 })
    expect(usePrefs.getState()).toEqual(DEFAULT_PREFS)
  })

  it('keeps every change under one versioned key and reads it back', () => {
    prefs.set({ interfaceScale: 125, boardScale: 150 })
    prefs.set({ theme: 'light', reduceMotion: 'reduce', textSize: 110 })
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!)).toEqual({
      v: 1,
      theme: 'light',
      interfaceScale: 125,
      textSize: 110,
      reduceMotion: 'reduce',
      boardScale: 150,
    })
    usePrefs.setState({ ...DEFAULT_PREFS }, true)
    prefs.reload()
    expect(usePrefs.getState()).toMatchObject({ theme: 'light', interfaceScale: 125, boardScale: 150 })
  })

  it('resets the keys asked for and nothing else', () => {
    prefs.set({ interfaceScale: 80, textSize: 130, boardScale: 60 })
    prefs.reset(['interfaceScale', 'textSize'])
    expect(usePrefs.getState()).toMatchObject({ interfaceScale: 100, textSize: 100, boardScale: 60 })
  })

  it('falls back to the defaults for a garbled store, field by field', () => {
    expect(parsePrefs('{not json')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('null')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('[1,2]')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs(JSON.stringify({ v: 1, theme: 'purple', interfaceScale: 133, textSize: '110', boardScale: 150, reduceMotion: 'reduce' }))).toEqual({
      ...DEFAULT_PREFS,
      boardScale: 150,
      reduceMotion: 'reduce',
    })
  })

  it('does not trust a store written by another version', () => {
    expect(parsePrefs(JSON.stringify({ v: 2, theme: 'light', boardScale: 150 }))).toEqual(DEFAULT_PREFS)
    expect(parsePrefs(JSON.stringify({ theme: 'light' }))).toEqual(DEFAULT_PREFS) // no version at all
  })

  it('takes the theme chosen before Settings existed, once', () => {
    window.localStorage.setItem(LEGACY_THEME_KEY, 'light')
    expect(readPrefs().theme).toBe('light')
    prefs.set({ theme: 'system' })
    expect(readPrefs().theme).toBe('system') // the new key wins from then on
  })

  it('never throws when storage is blocked: the change lasts for the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readPrefs()).toEqual(DEFAULT_PREFS)
    expect(() => prefs.set({ boardScale: 200 })).not.toThrow()
    expect(usePrefs.getState().boardScale).toBe(200)
  })

  it('steps the Board scale and stops at either end', () => {
    expect(stepBoardScale(100, 1)).toBe(110)
    expect(stepBoardScale(100, -1)).toBe(90)
    expect(stepBoardScale(200, 1)).toBe(200)
    expect(stepBoardScale(60, -1)).toBe(60)
    expect(stepBoardScale(175, 0)).toBe(100)
    expect(stepBoardScale(105, 1)).toBe(110) // not a step: the next one that way
  })
})

describe('applying the settings', () => {
  it('puts theme, scales and motion on <html>', () => {
    const root = document.documentElement
    applyPrefs({ theme: 'light', interfaceScale: 125, textSize: 120, reduceMotion: 'reduce', boardScale: 150 })
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('1.25')
    expect(root.style.getPropertyValue('--q-ui-unzoom')).toBe('0.8')
    expect(root.style.getPropertyValue('--q-text')).toBe('1.2')
    expect(root).toHaveAttribute('data-motion', 'reduce')
    expect(motionAllowed()).toBe(true) // reads the store, not the attribute: still "system" there
    applyPrefs({ ...DEFAULT_PREFS, reduceMotion: 'full' })
    expect(root).toHaveAttribute('data-motion', 'full')
    applyPrefs(DEFAULT_PREFS)
    expect(root).not.toHaveAttribute('data-motion')
    expect(root.style.getPropertyValue('--q-ui-zoom')).toBe('1')
  })

  it('measures the room in interface pixels: the window divided by the interface scale', () => {
    expect(roomFor(1100)).toBe('wide')
    expect(roomFor(1099)).toBe('medium')
    expect(roomFor(900)).toBe('medium')
    expect(roomFor(899)).toBe('narrow')
    const root = document.createElement('div')
    Object.defineProperty(root, 'clientWidth', { value: 900 })
    Object.defineProperty(root, 'clientHeight', { value: 600 })
    expect(applyRoom(100, root)).toBe('medium') // the desktop app's smallest window
    expect(applyRoom(150, root)).toBe('narrow') // 600 × 400 interface pixels
    expect(root).toHaveAttribute('data-room', 'narrow')
    expect(root.style.getPropertyValue('--q-vw')).toBe('600px')
    expect(root.style.getPropertyValue('--q-vh')).toBe('400px')
    expect(applyRoom(80, root)).toBe('wide') // 1125
  })

  it('says whether motion is welcome from the choice, else from the system', () => {
    prefs.set({ reduceMotion: 'reduce' })
    expect(motionAllowed()).toBe(false)
    prefs.set({ reduceMotion: 'full' })
    expect(motionAllowed()).toBe(true)
  })

  it('measures interface pixels per screen pixel, and is 1 without a layout', () => {
    const el = document.createElement('div')
    expect(interfacePxPerScreenPx(el)).toBe(1)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ width: 1250 } as DOMRect)
    Object.defineProperty(el, 'clientWidth', { value: 1000 })
    expect(interfacePxPerScreenPx(el)).toBe(0.8) // zoomed 125%
  })

  it('the stylesheets read what is applied: <body> zooms, the Board canvas undoes it, motion follows the choice', async () => {
    const { readFileSync } = await import('node:fs')
    const css = (p: string) => readFileSync(`${process.cwd()}/src/${p}`, 'utf8')
    expect(css('styles/base.css')).toMatch(/body \{ zoom: var\(--q-ui-zoom, 1\); \}/)
    expect(css('styles/base.css')).toMatch(/:root\[data-motion="reduce"\] \*/)
    expect(css('styles/base.css')).toMatch(/:root:not\(\[data-motion="full"\]\)/)
    expect(css('ui/board/board.css')).toMatch(/zoom: var\(--q-ui-unzoom, 1\);/)
    expect(css('ui/board/board.css')).toMatch(/font-size: calc\(13px \* var\(--q-text, 1\)\)/) // Card titles follow Text size
  })
})
