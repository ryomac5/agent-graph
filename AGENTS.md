# AGENTS.md

## 目的

agent-graph は AI エージェント間の委譲を記録し、可視化し、割り当てを改善する常駐デーモンである。
設計の正本は `docs/agents/architecture.md`。実装の前に必ず読む。

## パッケージ

pnpm workspace のモノレポ。`packages/core`、`daemon`、`dashboard`、`adapters`、`planner` に分ける。
責務と依存してよい先は設計書の「部品の責務と境界」の表を参照する。
2 段目は `packages/core` の実行アダプタと委譲処理、`packages/daemon` の MCP・ソケット・エントリ、および双方向 e2e を実装する。
3 段目は core の割り当て層と daemon の利用枠取得を結線する。
4 段目は daemon の HTTP と SSE を dashboard の静的ファイルに結線し、双方向の辺と表示遅延を e2e で確認する。
個人の割り当て設定は `~/.config/agent-graph/policy.toml`（`XDG_CONFIG_HOME` 優先）に置く。

## 開発コマンド

- 依存の解決: `npx --yes pnpm@10 install`
- テスト: `npx --yes pnpm@10 test`
- デーモン: `npx --yes pnpm@10 daemon`
- ダッシュボード: デーモン起動後、`daemon.log` の `dashboard` 行に記録された URL を開く。ポートは `AGENT_GRAPH_PORT` または `~/.config/agent-graph/config.toml` の `[dashboard] port` で指定できる
- 実機の双方向 e2e（claude と codex の認証が必要、API 利用費用が発生）: `AGENT_GRAPH_E2E=1 bash scripts/e2e-stage2.sh`
- 実機のダッシュボード e2e（同じ認証と API 利用費用が発生）: `AGENT_GRAPH_E2E=1 bash scripts/e2e-stage4.sh`
- e2e は未指定時 skip。状態と作業リポジトリは一時ディレクトリに隔離する
- pnpm は常に `npx --yes pnpm@10` で呼ぶ

## 規則

共通のコーディング規約は `~/.codex/AGENTS.md` を正本とする。ここには差分だけ書く。

- 実装は Node 互換の TypeScript とする。Bun でも動く形を保つ
- `core` は Node 標準と `node:sqlite` 以外に依存を追加しない
- テストは `node:test` を使う。TypeScript は Node の型除去で直接実行する
- enum や namespace など型除去で消せない構文は使わない
- 状態は作業リポジトリの外に置く。置き場は設計書の「置き場」の表に従う
- 未確認事項は設計書の「未確認事項」の表にある。決定事項として実装しない
- `pnpm-lock.yaml` はリポジトリに含める

## 文書の置き場

- 人が読む文書は `docs/guides/` に自己完結 HTML で置く
- AI エージェントが読む文書は `docs/agents/` に Markdown で置く
