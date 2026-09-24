# AGENTS.md

## 目的

agent-graph は AI エージェント間の委譲を記録し、可視化し、割り当てを改善する常駐デーモンである。
設計の正本は `docs/agents/architecture.md`。実装の前に必ず読む。

## パッケージ

pnpm workspace のモノレポ。`packages/core`、`daemon`、`dashboard`、`adapters`、`planner` に分ける。
責務と依存してよい先は設計書の「部品の責務と境界」の表を参照する。
1 段目は `packages/core` だけを実装する。

## 開発コマンド

- 依存の解決: `npx --yes pnpm@10 install`
- テスト: `npx --yes pnpm@10 test`
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
