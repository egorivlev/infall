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

export function networkError(): ApiError {
  return new ApiError(0, 'network', 'Cannot reach the server.')
}

function parseJson(raw: string): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** The ApiError for a non-2xx answer whose body was `raw`. A 401 also ends the session. */
export function errorFromBody(status: number, raw: string): ApiError {
  return errorFrom(status, parseJson(raw))
}

function errorFrom(status: number, json: unknown): ApiError {
  if (status === 401 && sessionStore.getState().status !== 'signed_out') {
    sessionStore.setState({ status: 'signed_out' }, true)
  }
  const err = isRecord(json) && isRecord(json.error) ? json.error : undefined
  const e = new ApiError(
    status,
    typeof err?.code === 'string' ? err.code : `http_${status}`,
    typeof err?.message === 'string' ? err.message : `Request failed (${status}).`,
    err?.detail ?? null,
  )
  if (status === 403 && e.code === 'moved') noteMoved(e.message)
  return e
}

// ---- M18: a moved Local Workspace refuses every write with 403 `moved` (team-move.md, Contract A) ----

/** The sentence a moved Workspace answers a write with, when the server sends none. */
export const MOVED_SENTENCE = 'This Workspace was moved to a Team server; open it there to make changes.'

type MovedState = { sentence: string | null; refusals: number }
const movedListeners = new Set<() => void>()
let moved: MovedState = { sentence: null, refusals: 0 }

function noteMoved(sentence: string) {
  moved = { sentence: sentence || MOVED_SENTENCE, refusals: moved.refusals + 1 }
  for (const fn of [...movedListeners]) fn()
}

/** Every 403 `moved` seen so far: the server's sentence and how many there were (internal: the Workspace store reads it). */
export const movedRefusals = {
  current: (): MovedState => moved,
  subscribe(fn: () => void): () => void {
    movedListeners.add(fn)
    return () => {
      movedListeners.delete(fn)
    }
  },
  /** For tests and a new session. */
  reset() {
    if (moved.refusals === 0) return
    moved = { sentence: null, refusals: 0 }
    for (const fn of [...movedListeners]) fn()
  },
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET' && method !== 'HEAD') headers['X-Infall-Request'] = '1'
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
  const json = parseJson(raw)
  if (!res.ok) throw errorFrom(res.status, json)
  if (raw && json === undefined) {
    throw new ApiError(res.status, 'internal', 'The server sent an unreadable response.')
  }
  return (json ?? {}) as T
}

/** `GET` for a file: the bytes and the `Content-Disposition` file name, if any. Errors as `request`. */
export async function requestBytes(path: string): Promise<{ bytes: Uint8Array; filename: string | null }> {
  let res: Response
  let bytes: Uint8Array
  try {
    res = await fetch(path, { method: 'GET', headers: { Accept: 'application/octet-stream' }, credentials: 'same-origin' })
    if (!res.ok) {
      const raw = await res.text()
      throw errorFromBody(res.status, raw)
    }
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw networkError()
  }
  return { bytes, filename: dispositionName(res.headers?.get?.('Content-Disposition') ?? null) }
}

/** The file name in a `Content-Disposition` header (`filename*=UTF-8''…` first, then `filename="…"`), or null. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim())
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/.exec(header)
  if (!plain) return null
  const name = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1]!.trim()
  return name || null
}

/** Progress of an upload: bytes sent so far and in all. */
export type UploadProgress = (sent: number, total: number) => void

/**
 * `POST` of raw bytes as `application/octet-stream`, answered with JSON. Reports upload progress through
 * XMLHttpRequest where the page has it (fetch cannot), else sends with fetch and reports only the end. Errors as `request`;
 * an abort rejects with ApiError(0, 'aborted').
 */
export function uploadBytes<T>(path: string, body: Blob | Uint8Array, options: { onProgress?: UploadProgress; signal?: AbortSignal } = {}): Promise<T> {
  const total = body instanceof Uint8Array ? body.byteLength : body.size
  const payload: Blob = body instanceof Uint8Array ? new Blob([body as BlobPart], { type: 'application/octet-stream' }) : body
  const { onProgress, signal } = options
  const finish = (status: number, raw: string): T => {
    const json = parseJson(raw)
    if (status < 200 || status >= 300) throw errorFrom(status, json)
    if (raw && json === undefined) throw new ApiError(status, 'internal', 'The server sent an unreadable response.')
    return (json ?? {}) as T
  }
  const aborted = () => new ApiError(0, 'aborted', 'The upload was stopped.')
  if (typeof XMLHttpRequest === 'undefined') {
    return fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-Infall-Request': '1' },
      body: payload,
      credentials: 'same-origin',
      signal,
    }).then(
      async (res) => {
        const raw = await res.text()
        onProgress?.(total, total)
        return finish(res.status, raw)
      },
      () => {
        throw signal?.aborted ? aborted() : networkError()
      },
    )
  }
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Infall-Request', '1')
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e: ProgressEvent) => onProgress(e.loaded, e.lengthComputable ? e.total : total)
    }
    xhr.onload = () => {
      try {
        onProgress?.(total, total)
        resolve(finish(xhr.status, typeof xhr.responseText === 'string' ? xhr.responseText : ''))
      } catch (e) {
        reject(e)
      }
    }
    xhr.onerror = () => reject(networkError())
    xhr.onabort = () => reject(aborted())
    if (signal) {
      if (signal.aborted) return reject(aborted())
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(payload)
  })
}
