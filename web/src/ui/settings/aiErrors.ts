import { describeError, errorCode, errorStatus, NETWORK_ERROR } from '../shell/errorMessages'

export const SERVER_OFF = 'This server is not set up to store keys. Ask your Admin.'
export const KEY_REQUIRED = 'Paste your OpenRouter key first.'
export const KEY_REFUSED = "That key wasn't accepted. Check that you copied the whole OpenRouter key, then try again."
export const MODELS_FAILED = "The list of models couldn't be loaded."
export const MODEL_FAILED = "The model couldn't be changed. Try again."

const isOff = (status: number, code: string) => status === 404 || status === 501 || /disabled|not_enabled|server_off/.test(code)

/**
 * Plain words for a failed "Add key" / "Replace key". Built from the status and code only:
 * the failure's own message is never shown, so nothing the server echoes back can put the key on screen.
 */
export function describeKeyError(e: unknown): string {
  const status = errorStatus(e)
  const code = errorCode(e)
  if (code === 'network') return NETWORK_ERROR
  if (isOff(status, code)) return SERVER_OFF
  if (status === 400 || status === 401 || status === 422) return KEY_REFUSED
  if (status === 429) return 'Too many attempts. Try again in a few minutes.'
  return describeError(e)
}

/** Plain words for a failed "Remove". */
export function describeRemoveError(e: unknown): string {
  const status = errorStatus(e)
  const code = errorCode(e)
  if (code === 'network') return NETWORK_ERROR
  if (isOff(status, code)) return SERVER_OFF
  return describeError(e)
}

/** Plain words for a failed change of model. */
export function describeModelError(e: unknown): string {
  const status = errorStatus(e)
  const code = errorCode(e)
  if (code === 'network') return NETWORK_ERROR
  if (isOff(status, code)) return SERVER_OFF
  if (status === 400 || status === 422) return "That model can't be used. Choose another one."
  return MODEL_FAILED
}

/** Plain words for a list of models that did not load. */
export function describeModelsError(e: unknown): string {
  return errorCode(e) === 'network' ? `${MODELS_FAILED} ${NETWORK_ERROR}` : MODELS_FAILED
}
