# 引き継ぎ

- 日付: 2026-09-25
- 読み手: 作業を再開する根エージェント
- 目的: ダッシュボードと観測を旧版と同等以上にする作業の、残りを迷わず終える

## 再開の条件

Codex の利用枠は 2026-10-01 12:33 に戻る。
Claude の Fable は週の枠を 75% まで使った。利用者から使用を止められている。
再開は Codex の枠が戻ってからにする。
実装は Codex に振る。易しい修正は gpt-6-sol、結線は gpt-6-astra を使う。
レビューは Claude の opus か sonnet に振る。Fable は利用者の許可が出るまで使わない。

## いまの状態

main には段 1 から段 6 と導入の道具が入っている。PR は #1 から #9 まで統合済みである。
作業ブランチは手元の `ag/s10` だけにある。push していない。
`ag/s10` は `npx --yes pnpm@10 typecheck` と `npx --yes pnpm@10 test` が通る。

| タスク | 中身 | 状態 |
| --- | --- | --- |
| C0 | 画面 API の契約と守り | 統合済み。レビュー承認 |
| V1b | セッションの名前、終了、生死、待ち | 統合済み。必須の指摘 1 件は V1d に移した |
| V1c | 画面からの操作と planner への受け渡し | 統合済み。指摘の修正も統合済み |
| V1a | 一覧とプロジェクトの読み取り API と SSE | 統合済み。埋まらない項目は V1d に移した |
| V2 | 旧版の画面の移植と磨き | 初版は統合済み。指摘の修正が途中 |
| O1 | Claude のサブエージェントの観測 | 初版は統合済み。指摘の修正が途中 |
| V1d | 委譲の詳細の保存と根の生死判定 | 実装が途中 |
| P1, F1 | planner の部品、レビューの差分 | 統合済み |
| E10 | 結線と撮影 | 未着手 |

途中の 3 つは WIP のコミットとして各ブランチに残してある。どれも未検証である。

| タスク | ブランチ | コミット |
| --- | --- | --- |
| V2 | `worktree-agent-a765664dc993afb66` | e464416 |
| O1 | `worktree-agent-a72e49856599e8bc5` | 5be24f7 |
| V1d | `worktree-agent-a60852fb5f27d8375` | c9895cc |

契約は `packages/daemon/src/http/contract.ts` と `docs/agents/dashboard-api.md` にある。どのタスクも契約の型を変えない。
依頼の全文は `.agents/graph/agent-graph-001-s10/tasks.yaml` にある。

## やること

上から順に進める。各項目の受け入れは、`ag/s10` に統合したあとに `npx --yes pnpm@10 typecheck` と `npx --yes pnpm@10 test` が通ることとする。

### 1. V2 の修正を終える

WIP の e464416 を土台にし、差分を読んで残りを仕上げる。

- 再接続の失敗でポーリングが増えないようにする。`public/ui/feed.js` を直し、偽のタイマーのテストで確かめる
- 辺のラベルで向きの語「Claude → Codex」を切らない。行きと戻りの辺のラベルを離して置く
- 操作の送信の body から `nodeId` を外す。`ActionResult.ok` が偽なら失敗のトーストを出す
- 一覧の丸の状態はサーバの `ProjectSummary.status` を正とする。Unavailable は取得の失敗で出す
- 操作の送信と SSE のテストを足す
- 撮り直した画像で `packages/dashboard/test/screenshots/` を差し替える

### 2. O1 の修正を終える

WIP の 5be24f7 を土台にする。

- 種別の無い内部エージェントに本物の行を奪わせない
- サブエージェントの観測で根の待ちを消さない。待ちを解くのは `resumed` と turn だけにする
- 起動しなかった Agent 呼び出しの行を failed で閉じる。PostToolUse と PostToolUseFailure に Agent を足す
- 並列の同じ種別は、子の最初の依頼文を `delegation.requested` の task と突き合わせて結び直す

### 3. V1d を終える

WIP の c9895cc を土台にする。依頼の全文は、このファイルの末尾の節に写した。

- 版 3 の移行で、delegations に task, scope, outputs, output, worktree を足す。`delegation_rounds` 表と sessions の `ended_reason` も足す
- `runDelegation` が上の列と往復を保存する。画面の詳細に出す
- shim の hello を受けた時点で、根の pid と起動時刻を記録する
- pid を持たずに 30 分の規則で終わったセッションだけは、turn の観測で running に戻す
- endSession の events への追記を appendEvent にまとめる

### 4. E10 で結線して撮影する

依頼の全文は tasks.yaml の `id: E10` にある。加えて次を行う。

- 往復の置き場を 1 つにする。O1 は events の `subagent.*` に、V1d は `delegation_rounds` に積む。サブエージェントも `delegation_rounds` に書くよう O1 を直す。画面は `delegation_rounds` だけを読む
- P1 の `buildTaskPrompt` と `nextAttempt` と `renderReport` を planner の `run.ts` に結線する
- `docs/agents/dashboard-api.md` の古い一文を消す。「現状の events.ts は snapshot を送る」の文である
- 実データで撮影し、旧版の画面と並べて見比べる。旧版の撮影は `agd --port 8765` で起こし、同じ手順で撮る

### 5. 統合して PR にする

根は hook で `git push` を禁じられている。利用者に次を打ってもらう。

```
cd ~/00_project/agent-graph && git push -u origin ag/s10 && gh pr create --base main --head ag/s10 --title "ダッシュボードと観測を旧版と同等以上にする" --fill
```

PR の統合は利用者の指示があれば根が行う。
統合したら、手元の `ag/s10` と各 worktree を片付ける。

## 後回しにしたもの

旧版の hook が守りとして動いているので、次は今回の範囲に入れていない。

- 危険な操作の制止と保護パスの判定
- herdr の連携、statusline、単発の委譲の CLI
- OTLP の受信と、未確認事項の U1, U2, U3, U4, U5, U8

## 繰り返さないこと

- 受け入れの前に、scope に必要なファイルがすべて入っているか根が確かめる
- 並行するタスクの間の約束は、先に型として固定する
- 画面は必ず実際のブラウザで撮り、旧版と並べて見てから完了とする
- 長く走らせるときは `caffeinate -i -s -w <pid>` で Mac のスリープを止める
- モデルの利用枠を確かめてから振る。差し戻しは、実際に壊れる指摘だけに絞る
- 同じ子への指示のやり直しは 3 回までにする

## V1d の依頼の全文

- 版 3 の移行を足す。delegations に task, scope, outputs, output, worktree を足す。delegation_rounds 表を作る。列は delegation_id, seq, kind, text, at である。sessions に ended_reason を足す。値は process_exit, idle, explicit である。版 2 から移行でき、2 回流しても同じ結果になること
- packages/core/src/delegate/run.ts が依頼の task と scope と outputs と cwd を保存し、完了時に子の出力を保存する。最初の依頼を request、再指示を reinstruct、報告を report として delegation_rounds に足す
- packages/daemon/src/http/views.ts と packages/core/src/store/queries.ts で、上の列と表から NodeDetail の task, output, scope, outputs, worktree, rounds を埋める。events 由来の埋め方は、列が空のときの予備として残す
- socket.ts が hello を受けた時点で、根の pid と起動時刻を記録する。既存のセッションには setSessionProcess と resumeSession を呼ぶ。子の hello では根を書き換えない
- pid を持たないまま 30 分の規則で ended にしたセッションに限り、turn_start と turn_done と waiting の観測で running に戻す。プロセスが死んで ended にしたものは戻さない
- endSession の events への追記を、appendEvent を同じトランザクションで呼ぶ形にまとめる
- docs/agents/dashboard-api.md の「ended は turn では戻らない」を上の規則に改める
- テストで確かめること: 移行、各列と往復の保存、画面の詳細への表示、hello だけで根に pid が入ること、委譲せずに 30 分黙った根が次の turn で戻ること、プロセスが死んだ根は戻らないこと、子の hello で根が書き換わらないこと
