import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ai } from '../../lib'
import type { AiModel } from '../../lib'
import { describeModelError, describeModelsError } from './aiErrors'

/** With more models than this the list gets a text filter above it. */
export const FILTER_FROM = 12

const label = (m: AiModel) => (m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id)

type Props = {
  /** The model that is set, or '' when none is. Shown even when the list cannot be loaded. */
  current: string
}

/** "Model": a `<select>` filled from `ai.models()`; changing it sets the model at once. */
export function ModelPicker({ current }: Props) {
  const [list, setList] = useState<AiModel[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const busy = useRef(false)
  const selectId = useId()
  const filterId = useId()
  const countId = useId()

  // Only the newest request may answer; an answer that arrives after the screen is left is dropped.
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    return Promise.resolve()
      .then(() => ai.models())
      .then(
        (found) => {
          if (seq !== loadSeq.current || !alive.current) return
          setList(found)
          setLoadError('')
        },
        (e: unknown) => {
          if (seq !== loadSeq.current || !alive.current) return
          setLoadError(describeModelsError(e))
        },
      )
  }, [])

  useEffect(() => {
    alive.current = true // StrictMode mounts twice: the second run must be allowed to answer
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  const all = list ?? []
  const q = filter.trim().toLowerCase()
  const matches = q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all
  const value = saving ?? current
  // The model that is set always stays in the list: when the filter hides it, when the list failed, when it was retired.
  const pinned = value && !matches.some((m) => m.id === value) ? (all.find((m) => m.id === value) ?? { id: value, name: value }) : null

  async function change(id: string) {
    if (!id || id === current || busy.current) return
    busy.current = true
    setSaving(id)
    setError('')
    setNote('')
    try {
      await ai.setModel(id)
      if (!alive.current) return
      setNote('Model changed.')
    } catch (e) {
      if (alive.current) setError(describeModelError(e))
    } finally {
      busy.current = false
      if (alive.current) setSaving(null)
    }
  }

  return (
    <div className="q-ai__model">
      {all.length > FILTER_FROM && (
        <div className="q-ai__filter">
          <label className="q-label" htmlFor={filterId}>
            Filter models
          </label>
          <input
            id={filterId}
            className="q-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={filter}
            aria-describedby={countId}
            onChange={(e) => setFilter(e.target.value)}
          />
          <p className="q-hint q-mono" id={countId} role="status">
            {q ? `${matches.length} of ${all.length} models` : `${all.length} models`}
          </p>
        </div>
      )}
      <label className="q-label" htmlFor={selectId}>
        Model
      </label>
      <select
        id={selectId}
        className="q-input q-ai__select"
        value={value}
        aria-busy={saving !== null}
        disabled={!value && all.length === 0}
        onChange={(e) => void change(e.target.value)}
      >
        {!value && <option value="">{list === null && !loadError ? 'Loading models…' : 'Choose a model'}</option>}
        {pinned && <option value={pinned.id}>{label(pinned)}</option>}
        {matches.map((m) => (
          <option key={m.id} value={m.id}>
            {label(m)}
          </option>
        ))}
      </select>
      {loadError && (
        <div className="q-settings__retry">
          <p className="q-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="q-btn q-btn--sm" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {error && (
        <p className="q-error" role="alert">
          {error}
        </p>
      )}
      <p className="q-hint q-settings__status" role="status">
        {saving !== null ? 'Changing model…' : note}
      </p>
    </div>
  )
}
