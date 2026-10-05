#!/usr/bin/env bash
# 新PCの実行環境はユーザー領域に置き、Homebrewやsudoを必要にしない。
agent_graph_prepare_tools() {
  agent_graph_tools="${XDG_DATA_HOME:-$HOME/.local/share}/agent-graph/tools"
  case "$agent_graph_tools" in /*) ;; *) echo 'XDG_DATA_HOMEは絶対パスで指定してください。' >&2; exit 1 ;; esac
  export PATH="$agent_graph_tools/bin:$HOME/.local/bin:$PATH"
  agent_graph_node="$(command -v node || true)"
  agent_graph_npm="$(command -v npm || true)"
  agent_graph_mode=install
  for agent_graph_arg in "$@"; do
    case "$agent_graph_arg" in --doctor|--dry-run) agent_graph_mode=inspect ;; esac
  done
  agent_graph_need_node=false
  if [[ -z "$agent_graph_node" ]] || ! "$agent_graph_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    agent_graph_need_node=true
  fi
  if [[ "$agent_graph_need_node" == true ]]; then
    for agent_graph_cached_node in "$agent_graph_tools"/node-v24.21.0-darwin-*/bin/node; do
      if [[ -x "$agent_graph_cached_node" ]] && "$agent_graph_cached_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
        agent_graph_node="$agent_graph_cached_node"
        agent_graph_npm="$(dirname -- "$agent_graph_node")/npm"
        agent_graph_need_node=false
        break
      fi
    done
  fi
  if [[ "$agent_graph_mode" == install ]] && ! command -v codex >/dev/null 2>&1 && [[ -z "$agent_graph_npm" ]]; then agent_graph_need_node=true; fi
  if [[ "$agent_graph_mode" == inspect ]]; then
    if [[ "$agent_graph_need_node" == true ]]; then
      echo 'Node 24 が未導入です。通常のセットアップで公式バイナリをユーザー領域へ導入します。'
      exit 0
    fi
    return 0
  fi
  agent_graph_tools_temp="$(mktemp -d "${TMPDIR:-/tmp}/agent-graph-tools.XXXXXX")"
  trap 'rm -rf -- "$agent_graph_tools_temp"' EXIT
  if [[ "$agent_graph_need_node" == true ]]; then
    case "$(uname -m)" in
      arm64) agent_graph_arch=arm64; agent_graph_node_sha=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
      x86_64) agent_graph_arch=x64; agent_graph_node_sha=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
      *) echo '対応CPUはApple Silicon / Intelです。' >&2; exit 1 ;;
    esac
    agent_graph_node_name="node-v24.21.0-darwin-$agent_graph_arch"
    agent_graph_node_dir="$agent_graph_tools/$agent_graph_node_name"
    if [[ ! -x "$agent_graph_node_dir/bin/node" ]]; then
      echo 'Node 24 を公式配布から導入します。'
      curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "https://nodejs.org/dist/v24.21.0/$agent_graph_node_name.tar.gz" -o "$agent_graph_tools_temp/node.tar.gz"
      agent_graph_actual_sha="$(shasum -a 256 "$agent_graph_tools_temp/node.tar.gz" | awk '{print $1}')"
      if [[ "$agent_graph_actual_sha" != "$agent_graph_node_sha" ]]; then echo 'Nodeのチェックサムが一致しません。導入を中止します。' >&2; exit 1; fi
      tar -xzf "$agent_graph_tools_temp/node.tar.gz" -C "$agent_graph_tools_temp"
      mkdir -p "$agent_graph_tools"
      if [[ -e "$agent_graph_node_dir" ]]; then echo "不完全な導入先があります: $agent_graph_node_dir" >&2; exit 1; fi
      mv "$agent_graph_tools_temp/$agent_graph_node_name" "$agent_graph_node_dir"
    fi
    agent_graph_node="$agent_graph_node_dir/bin/node"
    agent_graph_npm="$agent_graph_node_dir/bin/npm"
  fi
  export PATH="$(dirname -- "$agent_graph_node"):$PATH"
  if ! command -v claude >/dev/null 2>&1; then
    echo 'Claude Code を公式インストーラーから導入します。'
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 https://claude.ai/install.sh -o "$agent_graph_tools_temp/claude.sh"
    bash "$agent_graph_tools_temp/claude.sh" stable
  fi
  if ! command -v codex >/dev/null 2>&1; then
    echo 'Codex CLI を公式npmパッケージから導入します。'
    "$agent_graph_npm" install --global --prefix "$agent_graph_tools" @openai/codex
  fi
  if ! command -v herdr >/dev/null 2>&1; then
    echo 'Herdr を公式インストーラーから導入します。'
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 https://herdr.dev/install.sh -o "$agent_graph_tools_temp/herdr.sh"
    HERDR_INSTALL_DIR="$agent_graph_tools/bin" sh "$agent_graph_tools_temp/herdr.sh"
  fi
  for agent_graph_client in claude codex herdr; do
    if ! command -v "$agent_graph_client" >/dev/null 2>&1; then echo "$agent_graph_client の導入を確認できません。" >&2; exit 1; fi
    "$agent_graph_client" --version
  done
  if ! xcrun --find git >/dev/null 2>&1; then
    echo 'Gitに必要なmacOS Command Line Toolsを導入します。表示された画面でインストールしてください。'
    xcode-select --install
    agent_graph_wait=0
    until xcrun --find git >/dev/null 2>&1; do
      if [[ "$agent_graph_wait" -ge 900 ]]; then echo 'Command Line Toolsの導入後、同じコマンドを再実行してください。' >&2; exit 1; fi
      if [[ $((agent_graph_wait % 30)) -eq 0 ]]; then echo 'Command Line Toolsの導入を待っています…'; fi
      sleep 2
      agent_graph_wait=$((agent_graph_wait + 2))
    done
  fi
}
