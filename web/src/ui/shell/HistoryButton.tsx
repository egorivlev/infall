import { historyPanel, useHistoryPanel } from '../bridge'
import { Icon } from './Icon'
import { boardPath, navigate } from './router'
import { useRoute } from './useRoute'

/** Shows or hides the History panel of the Board. From another screen it goes to the Board and shows it. */
export function HistoryButton() {
  const open = useHistoryPanel((s) => s.open)
  const onBoard = useRoute().name === 'board'
  const pressed = open && onBoard

  const onClick = () => {
    if (onBoard) return historyPanel.toggle()
    navigate(boardPath())
    if (!open) historyPanel.toggle()
  }

  return (
    <button type="button" className="q-btn q-topbtn" title="History of this Branch" aria-pressed={pressed} onClick={onClick}>
      <Icon name="history" size={13} />
      History
    </button>
  )
}
