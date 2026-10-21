import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardVM, FrameVM } from '../../lib'
import { branchMeta, orderBranches, parentName } from './branchMeta'
import { endOfLocalDay, formatDateTime, formatShortDate, formatTime, todayYmd } from './dates'
import { describeError, describeLookupError, GENERIC_ERROR, INVALID_INVITE, isInviteGone } from './errorMessages'
import { frameCounts } from './frameCounts'
import { initials } from './initials'
import { boardPath, branchPath, currentPath, mergePath, navigate, parseRoute, rememberBranch, subscribeRoute, TODOS_PATH } from './router'
import { searchCards } from './searchCards'
import { applyTheme, getThemePref, nextThemePref, readThemePref, resetThemeCache, resolveTheme, setThemePref, THEME_KEY } from './theme'

describe('parseRoute', () => {
  const main = { name: 'board', branch: 'main' }
  it('maps the fixed paths', () => {
    expect(parseRoute('/')).toEqual(main)
    expect(parseRoute('/members')).toEqual({ name: 'members' })
    expect(parseRoute('/members/')).toEqual({ name: 'members' })
    expect(parseRoute('/branches')).toEqual({ name: 'branches' })
    expect(parseRoute('/branches/')).toEqual({ name: 'branches' })
    expect(parseRoute('/todos')).toEqual({ name: 'todos' })
    expect(parseRoute('/todos/')).toEqual({ name: 'todos' })
    expect(parseRoute('/todos?x=1#y')).toEqual({ name: 'todos' })
    expect(parseRoute('/todos/abc')).toEqual(main)
    expect(parseRoute(TODOS_PATH)).toEqual({ name: 'todos' })
    expect(parseRoute('/invite/abc123')).toEqual({ name: 'invite', token: 'abc123' })
  })
  it('decodes the token and ignores query and hash', () => {
    expect(parseRoute('/invite/a%2Bb?x=1#y')).toEqual({ name: 'invite', token: 'a+b' })
    expect(parseRoute('/invite/%E0%A4%A')).toEqual({ name: 'invite', token: '%E0%A4%A' })
  })
  it('falls back to the Board of main for anything else', () => {
    expect(parseRoute('/invite')).toEqual(main)
    expect(parseRoute('/invite/a/b')).toEqual(main)
    expect(parseRoute('/nope')).toEqual(main)
    expect(parseRoute('/b')).toEqual(main)
    expect(parseRoute('/b/')).toEqual(main)
    expect(parseRoute('/branches/x')).toEqual(main)
  })
  it('reads the Branch name from /b/<name>, with "/" and spaces in it', () => {
    expect(parseRoute('/b/try-QEC')).toEqual({ name: 'board', branch: 'try-QEC' })
    expect(parseRoute('/b/ana%2Fcartpole-lr')).toEqual({ name: 'board', branch: 'ana/cartpole-lr' })
    expect(parseRoute('/b/ana/cartpole-lr')).toEqual({ name: 'board', branch: 'ana/cartpole-lr' })
    expect(parseRoute('/b/decoder%20rewrite%20v2?x=1#y')).toEqual({ name: 'board', branch: 'decoder rewrite v2' })
    expect(parseRoute('/b/try-QEC/')).toEqual({ name: 'board', branch: 'try-QEC' })
    expect(parseRoute('/b/100%25%20sure%3F')).toEqual({ name: 'board', branch: '100% sure?' })
    expect(parseRoute('/b/%E0%A4%A')).toEqual({ name: 'board', branch: '%E0%A4%A' })
    expect(parseRoute('/b/main')).toEqual(main)
  })
})

describe('mergePath', () => {
  it('puts both Branch names in the query, each encoded', () => {
    expect(mergePath('try-QEC', 'main')).toBe('/merge?from=try-QEC&into=main')
    expect(mergePath('ana/cartpole lr', 'main')).toBe('/merge?from=ana%2Fcartpole%20lr&into=main')
    expect(mergePath('main', 'R&D = 100%? #2 + more')).toBe('/merge?from=main&into=R%26D%20%3D%20100%25%3F%20%232%20%2B%20more')
  })

  it('round-trips awkward names through parseRoute', () => {
    const names = ['try-QEC', 'ana/cartpole lr', 'R&D', 'a=b&into=main', '100% sure?', '#2', 'a+b', 'into', 'Ünïcode ≈ 1%', ' padded ', '%2F', 'x?from=y']
    for (const from of names) {
      for (const into of ['main', ...names]) {
        expect(parseRoute(mergePath(from, into))).toEqual({ name: 'merge', from, into })
      }
    }
  })

  it('parses the Merge route by hand-typed and odd URLs too', () => {
    expect(parseRoute('/merge?into=main&from=try-QEC')).toEqual({ name: 'merge', from: 'try-QEC', into: 'main' })
    expect(parseRoute('/merge/?from=a&into=b#q-merge-c2')).toEqual({ name: 'merge', from: 'a', into: 'b' })
    expect(parseRoute('/merge?x=1&from=ana/fit&into=main')).toEqual({ name: 'merge', from: 'ana/fit', into: 'main' })
    expect(parseRoute('/merge?from=%E0%A4%A&into=main')).toEqual({ name: 'merge', from: '%E0%A4%A', into: 'main' })
    // Names are case-sensitive and kept as written.
    expect(parseRoute('/merge?from=Try-QEC&into=Main')).toEqual({ name: 'merge', from: 'Try-QEC', into: 'Main' })
  })

  it('falls back to the Branches screen without both names', () => {
    expect(parseRoute('/merge')).toEqual({ name: 'branches' })
    expect(parseRoute('/merge?from=try-QEC')).toEqual({ name: 'branches' })
    expect(parseRoute('/merge?from=&into=main')).toEqual({ name: 'branches' })
    expect(parseRoute('/merge/x?from=a&into=b')).toEqual({ name: 'board', branch: 'main' })
  })

  it('currentPath carries the query, so the route can be read from it', () => {
    window.history.replaceState(null, '', mergePath('ana/cartpole lr', 'main'))
    expect(currentPath()).toBe('/merge?from=ana%2Fcartpole%20lr&into=main')
    expect(parseRoute(currentPath())).toEqual({ name: 'merge', from: 'ana/cartpole lr', into: 'main' })
    window.history.replaceState(null, '', '/')
  })
})

describe('branchPath', () => {
  it('is / for main and /b/<encoded name> otherwise, and round-trips through parseRoute', () => {
    expect(branchPath('main')).toBe('/')
    expect(branchPath('try-QEC')).toBe('/b/try-QEC')
    expect(branchPath('ana/cartpole-lr')).toBe('/b/ana%2Fcartpole-lr')
    expect(branchPath('decoder rewrite v2')).toBe('/b/decoder%20rewrite%20v2')
    for (const name of ['ana/cartpole-lr', 'decoder rewrite v2', '100% sure?', 'a#b', 'ünïcode/ß']) {
      expect(parseRoute(branchPath(name))).toEqual({ name: 'board', branch: name })
    }
  })
  it('remembers the Branch the Board last showed', () => {
    expect(boardPath()).toBe('/')
    rememberBranch('ana/cartpole-lr')
    expect(boardPath()).toBe('/b/ana%2Fcartpole-lr')
    rememberBranch('main')
    expect(boardPath()).toBe('/')
  })
})

describe('branchMeta', () => {
  const now = new Date(2026, 10, 22)
  const main = { id: 'b0', name: 'main', seq: 40, checkpoints: 2 }
  const qec = { id: 'b1', name: 'try-QEC', seq: 14, checkpoints: 0, parent: { branch: 'b0', seq: 30 }, created_by: 'm', created_at: new Date(2026, 10, 14, 10, 2).getTime() }
  const orphan = { id: 'b2', name: 'x', seq: 0, checkpoints: 0, parent: { branch: 'gone', seq: 1 } }
  const people = [{ id: 'm', name: 'Mei Lin', role: 'member' as const, color: '#000' }]
  it('describes main, and a Branch by parent, creator first name and date', () => {
    expect(branchMeta(main, [main, qec], people, now)).toBe('default Branch')
    expect(branchMeta(qec, [main, qec], people, now)).toBe('from main · Mei · 14 Nov')
    expect(branchMeta(qec, [main, qec], [], now)).toBe('from main · 14 Nov')
    expect(branchMeta(orphan, [main, orphan], people, now)).toBe('')
    expect(parentName(qec, [main, qec])).toBe('main')
    expect(parentName(orphan, [main])).toBe('')
  })
  it('lists main first and keeps the rest in order', () => {
    expect(orderBranches([qec, orphan, main]).map((b) => b.name)).toEqual(['main', 'try-QEC', 'x'])
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

const card = (id: string, x: number, y: number, w = 224, h = 132): CardVM => ({ id, title: id, summary: '', status: 'idea', x, y, w, h, blocks: 0, sources: 0 })
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
  it('formats local time and date-time', () => {
    const now = new Date(2026, 10, 22)
    const at = new Date(2026, 10, 14, 9, 5).getTime()
    expect(formatTime(at)).toBe('09:05')
    expect(formatDateTime(at, now)).toBe('14 Nov, 09:05')
    expect(formatDateTime(new Date(2025, 0, 5, 14, 6).getTime(), now)).toBe('5 Jan 2025, 14:06')
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
    // Kept with this device's other settings now; the old key is only read, for a choice made before Settings.
    expect(JSON.parse(window.localStorage.getItem('infall-settings')!)).toMatchObject({ v: 1, theme: 'light' })
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
