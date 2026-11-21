// 0.9: the top bar's first row leaves room for the macOS traffic lights, except in fullscreen, where macOS hides them.
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '../../lib'
import { FakeServer, fakeDesktop, fakeFullscreen, installDesktop } from '../../lib/testing'
import { TopBar } from './TopBar'
import { useDesktopFullscreen } from './windowChrome'

const ME: Member = { id: 'me', name: 'Mei Lin', role: 'admin', color: '#bbb' }
let remove: (() => void) | null = null
const platform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')

function desktopWith(fullscreen: unknown) {
  remove = installDesktop({ ...fakeDesktop(), fullscreen })
}

function setPlatform(value: string) {
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value })
}

const titlebar = () => document.querySelector('.q-titlebar') as HTMLElement

beforeEach(() => {
  vi.stubGlobal('fetch', new FakeServer().fetch)
  setPlatform('MacIntel')
})

afterEach(() => {
  cleanup()
  remove?.()
  remove = null
  vi.unstubAllGlobals()
  if (platform) Object.defineProperty(window.navigator, 'platform', platform)
  else delete (window.navigator as { platform?: string }).platform
})

describe('useDesktopFullscreen', () => {
  it('is false in a browser', () => {
    expect(renderHook(() => useDesktopFullscreen()).result.current).toBe(false)
  })

  it('is false in an app without the member, or with one of the wrong shape', () => {
    for (const odd of [undefined, null, true, {}, { current: () => true }, { subscribe: () => () => {} }, { current: true, subscribe: () => () => {} }]) {
      desktopWith(odd)
      const { result, unmount } = renderHook(() => useDesktopFullscreen())
      expect(result.current).toBe(false)
      unmount()
      remove?.()
    }
  })

  it('reads current() on the first render', () => {
    const fs = fakeFullscreen(true)
    desktopWith(fs)
    const seen: boolean[] = []
    renderHook(() => seen.push(useDesktopFullscreen()))
    expect(seen[0]).toBe(true)
  })

  it('follows the changes and unsubscribes when unmounted', () => {
    const fs = fakeFullscreen(false)
    desktopWith(fs)
    const { result, unmount } = renderHook(() => useDesktopFullscreen())
    expect(result.current).toBe(false)
    expect(fs.listeners).toBe(1)
    act(() => fs.set(true))
    expect(result.current).toBe(true)
    act(() => fs.set(false))
    expect(result.current).toBe(false)
    unmount()
    expect(fs.listeners).toBe(0)
  })
})

describe('the title bar', () => {
  it('has no is-fullscreen outside fullscreen', () => {
    desktopWith(fakeFullscreen(false))
    render(<TopBar member={ME} branch="main" available />)
    expect(titlebar()).toHaveClass('q-titlebar', 'is-mac-window')
    expect(titlebar()).not.toHaveClass('is-fullscreen')
  })

  it('has is-fullscreen from the first render when the window opens in fullscreen', () => {
    desktopWith(fakeFullscreen(true))
    render(<TopBar member={ME} branch="main" available />)
    expect(titlebar()).toHaveClass('q-titlebar', 'is-mac-window', 'is-fullscreen')
  })

  it('follows the window in and out of fullscreen', () => {
    const fs = fakeFullscreen(false)
    desktopWith(fs)
    const { unmount } = render(<TopBar member={ME} branch="main" available />)
    act(() => fs.set(true))
    expect(titlebar()).toHaveClass('is-fullscreen')
    act(() => fs.set(false))
    expect(titlebar()).not.toHaveClass('is-fullscreen')
    unmount()
    expect(fs.listeners).toBe(0)
  })

  it('has neither class in a browser, and no is-fullscreen in an older app', () => {
    const { unmount } = render(<TopBar member={ME} branch="main" available />)
    expect(titlebar().className).toBe('q-titlebar')
    unmount()
    desktopWith(undefined)
    render(<TopBar member={ME} branch="main" available />)
    expect(titlebar().className).toBe('q-titlebar is-mac-window')
  })
})
