// A streaming POST: the answer of an AI turn arrives as an event stream (api.md §14) — one `data: <AiEvent JSON>`
// line per event — and is read as it comes, not when it ends.
import { ApiError, errorFromBody, networkError } from './http'
import type { AiEvent } from './types'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const optionalText = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string'

/** Reads one event from parsed JSON; null when it is not one this build knows. Unknown keys are dropped. */
export function toAiEvent(json: unknown): AiEvent | null {
  if (!isRecord(json)) return null
  if (json.type === 'delta') return typeof json.text === 'string' ? { type: 'delta', text: json.text } : null
  if (json.type === 'tool') return typeof json.name === 'string' ? { type: 'tool', name: json.name } : null
  if (json.type === 'error') return typeof json.message === 'string' ? { type: 'error', message: json.message } : null
  if (json.type !== 'done' || !optionalText(json.model) || !optionalText(json.session)) return null
  const done: AiEvent = { type: 'done' }
  if (json.model !== undefined) done.model = json.model
  if (json.session !== undefined) done.session = json.session
  return done
}

/**
 * Turns the bytes of an event stream into events, whatever the chunks look like: a chunk may end inside a line or
 * inside a UTF-8 character. Lines end in LF or CRLF. A line starting with `:` is a comment; only `data:` lines are
 * read (one event each); a line that is not a readable event is skipped. `end()` reads a last line that has no
 * line break.
 */
export function createEventParser(): { push(chunk: Uint8Array): AiEvent[]; end(): AiEvent[] } {
  const decoder = new TextDecoder()
  let rest = ''
  const read = (text: string, last: boolean): AiEvent[] => {
    const lines = (rest + text).split('\n')
    rest = last ? '' : lines.pop()!
    const out: AiEvent[] = []
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (!line.startsWith('data:')) continue
      let json: unknown
      try {
        json = JSON.parse(line.slice(5))
      } catch {
        continue
      }
      const event = toAiEvent(json)
      if (event) out.push(event)
    }
    return out
  }
  return {
    push: (chunk) => read(decoder.decode(chunk, { stream: true }), false),
    end: () => read(decoder.decode(), true),
  }
}

/**
 * POSTs `body` as JSON and yields the events of the answer as they arrive.
 *
 * - An answer that is not 2xx throws the ApiError of its JSON error body (a 401 ends the session); a request that
 *   gets no answer throws `status 0, code 'network'`.
 * - A stream that breaks after it started throws `status 0, code 'cut_off'`; the events before the break were yielded.
 * - Aborting `signal` ends the generator quietly, before or during the stream. Leaving the loop early drops the request.
 */
export async function* postEventStream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<AiEvent, void, void> {
  if (signal?.aborted) return
  // The request is dropped when the caller aborts and when the caller stops reading.
  const control = new AbortController()
  const abort = () => control.abort()
  signal?.addEventListener('abort', abort)
  try {
    let res: Response
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-Infall-Request': '1' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        signal: control.signal,
      })
    } catch {
      if (signal?.aborted) return
      throw networkError()
    }
    if (!res.ok) {
      let raw = ''
      try {
        raw = await res.text()
      } catch {
        if (signal?.aborted) return
      }
      throw errorFromBody(res.status, raw)
    }
    const parser = createEventParser()
    const reader = res.body?.getReader()
    if (!reader) return
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await reader.read()
      } catch {
        if (signal?.aborted) return
        throw new ApiError(0, 'cut_off', 'The answer was cut off.')
      }
      if (signal?.aborted) return
      if (step.done) break
      for (const event of parser.push(step.value)) {
        yield event
        if (signal?.aborted) return
      }
    }
    yield* parser.end()
  } finally {
    signal?.removeEventListener('abort', abort)
    control.abort()
  }
}
