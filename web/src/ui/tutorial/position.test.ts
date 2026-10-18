import { describe, expect, it } from 'vitest'
import { placePopover, ringBox, sameBox, unionBox } from './position'

const VIEW = { width: 1440, height: 900 }
const POP = { width: 320, height: 180 }

describe('placing the popover', () => {
  it('goes under a control with room below', () => {
    expect(placePopover({ left: 300, top: 36, width: 120, height: 26 }, POP, VIEW)).toEqual({ left: 300, top: 72 })
  })

  it('goes above a control at the bottom', () => {
    expect(placePopover({ left: 300, top: 850, width: 120, height: 26 }, POP, VIEW)).toEqual({ left: 300, top: 660 })
  })

  it('stays inside the window at the right edge', () => {
    expect(placePopover({ left: 1380, top: 4, width: 50, height: 22 }, POP, VIEW).left).toBe(1440 - 320 - 8)
  })

  it('stands to the left of a full-height panel at the right edge', () => {
    expect(placePopover({ left: 1064, top: 66, width: 376, height: 834 }, POP, VIEW)).toEqual({ left: 1064 - 10 - 320, top: 66 })
  })

  it('sits inside the bottom-left corner of a control with no room around it', () => {
    expect(placePopover({ left: 224, top: 66, width: 1216, height: 834 }, POP, VIEW)).toEqual({ left: 248, top: 900 - 180 - 24 })
  })
})

describe('the ring', () => {
  it('is drawn a little outside the control', () => {
    expect(ringBox({ left: 300, top: 36, width: 120, height: 26 }, VIEW)).toEqual({ left: 296, top: 32, width: 128, height: 34 })
  })

  it('never leaves the window', () => {
    expect(ringBox({ left: 0, top: 66, width: 1440, height: 834 }, VIEW)).toEqual({ left: 2, top: 62, width: 1436, height: 836 })
  })
})

describe('boxes', () => {
  it('joins several into one', () => {
    expect(unionBox([{ left: 10, top: 5, width: 20, height: 10 }, { left: 40, top: 0, width: 10, height: 30 }])).toEqual({ left: 10, top: 0, width: 40, height: 30 })
    expect(unionBox([])).toBeNull()
  })

  it('compares', () => {
    const a = { left: 1, top: 2, width: 3, height: 4 }
    expect(sameBox(a, { ...a })).toBe(true)
    expect(sameBox(a, { ...a, top: 3 })).toBe(false)
    expect(sameBox(a, null)).toBe(false)
    expect(sameBox(null, null)).toBe(true)
  })
})
