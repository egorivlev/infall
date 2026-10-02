import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardVM, FrameVM } from '../../lib'
import { endOfLocalDay, formatShortDate, todayYmd } from './dates'
import { describeError, describeLookupError, GENERIC_ERROR, INVALID_INVITE, isInviteGone } from './errorMessages'
import { frameCounts } from './frameCounts'
import { initials } from './initials'
import { navigate, parseRoute, subscribeRoute } from './router'
import { searchCards } from './searchCards'
import { applyTheme, getThemePref, nextThemePref, readThemePref, resetThemeCache, resolveTheme, setThemePref, THEME_KEY } from './theme'

describe('parseRoute', () => {
  it('maps the three paths', () => {
    expect(parseRoute('/')).toEqual({ name: 'board' })
    expect(parseRoute('/members')).toEqual({ name: 'members' })
    expect(parseRoute('/members/')).toEqual({ name: 'members' })
    expect(parseRoute('/invite/abc123')).toEqual({ name: 'invite', token: 'abc123' })
  })
  it('decodes the token and ignores query and hash', () => {
    expect(parseRoute('/invite/a%2Bb?x=1#y')).toEqual({ name: 'invite', token: 'a+b' })
    expect(parseRoute('/invite/%E0%A4%A')).toEqual({ name: 'invite', token: '%E0%A4%A' })
  })
  it('falls back to the Board for anything else', () => {
    expect(parseRoute('/invite')).toEqual({ name: 'board' })
    expect(parseRoute('/invite/a/b')).toEqual({ name: 'board' })
    expect(parseRoute('/nope')).toEqual({ name: 'board' })
  })
})

describe('navigate', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'))
  it('pushes, notifies subscribers and skips no-ops', () => {
    const seen = vi.fn()
    const off = subscribeRoute(seen)
    navigate('/members')
    expect(window.location.pathname).toBe('/members')
    expect(seen).toHaveBeenCalledTimes(1)
    navigate('/members')
    expect(seen).toHaveBeenCalledTimes(1)
    navigate('/', { replace: true })
    expect(window.location.pathname).toBe('/')
    off()
    navigate('/members')
    expect(seen).toHaveBeenCalledTimes(2)
  })
})

describe('initials', () => {
  it('takes first and last word', () => {
    expect(initials('Ana Ruiz')).toBe('AR')
    expect(initials('  prof. elena  varga ')).toBe('PV')
  })
  it('handles one word and empty', () => {
    expect(initials('Cher')).toBe('CH')
    expect(initials('')).toBe('?')
  })
})

const card = (id: string, x: number, y: number, w = 224, h = 132): CardVM => ({ id, title: id, summary: '', status: 'idea', x, y, w, h })
const frame = (id: string, x: number, y: number, w: number, h: number): FrameVM => ({ id, title: id, x, y, w, h })

describe('frameCounts', () => {
  it('counts Cards whose centre is inside, not mere overlap', () => {
    const f = frame('f', 0, 0, 500, 300)
    const inside = card('a', 10, 10) // centre 122,76
    const edgeOverlap = card('b', 450, 10) // centre 562 -> outside although it overlaps
    const outside = card('c', 900, 900)
    expect(frameCounts([f], [inside, edgeOverlap, outside])).toEqual({ f: 1 })
  })
  it('counts a Card in every Frame that contains it and gives empty Frames 0', () => {
    const big = frame('big', 0, 0, 1000, 1000)
    const small = frame('small', 0, 0, 300, 200)
    const empty = frame('empty', 2000, 2000, 10, 10)
    expect(frameCounts([big, small, empty], [card('a', 10, 10)])).toEqual({ big: 1, small: 1, empty: 0 })
  })
})

describe('searchCards', () => {
  const cards: CardVM[] = [
    { ...card('1', 0, 0), title: 'Surface code', summary: 'threshold' },
    { ...card('2', 0, 0), title: 'Decoders', summary: 'uses the SURFACE lattice' },
    { ...card('3', 0, 0), title: 'Noise', summary: '' },
  ]
  it('matches title and summary case-insensitively, title matches first', () => {
    expect(searchCards(cards, 'surface').map((c) => c.id)).toEqual(['1', '2'])
    expect(searchCards(cards, 'SURFACE').map((c) => c.id)).toEqual(['1', '2'])
  })
  it('returns nothing for a blank query', () => {
    expect(searchCards(cards, '   ')).toEqual([])
  })
})

describe('error messages', () => {
  it('maps the known codes to plain words', () => {
    expect(describeError({ code: 'bad_credentials' })).toBe("That email and password don't match.")
    expect(describeError({ code: 'too_many_attempts' })).toBe('Too many attempts. Try again in a few minutes.')
    expect(describeError({ code: 'network' })).toBe("Can't reach the server. Check your connection and try again.")
    expect(describeError({ code: 'email_taken' })).toBe('Someone with that email already has access.')
    expect(describeError({ code: 'invite_expired' })).toBe(INVALID_INVITE)
  })
  it('never leaks raw codes or messages', () => {
    expect(describeError({ code: 'internal', message: 'stack trace here' })).toBe(GENERIC_ERROR)
    expect(describeError(new Error('boom'))).toBe(GENERIC_ERROR)
    expect(describeError(null)).toBe(GENERIC_ERROR)
  })
  it('treats 404/410 on lookup as an invalid invite', () => {
    expect(isInviteGone({ status: 404, code: 'not_found' })).toBe(true)
    expect(isInviteGone({ status: 410, code: 'invite_expired' })).toBe(true)
    expect(isInviteGone({ status: 500, code: 'internal' })).toBe(false)
    expect(describeLookupError({ status: 404, code: 'not_found' })).toBe(INVALID_INVITE)
    expect(describeError({ status: 404, code: 'not_found' })).toBe(GENERIC_ERROR)
  })
})

describe('dates', () => {
  it('builds the end of a local day and rejects impossible dates', () => {
    const end = endOfLocalDay('2030-02-10')
    expect(end).not.toBeNull()
    expect(new Date(end as number).getHours()).toBe(23)
    expect(endOfLocalDay('2030-02-31')).toBeNull()
    expect(endOfLocalDay('')).toBeNull()
    expect(endOfLocalDay('10/02/2030')).toBeNull()
  })
  it('formats short dates, adding the year only when it differs', () => {
    const now = new Date(2026, 10, 22)
    expect(formatShortDate(new Date(2026, 10, 30).getTime(), now)).toBe('30 Nov')
    expect(formatShortDate(new Date(2027, 0, 5).getTime(), now)).toBe('5 Jan 2027')
    expect(todayYmd(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('theme storage', () => {
  beforeEach(() => {
    resetThemeCache()
    window.localStorage.clear()
  })
  afterEach(() => vi.restoreAllMocks())

  it('defaults to dark and reads a stored choice', () => {
    expect(readThemePref()).toBe('dark')
    window.localStorage.setItem(THEME_KEY, 'light')
    expect(readThemePref()).toBe('light')
    window.localStorage.setItem(THEME_KEY, 'purple')
    expect(readThemePref()).toBe('dark')
  })
  it('fails safely when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readThemePref()).toBe('dark')
    expect(() => setThemePref('light')).not.toThrow()
    expect(getThemePref()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
  it('stores the choice, applies it to <html> and cycles dark, light, system', () => {
    setThemePref('light')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(nextThemePref('dark')).toBe('light')
    expect(nextThemePref('light')).toBe('system')
    expect(nextThemePref('system')).toBe('dark')
  })
  it('resolves "system" from the media query', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
