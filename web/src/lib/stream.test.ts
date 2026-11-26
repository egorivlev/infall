import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { sessionStore } from './session-store'
import { createEventParser, postEventStream, toAiEvent } from './stream'
import { FakeServer, ME } from './testing'
import type { AiEvent } from './types'

const bytes = (text: string) => new TextEncoder().encode(text)

// Feeds `text` to a parser in chunks of `size` bytes and returns everything it read.
function parse(text: string, size: number): AiEvent[] {
  const parser = createEventParser()
  const all = bytes(text)
  const out: AiEvent[] = []
  for (let i = 0; i < all.length; i += size) out.push(...parser.push(all.slice(i, i + size)))
  return [...out, ...parser.end()]
}

const line = (event: AiEvent) => `data: ${JSON.stringify(event)}\n`

describe('toAiEvent', () => {
  it('reads the four events and drops what it does not know', () => {
    expect(toAiEvent({ type: 'delta', text: 'a', extra: 1 })).toEqual({ type: 'delta', text: 'a' })
    expect(toAiEvent({ type: 'tool', name: 'get_card' })).toEqual({ type: 'tool', name: 'get_card' })
    expect(toAiEvent({ type: 'done' })).toEqual({ type: 'done' })
    expect(toAiEvent({ type: 'done', model: 'm', session: 's' })).toEqual({ type: 'done', model: 'm', session: 's' })
    expect(toAiEvent({ type: 'error', message: 'No.' })).toEqual({ type: 'error', message: 'No.' })
    for (const bad of [null, 'delta', 7, [], {}, { type: 'delta' }, { type: 'delta', text: 1 }, { type: 'tool' }, { type: 'error' }, { type: 'done', model: 3 }, { type: 'ping' }]) {
      expect(toAiEvent(bad)).toBeNull()
    }
  })
})

describe('createEventParser', () => {
  const events: AiEvent[] = [
    { type: 'delta', text: 'Schwelle ≈ 1 % — 表面符号 🧮' },
    { type: 'tool', name: 'get_card' },
    { type: 'delta', text: ' line\nbreak and "quotes"' },
    { type: 'done', model: 'anthropic/claude' },
  ]
  const text = events.map(line).join('')

  it('reads one event per data line', () => {
    expect(parse(text, 100_000)).toEqual(events)
  })
  it('gives the same events however the bytes are cut: inside a line, inside a character', () => {
    for (const size of [1, 2, 3, 5, 7, 16, 61]) expect(parse(text, size)).toEqual(events)
  })
  it('hands out an event as soon as its line is complete, not before', () => {
    const parser = createEventParser()
    const whole = bytes(line({ type: 'delta', text: 'é' }))
    expect(parser.push(whole.slice(0, whole.length - 1))).toEqual([])
    expect(parser.push(whole.slice(whole.length - 1))).toEqual([{ type: 'delta', text: 'é' }])
    expect(parser.end()).toEqual([])
  })
  it('skips comment lines, blank lines, other fields and lines that are not events', () => {
    const noisy = [
      ': keep-alive',
      '',
      'event: message',
      'id: 7',
      'retry: 1000',
      'data: {"type":"delta","text":"a"}',
      'data: not json',
      'data: {"type":"ping"}',
      'data:{"type":"delta","text":"b"}',
      ':data: {"type":"delta","text":"never"}',
      'data: {"type":"done"}',
      '',
    ].join('\n')
    const expected: AiEvent[] = [{ type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }, { type: 'done' }]
    expect(parse(noisy, 100_000)).toEqual(expected)
    expect(parse(noisy, 1)).toEqual(expected)
  })
  it('reads CRLF line ends, also when a chunk ends between the two', () => {
    const crlf = text.replaceAll('\n', '\r\n')
    expect(parse(crlf, 100_000)).toEqual(events)
    for (const size of [1, 4, 9]) expect(parse(crlf, size)).toEqual(events)
  })
  it('reads a last line without a line break', () => {
    expect(parse(text.slice(0, -1), 100_000)).toEqual(events)
    expect(parse(text.slice(0, -1), 3)).toEqual(events)
    expect(parse('data: {"type":"done"}\r', 2)).toEqual([{ type: 'done' }])
  })
  it('reads nothing from an empty stream or half an event', () => {
    expect(parse('', 1)).toEqual([])
    expect(parse('data: {"type":"del', 4)).toEqual([])
  })
})

describe('postEventStream', () => {
  let server: FakeServer

  async function collect(signal?: AbortSignal): Promise<AiEvent[]> {
    const out: AiEvent[] = []
    for await (const e of postEventStream('/api/ai/chat', { messages: [{ role: 'user', content: 'Hi' }] }, signal)) out.push(e)
    return out
  }

  function deferred() {
    let release!: () => void
    const promise = new Promise<void>((r) => (release = r))
    return { promise, release }
  }

  beforeEach(() => {
    server = new FakeServer()
    server.aiSettings[ME.id] = { key: 'sk-or-v1-0123456789abcdef', added_at: 1, model: 'openai/gpt-5' }
    vi.stubGlobal('fetch', server.fetch)
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts JSON with the request header and yields the events of the answer', async () => {
    const fetchSpy = vi.fn(server.fetch)
    vi.stubGlobal('fetch', fetchSpy)
    server.aiScript = [{ type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }, { type: 'done', model: 'openai/gpt-5' }]
    expect(await collect()).toEqual(server.aiScript)
    const [path, init] = fetchSpy.mock.calls[0]!
    expect(path).toBe('/api/ai/chat')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"messages":[{"role":"user","content":"Hi"}]}' })
    expect(init!.headers).toMatchObject({ 'X-Infall-Request': '1', 'Content-Type': 'application/json' })
  })
  it('reads the same events through one-byte chunks', async () => {
    server.aiScript = [{ type: 'delta', text: 'π ≈ 3,14 🙂' }, { raw: ': ping\r\n' }, { type: 'tool', name: 'list_cards' }, { type: 'done' }]
    server.aiChunk = 1
    expect(await collect()).toEqual([{ type: 'delta', text: 'π ≈ 3,14 🙂' }, { type: 'tool', name: 'list_cards' }, { type: 'done' }])
  })
  it('yields events as they arrive, before the stream ends', async () => {
    const gate = deferred()
    server.aiScript = [{ type: 'delta', text: 'first' }, { wait: gate.promise }, { type: 'done' }]
    const stream = postEventStream('/api/ai/chat', { messages: [{ role: 'user', content: 'Hi' }] })
    expect((await stream.next()).value).toEqual({ type: 'delta', text: 'first' })
    gate.release()
    expect((await stream.next()).value).toEqual({ type: 'done' })
    expect((await stream.next()).done).toBe(true)
  })
  it('reads a last event that has no line break', async () => {
    server.aiScript = [{ type: 'delta', text: 'a' }, { raw: 'data: {"type":"done"}' }]
    expect(await collect()).toEqual([{ type: 'delta', text: 'a' }, { type: 'done' }])
  })
  it('throws the ApiError of a JSON error body', async () => {
    for (const [status, code] of [[409, 'no_key'], [429, 'too_many_requests'], [503, 'ai_not_configured'], [400, 'bad_request']] as const) {
      server.aiFail = { status, code }
      const error = await collect().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status, code, message: 'nope' })
    }
  })
  it('copes with an error body that is not JSON, and a 401 ends the session', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 })))
    await expect(collect()).rejects.toMatchObject({ status: 502, code: 'http_502' })
    vi.stubGlobal('fetch', server.fetch)
    server.aiFail = { status: 401, code: 'not_signed_in' }
    await expect(collect()).rejects.toMatchObject({ status: 401, code: 'not_signed_in' })
    expect(sessionStore.getState().status).toBe('signed_out')
  })
  it('throws a network error when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    await expect(collect()).rejects.toMatchObject({ status: 0, code: 'network' })
  })
  it('throws cut_off when the stream breaks, after yielding what came before', async () => {
    server.aiScript = [{ type: 'delta', text: 'half an ans' }]
    server.aiDrop = true
    const seen: AiEvent[] = []
    const error = await (async () => {
      for await (const e of postEventStream('/api/ai/chat', { messages: [{ role: 'user', content: 'Hi' }] })) seen.push(e)
    })().catch((e: unknown) => e)
    expect(seen).toEqual([{ type: 'delta', text: 'half an ans' }])
    expect(error).toMatchObject({ status: 0, code: 'cut_off', message: 'The answer was cut off.' })
  })
  it('ends quietly when aborted during the stream, and drops the request', async () => {
    const gate = deferred()
    const control = new AbortController()
    server.aiScript = [{ type: 'delta', text: 'first' }, { wait: gate.promise }, { type: 'delta', text: 'never' }, { type: 'done' }]
    const seen: AiEvent[] = []
    const reading = (async () => {
      for await (const e of postEventStream('/api/ai/chat', { messages: [{ role: 'user', content: 'Hi' }] }, control.signal)) seen.push(e)
    })()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    control.abort()
    await reading
    expect(seen).toEqual([{ type: 'delta', text: 'first' }])
    expect(server.aiAborted).toBe(1)
    gate.release()
  })
  it('ends quietly, without a request, when already aborted', async () => {
    const control = new AbortController()
    control.abort()
    expect(await collect(control.signal)).toEqual([])
    expect(server.requests).toEqual([])
  })
  it('ends quietly when aborted before the answer starts', async () => {
    const control = new AbortController()
    vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    })
    const reading = collect(control.signal)
    control.abort()
    expect(await reading).toEqual([])
  })
  it('drops the request when the reader stops early', async () => {
    const gate = deferred()
    server.aiScript = [{ type: 'error', message: 'No.' }, { wait: gate.promise }, { type: 'done' }]
    for await (const e of postEventStream('/api/ai/chat', { messages: [{ role: 'user', content: 'Hi' }] })) {
      expect(e).toEqual({ type: 'error', message: 'No.' })
      break
    }
    expect(server.aiAborted).toBe(1)
    gate.release()
  })
})
