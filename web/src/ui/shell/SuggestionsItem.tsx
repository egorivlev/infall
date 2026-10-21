import { useSuggestions } from '../../lib'
import { suggestionsPanel, useSuggestionsPanel } from '../bridge'
import { Icon } from './Icon'
import { boardPath, navigate } from './router'

/**
 * Rail item for the Suggestions panel of the Board, with how many are waiting for a decision.
 * A toggle, not a place: from another screen it goes to the Board and shows the panel.
 */
export function SuggestionsItem({ onBoard }: { onBoard: boolean }) {
  const open = useSuggestionsPanel((s) => s.open)
  const pending = useSuggestions().reduce((n, s) => (s.suggestion.state === 'pending' ? n + 1 : n), 0)
  const pressed = open && onBoard

  const onClick = () => {
    if (onBoard) return suggestionsPanel.toggle()
    navigate(boardPath())
    if (!open) suggestionsPanel.toggle()
  }

  return (
    <button
      type="button"
      className="q-rail__item"
      data-tour="suggestions"
      aria-pressed={pressed}
      aria-label={`Suggestions, ${pending} pending`}
      title="Suggestions for this Branch"
      onClick={onClick}
    >
      <Icon name="suggestion" />
      <span className="q-rail__label">Suggestions</span>
      <span className={`q-rail__badge${pending > 0 ? ' q-rail__badge--hot' : ''}`}>{pending}</span>
    </button>
  )
}
