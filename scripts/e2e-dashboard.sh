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
{"roles":{"orchestrate":[],"research":[],"implement":[{"executor":"codex","model":"gpt-6-luna","family":"openai","tier":"low"}],"document":[{"executor":"claude","model":"haiku","family":"anthropic","tier":"low"}],"review":[{"executor":"claude","model":"sonnet","family":"anthropic","tier":"mid"}]}}
JSON
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
# デーモンの cwd を対象 repo にして起動時に store を登録させる。
mkdir "$TEMP/repo"
builtin cd "$TEMP/repo"
git init -q -b main
git config user.name e2e
git config user.email e2e@example.invalid
git commit -q --allow-empty -m fixture
mkdir -p .agents/graph/dash
cat > .agents/graph/dash/tasks.yaml <<'YAML'
goal: dashboard e2e fixture
base_branch: main
tasks:
  - id: doc
    title: write notes
    executor: doc-light
    scope: [notes.md]
    outputs: [notes.md]
    accept: ["test -f notes.md"]
    prompt: write notes
  - id: gate
    title: approve outputs
    executor: human
    depends_on: [doc]
YAML
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
agent-graph-plan() { node "$ROOT/packages/planner/src/cli.ts" "$@"; }
# planner を human ゲートで止め、その間に契約を検べて撮影する。
agent-graph-plan run --session dash --no-pr > "$TEMP/dash-run.log" 2>&1 &
RUN_PID=$!
for ((attempt=0; attempt<300; attempt++)); do
  if node "$ROOT/scripts/e2e-dashboard-check.ts" project "$URL" > "$TEMP/project-check.log" 2>&1; then
    state=$(node --input-type=module -e "import{openPlanner}from'$ROOT/packages/planner/src/index.ts';import{repoKey}from'$ROOT/packages/core/src/paths.ts';const c=openPlanner('$TEMP/repo','dash','$TEMP/repo/.agents/graph/dash/tasks.yaml');try{const g=c.store.findGraph(c.key,'dash',c.fingerprint);if(!g)process.exit(1);const t=c.store.listTasks(g.id).find(t=>t.id==='gate');console.log(t?.state??'')}finally{c.store.close()}" 2>/dev/null || true)
    [[ "$state" == "waiting_human" ]] && break
  fi
  kill -0 "$RUN_PID" 2>/dev/null || break
  sleep 0.2
done
node "$ROOT/scripts/e2e-dashboard-check.ts" overview "$URL" > "$TEMP/overview-check.log" 2>&1
cat "$TEMP/overview-check.log"
node "$ROOT/scripts/e2e-dashboard-check.ts" project "$URL" > "$TEMP/project-check.log" 2>&1
cat "$TEMP/project-check.log"
# 撮影。Overview とプロジェクトと詳細パネルを開いた状態を保存する。
mkdir -p "$ROOT/.agents-shots"
node "$ROOT/scripts/screenshot.ts" --url "$URL" --out "$ROOT/.agents-shots/overview.png" --target overview
node "$ROOT/scripts/screenshot.ts" --url "$URL" --out "$ROOT/.agents-shots/project.png" --target project
node "$ROOT/scripts/screenshot.ts" --url "$URL" --out "$ROOT/.agents-shots/detail.png" --target detail
# HTTP で Approve を送り、planner が進んで完了することを確かめる。
TOKEN=$(curl -s "$URL" | sed -n 's/.*name="agent-graph-token" content="\([^"]*\)".*/\1/p')
GRAPH_ID=$(node --input-type=module -e "import{openPlanner}from'$ROOT/packages/planner/src/index.ts';const c=openPlanner('$TEMP/repo','dash','$TEMP/repo/.agents/graph/dash/tasks.yaml');try{const g=c.store.findGraph(c.key,'dash',c.fingerprint);console.log(g.id)}finally{c.store.close()}")
node "$ROOT/scripts/e2e-dashboard-check.ts" approve "$URL" "$GRAPH_ID" gate "$TOKEN" > "$TEMP/approve.log" 2>&1
cat "$TEMP/approve.log"
for ((attempt=0; attempt<100; attempt++)); do
  if ! kill -0 "$RUN_PID" 2>/dev/null; then break; fi
  sleep 0.2
done
wait "$RUN_PID"
RUN_PID=''
state=$(node --input-type=module -e "import{openPlanner}from'$ROOT/packages/planner/src/index.ts';const c=openPlanner('$TEMP/repo','dash','$TEMP/repo/.agents/graph/dash/tasks.yaml');try{const g=c.store.findGraph(c.key,'dash',c.fingerprint);if(!g){console.log('none');process.exit(1)}const t=c.store.listTasks(g.id).find(t=>t.id==='gate');console.log(t?.state??'')}finally{c.store.close()}")
[[ "$state" == "done" ]] || { echo "gate not done after approve: $state"; exit 1; }
for shot in overview project detail; do
  [[ -s "$ROOT/.agents-shots/$shot.png" ]] || { echo "missing screenshot $shot.png"; exit 1; }
done
echo 'PASS: stage dashboard e2e'
