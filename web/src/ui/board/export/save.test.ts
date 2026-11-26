import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toasts } from '../toastStore'
import { boardFileName, fileMoment, savePng, saveSvg } from './save'

const g = globalThis as { infallDesktop?: unknown }

describe('boardFileName', () => {
  it('names the Branch, the moment History shows, and the visible area', () => {
    const at = new Date(2026, 10, 24, 14, 3).getTime()
    expect(boardFileName({ branch: 'main', visibleOnly: false, extension: 'svg' })).toBe('Board of main.svg')
    expect(fileMoment(at)).toBe('2026-11-24 14.03')
    expect(boardFileName({ branch: 'main', at, visibleOnly: false, extension: 'png' })).toBe('Board of main at 2026-11-24 14.03.png')
    expect(boardFileName({ branch: 'main', at: null, visibleOnly: true, extension: 'png' })).toBe('Board of main at the start, visible area.png')
    // A Branch name no file system takes as it is.
    expect(boardFileName({ branch: 'exp/a:b', visibleOnly: false, extension: 'svg' })).toBe('Board of exp a b.svg')
  })
})

describe('saving', () => {
  let clicks: Array<{ href: string; download: string }>
  beforeEach(() => {
    clicks = []
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download })
    })
    vi.spyOn(toasts, 'show')
  })
  afterEach(() => {
    delete g.infallDesktop
    vi.restoreAllMocks()
  })

  it('saves the SVG through the desktop app’s save dialog when it has one', async () => {
    const saveFile = vi.fn().mockResolvedValue(true)
    g.infallDesktop = { saveFile }
    expect(await saveSvg('Board of main.svg', '<svg/>')).toBe('saved')
    expect(saveFile).toHaveBeenCalledWith({ suggestedName: 'Board of main.svg', text: '<svg/>' })
    expect(clicks).toEqual([])
  })

  it('downloads the SVG in a browser', async () => {
    expect(await saveSvg('Board of main.svg', '<svg/>')).toBe('downloaded')
    expect(clicks).toEqual([{ href: 'blob:x', download: 'Board of main.svg' }])
    expect(toasts.show).toHaveBeenCalledWith({ message: 'Downloaded “Board of main.svg”.' })
  })

  it('downloads the PNG, and says in an older desktop app that it may not be kept', async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    expect(await savePng('Board of main.png', png)).toBe('downloaded')
    expect(clicks).toEqual([{ href: 'blob:x', download: 'Board of main.png' }])
    g.infallDesktop = { saveFile: vi.fn() }
    expect(await savePng('Board of main.png', png)).toBe('offered')
    expect(vi.mocked(toasts.show).mock.calls.at(-1)![0].message).toMatch(/may not keep it/)
  })

  it('M18: writes the PNG’s bytes through the app’s binary save when it has one — no download, no warning', async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const saveBinaryFile = vi.fn().mockResolvedValue(true)
    g.infallDesktop = { saveFile: vi.fn(), saveBinaryFile }
    expect(await savePng('Board of main.png', png)).toBe('saved')
    expect(saveBinaryFile).toHaveBeenCalledWith({ suggestedName: 'Board of main.png', bytes: new Uint8Array([137, 80, 78, 71]) })
    expect(clicks).toEqual([])
    expect(vi.mocked(toasts.show).mock.calls.at(-1)![0].message).toBe('Exported “Board of main.png”.')
    saveBinaryFile.mockResolvedValue(false)
    expect(await savePng('Board of main.png', png)).toBe('cancelled')
    saveBinaryFile.mockRejectedValue(new Error('Disk full.'))
    expect(await savePng('Board of main.png', png)).toBe('failed')
    expect(vi.mocked(toasts.show).mock.calls.at(-1)![0].message).toMatch(/could not be written\. Disk full\./)
  })
})
