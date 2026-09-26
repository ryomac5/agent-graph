# agent-graph

AI エージェント同士の委譲を記録し、可視化し、割り当てを改善する常駐デーモンである。
Claude Code と Codex のどちらから呼んだ委譲も 1 つの有向グラフに乗る。
委譲の口は MCP ツール `delegate` 1 本である。
設計の正本は `docs/agents/architecture.md`。導入前に一読する。

## 構成

pnpm workspace のモノレポである。5 つのパッケージに分ける。

| パッケージ | 責務 |
| --- | --- |
| `packages/core` | イベントの型、トレース文脈、割り当て層、実行アダプタ、受け入れ検証、SQLite の保存 |
| `packages/daemon` | MCP サーバ、ダッシュボード用 HTTP と SSE、トレース受信、利用枠の取得 |
| `packages/dashboard` | Web 画面。グラフと履歴と判断待ちの操作を表示する |
| `packages/adapters` | Claude Code プラグインと Codex 設定を生成する |
| `packages/planner` | tasks.yaml のグラフを実行する。ready なタスクごとに `delegate` を呼ぶ |

## 必要なもの

- Node 24 以上
- pnpm は `npx --yes pnpm@10` 経由で呼ぶ。グローバル導入は不要
- `claude` CLI。認証済みであること
- `codex` CLI。認証済みであること

## 導入と起動

1. 依存を解決する。`npx --yes pnpm@10 install`
2. デーモンを起動する。`npx --yes pnpm@10 daemon`
3. ダッシュボードを開く。URL は `daemon.log` の `dashboard` 行に出る。ポートは環境変数 `AGENT_GRAPH_PORT` か `~/.config/agent-graph/config.toml` の `[dashboard] port` で指定する
4. Claude Code に登録する。リポジトリのルートで実行する。`node packages/adapters/src/cli.ts --claude-plugin-dir <dir>` でプラグインを生成し、`claude` に `--plugin-dir <dir>` を渡す
5. Codex に登録する。リポジトリのルートで実行する。`node packages/adapters/src/cli.ts --codex-config <path>` で指定先へ導入するか、`--print-codex-overrides` の出力を 1 行 1 引数として `codex exec` に渡す。既存の設定は書き換えない

割り当てポリシーの個人値は `~/.config/agent-graph/policy.toml` に置く。`XDG_CONFIG_HOME` があれば優先する。

## 使い方

呼び出し側は役割と依頼文と受け入れ条件を渡す。モデルは渡さない。
割り当て層がコードのポリシーとして候補からモデルを選ぶ。
子プロセスも同じ `delegate` を呼べる。Claude から Codex、Codex から Claude のどちらの向きも記録される。
入出力の型は `docs/agents/architecture.md` の「delegate の入出力」にある。

複数タスクをまとめて回すときは planner を使う。

- 実行する。リポジトリのルートで `node packages/planner/src/cli.ts run --session <id> [--spec path] [--max-parallel n] [--no-pr]` を実行する
- 状態を見て判断する。リポジトリのルートで `node packages/planner/src/cli.ts status|approve|reject|retry [task] --session <id>` を実行する

spec の既定は `.agents/graph/<id>/tasks.yaml` である。

## ダッシュボード

デーモンの起動中に開ける。URL は `daemon.log` の `dashboard` 行に出す。

- Overview。全リポジトリのセッションと利用枠を丸と件数で表示する
- プロジェクト。1 リポジトリの委譲を有向グラフで表示する。根と子を選ぶと詳細パネルが開き、依頼文・出力・往復・受け入れ・割り当ての理由が見える
- 判断待ち。planner が `waiting_human` か `conflict` で止まったタスクに Approve / Reject / Retry を送る
- 双方向の辺。Claude と Codex のどちらの向きの委譲も色で区別して表示する

画面は `packages/dashboard`、経路と SSE の約束は `docs/agents/dashboard-api.md` にある。

## 状態の置き場

作業するリポジトリの中に状態を置かない。

- 実行時の状態。`~/.local/state/agent-graph/<repo-key>/agent-graph.db`
- デーモンのソケットとログ。`~/.local/state/agent-graph/run/`
- worktree。`~/.cache/agent-graph/worktrees/<repo-key>/<session>/<task>/`

`XDG_STATE_HOME` と `XDG_CACHE_HOME` と `XDG_CONFIG_HOME` があれば優先する。
詳しい置き場の一覧は `docs/agents/architecture.md` の「置き場」にある。

## 開発

- テストを走らせる。`npx --yes pnpm@10 test`
- 実機の双方向 e2e。`AGENT_GRAPH_E2E=1 bash scripts/e2e-stage2.sh`
- 実機のダッシュボード e2e。`AGENT_GRAPH_E2E=1 bash scripts/e2e-stage4.sh`
- プラグインと設定生成の e2e。`AGENT_GRAPH_E2E=1 bash scripts/e2e-stage5.sh`
- planner とレビューの e2e。`AGENT_GRAPH_E2E=1 bash scripts/e2e-stage6.sh`

e2e は本物の `claude` と `codex` を呼ぶ。認証と API 利用費用が必要になる。
`AGENT_GRAPH_E2E` を指定しないときは skip する。状態と作業リポジトリは一時ディレクトリに隔離する。

## 設計

構成の詳細、イベントとトレースの型、割り当て層の判断、セキュリティの考え方は `docs/agents/architecture.md` にある。
開発コマンドの詳細とコーディング規約は `AGENTS.md` にある。
