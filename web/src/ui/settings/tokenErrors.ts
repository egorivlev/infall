import { describeError, errorCode, errorStatus } from '../shell/errorMessages'

/** How many access tokens one Member may hold (the server enforces it; the screen says so before asking). */
export const TOKEN_LIMIT = 10
export const NAME_MAX = 60

export const LIMIT_REACHED = `You already have ${TOKEN_LIMIT} access tokens, the most one Member can have. Revoke one you no longer use, then create a new one.`
export const NAME_REQUIRED = 'Give the access token a name, so you can tell it apart later.'
export const NAME_TOO_LONG = `Use a name of ${NAME_MAX} characters or fewer.`
export const NAME_REFUSED = `That name can't be used. Use 1 to ${NAME_MAX} characters on one line.`

/** What is wrong with a name as typed, or '' when it is fine. */
export function checkName(value: string): string {
  const name = value.trim()
  if (!name) return NAME_REQUIRED
  return name.length > NAME_MAX ? NAME_TOO_LONG : ''
}

/**
 * `refused`: the server said no to the request itself (400) — a name it will not take, or the limit;
 * it uses one code for both, so the screen looks at how many tokens there are to tell which.
 */
export type CreateFailure = { kind: 'limit' | 'refused' | 'other'; message: string }

/** Plain words for a failed "Create access token". Codes never reach the screen. */
export function describeCreateError(e: unknown): CreateFailure {
  const code = errorCode(e)
  const status = errorStatus(e)
  if (status === 409 || /limit|too_many/.test(code)) return { kind: 'limit', message: LIMIT_REACHED }
  if (status === 400 || status === 422) return { kind: 'refused', message: NAME_REFUSED }
  if (status === 403) return { kind: 'other', message: 'Access tokens are for Members. Your access is read-only.' }
  return { kind: 'other', message: describeError(e) }
}
