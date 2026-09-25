#!/usr/bin/env bash
set -euo pipefail
if [[ ${AGENT_GRAPH_E2E:-0} != 1 ]]; then
  echo 'skip: set AGENT_GRAPH_E2E=1 to run real claude/codex e2e'
  exit 0
fi
ROOT=$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP=$(mktemp -d /tmp/agent-graph-e2e.XXXXXX)
DAEMON_PID=''
cleanup() {
  result=$?
  trap - EXIT INT TERM
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
export E2E_REAL_CLAUDE E2E_REAL_CODEX E2E_LOG_DIR="$TEMP" E2E_ROOT="$ROOT"
E2E_REAL_CLAUDE=$(command -v claude)
E2E_REAL_CODEX=$(command -v codex)
unset AGENT_GRAPH_CLAUDE_BIN AGENT_GRAPH_CODEX_BIN TRACEPARENT TRACESTATE AGENT_GRAPH_SESSION AGENT_GRAPH_DELEGATION AGENT_GRAPH_CLIENT
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
export AGENT_GRAPH_CLIENT=codex
overrides=()
while IFS= read -r line; do overrides+=("$line"); done < "$E2E_LOG_DIR/codex-overrides"
"$E2E_REAL_CODEX" exec --ignore-user-config --ephemeral -c 'approval_policy="never"' "${overrides[@]}" "$@" 2> >(tee -a "$E2E_LOG_DIR/codex-child.stderr.log" >&2) | tee -a "$E2E_LOG_DIR/codex-child.stdout.log"
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
# 動的に割り当てた HTTP ポートを SessionStart hook に渡す。
export AGENT_GRAPH_PORT=${URL#http://127.0.0.1:}
export AGENT_GRAPH_PORT=${AGENT_GRAPH_PORT%/}
# インストーラーの生成物だけを使い、作業リポジトリには設定を置かない。
agent-graph-install() { node "$ROOT/packages/adapters/src/cli.ts" "$@"; }
agent-graph-install --claude-plugin-dir "$TEMP/plugin"
agent-graph-install --print-codex-overrides > "$TEMP/codex-overrides"
overrides=()
while IFS= read -r line; do overrides+=("$line"); done < "$TEMP/codex-overrides"
export TRACEPARENT=00-11111111111111111111111111111111-1111111111111111-01
export AGENT_GRAPH_SESSION=e2e-claude AGENT_GRAPH_CLIENT=claude
MCP_TOOL_TIMEOUT=1800000 claude -p --model haiku --plugin-dir "$TEMP/plugin" \
  --allowedTools mcp__plugin_agent-graph_agent-graph__delegate --setting-sources project --no-session-persistence \
  'Find the delegate MCP tool supplied by the agent-graph plugin and call it exactly once with {"role":"implement","title":"e2e hello","task":"Write hello followed by a newline to hello.txt in the current repository.","accept":["test -f hello.txt"],"review":false}. Do not write the file yourself. Wait for the result and report its status and output.' > "$TEMP/claude-parent.log" 2>&1
node "$ROOT/scripts/e2e-stage2-state.ts" check-root implement codex
test "$(cat hello.txt)" = hello
node "$ROOT/scripts/e2e-stage5-check.ts" hook
export TRACEPARENT=00-22222222222222222222222222222222-2222222222222222-01
export AGENT_GRAPH_SESSION=e2e-codex AGENT_GRAPH_CLIENT=codex
codex exec --ignore-user-config --ephemeral -m gpt-6-luna --sandbox workspace-write \
  -c 'approval_policy="never"' "${overrides[@]}" \
  'Find the agent-graph delegate MCP tool and call it exactly once with {"role":"document","title":"e2e notes","task":"Create notes.md in the current repository with exactly one line: e2e notes. Do not ask for clarification.","accept":["test -f notes.md"],"review":false}. Do not write the file yourself. Wait for the result and report its status and output.' > "$TEMP/codex-parent.log" 2>&1
node "$ROOT/scripts/e2e-stage2-state.ts" check-root document claude
test -f notes.md
node "$ROOT/scripts/e2e-stage5-check.ts" done
echo 'PASS: stage 5 generated plugin and Codex overrides expose callable delegate tools'
