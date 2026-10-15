# SessionEnd 後の同じ run の再開

2026-10-15。対象は `claude:354000b1-4a87-45e8-baa7-6c1fa209d741:1791953410470`。
本番 DB は `DatabaseSync(..., { readOnly: true })` と `PRAGMA query_only=ON` で開いた。
`~/.claude` は読み取りのみ。プロセスの起動・再起動・本番投影の変更は行っていない。

## Claude Code 2.1.299 の根拠

インストール済み `/Users/r/.local/share/claude/versions/2.1.299` の埋め込み JavaScript と、
履歴・daemon 記録・保存済み hook 入力を照合した。現在の `claude` のリンク先は 2.1.300 なので実行していない。

| reason | 2.1.299 の実装で確認した呼び出し |
| --- | --- |
| `clear` | 会話クリア処理が SessionEnd(clear) を実行する |
| `resume` | 対話中の会話切り替えで元の会話に SessionEnd(resume)、移行先に SessionStart(resume/fork) を実行する |
| `logout` | 通常の `/logout` が終了処理へ logout を渡す。背景セッション側には共有認証のため効果がない経路もある |
| `prompt_input_exit` | 入力画面からの終了。背景移行後の元画面の終了にも使われる |
| `other` | 汎用 shutdown の既定値。理由だけから同じ session_id の全実行の死を断定できない |

2.1.299 の reason 列挙は上の5種類。各操作を新規に実行した再現試験ではなく、インストール済み実装の読解である。
[公式の hook 仕様](https://code.claude.com/docs/en/hooks#sessionend) は意味の補助に使用し、現行仕様を2.1.299の実測と混同していない。

本番記録は次のとおり（UTC）。

| 時刻 | 記録 |
| --- | --- |
| 10-14 04:50:08.151 | `~/.claude/daemon.log` に背景会話 354000b1 の spawn。daemon は2.1.299 |
| 04:50:10.487 | 台帳 seq 299667: SessionStart(source=fork)、generation=1791953410470 |
| 09:08:58.731 | seq 301135: SessionEnd(reason=other)、同じ session_id と generation |
| 09:10:25.904 | `~/.claude/daemon/attach-journal/bf8fcbf3-9aaf-410a-a0db-6f5311ec34c8.json`: bg_cli attach、interactiveReached=true |
| 09:10:41.147 | 対象 jsonl に同じ sessionId の user 行、version=2.1.299 |
| 09:10:41.205 | seq 301443: UserPromptSubmit、同じ session_id と generation |
| 09:11:37.891 | seq 301522: Stop。同世代でその後もターンが継続 |
| 18:51:09–11 | daemon が2.1.300へ更新。背景 worker を adopted=1、respawned=0 で引き継ぐ |

対象 run の SessionStart は最初の1件のみ。`sessions/41658.json` は対象会話を kind=bg、version=2.1.299、開始04:50:09と記録し、
`daemon/roster.json` も同会話の2.1.299 workerを保持している。

**確定**: 背景 fork 由来の会話で、other の後に SessionStart なしで同じ会話・世代のターンが続いた。
**推測**: 時系列は背景会話への画面の再 attach と整合する。
**未確定**: 09:08:58のhookを発行したPID・端末はhook入力に無く、対象debugログも残っていない。
別端末の attach や画面切断そのものが other を発火したとまでは断定しない。daemon の更新は約9時間後なので当該終了の直接原因ではない。
プロセス一覧の照合は環境が `ps` を拒否したため行えていない。

## 投影の修正

- `ended` の終了根拠が `session_end` の場合だけ再開を許す。
- 同じ run subject・明示された同じ generation・同じ Claude session の確認済みターン開始を必要とする。
- hook は UserPromptSubmit、履歴は turn_started に限定する。事実の source_ts と根拠時刻の両方が ended_ts より後でなければならない。
- `claude:<id>` と `["claude","<id>"]` の既存2表現を同一会話として照合する。hook入力のsession_idがある場合も照合する。
- ホスト終了、アーカイブ、プロセス死亡、利用者訂正、失敗は復帰しない。SessionEnd後に届く確実な終了も保持する。
- 現在の ended_ts/end_evidence を消し、新ターンの時計を開始する。過去の有効な終了境界はメモリ上で別に保持し、古いQueuedを復活させない。訂正された終了は境界からも除く。

## 既存投影と本番データの検証

本番の対象subjectの262件で、保存済み `ended` が新しい投影では `idle` になった。
最後の状態根拠は `2026-10-15T02:07:52.819Z`。読み出し＋純粋投影は6ms。

同じ事実をメモリDBへ入れ、本番の古い ended 行を置いたあと、状態を持たない次の run.updated を1件追記した。
増分投影は39msで idle へ修復し、投影世代は不変。メモリDBでのrebuild結果とも一致した。
新コードを適用後、対象 run の次の事実が処理されれば既存の古い投影も直る。
更新が来るまでは古い保存値が残る。本作業は本番への適用や再起動を行っていない。

投影版11とスキーマは変更していない。増分処理は対象subjectの過去の事実を読み直すため、
約7GBの全台帳のrebuildは不要。全台帳の所要時間は実測せず、対象runのms値から外挿していない。

再検証用の読み取り専用コマンド（書き込み先はメモリDBのみ）:

```sh
node scripts/verify-session-end.mjs \
  /Users/r/.local/state/agent-graph/agent-graph.db \
  claude:354000b1-4a87-45e8-baa7-6c1fa209d741:1791953410470
```

## 試験

- core全体422件成功。最終の小修正後にrun/turn/Queued関連48件も成功。
- APIの送信監視とQueued関連37件成功。再開後はbusy_runを捕捉し、古いSessionEndで期限を開始しない。feedの根もrunningになり、終了前のQueuedを戻さない。
- 画面のWorking・ターン関連51件成功。投影から行・タブ・Workingの40秒表示、Stop後の未読、既読解除を確認。
- `git show HEAD:packages/core/src/ledger/projections/runs.ts` の旧実装をメモリ上で読み、同じ標本のrunning期待が `ended !== running` で失敗することを確認。作業ファイルを旧版へ戻していない。
- 型検査は既知の `packages/daemon/src/http/views.ts:83` 以外を個別にも確認した。
