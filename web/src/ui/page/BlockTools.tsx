import type { DraftResult } from './DraftArea'
import type { VisualTemplate } from './visuals/templates'

/** How a Visual's editor ended. `title` / `source` are set only when the person changed them. */
export type VisualResult = { commit: boolean; keyboard: boolean; title?: string; source?: string }

/** What a Block can ask of the list it is in. Stable for the life of the list. */
export type BlockHandlers = {
  edit: (id: string) => void
  finish: (id: string, result: DraftResult) => void
  finishVisual: (id: string, result: VisualResult) => void
  move: (id: string, by: -1 | 1) => void
  remove: (id: string) => void
}

/** A new Block goes before the Block at `index` (or at the end): text, or a Visual from a starter. */
export type AddBlock = (index: number, template?: VisualTemplate) => void

type Props = {
  id: string
  /** 0-based place in the Page. */
  index: number
  last: boolean
  handlers: BlockHandlers
}

/** Move up, move down, delete: the same for every type of Block, in the left gutter. */
export function BlockTools({ id, index, last, handlers }: Props) {
  return (
    <div className="qp-block__tools" role="group" aria-label={`Block ${index + 1}`}>
      <button
        type="button"
        className="qp-tool"
        data-move="-1"
        aria-label="Move block up"
        title="Move block up"
        disabled={index === 0}
        onClick={() => handlers.move(id, -1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="qp-tool"
        data-move="1"
        aria-label="Move block down"
        title="Move block down"
        disabled={last}
        onClick={() => handlers.move(id, 1)}
      >
        ↓
      </button>
      <button type="button" className="qp-tool qp-tool--danger" aria-label="Delete block" title="Delete block" onClick={() => handlers.remove(id)}>
        ✕
      </button>
    </div>
  )
}
