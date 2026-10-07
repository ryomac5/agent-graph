#!/usr/bin/env bash
set -euo pipefail
if [[ "${AGENT_GRAPH_E2E:-}" != "1" ]]; then
  echo 'SKIP: set AGENT_GRAPH_E2E=1 to run authenticated host checks (API usage may incur costs).'
  exit 0
fi
repo_root="$(builtin cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
builtin cd "$repo_root"
# 認証設定はそのまま使い、試験専用 runner で会話の保存を止める。
exec node packages/runner/src/e2e-hosts.ts
