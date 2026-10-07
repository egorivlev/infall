import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { newId, ops, orderBetween } from '../../lib'
import type { BlockVM } from '../../lib'
import { useBoardActions } from '../board/useBoardActions'
import { AddSlot } from './AddSlot'
import { BlockTools } from './BlockTools'
import type { AddBlock, BlockHandlers, VisualResult } from './BlockTools'
import { DraftArea } from './DraftArea'
import type { DraftResult } from './DraftArea'
import { editLock } from './lock'
import { MarkdownView } from './MarkdownView'
import { VisualBlock } from './visuals/VisualBlock'

type BlockProps = {
  block: BlockVM
  /** 0-based place in the Page. */
  index: number
  last: boolean
  editing: boolean
  canEdit: boolean
  handlers: BlockHandlers
}

/**
 * One text Block. Memoised: `block` keeps its identity until it changes and every other prop is a
 * primitive or stable, so typing in (or committing) one Block never re-renders the others.
 */
const Block = memo(function Block({ block, index, last, editing, canEdit, handlers }: BlockProps) {
  const { id, text } = block
  const hintId = useId()
  const viewRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const n = index + 1

  // After finishing from the keyboard, focus returns to the Block so the keyboard keeps working.
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    viewRef.current?.focus({ preventScroll: true })
  }, [editing])

  if (editing) {
    return (
      <div className="qp-block is-editing" data-block={id} data-testid={`block-${id}`}>
        <DraftArea
          initial={text}
          label={`Block ${n}, Markdown`}
          confirm="mod-enter"
          className="qp-block__editor"
          describedBy={hintId}
          onFinish={(result) => {
            refocus.current = result.keyboard
            handlers.finish(id, result)
          }}
        />
        <p className="qp-block__hint" id={hintId}>
          Markdown · $math$ · ⌘Enter to finish · Esc to cancel
        </p>
      </div>
    )
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('a')) return // following a link is not editing
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return // selecting text to copy is not editing
    handlers.edit(id)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return
    e.preventDefault()
    handlers.edit(id)
  }

  const body = text.trim() ? <MarkdownView text={text} /> : <p className="qp-block__blank">Empty block</p>

  return (
    <div className="qp-block" data-block={id} data-testid={`block-${id}`}>
      {canEdit && <BlockTools id={id} index={index} last={last} handlers={handlers} />}
      {canEdit ? (
        <div
          ref={viewRef}
          className="qp-block__view is-editable"
          role="group"
          tabIndex={0}
          aria-label={`Block ${n}. Press Enter to edit.`}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          {body}
        </div>
      ) : (
        <div className="qp-block__view">{body}</div>
      )}
    </div>
  )
})

const NONE: ReadonlySet<string> = new Set()

type Props = { cardId: string; blocks: readonly BlockVM[]; canEdit: boolean }

/** The Blocks of a Page, in order, with their editors. Holds the soft lock while any editor is open. */
export function Blocks({ cardId, blocks, canEdit }: Props) {
  const actions = useBoardActions()
  const rootRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState<ReadonlySet<string>>(NONE)
  const latest = useRef({ blocks, cardId })
  useLayoutEffect(() => {
    latest.current = { blocks, cardId }
  })

  // Editors whose Block is gone (removed elsewhere), or all of them once the Page turns
  // read-only, are forgotten — otherwise a Block brought back later would reopen by itself.
  const live = useMemo(() => new Set(blocks.map((b) => b.id)), [blocks])
  let open = editing
  if (editing.size > 0 && (!canEdit || [...editing].some((id) => !live.has(id)))) {
    open = canEdit ? new Set([...editing].filter((id) => live.has(id))) : NONE
    setEditing(open.size ? open : NONE)
  }

  // The soft lock: claimed when the first editor opens, released when the last one closes…
  const active = open.size > 0
  useEffect(() => {
    if (!active) return
    editLock.claim(cardId)
    return () => editLock.releaseSoon()
  }, [active, cardId])
  // …and at once when the panel closes or turns to another Card.
  useEffect(() => () => editLock.releaseNow(), [cardId])

  // Moving a Block reorders the DOM, which can drop focus from the button that was pressed.
  const moved = useRef<{ id: string; by: -1 | 1 } | null>(null)
  useLayoutEffect(() => {
    const m = moved.current
    if (!m) return
    moved.current = null
    const row = rootRef.current?.querySelector(`[data-block="${CSS.escape(m.id)}"]`)
    const same = row?.querySelector<HTMLButtonElement>(`[data-move="${m.by}"]:not(:disabled)`)
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${-m.by}"]:not(:disabled)`)
    ;(same ?? other)?.focus({ preventScroll: true })
  }, [blocks])

  const edit = useCallback((id: string) => {
    setEditing((s) => (s.has(id) ? s : new Set(s).add(id)))
  }, [])

  const finish = useCallback(
    (id: string, result: DraftResult) => {
      setEditing((s) => {
        if (!s.has(id)) return s
        const next = new Set(s)
        next.delete(id)
        return next.size ? next : NONE
      })
      const block = latest.current.blocks.find((b) => b.id === id)
      if (!block) return
      const before = block.text
      const text = result.text.trim()
      const focusEnd = () => {
        if (result.keyboard) queueMicrotask(() => endRef.current?.focus({ preventScroll: true }))
      }
      if (before.trim() === '' && (!result.commit || text === '')) {
        // An empty Block left empty is removed again — quietly: there is nothing to bring back.
        void actions.submit([ops.remove(id)])
        focusEnd()
      } else if (!result.commit) {
        // Esc: the text stays as it was.
      } else if (text === '') {
        // Everything was deleted from a Block that had text: that removes the Block, with Undo.
        actions.removeWithUndo([{ id, kind: 'Block' }])
        focusEnd()
      } else if (text !== before) {
        void actions.submit([ops.setBlockText(id, text)])
      }
    },
    [actions],
  )

  const move = useCallback(
    (id: string, by: -1 | 1) => {
      const list = latest.current.blocks
      const i = list.findIndex((b) => b.id === id)
      const target = list[i + by]
      if (i === -1 || !target) return
      // Up: between the Block two above and the one above. Down: between the one below and the next.
      const order = by === -1 ? orderBetween(list[i - 2]?.order, target.order) : orderBetween(target.order, list[i + 2]?.order)
      moved.current = { id, by }
      void actions.submit([ops.moveBlock(id, order)])
    },
    [actions],
  )

  const remove = useCallback(
    (id: string) => {
      actions.removeWithUndo([{ id, kind: 'Block' }])
      queueMicrotask(() => endRef.current?.focus({ preventScroll: true }))
    },
    [actions],
  )

  // A Visual's editor ended: the title and the source that changed go out together, as one batch.
  const finishVisual = useCallback(
    (id: string, result: VisualResult) => {
      setEditing((s) => {
        if (!s.has(id)) return s
        const next = new Set(s)
        next.delete(id)
        return next.size ? next : NONE
      })
      if (!result.commit || !latest.current.blocks.some((b) => b.id === id)) return
      const batch = []
      if (result.title !== undefined) batch.push(ops.setBlockTitle(id, result.title))
      if (result.source !== undefined) batch.push(ops.setBlockText(id, result.source))
      void actions.submit(batch)
    },
    [actions],
  )

  const addAt = useCallback<AddBlock>(
    (index, template) => {
      const { blocks: list, cardId: card } = latest.current
      const id = newId()
      const order = orderBetween(list[index - 1]?.order, list[index]?.order)
      // The Board applies it locally at once, so the new Block is there when the editor opens.
      const op = template
        ? ops.addBlock({ id, card, type: 'visual', title: template.title, text: template.source, order })
        : ops.addBlock({ id, card, text: '', order })
      void actions.submit([op])
      setEditing((s) => new Set(s).add(id))
    },
    [actions],
  )

  const handlers = useMemo<BlockHandlers>(() => ({ edit, finish, finishVisual, move, remove }), [edit, finish, finishVisual, move, remove])

  if (blocks.length === 0) {
    return (
      <div className="qp-blocks qp-blocks--empty" ref={rootRef}>
        <p className="qp-blocks__none">This Page is empty.</p>
        {canEdit && <AddSlot index={0} label="Add block" variant="first" onAdd={addAt} />}
      </div>
    )
  }

  return (
    <div className="qp-blocks" ref={rootRef}>
      {blocks.map((b, i) => (
        <Fragment key={b.id}>
          {canEdit && (
            <AddSlot index={i} label={i === 0 ? 'Add block at the start' : `Add block before block ${i + 1}`} onAdd={addAt} />
          )}
          {b.type === 'visual' ? (
            <VisualBlock block={b} index={i} last={i === blocks.length - 1} editing={open.has(b.id)} canEdit={canEdit} handlers={handlers} />
          ) : (
            <Block block={b} index={i} last={i === blocks.length - 1} editing={open.has(b.id)} canEdit={canEdit} handlers={handlers} />
          )}
        </Fragment>
      ))}
      {canEdit && <AddSlot ref={endRef} index={blocks.length} label="Add block at the end" variant="end" onAdd={addAt} />}
    </div>
  )
}
