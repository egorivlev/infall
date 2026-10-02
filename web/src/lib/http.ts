import { sessionStore } from './session-store'

export class ApiError extends Error {
  status: number
  code: string
  detail: unknown
  constructor(status: number, code: string, message: string, detail: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function networkError(): ApiError {
  return new ApiError(0, 'network', 'Cannot reach the server.')
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET' && method !== 'HEAD') headers['X-Qoop-Request'] = '1'
  let payload: string | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let raw = ''
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' })
    raw = await res.text()
  } catch {
    throw networkError()
  }
  let json: unknown
  if (raw) {
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
  }
  if (!res.ok) {
    if (res.status === 401 && sessionStore.getState().status !== 'signed_out') {
      sessionStore.setState({ status: 'signed_out' }, true)
    }
    const err = isRecord(json) && isRecord(json.error) ? json.error : undefined
    throw new ApiError(
      res.status,
      typeof err?.code === 'string' ? err.code : `http_${res.status}`,
      typeof err?.message === 'string' ? err.message : `Request failed (${res.status}).`,
      err?.detail ?? null,
    )
  }
  if (raw && json === undefined) {
    throw new ApiError(res.status, 'internal', 'The server sent an unreadable response.')
  }
  return (json ?? {}) as T
}
