# agent-graph

AI エージェント同士の委譲を記録し、可視化し、割り当てを改善する常駐デーモンである。
Claude Code と Codex のどちらから呼んだ委譲も 1 つの有向グラフに乗る。
委譲の口は MCP ツール `delegate` 1 本である。

## 新しいMacへの導入

このリポジトリを新しいMacに置き、ルートで実行する。

```bash
bash scripts/setup.sh
```

常駐起動・Claudeのユーザー登録・Codex設定をまとめて行い、ダッシュボードのURLを表示する。
Node 24以上が必要。未導入でもHomebrewがあれば自動で導入する。実行用の依存インストールやpnpmは不要。
Claude / CodexのCLIとログインは各PCで準備する。設定の反映後、開いているClaude / Codexを再起動する。
画面からの新規起動・送信・モデル変更にはHerdrも必要。

```bash
bash scripts/setup.sh --doctor   # 登録状況とURLを確認
bash scripts/setup.sh --dry-run  # 変更内容だけを確認
```

既存のCodex設定はagent-graphの項目だけを更新し、変更前のファイルをバックアップする。
同じ設定での再実行はデーモンを再起動しない。実行中の委譲がある場合は再起動を伴う更新を止める。
詳しい導入・ログイン・移行手順は [導入ガイド](docs/guides/setup.html) を参照。

## 構成

pnpm workspace のモノレポである。5 つのパッケージに分ける。

| パッケージ | 責務 |
| --- | --- |
| `packages/core` | イベントの型、トレース文脈、割り当て層、実行アダプタ、受け入れ検証、SQLite の保存 |
| `packages/daemon` | MCP サーバ、ダッシュボード用 HTTP と SSE、トレース受信、利用枠の取得 |
| `packages/dashboard` | Web 画面。グラフと履歴と判断待ちの操作を表示する |
| `packages/adapters` | Claude Code プラグインと Codex 設定を生成する |
| `packages/planner` | tasks.yaml のグラフを実行する。ready なタスクごとに `delegate` を呼ぶ |

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

- プロジェクトとセッションを選び、委譲グラフを表示する。終了したセッションは折りたたむ
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

- 開発用の依存を解決する。`npx --yes pnpm@10 install`
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
