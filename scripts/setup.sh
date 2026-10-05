#!/usr/bin/env bash
set -euo pipefail

for agent_graph_arg in "$@"; do
  case "$agent_graph_arg" in
    --dry-run|--doctor) ;;
    *) echo "不明なオプション: $agent_graph_arg（--dry-run / --doctor）" >&2; exit 1 ;;
  esac
done
if [[ "$(uname -s)" != Darwin ]]; then
  echo '自動セットアップは macOS に対応しています。' >&2
  exit 1
fi
agent_graph_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
agent_graph_node="$(command -v node || true)"
if [[ -z "$agent_graph_node" ]] || ! "$agent_graph_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  agent_graph_brew="$(command -v brew || true)"
  if [[ -z "$agent_graph_brew" ]]; then
    for agent_graph_candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [[ -x "$agent_graph_candidate" ]]; then agent_graph_brew="$agent_graph_candidate"; break; fi
    done
  fi
  if [[ -z "$agent_graph_brew" ]]; then
    echo 'Node 24 以上が必要です。https://nodejs.org/ から導入して、このコマンドを再実行してください。' >&2
    exit 1
  fi
  agent_graph_brew_prefix="$("$agent_graph_brew" --prefix)"
  agent_graph_node="$agent_graph_brew_prefix/opt/node@24/bin/node"
  if [[ ! -x "$agent_graph_node" ]]; then
    for agent_graph_arg in "$@"; do
      if [[ "$agent_graph_arg" == --dry-run || "$agent_graph_arg" == --doctor ]]; then
        echo 'Node 24 が未導入です。通常のセットアップでは brew install node@24 を実行します。' >&2
        exit 1
      fi
    done
    echo 'Node 24 を Homebrew から導入します。'
    "$agent_graph_brew" install node@24
  fi
fi
agent_graph_node="$(cd -- "$(dirname -- "$agent_graph_node")" && pwd)/$(basename -- "$agent_graph_node")"
export AGENT_GRAPH_SETUP_NODE="$agent_graph_node"
exec "$agent_graph_node" "$agent_graph_root/packages/adapters/src/cli.ts" --setup "$@"
