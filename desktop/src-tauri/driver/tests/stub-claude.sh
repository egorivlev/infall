#!/bin/sh
# A stand-in for `claude`, used by the driver's tests through QOOP_CLAUDE_BIN-style
# selection (Driver::bin). It never talks to anything. It records how it was started in
# $QOOP_STUB_DIR and prints the canned event stream chosen by $QOOP_STUB_MODE.

dir="${QOOP_STUB_DIR:?QOOP_STUB_DIR is not set}"
mode="${QOOP_STUB_MODE:-answer}"

if [ "$1" = "--version" ]; then
  case "$mode" in
    version-fail) exit 3 ;;
    version-odd) echo "Claude Code, some build" ;;
    *) echo "9.8.7 (Claude Code)" ;;
  esac
  exit 0
fi

# ---- record: arguments (NUL-separated), working directory, MCP config, standard input ----
: > "$dir/argv"
for a in "$@"; do printf '%s\0' "$a" >> "$dir/argv"; done
pwd -P > "$dir/cwd"
ls -A > "$dir/cwd-listing"
env | grep '^CLAUDE_CODE_DISABLE' | sort > "$dir/env"
prev=""
cfg=""
for a in "$@"; do
  if [ "$prev" = "--mcp-config" ]; then cfg="$a"; fi
  prev="$a"
done
if [ -n "$cfg" ]; then
  printf '%s' "$cfg" > "$dir/mcp-path"
  cat "$cfg" > "$dir/mcp-config"
  ls -l "$cfg" | cut -c1-10 > "$dir/mcp-mode"
fi
cat > "$dir/stdin"
echo "$$" > "$dir/pid"

init='{"type":"system","subtype":"init","session_id":"sess-42","model":"claude-stub-1","tools":["mcp__qoop__list_cards"],"mcp_servers":[{"name":"qoop","status":"connected"}]}'
d1='{"type":"stream_event","session_id":"sess-42","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking at "}}}'
d2='{"type":"stream_event","session_id":"sess-42","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the board."}}}'
tool='{"type":"stream_event","session_id":"sess-42","parent_tool_use_id":null,"event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__qoop__list_cards","input":{}}}}'
full='{"type":"assistant","session_id":"sess-42","message":{"model":"claude-stub-1","content":[{"type":"text","text":"Looking at the board."},{"type":"tool_use","id":"toolu_1","name":"mcp__qoop__list_cards","input":{}}]}}'
tres='{"type":"user","session_id":"sess-42","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"[]"}]}}'
b2='{"type":"stream_event","session_id":"sess-42","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
d3='{"type":"stream_event","session_id":"sess-42","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It is empty."}}}'
ok='{"type":"result","subtype":"success","is_error":false,"result":"It is empty.","session_id":"sess-42","num_turns":2}'

hang() {
  # A child of our own, to show that the whole process group is stopped.
  sleep 600 &
  echo "$!" > "$dir/child-pid"
  wait
}

case "$mode" in
  answer)
    for l in "$init" "$d1" "$d2" "$tool" "$full" "$tres" "$b2" "$d3" "$ok"; do echo "$l"; done
    ;;
  garbage)
    echo "warning: something on stdout that is not JSON"
    echo "$init"
    echo '{"type":"a_future_event","payload":[1,2,3]}'
    echo "$d1"
    echo '{"type":"stream_event","event":{"type":"content_block_del'
    printf '\377\376 not utf-8\n'
    echo ""
    echo "$d2"
    echo '[]'
    echo "$ok"
    ;;
  error)
    echo "$init"
    echo '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login","session_id":"sess-42"}'
    ;;
  leak)
    # An error text that repeats the Authorization header it was given.
    token=$(sed 's/.*Bearer \([^"]*\)".*/\1/' "$dir/mcp-config")
    echo "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":\"MCP server refused Bearer $token\"}"
    ;;
  crash)
    echo "$init"
    echo "$d1"
    echo "fatal: something broke" >&2
    exit 2
    ;;
  hang)
    echo "$init"
    echo "$d1"
    hang
    ;;
  stubborn)
    # Ignores the polite request to stop; so do its children.
    trap '' TERM
    echo "$init"
    hang
    ;;
  slow)
    for l in "$init" "$d1" "$d2" "$b2" "$d3" "$ok"; do echo "$l"; sleep 0.15; done
    ;;
  linger)
    # Answers, then does not exit.
    for l in "$init" "$d1" "$ok"; do echo "$l"; done
    hang
    ;;
  litter)
    # Leaves a file in its working directory.
    echo "left behind" > note.txt
    for l in "$init" "$d1" "$ok"; do echo "$l"; done
    ;;
esac
exit 0
