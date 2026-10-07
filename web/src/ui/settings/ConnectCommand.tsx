import { useRef } from 'react'
import { useCopy } from './useCopy'

const PLACEHOLDER = '<YOUR_TOKEN>'

/** The exact command; the real secret stands in for the placeholder only while it is on show. */
function connectCommand(endpoint: string, secret: string | null): string {
  return `claude mcp add --transport http qoop ${endpoint} --header "Authorization: Bearer ${secret ?? PLACEHOLDER}"`
}

function selectContents(node: HTMLElement | null) {
  const selection = window.getSelection()
  if (!node || !selection) return
  const range = document.createRange()
  range.selectNodeContents(node)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function ConnectCommand({ endpoint, secret }: { endpoint: string; secret: string | null }) {
  const { state, copy } = useCopy()
  const codeRef = useRef<HTMLPreElement>(null)
  const command = connectCommand(endpoint, secret)

  const onCopy = () => {
    selectContents(codeRef.current)
    void copy(command)
  }

  return (
    <section className="q-settings__card" aria-labelledby="q-connect-h">
      <h2 className="q-panel-title" id="q-connect-h">
        Connect Claude Code
      </h2>
      <p className="q-settings__text">
        {secret === null
          ? `Run this in a terminal, with your access token in place of ${PLACEHOLDER}.`
          : 'Run this in a terminal. It contains the access token you just created.'}
      </p>
      <div className="q-command">
        {/* Focusable so a long command can be scrolled and selected from the keyboard. */}
        <pre ref={codeRef} className="q-command__code" tabIndex={0} aria-label="Command to connect Claude Code" onFocus={(e) => selectContents(e.currentTarget)}>
          <code>{command}</code>
        </pre>
        <button type="button" className="q-btn q-btn--sm q-command__copy" aria-label="Copy command" onClick={onCopy}>
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="q-hint q-settings__status" role="status">
        {state === 'failed' ? "Couldn't copy automatically. The command is selected — copy it with your keyboard." : ''}
      </p>
      <p className="q-settings__text">
        Other MCP clients: endpoint <code className="q-settings__code">{endpoint}</code>, header{' '}
        <code className="q-settings__code">Authorization: Bearer &lt;token&gt;</code>.
      </p>
    </section>
  )
}
