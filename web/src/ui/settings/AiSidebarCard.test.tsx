// M7: the "AI sidebar" card of the AI access screen — what answers on this device, the OpenRouter key and model.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiModel, AiSetup } from '../../lib'

// Plain functions, not vi.fn(): vitest attaches an unhandled-rejection handler to a mock's rejected Promise.
type Fn = (...a: unknown[]) => Promise<unknown>
const h = vi.hoisted(() => ({
  setup: null as unknown,
  refresh: (async () => {}) as Fn,
  setKey: (async () => {}) as Fn,
  removeKey: (async () => {}) as Fn,
  setModel: (async () => {}) as Fn,
  models: (async () => []) as Fn,
  calls: { refresh: 0, setKey: [] as unknown[][], removeKey: 0, setModel: [] as unknown[][], models: 0 },
}))

vi.mock('../../lib', () => ({
  tokens: { list: async () => [], create: async () => ({}), remove: async () => {} },
  toolEndpoint: () => 'https://qoop.test/mcp',
  useAi: () => ({ setup: h.setup, conversations: [], current: null, busy: false }),
  ai: {
    refresh: () => {
      h.calls.refresh++
      return h.refresh()
    },
    setKey: (...a: unknown[]) => {
      h.calls.setKey.push(a)
      return h.setKey(...a)
    },
    removeKey: () => {
      h.calls.removeKey++
      return h.removeKey()
    },
    setModel: (...a: unknown[]) => {
      h.calls.setModel.push(a)
      return h.setModel(...a)
    },
    models: () => {
      h.calls.models++
      return h.models()
    },
  },
}))

import { AiAccess } from './AiAccess'
import { AiSidebarCard } from './AiSidebarCard'

const KEY = 'sk-or-v1-S3CR3T-0123456789abcdef7f3a'
const ADDED = new Date(2030, 10, 14, 9, 0).getTime()
const SONNET = 'anthropic/claude-sonnet-4.5'

const none = (
  reason: 'loading' | 'guest' | 'desktop_no_claude' | 'browser_no_key' | 'no_model' | 'server_off',
  extra: { desktop?: boolean; enabled?: boolean; key?: { last4: string; added_at: number }; model?: string } = {},
): AiSetup => ({
  provider: 'none',
  reason,
  desktop: extra.desktop ?? false,
  openrouter: { enabled: extra.enabled ?? true, key: extra.key, model: extra.model },
})
const NO_KEY = none('browser_no_key')
const WITH_KEY = none('no_model', { key: { last4: '7f3a', added_at: ADDED } })
const OR = (model: string) => ({ desktop: false, openrouter: { enabled: true, key: { last4: '7f3a', added_at: ADDED }, model } })
const WITH_MODEL: AiSetup = { provider: 'openrouter', label: 'Claude Sonnet 4.5', model: SONNET, ...OR(SONNET) }
const MODELS: AiModel[] = [
  { id: SONNET, name: 'Claude Sonnet 4.5' },
  { id: 'openai/gpt-5', name: 'GPT-5' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large' },
]
const MANY: AiModel[] = [...MODELS, ...Array.from({ length: 12 }, (_, i) => ({ id: `lab/model-${i}`, name: `Lab model ${i}` }))]

const fail = (status: number, code: string, message = code) => async () => {
  throw Object.assign(new Error(message), { status, code })
}

const card = () => within(screen.getByRole('region', { name: 'AI sidebar' }))
const keyField = () => screen.getByLabelText<HTMLInputElement>(/OpenRouter key$/, { selector: 'input' })
const select = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' })
const optionValues = () => [...select().options].map((o) => o.value)

function open(setup: AiSetup) {
  h.setup = setup
  const user = userEvent.setup()
  const view = render(<AiSidebarCard />)
  const show = (next: AiSetup) => {
    h.setup = next
    view.rerender(<AiSidebarCard />)
  }
  return { user, show, ...view }
}

beforeEach(() => {
  h.setup = NO_KEY
  h.refresh = async () => {}
  h.setKey = async () => {}
  h.removeKey = async () => {}
  h.setModel = async () => {}
  h.models = async () => MODELS
  h.calls = { refresh: 0, setKey: [], removeKey: 0, setModel: [], models: 0 }
  delete (window as { qoopDesktop?: unknown }).qoopDesktop
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AI sidebar card: where it is', () => {
  it('sits above "Access tokens" on the AI access screen, which keeps working', async () => {
    h.setup = NO_KEY
    render(<AiAccess />)
    const headings = screen.getAllByRole('heading', { level: 2 }).map((n) => n.textContent)
    expect(headings.slice(0, 2)).toEqual(['AI sidebar', 'Access tokens'])
    expect(await screen.findByText('No access tokens yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create access token' })).toBeInTheDocument()
  })

  it('says it is checking while the setup is not known, and shows nothing to a Guest setup', () => {
    const { show } = open(none('loading'))
    expect(card().getByRole('status')).toHaveTextContent('Checking how AI is set up…')
    expect(screen.queryByLabelText(/OpenRouter key/, { selector: 'input' })).toBeNull()
    show(none('guest'))
    expect(screen.queryByLabelText(/OpenRouter key/, { selector: 'input' })).toBeNull()
    expect(screen.queryByText(/OpenRouter/)).toBeNull()
  })
})

describe('AI sidebar card: the environment', () => {
  it('in the desktop app with Claude Code: the wording and the version, nothing to set', () => {
    open({ provider: 'claude-code', label: 'Claude Code', version: '2.1.7', desktop: true, openrouter: { enabled: false } })
    expect(card().getByText('This app runs the sidebar on your own Claude subscription through Claude Code — nothing to set here.')).toBeInTheDocument()
    expect(card().getAllByRole('status')[0]).toHaveTextContent('Claude Code 2.1.7 found')
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(screen.queryByLabelText(/OpenRouter key/, { selector: 'input' })).toBeNull()
    expect(h.calls.models).toBe(0)
  })

  it('in the desktop app with Claude Code a stored OpenRouter key can still be seen and removed', () => {
    open({ provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: { enabled: true, key: { last4: '7f3a', added_at: ADDED }, model: SONNET } })
    expect(card().getByText('7f3a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove OpenRouter key' })).toBeInTheDocument()
  })

  it('says "Claude Code found" when the version is not known', () => {
    open({ provider: 'claude-code', label: 'Claude Code', desktop: true, openrouter: { enabled: false } })
    expect(card().getAllByRole('status')[0]).toHaveTextContent(/^✓ Claude Code found$/)
  })

  it('in the desktop app without Claude Code: says so, and "Check again" reads the setup again', async () => {
    const { user } = open(none('desktop_no_claude', { desktop: true }))
    expect(card().getByText(/This app runs the sidebar on your own Claude subscription through Claude Code/)).toBeInTheDocument()
    expect(card().getByText(/Claude Code not found on this computer/)).toBeInTheDocument()
    expect(screen.queryByText(/In the browser it needs an OpenRouter key/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(h.calls.refresh).toBe(1)
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument()
    // The optional OpenRouter part is offered there too.
    expect(keyField()).toBeInTheDocument()
  })

  it('"Check again" sends one request while one is under way', async () => {
    let release = () => {}
    h.refresh = () => new Promise<void>((r) => (release = r))
    const { user } = open(none('desktop_no_claude', { desktop: true }))
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await user.click(screen.getByRole('button', { name: 'Checking…' }))
    expect(h.calls.refresh).toBe(1)
    release()
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('in a browser: the browser wording, no Claude Code status', () => {
    open(NO_KEY)
    expect(
      card().getByText('In the desktop app the sidebar runs on your own Claude subscription. In the browser it needs an OpenRouter key.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Claude Code (not )?found/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(card().getByRole('heading', { level: 3 })).toHaveTextContent('OpenRouter (optional)')
  })

  it('with OpenRouter answering, the desktop app still says Claude Code was not found', async () => {
    open({ ...WITH_MODEL, desktop: true })
    expect(card().getByText(/Claude Code not found on this computer/)).toBeInTheDocument()
    await waitFor(() => expect(optionValues()).toContain('openai/gpt-5'))
  })

  it('when the server does not store keys: says so and offers no field', () => {
    open(none('server_off', { enabled: false }))
    expect(card().getByText('This server is not set up to store keys. Ask your Admin.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/OpenRouter key/, { selector: 'input' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText(/stored encrypted/)).toBeNull()
  })

  it('has the small print, naming this host', () => {
    open(NO_KEY)
    expect(document.querySelector('.q-ai__small')).toHaveTextContent(
      `Your key is stored encrypted on ${window.location.host} and is never shown again. The server sends your question, and what the AI reads through Sheaf's tools, to OpenRouter. Conversations are kept only on this device.`,
    )
  })
})

describe('AI sidebar card: the key', () => {
  it('the field is a password field, not auto-completed, and never pre-filled', () => {
    open(NO_KEY)
    const field = keyField()
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).not.toHaveAttribute('name')
    expect(field.value).toBe('')
    expect(screen.queryByRole('combobox')).toBeNull() // a model is chosen once there is a key
  })

  it('"Add key" stores the typed value and clears the field', async () => {
    const { user, show } = open(NO_KEY)
    await user.type(keyField(), `  ${KEY} `)
    await user.click(screen.getByRole('button', { name: 'Add key' }))
    expect(h.calls.setKey).toEqual([[KEY]])
    expect(keyField().value).toBe('')
    expect(await screen.findByText('Key added.')).toBeInTheDocument()
    expect(h.calls.refresh).toBe(0) // the data layer updates the setup itself

    show(WITH_KEY)
    expect(screen.queryByLabelText(/OpenRouter key$/, { selector: 'input' })).toBeNull()
    expect(card().getByText(/added 14 Nov 2030/)).toHaveTextContent('••••Key ending in 7f3a · added 14 Nov 2030')
    expect(document.body.textContent).not.toContain(KEY)
  })

  it('the field is already empty while the request is under way', async () => {
    let release = () => {}
    h.setKey = () => new Promise<void>((r) => (release = r))
    const { user } = open(NO_KEY)
    await user.type(keyField(), KEY)
    await user.click(screen.getByRole('button', { name: 'Add key' }))
    expect(keyField().value).toBe('')
    await user.click(screen.getByRole('button', { name: 'Adding key…' }))
    expect(h.calls.setKey).toHaveLength(1)
    release()
    expect(await screen.findByText('Key added.')).toBeInTheDocument()
  })

  it('asks for a key before sending anything', async () => {
    const { user } = open(NO_KEY)
    await user.click(screen.getByRole('button', { name: 'Add key' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Paste your OpenRouter key first.')
    expect(h.calls.setKey).toEqual([])
    expect(keyField()).toHaveFocus()
    await user.type(keyField(), 'x')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    [400, 'bad_key', "That key wasn't accepted. Check that you copied the whole OpenRouter key, then try again."],
    [404, 'not_found', 'This server is not set up to store keys. Ask your Admin.'],
    [-1, 'network', "Can't reach the server. Check your connection and try again."],
    [500, 'internal', 'Something went wrong on our side. Try again.'],
  ])('a failure (%i %s) is a plain sentence that never repeats the key, and the field is cleared', async (status, code, sentence) => {
    h.setKey = fail(status, code, `rejected ${KEY}`) // even when the failure itself carries the key
    const { user } = open(NO_KEY)
    await user.type(keyField(), KEY)
    await user.click(screen.getByRole('button', { name: 'Add key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence)
    expect(keyField().value).toBe('')
    expect(document.body.textContent).not.toContain(KEY)
    expect(document.body.innerHTML).not.toContain(KEY)
    expect(screen.queryByText('Key added.')).toBeNull()
  })

  it('"Replace" opens an empty field; "Replace key" stores the new value; "Cancel" changes nothing', async () => {
    const { user } = open(WITH_KEY)
    expect(screen.queryByLabelText(/OpenRouter key$/, { selector: 'input' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Replace OpenRouter key' }))
    expect(keyField()).toHaveFocus()
    expect(keyField().value).toBe('')
    expect(keyField()).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText(/OpenRouter key$/, { selector: 'input' })).toBeNull()
    expect(h.calls.setKey).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Replace OpenRouter key' }))
    await user.type(keyField(), KEY)
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    expect(h.calls.setKey).toEqual([[KEY]])
    expect(await screen.findByText('Key replaced.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/OpenRouter key$/, { selector: 'input' })).toBeNull()
    expect(card().getByText(/added 14 Nov 2030/)).toBeInTheDocument()
  })

  it('"Remove" asks first; Cancel changes nothing; confirming removes the key', async () => {
    const { user, show } = open(WITH_KEY)
    await user.click(screen.getByRole('button', { name: 'Remove OpenRouter key' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Remove your OpenRouter key?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(h.calls.removeKey).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Remove OpenRouter key' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(h.calls.removeKey).toBe(1)
    expect(screen.getByText('Key removed.')).toBeInTheDocument()

    show(NO_KEY)
    expect(keyField().value).toBe('')
    expect(screen.queryByText(/added 14 Nov/)).toBeNull()
  })

  it('keeps the dialog open with a plain sentence when removing fails; a key already gone counts as removed', async () => {
    h.removeKey = fail(500, 'internal')
    const { user } = open(WITH_KEY)
    await user.click(screen.getByRole('button', { name: 'Remove OpenRouter key' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    expect(await within(screen.getByRole('dialog')).findByText('Something went wrong on our side. Try again.')).toBeInTheDocument()
    expect(screen.queryByText('Key removed.')).toBeNull()

    h.removeKey = fail(404, 'not_found')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Key removed.')).toBeInTheDocument()
  })

  it('shows the key mask when a key and a model are set', async () => {
    open(WITH_MODEL)
    expect(card().getByText('7f3a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace OpenRouter key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove OpenRouter key' })).toBeInTheDocument()
    await waitFor(() => expect(h.calls.models).toBe(1))
  })

  it('keeps an open "Replace" field while the setup is being read again', async () => {
    const { user, show } = open(WITH_KEY)
    await user.click(screen.getByRole('button', { name: 'Replace OpenRouter key' }))
    await user.type(keyField(), 'sk-or-part')
    show(none('loading'))
    expect(keyField().value).toBe('sk-or-part')
    show({ ...WITH_KEY })
    expect(keyField().value).toBe('sk-or-part')
  })

  it('writes nothing about the key to storage, the URL or the console — on success and on failure', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const href = window.location.href
    const { user } = open(NO_KEY)
    await user.type(keyField(), KEY)
    await user.click(screen.getByRole('button', { name: 'Add key' }))
    await screen.findByText('Key added.')
    h.setKey = fail(400, 'bad_key', `rejected ${KEY}`)
    await user.type(keyField(), KEY)
    await user.click(screen.getByRole('button', { name: 'Add key' }))
    await screen.findByRole('alert')

    expect(setItem).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain('sk-or')
    expect(window.location.href).toBe(href)
    expect(document.cookie).not.toContain('sk-or')
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('sk-or')
  })
})

describe('AI sidebar card: the model', () => {
  it('fills the list from ai.models() and shows the model that is set, as written', async () => {
    open(WITH_MODEL)
    await waitFor(() => expect(optionValues()).toEqual([SONNET, 'openai/gpt-5', 'mistralai/mistral-large']))
    expect(select().value).toBe(SONNET)
    expect(select().selectedOptions[0]).toHaveTextContent(`Claude Sonnet 4.5 — ${SONNET}`)
    expect(screen.queryByLabelText('Filter models')).toBeNull() // a short list needs no filter
  })

  it('with a key and no model yet, asks to choose one', async () => {
    open(WITH_KEY)
    await waitFor(() => expect(optionValues()).toEqual(['', SONNET, 'openai/gpt-5', 'mistralai/mistral-large']))
    expect(select().selectedOptions[0]).toHaveTextContent('Choose a model')
  })

  it('changing it sets the model', async () => {
    const { user } = open(WITH_MODEL)
    await waitFor(() => expect(optionValues()).toContain('openai/gpt-5'))
    await user.selectOptions(select(), 'openai/gpt-5')
    expect(h.calls.setModel).toEqual([['openai/gpt-5']])
    expect(await screen.findByText('Model changed.')).toBeInTheDocument()
  })

  it('a long list gets a filter that narrows it, keeping the model that is set', async () => {
    h.models = async () => MANY
    const { user } = open(WITH_MODEL)
    const filter = await screen.findByLabelText('Filter models')
    expect(optionValues()).toHaveLength(15)
    await user.type(filter, 'GPT')
    expect(optionValues()).toEqual([SONNET, 'openai/gpt-5'])
    expect(select().value).toBe(SONNET)
    expect(screen.getByText('1 of 15 models')).toBeInTheDocument()
    await user.selectOptions(select(), 'openai/gpt-5')
    expect(h.calls.setModel).toEqual([['openai/gpt-5']])
    await user.clear(filter)
    await user.type(filter, 'lab/model-1')
    expect(optionValues()).toEqual([SONNET, 'lab/model-1', 'lab/model-10', 'lab/model-11'])
  })

  it('when the list cannot be loaded it still shows the current id, says so, and can try again', async () => {
    h.models = fail(502, 'upstream')
    const { user } = open(WITH_MODEL)
    expect(await screen.findByRole('alert')).toHaveTextContent("The list of models couldn't be loaded.")
    expect(optionValues()).toEqual([SONNET])
    expect(select().selectedOptions[0]).toHaveTextContent(SONNET)
    h.models = async () => MODELS
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(optionValues()).toHaveLength(3))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a current model that the list no longer has', async () => {
    open({ provider: 'openrouter', label: 'Old', model: 'lab/retired-1', ...OR('lab/retired-1') })
    await waitFor(() => expect(optionValues()).toEqual(['lab/retired-1', SONNET, 'openai/gpt-5', 'mistralai/mistral-large']))
    expect(select().value).toBe('lab/retired-1')
  })

  it('says in words when the model cannot be changed, and goes back to the one that is set', async () => {
    h.setModel = fail(500, 'internal')
    const { user } = open(WITH_MODEL)
    await waitFor(() => expect(optionValues()).toContain('openai/gpt-5'))
    await user.selectOptions(select(), 'openai/gpt-5')
    expect(await screen.findByRole('alert')).toHaveTextContent("The model couldn't be changed. Try again.")
    expect(select().value).toBe(SONNET)
  })

  it('loads the list once per mount under StrictMode and still answers', async () => {
    h.setup = WITH_MODEL
    render(
      <StrictMode>
        <AiSidebarCard />
      </StrictMode>,
    )
    await waitFor(() => expect(optionValues()).toHaveLength(3))
    expect(h.calls.models).toBeLessThanOrEqual(2)
  })
})
