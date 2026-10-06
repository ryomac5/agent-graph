#!/usr/bin/env bash
set -euo pipefail
if [[ "${AGENT_GRAPH_E2E:-}" != "1" ]]; then
  echo 'SKIP: set AGENT_GRAPH_E2E=1 (real hosts require authentication and may incur API costs).'
  exit 0
fi
repo_root="$(builtin cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
builtin cd "$repo_root"
exec node packages/runner/src/e2e-intake.ts
