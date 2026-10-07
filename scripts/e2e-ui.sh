#!/usr/bin/env bash
set -euo pipefail
if [[ "${AGENT_GRAPH_E2E:-}" != "1" ]]; then
  echo 'SKIP: set AGENT_GRAPH_E2E=1 to run the isolated browser UI test.'
  exit 0
fi
repo_root="$(builtin cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
builtin cd "$repo_root"
exec node scripts/e2e-ui.mjs
