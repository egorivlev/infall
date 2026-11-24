// 0.9: the desktop app is told the interface scale, so that macOS centres the traffic lights in the top bar's first row.
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeChromeScale, fakeDesktop, installDesktop } from '../../lib/testing'
import { tellDesktopChromeScale } from '../shell/windowChrome'
import { useAppliedPrefs } from './apply'
import { prefs } from './prefs'

let remove: (() => void) | null = null

function desktopWith(chromeScale: unknown) {
  remove?.()
  remove = installDesktop({ ...fakeDesktop(), chromeScale })
}

afterEach(() => {
  remove?.()
  remove = null
  localStorage.clear()
  prefs.reload()
  document.documentElement.removeAttribute('style')
})

describe('useAppliedPrefs and the desktop app', () => {
  it('tells the scale at the start, and again only when the scale changes', () => {
    prefs.set({ interfaceScale: 125 })
    const chromeScale = fakeChromeScale()
    desktopWith(chromeScale)
    const hook = renderHook(() => useAppliedPrefs())
    expect(chromeScale.said).toEqual([1.25])
    prefs.set({ textSize: 120 })
    prefs.set({ theme: 'light' })
    expect(chromeScale.said).toEqual([1.25])
    prefs.set({ interfaceScale: 80 })
    prefs.set({ interfaceScale: 150 })
    expect(chromeScale.said).toEqual([1.25, 0.8, 1.5])
    hook.unmount()
    prefs.set({ interfaceScale: 100 })
    expect(chromeScale.said).toEqual([1.25, 0.8, 1.5])
  })

  it('works in a browser and in an app without the member', () => {
    expect(() => renderHook(() => useAppliedPrefs()).unmount()).not.toThrow()
    remove = installDesktop(fakeDesktop())
    const hook = renderHook(() => useAppliedPrefs())
    expect(() => prefs.set({ interfaceScale: 110 })).not.toThrow()
    hook.unmount()
  })
})

describe('tellDesktopChromeScale', () => {
  it('sends the percentage as a factor', () => {
    const chromeScale = fakeChromeScale()
    desktopWith(chromeScale)
    tellDesktopChromeScale(90)
    tellDesktopChromeScale(100)
    expect(chromeScale.said).toEqual([0.9, 1])
  })

  it('leaves a missing or malformed member alone', () => {
    expect(() => tellDesktopChromeScale(150)).not.toThrow() // no bridge at all
    for (const chromeScale of [undefined, null, 1.5, 'chromeScale', { call: () => {} }]) {
      desktopWith(chromeScale)
      expect(() => tellDesktopChromeScale(150)).not.toThrow()
    }
    remove?.()
    remove = installDesktop(null)
    expect(() => tellDesktopChromeScale(150)).not.toThrow()
  })

  it('keeps a throw or a refusal of the bridge to itself', async () => {
    const throws = vi.fn(() => {
      throw new Error('bridge down')
    })
    desktopWith(throws)
    expect(() => tellDesktopChromeScale(150)).not.toThrow()
    expect(throws).toHaveBeenCalledWith(1.5)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      desktopWith(() => Promise.reject(new Error('Not allowed.')))
      tellDesktopChromeScale(150)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
