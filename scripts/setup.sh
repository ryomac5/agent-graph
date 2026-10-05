#!/usr/bin/env bash
set -euo pipefail

for agent_graph_arg in "$@"; do
  case "$agent_graph_arg" in
    --dry-run|--doctor|--skip-login) ;;
    *) echo "不明なオプション: $agent_graph_arg（--dry-run / --doctor / --skip-login）" >&2; exit 1 ;;
  esac
done
if [[ "$(uname -s)" != Darwin ]]; then
  echo '自動セットアップは macOS に対応しています。' >&2
  exit 1
fi
agent_graph_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$agent_graph_root/scripts/bootstrap-tools.sh"
agent_graph_prepare_tools "$@"
agent_graph_node="$(cd -- "$(dirname -- "$agent_graph_node")" && pwd)/$(basename -- "$agent_graph_node")"
export AGENT_GRAPH_SETUP_NODE="$agent_graph_node"
"$agent_graph_node" "$agent_graph_root/packages/adapters/src/cli.ts" --setup "$@"
