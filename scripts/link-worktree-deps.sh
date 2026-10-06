#!/usr/bin/env bash
# planner の作業ツリーには node_modules が無い。子の囲いでは依存を取得できないので、
# 根が囲いの外で導入した本体の node_modules を、作業ツリーの同じ位置へ結ぶ。
set -euo pipefail
main_root=/Users/r/00_project/agent-graph
here=$(git rev-parse --show-toplevel)
[ "$here" = "$main_root" ] && exit 0
for dir in "$main_root" "$main_root"/packages/*; do
  [ -d "$dir/node_modules" ] || continue
  rel=${dir#"$main_root"}
  target="$here$rel/node_modules"
  [ -e "$target" ] || { mkdir -p "$here$rel"; ln -s "$dir/node_modules" "$target"; }
done
