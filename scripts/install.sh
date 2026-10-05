#!/usr/bin/env bash
set -euo pipefail

for agent_graph_arg in "$@"; do
  case "$agent_graph_arg" in
    --dry-run|--doctor)
      echo '取得・Node / Claude / Codex / Herdrの導入・ログイン案内・常駐起動を行います。'
      echo '既存導入の確認は、導入済みフォルダの scripts/setup.sh --doctor を使ってください。'
      exit 0 ;;
    --skip-login) ;;
    *) echo "不明なオプション: $agent_graph_arg" >&2; exit 1 ;;
  esac
done
if [[ "$(uname -s)" != Darwin ]]; then echo '自動導入はmacOSに対応しています。' >&2; exit 1; fi
agent_graph_data="${XDG_DATA_HOME:-$HOME/.local/share}/agent-graph"
case "$agent_graph_data" in /*) ;; *) echo 'XDG_DATA_HOMEは絶対パスで指定してください。' >&2; exit 1 ;; esac
agent_graph_install_temp="$(mktemp -d "${TMPDIR:-/tmp}/agent-graph-install.XXXXXX")"
trap 'rm -rf -- "$agent_graph_install_temp"' EXIT
echo 'agent-graphを取得します。'
curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 https://codeload.github.com/ryomac5/agent-graph/tar.gz/refs/heads/main -o "$agent_graph_install_temp/source.tar.gz"
agent_graph_revision="$(shasum -a 256 "$agent_graph_install_temp/source.tar.gz" | awk '{print $1}')"
tar -xzf "$agent_graph_install_temp/source.tar.gz" -C "$agent_graph_install_temp"
agent_graph_install_root="$agent_graph_data/releases/$agent_graph_revision"
if [[ ! -f "$agent_graph_install_temp/agent-graph-main/scripts/setup.sh" ]]; then echo '取得したコードにセットアップがありません。' >&2; exit 1; fi
if [[ ! -d "$agent_graph_install_root" ]]; then
  mkdir -p "$agent_graph_data/releases"
  mv "$agent_graph_install_temp/agent-graph-main" "$agent_graph_install_root"
fi
# curl | bashでも、ログインは本人の端末で操作できるようにする。
if [[ -t 1 && -r /dev/tty ]]; then
  bash "$agent_graph_install_root/scripts/setup.sh" "$@" </dev/tty
else
  bash "$agent_graph_install_root/scripts/setup.sh" "$@"
fi
