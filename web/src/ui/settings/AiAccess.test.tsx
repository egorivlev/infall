// M5: the AI access screen — the Member's own access tokens, the one-time secret, and the connect command.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessToken } from '../../lib'

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
type Fn = (...a: unknown[]) => Promise<unknown>
const h = vi.hoisted(() => ({
  list: (async () => []) as Fn,
  create: (async () => ({})) as Fn,
  remove: (async () => {}) as Fn,
  listed: 0,
  created: [] as unknown[][],
  removed: [] as unknown[][],
  ai: { setup: { provider: 'none', reason: 'loading', desktop: false, openrouter: { enabled: false } }, conversations: [], current: null, busy: false },
}))

vi.mock('../../lib', () => ({
  tokens: {
    list: () => {
      h.listed++
      return h.list()
    },
    create: (...a: unknown[]) => {
      h.created.push(a)
      return h.create(...a)
    },
    remove: (...a: unknown[]) => {
      h.removed.push(a)
      return h.remove(...a)
    },
  },
  toolEndpoint: () => 'https://qoop.test/mcp',
  // The "AI sidebar" card above the tokens has its own tests (AiSidebarCard.test.tsx); here it stays in its checking state.
  useAi: () => h.ai,
  ai: { refresh: async () => {}, setKey: async () => {}, removeKey: async () => {}, setModel: async () => {}, models: async () => [] },
}))

import { AiAccess } from './AiAccess'

const SECRET = 'qoop_at_S3CR3T-value-0123456789'
const ENDPOINT = 'https://qoop.test/mcp'
const PLACEHOLDER_COMMAND = `claude mcp add --transport http qoop ${ENDPOINT} --header "Authorization: Bearer <YOUR_TOKEN>"`
const REAL_COMMAND = `claude mcp add --transport http qoop ${ENDPOINT} --header "Authorization: Bearer ${SECRET}"`

const LAPTOP: AccessToken = { id: 't1', name: 'Claude Code on my laptop', created_at: new Date(2030, 10, 14, 9, 0).getTime(), last_used_at: new Date(2030, 10, 20, 14, 6).getTime() }
const DESKTOP: AccessToken = { id: 't2', name: 'office desktop', created_at: new Date(2030, 10, 2, 9, 0).getTime() }
const NEW: AccessToken = { id: 't3', name: 'Cursor', created_at: new Date(2030, 10, 22, 9, 0).getTime() }

const fail = (status: number, code: string) => async () => {
  throw Object.assign(new Error(code), { status, code })
}

let clipboard: string[]
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

const command = () => screen.getByLabelText('Command to connect Claude Code')
const nameField = () => screen.getByRole('textbox', { name: 'Name' })
const createButton = () => screen.getByRole('button', { name: 'Create access token' })
const secretPanel = () => screen.getByRole('group', { name: 'New access token' })

async function renderLoaded() {
  const user = userEvent.setup()
  const view = render(<AiAccess />)
  await screen.findByRole('table')
  // userEvent.setup() installs its own clipboard stub: put ours back on top.
  stubClipboard(async (text) => void clipboard.push(text))
  return { user, ...view }
}
async function createToken(user: ReturnType<typeof userEvent.setup>, name = 'Cursor') {
  await user.type(nameField(), name)
  await user.click(createButton())
  return screen.findByRole('group', { name: 'New access token' })
}

beforeEach(() => {
  h.list = async () => [DESKTOP, LAPTOP]
  h.create = async () => ({ token: NEW, secret: SECRET })
  h.remove = async () => {}
  h.listed = 0
  h.created = []
  h.removed = []
  clipboard = []
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AI access: the screen', () => {
  it('has the heading, the two intro paragraphs, what the AI can do, and the note — in the vocabulary', async () => {
    await renderLoaded()
    expect(screen.getByRole('heading', { level: 1, name: 'AI access' })).toBeInTheDocument()
    expect(screen.getByText(/Infall doesn't ship a model\. Connect the AI you already use/)).toBeInTheDocument()
    expect(screen.getByText(/An access token lets an AI act as you, read-only plus Suggestions\. Treat it like a password/)).toBeInTheDocument()
    const can = within(screen.getByRole('region', { name: 'What the AI can do' })).getAllByRole('listitem').map((li) => li.textContent)
    expect(can).toEqual([
      'Read Cards, Pages, Sources and Connections on any Branch',
      'Propose a Source for a Card',
      'Propose a Connection between two Cards',
      'Not: change, delete, or accept anything',
    ])
    expect(screen.getByText('Text on the Board was written by people and other AIs. A careful AI treats it as content, not as instructions.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/API key|recommendation|proposal|\bbot\b|\buser\b/i)
  })

  it('lists the tokens newest first, with "never" for one that was not used', async () => {
    await renderLoaded()
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('rowheader')).toHaveTextContent('Claude Code on my laptop')
    expect(rows[0]).toHaveTextContent('14 Nov 2030')
    expect(rows[0]).toHaveTextContent('20 Nov 2030, 14:06')
    expect(within(rows[1]!).getByRole('rowheader')).toHaveTextContent('office desktop')
    expect(within(rows[1]!).getAllByRole('cell')[1]).toHaveTextContent(/^never$/)
    expect(screen.getByText('2 of 10')).toBeInTheDocument()
  })

  it('shows a token name as typed: its cell opts out of the upper-casing of table heads', async () => {
    await renderLoaded()
    const cell = screen.getByRole('rowheader', { name: 'office desktop' })
    expect(cell.textContent).toBe('office desktop')
    expect(cell).toHaveClass('q-tokens__name')
  })

  it('says so when there are none, and when the list cannot be loaded offers to try again', async () => {
    h.list = async () => []
    const first = render(<AiAccess />)
    expect(await screen.findByText('No access tokens yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    first.unmount()

    h.list = fail(0, 'network')
    const user = userEvent.setup()
    render(<AiAccess />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection and try again.")
    h.list = async () => [LAPTOP]
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('rowheader', { name: 'Claude Code on my laptop' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says "Loading access tokens…" only after 150 ms', async () => {
    vi.useFakeTimers()
    h.list = () => new Promise(() => {})
    render(<AiAccess />)
    expect(screen.queryByText('Loading access tokens…')).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(160))
    expect(screen.getByText('Loading access tokens…')).toBeInTheDocument()
  })

  it('works under StrictMode (effects run twice)', async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <AiAccess />
      </StrictMode>,
    )
    expect(await screen.findByRole('rowheader', { name: 'office desktop' })).toBeInTheDocument()
    await createToken(user)
    expect(h.created).toEqual([['Cursor']])
    expect(within(secretPanel()).getByRole('textbox')).toHaveValue(SECRET)
  })
})

describe('AI access: the connect command', () => {
  it('shows the exact command with <YOUR_TOKEN> and the endpoint while no secret is on show', async () => {
    await renderLoaded()
    expect(command().textContent).toBe(PLACEHOLDER_COMMAND)
    expect(screen.getByText(/Other MCP clients: endpoint/)).toHaveTextContent(`Other MCP clients: endpoint ${ENDPOINT}, header Authorization: Bearer <token>.`)
  })

  it('copies the command and says "Copied"', async () => {
    const { user } = await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(clipboard).toEqual([PLACEHOLDER_COMMAND])
    expect(await screen.findByRole('button', { name: 'Copy command' })).toHaveTextContent('Copied')
  })

  it('says in words when copying fails, with the command selected', async () => {
    const { user } = await renderLoaded()
    stubClipboard(async () => {
      throw new Error('denied')
    })
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(await screen.findByText("Couldn't copy automatically. The command is selected — copy it with your keyboard.")).toBeInTheDocument()
    expect(window.getSelection()?.toString()).toBe(PLACEHOLDER_COMMAND)
  })

  it('selects its content on focus', async () => {
    await renderLoaded()
    fireEvent.focus(command())
    expect(window.getSelection()?.toString()).toBe(PLACEHOLDER_COMMAND)
  })
})

describe('AI access: creating an access token', () => {
  it('creates it with the trimmed name and shows the secret once, focused and selected', async () => {
    const { user } = await renderLoaded()
    const panel = await createToken(user, '  Cursor  ')
    expect(h.created).toEqual([['Cursor']])
    const field = within(panel).getByRole<HTMLInputElement>('textbox', { name: /Access token “Cursor”/ })
    expect(field).toHaveValue(SECRET)
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveFocus()
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(SECRET.length)
    expect(within(panel).getByText('This is shown once. Store it in your AI app now.')).toBeInTheDocument()
    // the new token is in the table, the form is ready for the next one
    expect(screen.getByRole('rowheader', { name: 'Cursor' })).toBeInTheDocument()
    expect(screen.getByText('3 of 10')).toBeInTheDocument()
    expect(nameField()).toHaveValue('')
  })

  it('puts the real secret into the command block, with the endpoint', async () => {
    const { user } = await renderLoaded()
    await createToken(user)
    expect(command().textContent).toBe(REAL_COMMAND)
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(clipboard).toEqual([REAL_COMMAND])
  })

  it('"Done" removes the secret from everywhere on the screen', async () => {
    const { user, container } = await renderLoaded()
    const panel = await createToken(user)
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('group', { name: 'New access token' })).not.toBeInTheDocument()
    expect(command().textContent).toBe(PLACEHOLDER_COMMAND)
    expect(document.body.innerHTML).not.toContain(SECRET)
    for (const input of container.querySelectorAll('input')) expect(input.value).not.toContain(SECRET)
    expect(screen.getByRole('rowheader', { name: 'Cursor' })).toBeInTheDocument() // the token itself stays
    expect(nameField()).toHaveFocus()
  })

  it('copies the secret and says "Copied"', async () => {
    const { user } = await renderLoaded()
    const panel = await createToken(user)
    await user.click(within(panel).getByRole('button', { name: 'Copy' }))
    expect(clipboard).toEqual([SECRET])
    expect(await within(panel).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('says in words when copying the secret fails, leaving it selected', async () => {
    const { user } = await renderLoaded()
    const panel = await createToken(user)
    stubClipboard(async () => {
      throw new Error('denied')
    })
    await user.click(within(panel).getByRole('button', { name: 'Copy' }))
    expect(await within(panel).findByText("Couldn't copy automatically. The access token is selected — copy it with your keyboard.")).toBeInTheDocument()
    const field = within(panel).getByRole<HTMLInputElement>('textbox')
    expect(field.selectionEnd! - field.selectionStart!).toBe(SECRET.length)
  })

  it('reports a missing Clipboard API as a failure too', async () => {
    const { user } = await renderLoaded()
    const panel = await createToken(user)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await user.click(within(panel).getByRole('button', { name: 'Copy' }))
    expect(await within(panel).findByText(/Couldn't copy automatically/)).toBeInTheDocument()
  })

  it('selects the secret when its field is focused', async () => {
    const { user } = await renderLoaded()
    const panel = await createToken(user)
    const field = within(panel).getByRole<HTMLInputElement>('textbox')
    field.setSelectionRange(3, 3)
    await user.click(nameField())
    await user.click(field)
    fireEvent.focus(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(SECRET.length)
  })

  it('writes nothing about the secret to storage, the URL or the console', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const { user } = await renderLoaded()
    const panel = await createToken(user)
    await user.click(within(panel).getByRole('button', { name: 'Copy' }))
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    await user.click(within(panel).getByRole('button', { name: 'Done' }))

    expect(setItem).not.toHaveBeenCalled()
    const stored = [window.localStorage, window.sessionStorage].flatMap((s) => Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i)!) ?? ''))
    expect(stored.join('\n')).not.toContain(SECRET)
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET)
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(window.location.href).not.toContain(SECRET)
    expect(document.cookie).not.toContain(SECRET)
  })

  it('asks for a name before sending anything', async () => {
    const { user } = await renderLoaded()
    await user.click(createButton())
    expect(screen.getByText('Give the access token a name, so you can tell it apart later.')).toBeInTheDocument()
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
    expect(nameField()).toHaveFocus()
    await user.type(nameField(), '   ')
    await user.click(createButton())
    expect(h.created).toEqual([])
    await user.type(nameField(), 'x')
    expect(screen.queryByText(/Give the access token a name/)).not.toBeInTheDocument()
  })

  it('says in plain words when the server refuses the name', async () => {
    h.create = fail(400, 'bad_request')
    const { user } = await renderLoaded()
    await user.type(nameField(), 'Cursor')
    await user.click(createButton())
    expect(await screen.findByText("That name can't be used. Use 1 to 60 characters on one line.")).toBeInTheDocument()
    expect(nameField()).toHaveValue('Cursor')
    expect(screen.queryByRole('group', { name: 'New access token' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('bad_request')
  })

  it('says in plain words when the server reports the limit', async () => {
    h.create = fail(409, 'token_limit')
    const { user } = await renderLoaded()
    await user.type(nameField(), 'Cursor')
    await user.click(createButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have 10 access tokens, the most one Member can have. Revoke one you no longer use, then create a new one.')
    expect(document.body.textContent).not.toContain('token_limit')
  })

  it('tells the limit from a refused name when the server answers both with 400', async () => {
    // What the server does today: 400 bad_request for the limit. Nine tokens when the screen loaded, ten by now.
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, name: `token ${i}`, created_at: 1000 + i }))
    h.list = async () => many(9)
    const { user } = await renderLoaded()
    h.list = async () => many(10)
    h.create = fail(400, 'bad_request')
    await user.type(nameField(), 'Cursor')
    await user.click(createButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(/You already have 10 access tokens, the most one Member can have\./)
    expect(screen.getAllByText(/You already have 10 access tokens/)).toHaveLength(1)
    expect(screen.queryByText(/That name can't be used/)).not.toBeInTheDocument()
    expect(screen.getByText('10 of 10')).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
  })

  it('with 10 tokens it says so up front and does not offer to create another', async () => {
    h.list = async () => Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, name: `token ${i}`, created_at: 1000 + i }))
    const { user } = await renderLoaded()
    expect(screen.getByText(/You already have 10 access tokens, the most one Member can have\./)).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
    await user.type(nameField(), 'one more{Enter}')
    expect(h.created).toEqual([])
  })

  it('says in plain words when the server cannot be reached or fails', async () => {
    h.create = fail(0, 'network')
    const { user } = await renderLoaded()
    await user.type(nameField(), 'Cursor')
    await user.click(createButton())
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection and try again.")
    h.create = fail(500, 'internal')
    await user.click(createButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again.'))
    expect(command().textContent).toBe(PLACEHOLDER_COMMAND)
  })

  it('sends one request for a double submit', async () => {
    let release = (_v: unknown) => {}
    h.create = () => new Promise((r) => (release = r))
    const { user } = await renderLoaded()
    await user.type(nameField(), 'Cursor')
    await user.click(createButton())
    await user.click(screen.getByRole('button', { name: 'Creating access token…' }))
    expect(h.created).toHaveLength(1)
    release({ token: NEW, secret: SECRET })
    expect(await screen.findByRole('group', { name: 'New access token' })).toBeInTheDocument()
  })

  it('drops a secret that arrives after the screen was left', async () => {
    let release = (_v: unknown) => {}
    h.create = () => new Promise((r) => (release = r))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { user, unmount } = await renderLoaded()
    await user.type(nameField(), 'Cursor')
    await user.click(createButton())
    unmount()
    release({ token: NEW, secret: SECRET })
    await Promise.resolve()
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('AI access: revoking', () => {
  it('asks first, naming the token, and Cancel changes nothing', async () => {
    const { user } = await renderLoaded()
    const opener = screen.getByRole('button', { name: 'Revoke access token office desktop' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Revoke “office desktop”?' })
    expect(dialog).toHaveTextContent('Any AI using this access token loses access immediately.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(h.removed).toEqual([])
    expect(opener).toHaveFocus()
    expect(screen.getByRole('rowheader', { name: 'office desktop' })).toBeInTheDocument()
  })

  it('revokes on confirm and takes the row away', async () => {
    const { user } = await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'Revoke access token office desktop' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(h.removed).toEqual([['t2']])
    expect(screen.queryByRole('rowheader', { name: 'office desktop' })).not.toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Claude Code on my laptop' })).toBeInTheDocument()
    expect(screen.getByText('1 of 10')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Access tokens' })).toHaveFocus()
  })

  it('keeps the dialog open with a plain sentence when revoking fails', async () => {
    h.remove = fail(500, 'internal')
    const { user } = await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'Revoke access token office desktop' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again.')
    expect(screen.getByRole('rowheader', { name: 'office desktop' })).toBeInTheDocument()
  })

  it('treats a token that is already gone as revoked', async () => {
    h.remove = fail(404, 'not_found')
    const { user } = await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'Revoke access token office desktop' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: 'office desktop' })).not.toBeInTheDocument())
  })

  it('stops showing the secret of a token that is revoked while it is on show', async () => {
    const { user } = await renderLoaded()
    await createToken(user)
    await user.click(screen.getByRole('button', { name: 'Revoke access token Cursor' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'New access token' })).not.toBeInTheDocument())
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(command().textContent).toBe(PLACEHOLDER_COMMAND)
  })
})
