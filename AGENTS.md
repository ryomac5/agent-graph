# AGENTS.md

## 目的

agent-graph は AI エージェント間の委譲を記録し、可視化し、割り当てを改善する常駐デーモンである。
設計の正本は `docs/agents/architecture-v2.md` である。実装の前に必ず読む。
旧い `docs/agents/architecture.md` は、移行が終わるまでの参照用である。

## パッケージ

pnpm workspace のモノレポ。`packages/core`、`daemon`、`dashboard`、`adapters`、`planner` に分ける。
責務と依存してよい先は設計書の「パッケージ」の表を参照する。

## 実装の段階

段の詳細と受け入れは、設計書の「実装の段階」に従う。
各段で触るパッケージは、設計書の段の記述に限る。

- 段 1 台帳の核: core に台帳と秘匿と状態の規則と投影と再構築を置く
- 段 2 取り込みと移行: 旧い DB の変換と api の取り込みと別名の取り込みを作る
- 段 3 runner とホスト: runner とホストと承認と api の WebSocket を作る
- 段 4 受付と委譲: 受付と MCP の受け口と runner での planner の実行を作る
- 段 5 画面の土台: Vite と React で一覧と会話と承認の受け箱を作る
- 段 6 成果物とレビューと検索: 成果物の確定とレビューと委譲の木と横断検索を作る
- 段 7 Settings と公開水準: Settings と旧い daemon の削除と公開の判定を行う

## 旧い作りの操作

`agent-graph-install --claude-plugin-dir <dir>` で生成し、Claude Code に `--plugin-dir <dir>` を渡す。
Codex は `agent-graph-install --codex-config <path>` で指定先に導入するか、`--print-codex-overrides` の出力を 1 行 1 引数として `codex exec` に渡す（既存の設定を書き換えない）。
個人の割り当て設定は `~/.config/agent-graph/policy.toml`（`XDG_CONFIG_HOME` 優先）に置く。
`agent-graph-plan run --session <id> [--spec path] [--max-parallel n] [--no-pr]` で実行する。spec の既定は `.agents/graph/<id>/tasks.yaml`。
`agent-graph-plan status|approve|reject|retry [task] --session <id>` で状態確認・判断を行う。失敗したタスクも retry できる。

## 開発コマンド

- 依存の解決: `npx --yes pnpm@10 install`
- テスト: `npx --yes pnpm@10 test`
- 型検査: `npx --yes pnpm@10 typecheck`
- デーモン: `npx --yes pnpm@10 daemon`
- ダッシュボード: デーモン起動後、`daemon.log` の `dashboard` 行に記録された URL を開く。ポートは `AGENT_GRAPH_PORT` または `~/.config/agent-graph/config.toml` の `[dashboard] port` で指定できる
- 実機の双方向 e2e（claude と codex の認証が必要、API 利用費用が発生）: `AGENT_GRAPH_E2E=1 bash scripts/e2e-stage2.sh`
- 実機のダッシュボード e2e（同じ認証と API 利用費用が発生）: `AGENT_GRAPH_E2E=1 bash scripts/e2e-stage4.sh`
- e2e は未指定時 skip。状態と作業リポジトリは一時ディレクトリに隔離する
- pnpm は常に `npx --yes pnpm@10` で呼ぶ

## 規則

共通のコーディング規約は `~/.codex/AGENTS.md` を正本とする。ここには差分だけ書く。

- 実装は Node 互換の TypeScript とする。Bun でも動く形を保つ
- `core` は Node 標準と `node:sqlite` だけに依存する
- 依存は設計書の「依存」の表にあるものを、表の段でだけ足す
- `runner` は段 3 で `@anthropic-ai/claude-agent-sdk` を足す。`api` は段 3 で `ws` を足す
- `dashboard` は段 5 で `react` と `react-dom` と `vite` と `@vitejs/plugin-react` を足す
- `dashboard` は段 6 で `@xyflow/react` を足す
- MIT 以外のライセンスの依存は、段の受け入れでライセンスを確かめる
- 旧い `daemon` と旧い画面には手を入れない
- 新しい作りは `runner` と `api` に積む
- 画面の文言は英語を既定にする。日本語は設定で選べる翻訳として持つ
- テストは `node:test` を使う。TypeScript は Node の型除去で直接実行する
- enum や namespace など型除去で消せない構文は使わない
- 状態は作業リポジトリの外に置く。置き場は設計書の「置き場」の表に従う
- 未確認事項は設計書の「未確認事項」の表にある。決定事項として実装しない
- `pnpm-lock.yaml` はリポジトリに含める

## 文書の置き場

- 人が読む文書は `docs/guides/` に自己完結 HTML で置く
- AI エージェントが読む文書は `docs/agents/` に Markdown で置く
