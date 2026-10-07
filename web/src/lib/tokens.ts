// Access tokens for the AI tool layer: the signed-in Member's own. Nothing is cached — a secret is shown once.
import { ApiError, request } from './http'
import { sessionStore } from './session-store'
import type { AccessToken } from './types'

const MAX_NAME = 60

function member() {
  const s = sessionStore.getState()
  if (s.status !== 'signed_in' || s.member.role === 'guest') {
    throw new ApiError(403, 'forbidden', 'Guests cannot use access tokens.')
  }
}

export const tokens = {
  async list(): Promise<AccessToken[]> {
    member()
    const { tokens: list } = await request<{ tokens: AccessToken[] }>('GET', '/api/tokens')
    return list
  },
  async create(name: string): Promise<{ token: AccessToken; secret: string }> {
    member()
    const trimmed = name.trim()
    if (trimmed === '' || trimmed.length > MAX_NAME) {
      throw new ApiError(400, 'bad_request', `A token needs a name of 1 to ${MAX_NAME} characters.`)
    }
    const { token, secret } = await request<{ token: AccessToken; secret: string }>('POST', '/api/tokens', { name: trimmed })
    return { token, secret }
  },
  async remove(id: string): Promise<void> {
    member()
    await request('DELETE', `/api/tokens/${encodeURIComponent(id)}`)
  },
}

/** Where an AI client connects to (Model Context Protocol), to paste into its settings beside a token. */
export function toolEndpoint(): string {
  return `${globalThis.location.origin}/mcp`
}
