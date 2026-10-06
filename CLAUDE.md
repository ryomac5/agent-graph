# CLAUDE.md

作業前に `AGENTS.md` を読む。共通規則はそこに従う。
設計の正本は `docs/agents/architecture-v2.md` である。
旧い `docs/agents/architecture.md` は、移行が終わるまでの参照用である。

## Claude 固有の注意

- 各段で触るパッケージは、設計書の段の記述に限る
- 段 1 の作業では `packages/core` 以外に実装を広げない
- `packages/adapters` には段 2 より前に手を入れない
- 根の役割は指示に徹する。実装と検証は子エージェントか Codex に委譲する
- ls と cd は command ls と builtin cd を使う
- 危険操作は hook が拒否する。拒否されたら理由をユーザーに伝える
