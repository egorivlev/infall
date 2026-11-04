import { describe, expect, it } from 'vitest'
import { DEFAULT_PNG_SCALE, MAX_PIXELS, MAX_SIDE, PNG_SCALES, TILE, pngSize, svgDataUrl, tiles } from './png'

describe('pngSize', () => {
  it('is 1×, 2× or 4×, 2× by default', () => {
    expect(PNG_SCALES).toEqual([1, 2, 4])
    expect(DEFAULT_PNG_SCALE).toBe(2)
    expect(pngSize({ w: 800, h: 500 }, 2)).toEqual({ width: 1600, height: 1000, scale: 2, wanted: null })
    expect(pngSize({ w: 800, h: 500 }, 4)).toMatchObject({ width: 3200, height: 2000, wanted: null })
  })

  it('caps a 2 000-Card Board under 16 384 px a side and 32 Mpx, keeping its proportions', () => {
    // 50 × 40 Cards of 220 × 110 on a 260 × 150 grid: about 13 000 × 6 000 Board units.
    const area = { w: 50 * 260 + 64, h: 40 * 150 + 64 }
    for (const s of PNG_SCALES) {
      const size = pngSize(area, s)
      expect(size.width).toBeLessThanOrEqual(MAX_SIDE)
      expect(size.height).toBeLessThanOrEqual(MAX_SIDE)
      expect(size.width * size.height).toBeLessThanOrEqual(MAX_PIXELS)
      expect(Math.abs(size.width / size.height - area.w / area.h)).toBeLessThan(0.01)
    }
    // Even 1× would be 79 Mpx (316 MB while drawn): it is drawn at about 0.64×, and the dialog says so.
    expect(pngSize(area, 1).wanted).toEqual({ width: area.w, height: area.h })
    expect(pngSize(area, 4).wanted).toEqual({ width: 4 * area.w, height: 4 * area.h })
    expect(pngSize(area, 2).scale).toBeCloseTo(0.64, 1)
    // A Board of a few dozen Cards is not cut down at the default 2×, nor a small one at 4×.
    expect(pngSize({ w: 2400, h: 1600 }, 2).wanted).toBeNull()
    expect(pngSize({ w: 1400, h: 900 }, 4).wanted).toBeNull()
  })

  it('caps a very long thin Board by its side', () => {
    const size = pngSize({ w: 100_000, h: 200 }, 2)
    expect(size.width).toBe(MAX_SIDE)
    expect(size.height).toBeGreaterThanOrEqual(1)
  })
})

describe('tiles', () => {
  it('cover the picture once, row by row, each at most one tile', () => {
    const area = { x: -32, y: -50, w: 5000, h: 3000 }
    const size = pngSize(area, 1)
    const list = tiles(area, size)
    expect(list).toHaveLength(Math.ceil(5000 / TILE) * Math.ceil(3000 / TILE))
    expect(list.reduce((s, t) => s + t.width * t.height, 0)).toBe(size.width * size.height)
    expect(list.every((t) => t.width <= TILE && t.height <= TILE)).toBe(true)
    expect(list[0]!.area).toMatchObject({ x: -32, y: -50 })
  })
})

describe('svgDataUrl', () => {
  // The server's CSP lets images come from data: URLs, not blob: ones.
  it('is a data: URL with the SVG escaped', () => {
    expect(svgDataUrl('<svg a="#1"/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22%231%22%2F%3E')
  })
})
