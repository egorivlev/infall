import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { boardBridge } from '../bridge'
import { useBoard } from '../../lib'
import { Icon } from './Icon'
import { searchCards } from './searchCards'
import { useDismiss } from './useDismiss'
import { useOnBoard } from './useOnBoard'

const HINT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

export function SearchBox() {
  const { cards } = useBoard()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const onBoard = useOnBoard()

  const results = useMemo(() => searchCards(cards, query), [cards, query])
  const showList = open && query.trim() !== ''
  const close = useCallback(() => setOpen(false), [])
  useDismiss(showList, close, boxRef, inputRef)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const choose = (id: string) => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    onBoard(() => boardBridge.focus('card', id))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + step + results.length) % results.length)
    } else if (e.key === 'Enter') {
      const hit = results[active]
      if (showList && hit) {
        e.preventDefault()
        choose(hit.id)
      }
    } else if (e.key === 'Escape' && !showList && query) {
      setQuery('')
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`

  return (
    <div className="q-search" ref={boxRef}>
      <label className="q-sr" htmlFor={`${listId}-input`}>
        Search Cards
      </label>
      <span className="q-search__icon">
        <Icon name="search" size={13} />
      </span>
      <input
        id={`${listId}-input`}
        ref={inputRef}
        className="q-search__input"
        type="search"
        role="combobox"
        placeholder="Search Cards"
        autoComplete="off"
        spellCheck={false}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? optionId(active) : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <kbd className="q-search__kbd" aria-hidden="true">
        {HINT}
      </kbd>
      {showList && (
        <div className="q-search__pop">
          {results.length > 0 ? (
            <ul id={listId} role="listbox" aria-label="Matching Cards" className="q-search__list">
              {results.map((c, i) => (
                <li
                  key={c.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className="q-search__opt"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(c.id)}
                >
                  <span className={`q-search__title${c.title ? '' : ' q-search__title--empty'}`}>{c.title || 'Untitled'}</span>
                  {c.summary && <span className="q-search__sum">{c.summary}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="q-search__none" id={listId}>
              No Cards match.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
