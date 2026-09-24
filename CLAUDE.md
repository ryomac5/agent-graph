# CLAUDE.md

作業前に `AGENTS.md` を読む。共通規則はそこに従う。

## Claude 固有の注意

- 1 段目の作業では `packages/core` 以外に実装を広げない
- `packages/adapters` の Claude Code プラグイン生成は段 5 まで行わない
- 根の役割は指示に徹する。実装と検証は子エージェントか Codex に委譲する
- ls と cd は command ls と builtin cd を使う
- 危険操作は hook が拒否する。拒否されたら理由をユーザーに伝える
