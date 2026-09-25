#!/usr/bin/env bash
set -euo pipefail
if [[ ${AGENT_GRAPH_E2E:-0} != 1 ]]; then
  echo 'skip: set AGENT_GRAPH_E2E=1 to run real claude/codex e2e'
  exit 0
fi
ROOT=$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP=$(mktemp -d /tmp/agent-graph-e2e.XXXXXX)
DAEMON_PID=''
SSE_PID=''
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -n "$SSE_PID" ]]; then
    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
  fi
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [[ $result -ne 0 ]]; then
    for file in "$TEMP"/state/agent-graph/run/daemon.log "$TEMP"/*.log; do
      if [[ -f "$file" ]]; then
        echo "--- $file"
        cat "$file"
      fi
    done
  fi
  rm -rf "$TEMP"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export XDG_STATE_HOME="$TEMP/state" XDG_CACHE_HOME="$TEMP/cache" XDG_CONFIG_HOME="$TEMP/config"
export AGENT_GRAPH_SOCKET="$TEMP/daemon.sock"
export AGENT_GRAPH_USAGE_PROBE=0
export AGENT_GRAPH_PORT=0
export AGENT_GRAPH_POLICY_JSON="$TEMP/policy.json"
export E2E_REAL_CLAUDE E2E_REAL_CODEX E2E_LOG_DIR="$TEMP"
E2E_REAL_CLAUDE=$(command -v claude)
E2E_REAL_CODEX=$(command -v codex)
unset AGENT_GRAPH_CLAUDE_BIN AGENT_GRAPH_CODEX_BIN TRACEPARENT TRACESTATE AGENT_GRAPH_SESSION AGENT_GRAPH_DELEGATION
cat > "$AGENT_GRAPH_POLICY_JSON" <<'JSON'
{"roles":{"orchestrate":[],"research":[],"implement":[{"executor":"codex","model":"gpt-6-luna","family":"openai","tier":"low"}],"document":[{"executor":"claude","model":"haiku","family":"anthropic","tier":"low"}],"review":[{"executor":"claude","model":"haiku","family":"anthropic","tier":"low"}]}}
JSON
# 子の出力を保存し、一時リポジトリでの無人の書き込みを許可する。
cat > "$TEMP/claude-child" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
"$E2E_REAL_CLAUDE" "$@" --allowedTools Write Edit 'Bash(*)' --setting-sources project --no-session-persistence 2> >(tee -a "$E2E_LOG_DIR/claude-child.stderr.log" >&2) | tee -a "$E2E_LOG_DIR/claude-child.stdout.log"
SH
cat > "$TEMP/codex-child" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
shift
"$E2E_REAL_CODEX" exec --ignore-user-config --ephemeral -c 'approval_policy="never"' "$@" 2> >(tee -a "$E2E_LOG_DIR/codex-child.stderr.log" >&2) | tee -a "$E2E_LOG_DIR/codex-child.stdout.log"
SH
chmod +x "$TEMP/claude-child" "$TEMP/codex-child"
export AGENT_GRAPH_CLAUDE_BIN="$TEMP/claude-child" AGENT_GRAPH_CODEX_BIN="$TEMP/codex-child"
mkdir "$TEMP/repo"
builtin cd "$TEMP/repo"
git init -q
git -c user.name=e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m 'e2e fixture'
node "$ROOT/packages/daemon/src/main.ts" > "$TEMP/daemon-start.log" 2>&1 &
DAEMON_PID=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -S "$AGENT_GRAPH_SOCKET" ]] && break
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo 'daemon exited before startup'; exit 1; }
  sleep 0.1
done
[[ -S "$AGENT_GRAPH_SOCKET" ]] || { echo 'daemon startup timed out'; exit 1; }
LOG="$TEMP/state/agent-graph/run/daemon.log"
for ((attempt=0; attempt<100; attempt++)); do
  URL=$(sed -n 's/.*dashboard \(http:\/\/127\.0\.0\.1:[0-9]*\/\).*/\1/p' "$LOG" | tail -1)
  [[ -n "$URL" ]] && break
  sleep 0.1
done
[[ -n "$URL" ]] || { echo 'dashboard URL missing'; exit 1; }
node "$ROOT/scripts/e2e-stage4-check.ts" listen "$URL" "$TEMP/sse.jsonl" > "$TEMP/sse-listener.log" 2>&1 &
SSE_PID=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -f "$TEMP/sse.jsonl" ]] && break
  kill -0 "$SSE_PID" 2>/dev/null || { echo 'SSE listener exited'; exit 1; }
  sleep 0.1
done
[[ -f "$TEMP/sse.jsonl" ]] || { echo 'SSE connection timed out'; exit 1; }
export TRACEPARENT=00-11111111111111111111111111111111-1111111111111111-01
export TRACESTATE='agent-graph=session:e2e-claude;delegation:parent-claude'
export AGENT_GRAPH_SESSION=e2e-claude
node "$ROOT/scripts/e2e-stage2-state.ts" seed implement claude
export AGENT_GRAPH_DELEGATION=parent-claude AGENT_GRAPH_PARENT_EXECUTOR=claude AGENT_GRAPH_PARENT_FAMILY=anthropic
node "$ROOT/scripts/e2e-stage4-check.ts" seed-family
node --input-type=module - "$ROOT" > "$TEMP/mcp.json" <<'JS'
const env = Object.fromEntries(['AGENT_GRAPH_SOCKET', 'TRACEPARENT', 'TRACESTATE', 'AGENT_GRAPH_SESSION'].map(k => [k, process.env[k]]));
console.log(JSON.stringify({mcpServers: {'agent-graph': {command: process.execPath, args: [process.argv[2] + '/packages/daemon/src/shim.ts'], env}}}));
JS
MCP_TOOL_TIMEOUT=1800000 claude -p --model haiku --strict-mcp-config --mcp-config "$TEMP/mcp.json" \
  --allowedTools mcp__agent-graph__delegate --setting-sources project --no-session-persistence \
  'Call mcp__agent-graph__delegate exactly once with {"role":"implement","title":"e2e hello","task":"Write hello followed by a newline to hello.txt in the current repository.","accept":["test -f hello.txt"],"review":false}. Do not write the file yourself. Wait for the result and report its status and output.' > "$TEMP/claude-parent.log" 2>&1
node "$ROOT/scripts/e2e-stage2-state.ts" check implement codex
test "$(cat hello.txt)" = hello
export TRACEPARENT=00-22222222222222222222222222222222-2222222222222222-01
export TRACESTATE='agent-graph=session:e2e-codex;delegation:parent-codex'
export AGENT_GRAPH_SESSION=e2e-codex
node "$ROOT/scripts/e2e-stage2-state.ts" seed document codex
export AGENT_GRAPH_DELEGATION=parent-codex AGENT_GRAPH_PARENT_EXECUTOR=codex AGENT_GRAPH_PARENT_FAMILY=openai
node "$ROOT/scripts/e2e-stage4-check.ts" seed-family
MCP_CONFIG=$(node --input-type=module - "$ROOT" <<'JS'
const env = Object.fromEntries(['AGENT_GRAPH_SOCKET', 'TRACEPARENT', 'TRACESTATE', 'AGENT_GRAPH_SESSION'].map(k => [k, process.env[k]]));
const pairs = Object.entries(env).map(([k,v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
console.log(`mcp_servers.agent-graph={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(process.argv[2] + '/packages/daemon/src/shim.ts')}],env={${pairs}},tool_timeout_sec=1800}`);
JS
)
# approval_policy=never は承認要求を拒否するため、委譲ツールだけ事前承認する。
codex exec --ignore-user-config --ephemeral -m gpt-6-luna --sandbox workspace-write \
  -c 'approval_policy="never"' -c "$MCP_CONFIG" \
  -c 'mcp_servers.agent-graph.tools.delegate.approval_mode="approve"' \
  'Call the agent-graph delegate MCP tool exactly once with {"role":"document","title":"e2e notes","task":"Create notes.md in the current repository with exactly one line: e2e notes. Do not ask for clarification.","accept":["test -f notes.md"],"review":false}. Do not write the file yourself. Wait for the result and report its status and output.' > "$TEMP/codex-parent.log" 2>&1
node "$ROOT/scripts/e2e-stage2-state.ts" check document claude
test -f notes.md
node "$ROOT/scripts/e2e-stage4-check.ts" verify "$URL" "$TEMP/sse.jsonl"
CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if [[ -x "$CHROME" ]]; then
  "$CHROME" --headless=new --no-first-run --no-default-browser-check --dump-dom "$URL" > "$TEMP/chrome.html" 2> "$TEMP/chrome.log"
  node --input-type=module - "$TEMP/chrome.html" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(process.argv[2], 'utf8');
const svg = html.match(/<svg\b[^>]*id="graph"[\s\S]*?<\/svg>/)?.[0] ?? '';
assert.ok((svg.match(/<path\b[^>]*marker-end=/g) ?? []).length >= 2, 'dashboard must render at least two edges');
JS
else
  echo 'skip: Google Chrome is not installed in /Applications'
fi
echo 'PASS: stage 4 dashboard e2e'
