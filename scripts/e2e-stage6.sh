#!/usr/bin/env bash
set -euo pipefail
if [[ ${AGENT_GRAPH_E2E:-0} != 1 ]]; then
  echo 'skip: set AGENT_GRAPH_E2E=1 to run real claude/codex e2e'
  exit 0
fi
ROOT=$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP=$(mktemp -d /tmp/agent-graph-e2e.XXXXXX)
DAEMON_PID=''
RUN_PID=''
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -n "$RUN_PID" ]]; then
    kill "$RUN_PID" 2>/dev/null || true
    wait "$RUN_PID" 2>/dev/null || true
  fi
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [[ $result -ne 0 ]]; then
    if [[ -d "$TEMP/old" && -f "$TEMP/compare-new-result.json" ]]; then
      node "$ROOT/scripts/e2e-stage6-check.ts" diagnose "$TEMP/old" "$TEMP/compare-new-result.json" || true
    fi
    for file in "$TEMP"/state/agent-graph/run/daemon.log "$TEMP"/*.log; do
      if [[ -f "$file" ]]; then
        echo "--- $file"
        cat "$file"
      fi
    done
    if [[ -d "$TEMP/old/.agents" ]]; then
      find "$TEMP/old/.agents" -type f \( -name '*.log' -o -name '*.md' \) -exec cat {} \;
    fi
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
{"roles":{"orchestrate":[],"research":[],"implement":[{"executor":"codex","model":"gpt-6-luna","family":"openai","tier":"low"}],"document":[{"executor":"claude","model":"haiku","family":"anthropic","tier":"low"}],"review":[{"executor":"claude","model":"sonnet","family":"anthropic","tier":"mid"}]}}
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
node "$ROOT/packages/adapters/src/cli.ts" --print-codex-overrides > "$TEMP/codex-overrides"
node "$ROOT/packages/daemon/src/main.ts" > "$TEMP/daemon-start.log" 2>&1 &
DAEMON_PID=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -S "$AGENT_GRAPH_SOCKET" ]] && break
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo 'daemon exited before startup'; exit 1; }
  sleep 0.1
done
[[ -S "$AGENT_GRAPH_SOCKET" ]] || { echo 'daemon startup timed out'; exit 1; }
agent-graph-plan() { node "$ROOT/packages/planner/src/cli.ts" "$@"; }
prepare_repo() {
  mkdir "$1"
  git -C "$1" init -q -b main
  git -C "$1" config user.name e2e
  git -C "$1" config user.email e2e@example.invalid
  git -C "$1" commit -q --allow-empty -m fixture
  node "$ROOT/scripts/e2e-stage6-check.ts" fixture "$1" "$2"
}
run_new() {
  builtin cd "$1"
  agent-graph-plan run --session stage6 --no-pr > "$TEMP/$2-run.log" 2>&1 &
  RUN_PID=$!
  node "$ROOT/scripts/e2e-stage6-check.ts" wait-new "$1" "$RUN_PID"
  agent-graph-plan approve gate --session stage6
  node "$ROOT/scripts/e2e-stage6-check.ts" wait-new "$1" "$RUN_PID" complete
  wait "$RUN_PID"
  RUN_PID=''
  node "$ROOT/scripts/e2e-stage6-check.ts" check-new "$1" > "$TEMP/$2-result.json"
}
prepare_repo "$TEMP/new" full
run_new "$TEMP/new" new
if command -v agr >/dev/null 2>&1; then
  # 旧版に --no-pr が無いため、比較の両側から PR ノードを除く。
  prepare_repo "$TEMP/compare-new" compare
  run_new "$TEMP/compare-new" compare-new
  prepare_repo "$TEMP/old" compare
  mkdir "$TEMP/legacy-bin"
  # 旧版の子も一時ラッパーを通し、利用者の設定には書き込まない。
  cp "$TEMP/codex-child" "$TEMP/legacy-bin/codex"
  cat > "$TEMP/legacy-bin/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
"$E2E_REAL_CLAUDE" "$@" --setting-sources project --no-session-persistence \
  --agents '{"doc-light":{"description":"Write documentation","prompt":"Complete the requested document changes."},"reviewer":{"description":"Review changes","prompt":"Review the requested changes without editing files. End with VERDICT: approve or VERDICT: request_changes."}}' \
  2> >(tee -a "$E2E_LOG_DIR/legacy-claude.stderr.log" >&2) | tee -a "$E2E_LOG_DIR/legacy-claude.stdout.log"
SH
  chmod +x "$TEMP/legacy-bin/claude"
  # agr が PATH を上書きしても、LocalRunner の bash でラッパーを優先する。
  export E2E_LEGACY_BIN="$TEMP/legacy-bin"
  cat > "$TEMP/legacy-env" <<'SH'
export PATH="$E2E_LEGACY_BIN:$PATH"
SH
  builtin cd "$TEMP/old"
  AGENT_GRAPH_PROJECT="$TEMP/old" AGENT_GRAPH_RUNNER=local BASH_ENV="$TEMP/legacy-env" PATH="$TEMP/legacy-bin:$PATH" \
    agr run --session stage6 --max-parallel 3 --budget-min 20 > "$TEMP/old-run.log" 2>&1 &
  RUN_PID=$!
  node "$ROOT/scripts/e2e-stage6-check.ts" wait-old "$TEMP/old" "$RUN_PID"
  AGENT_GRAPH_PROJECT="$TEMP/old" AGENT_GRAPH_RUNNER=local agr approve gate --session stage6
  node "$ROOT/scripts/e2e-stage6-check.ts" wait-old "$TEMP/old" "$RUN_PID" complete
  wait "$RUN_PID"
  RUN_PID=''
  node "$ROOT/scripts/e2e-stage6-check.ts" compare "$TEMP/old" "$TEMP/compare-new-result.json"
else
  echo 'skip: agr is not on PATH; legacy comparison skipped'
fi
echo 'PASS: stage 6 planner acceptance, reviews, integration and human gate'
