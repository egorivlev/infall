import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { branches, useBranches, useMembers, useWorkspace } from '../../lib'
import { branchMeta, orderBranches } from './branchMeta'
import { Icon } from './Icon'
import { Link } from './Link'
import { newBranchIntent } from './newBranchIntent'
import { branchPath, MAIN } from './router'
import { useDismiss } from './useDismiss'

const ignore = () => {}

/** The Branch pill in the top bar: shows the open Branch and opens the menu that switches to another. */
export function BranchSwitcher({ branch }: { branch: string }) {
  const moved = useWorkspace().readOnly === true // a moved copy starts no Branch
  const list = orderBranches(useBranches())
  const people = useMembers()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, boxRef, triggerRef)
  // Choosing unmounts the menu; keep keyboard focus on the pill rather than losing it.
  const chosen = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  const focusItem = (i: number) => {
    const all = items()
    all[(i + all.length) % all.length]?.focus()
  }

  const show = () => {
    setOpen(true)
    if (list.length === 0) void Promise.resolve(branches.reload()).catch(ignore)
    // once rendered, start on the open Branch
    window.setTimeout(() => {
      const all = items()
      const at = all.findIndex((el) => el.getAttribute('aria-current') === 'true')
      focusItem(at < 0 ? 0 : at)
    }, 0)
  }

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      show()
    }
  }

  const onMenuKey = (e: KeyboardEvent) => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null
    if (to !== null) {
      e.preventDefault()
      focusItem(to)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="q-switch" ref={boxRef}>
      <button
        type="button"
        ref={triggerRef}
        className="q-branch q-branch--button"
        data-tour="branch"
        title={`Switch Branch — ${branch}`}
        aria-label={`Branch ${branch}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
      >
        <Icon name="branch" />
        <span className="q-lab">Branch</span>
        <span className="q-branch__name">{branch}</span>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <div className="q-menu q-switch__menu" id={menuId} role="menu" aria-label="Branches" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="q-lab q-switch__label" role="presentation">
            Branches
          </div>
          {list.length === 0 && (
            <p className="q-hint q-switch__empty" role="presentation">
              Loading Branches…
            </p>
          )}
          {list.map((b) => {
            const current = b.name === branch
            const meta = branchMeta(b, list, people)
            return (
              <Link
                key={b.id}
                href={branchPath(b.name)}
                role="menuitem"
                className="q-switch__row"
                aria-current={current ? 'true' : undefined}
                onClick={chosen}
              >
                <span className="q-switch__check" aria-hidden="true">
                  {current ? '✓' : ''}
                </span>
                <span className="q-switch__text">
                  <span className={`q-switch__name${b.name === MAIN ? '' : ' q-switch__name--branch'}`}>{b.name}</span>
                  {meta && <span className="q-switch__meta">{meta}</span>}
                </span>
              </Link>
            )
          })}
          <div className="q-switch__rule" role="separator" />
          {!moved && (
            <Link
              href="/branches"
              role="menuitem"
              className="q-menu__item"
              onClick={() => {
                newBranchIntent.request()
                chosen()
              }}
            >
              New Branch…
            </Link>
          )}
          <Link href="/branches" role="menuitem" className="q-menu__item" onClick={chosen}>
            All Branches…
          </Link>
        </div>
      )}
    </div>
  )
}
