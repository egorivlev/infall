export const INVALID_INVITE = 'This invite is no longer valid. Ask your Admin for a new one.'
export const GENERIC_ERROR = 'Something went wrong on our side. Try again.'
export const NETWORK_ERROR = "Can't reach the server. Check your connection and try again."

type ErrorLike = { code?: unknown; status?: unknown }

function read(e: unknown): { code: string; status: number } {
  const o: ErrorLike = typeof e === 'object' && e !== null ? e : {}
  return {
    code: typeof o.code === 'string' ? o.code : '',
    status: typeof o.status === 'number' ? o.status : -1,
  }
}

/** True when an invite lookup/accept says the invite is unknown, used, or expired. */
export function isInviteGone(e: unknown): boolean {
  const { code, status } = read(e)
  return code === 'invite_expired' || status === 404 || status === 410
}

/** Plain-words message for any failure. Never exposes codes or stack traces. */
export function describeError(e: unknown): string {
  switch (read(e).code) {
    case 'bad_credentials':
      return "That email and password don't match."
    case 'too_many_attempts':
      return 'Too many attempts. Try again in a few minutes.'
    case 'network':
      return NETWORK_ERROR
    case 'email_taken':
      return 'Someone with that email already has access.'
    case 'invite_expired':
      return INVALID_INVITE
    default:
      return GENERIC_ERROR
  }
}

/** Same, for the invite lookup where a 404 also means "no longer valid". */
export function describeLookupError(e: unknown): string {
  return isInviteGone(e) ? INVALID_INVITE : describeError(e)
}

/** The server's error code, or '' when the failure carries none. */
export function errorCode(e: unknown): string {
  return read(e).code
}
/** The HTTP status of a failure, or -1. */
export function errorStatus(e: unknown): number {
  return read(e).status
}
