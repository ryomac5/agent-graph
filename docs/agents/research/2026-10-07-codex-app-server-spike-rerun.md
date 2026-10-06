# Codex app-server 常駐試作の再実行

最初の実行では外部通信がなく、モデルの応答を一度も確かめられなかった。
今回は外部と通信できる環境で、同じ試作をもう一度動かした。
本書は最初の報告書 `2026-10-07-codex-app-server-spike.md` の追補である。

## 手順

試作はブランチ `agent-graph/v2-foundation-01M492FQ00QEBFA5E9X2KJTCED/S2` から取り出した。
`git show` で `spikes/codex-app-server/run.mjs` を一時ディレクトリへ書き出した。
リポジトリの作業ツリーとブランチの中では一度も動かしていない。

| 項目 | 値 |
| --- | --- |
| 実行日時 | 2026-10-07 02:13:41 JST から 02:14:12 JST |
| 実行ファイル | `/Users/r/.nodebrew/current/bin/codex` |
| 版 | `codex-cli 0.160.1` |
| Node.js | `v24.6.0` |
| 写しの置き場 | `/tmp/cas-rerun-2rGOC7/run.mjs` |
| 試作の改修 | なし |
| 環境変数 | `SPIKE_OTHER_MODEL=gpt-5.6-luna` |
| 実行回数 | 1 回 |

```sh
SPIKE_OTHER_MODEL=gpt-5.6-luna node /tmp/cas-rerun-2rGOC7/run.mjs > /tmp/cas-rerun-2rGOC7/run1.jsonl
```

試作はそのままで全段が通ったので、写しには手を入れていない。
費用を抑えるため、切り替え先のモデルも `gpt-5.6-luna` にした。
このためモデル切り替えの段は effort の切り替えだけを確かめた。

CODEX_HOME は試作が作る一時ディレクトリである。
そこへ写したのは `auth.json` だけで、hook の設定は写していない。
`~/.codex` の設定ファイルは読み出しも変更もしていない。

## 結果

試作は終了コード 0 で終わり、12 の段がすべて成功した。
記録は 292 行で、そのうち通知は 235 件だった。
末尾が Z の時刻は協定世界時で、日本時間より 9 時間遅い。

### 隔離と起動

| 項目 | 実測値 |
| --- | --- |
| CODEX_HOME | `/var/folders/07/wtfd17vj0pbfk26xvgyv73r00000gn/T/codex-app-server-spike-3FiU4i/home` |
| cwd | `/var/folders/07/wtfd17vj0pbfk26xvgyv73r00000gn/T/codex-app-server-spike-3FiU4i/work` |
| 複製ファイル一覧 | `["auth.json"]` |
| 初回 PID | 37553 |
| 再起動後 PID | 38423 |
| サーバーの終了コード | 両方 0 |
| hook 通知 | 0 件 |
| 標準エラー | 0 行 |
| `account/updated` | `authMode=chatgpt` |
| 終了後のプロセス | 37553 と 38423 は `no such process` |
| 一時ホームの終了後の存在 | なし |

最初の実行で出た接続失敗の標準エラーは今回一行も出なかった。

### 各段の実測

| 段 | 操作 | 実測値 | 判定 |
| --- | --- | --- | --- |
| 1 | 二件の `thread/start` | A: `01a11234-f0ca-74a1-9590-a72d69487b3d`<br>B: `01a11234-f0ca-74a1-9590-a73e08236f69` | 両方成功 |
| 1 | 開始応答 | 両方 `ephemeral=false`・`model=gpt-5.6-luna`・`status.type=idle` | 永続スレッド |
| 2 | 同時稼働 | B が 17:13:41.868Z に active・A が 17:13:41.869Z に active | 期間の重複あり |
| 2 | A の最初の応答 | `status=completed`・本文 `I’ll run the requested approval test command now.` と `READY` | 本文が届いた |
| 2 | B の最初の応答 | `status=completed`・本文 `I’ll run the requested command now.` と `READY` | 本文が届いた |
| 3 | 承認要求 | `approvals=2`・両スレッドに 1 件ずつ | 受信した |
| 3 | 許可後の実行 | 両方 `status=completed`・`exitCode=0` | 処理が進んだ |
| 4 | 再起動後の `thread/resume` | 両方同じ ID・`turns=1`・`reasoningEffort=low` | API 成功 |
| 4 | 保存済み入力 | 両方 `expectedMarkerPresent=true`・`otherMarkerPresent=false` | 混在なし |
| 4 | A の記憶の回答 | 本文 `AMBER-731` | 一致 |
| 4 | B の記憶の回答 | 本文 `VIOLET-482` | 一致 |
| 5 | `thread/fork` | `01a11235-2f33-7d83-aa2a-9f86da1c7549`・`forkedFromId` は A | 成功 |
| 5 | 分岐の属性 | `parentThreadId=null`・`model=gpt-6.1-sol`・`reasoningEffort=null` | 最初の実行と同じ |
| 6 | 親の応答 | 本文 `I’ll create one subagent, wait for its response, and then close it.` と `CHILD-OK` | 成功 |
| 6 | 子スレッド | `01a11235-3c5b-77d2-8c10-9f449a18358e` | 生成された |
| 6 | 子の通知 | 17 件・本文 `CHILD-OK` | 届いた |
| 6 | 子の `parentThreadId` | A と一致 | `thread/list` で取得 |
| 7 | luna と low への切り替え | 本文 `SWITCH-OK`・読出値 `gpt-5.6-luna` と `low` | 一致 |
| 7 | luna と high への切り替え | 本文 `SWITCH-OK`・読出値 `gpt-5.6-luna` と `high` | 一致 |

### モデルの応答本文

本文は `item/agentMessage/delta` で少しずつ届いた。
完成した本文は `item/completed` の `agentMessage` で届いた。
delta は A に 36 件、B に 22 件、子に 4 件届いた。

delta の 1 件は次の形だった。

```json
{"method":"item/agentMessage/delta","params":{"threadId":"01a11234-f0ca-74a1-9590-a73e08236f69","turnId":"01a11234-f0e1-77e0-ace1-0badbe7f6270","itemId":"msg_030e9cf103aab629016ac52c4843388191af12de4324a5aa44","delta":"I"}}
```

`agentMessage` には `phase` があり、値は二種類だった。
途中の説明は `commentary` で、最後の回答は `final_answer` だった。
本文の確定には `final_answer` だけを見ればよい。

### 承認

B への承認要求は 02:13:45.076 JST に届いた。
要求は JSON-RPC の要求で、`id` は 0 だった。

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"01a11234-f0ca-74a1-9590-a73e08236f69","turnId":"01a11234-f0e1-77e0-ace1-0badbe7f6270","itemId":"exec-01102dde-e9ad-4eb4-84ac-372e30bf05b7","command":"/bin/zsh -lc 'sleep 2'","commandActions":[{"type":"unknown","command":"sleep 2"}],"proposedExecpolicyAmendment":["sleep","2"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["sleep","2"]}},"cancel"]}}
```

試作は同じ `id` で `{"decision":"accept"}` を返した。
直後に `serverRequest/resolved` が `requestId=0` で届いた。
約 2 秒後に `commandExecution` が `status=completed` と `exitCode=0` で完了した。

承認待ちの間はスレッドの状態に印が付いた。

| 時刻 | 状態 |
| --- | --- |
| 17:13:45.076Z | `active`・`activeFlags=["waitingOnApproval"]` |
| 17:13:45.076Z | `active`・`activeFlags=[]` |

A も 17:13:47.431Z に同じ流れで要求を受け、`id` は 1 だった。
二件の要求は別々の ID で届き、取り違えは起きなかった。

### サブエージェント

親 A の応答の中で `collabAgentToolCall` という item が三つ届いた。
`tool` の値は順に `spawnAgent`、`wait`、`closeAgent` だった。

| item | 親側の値 |
| --- | --- |
| `spawnAgent` の完了 | `senderThreadId` は A・`receiverThreadIds` は子の ID |
| `wait` の完了 | `agentsStates` で子は `completed`・`message=CHILD-OK` |
| `closeAgent` の完了 | 子の状態は `completed` のまま |

子スレッドの通知は子の `threadId` を付けて届いた。

| 時刻 | 子の通知 |
| --- | --- |
| 17:14:01.226Z | `thread/status/changed` で `idle` |
| 17:14:01.228Z | `turn/started` |
| 17:14:02.716Z | `item/started` で `userMessage` |
| 17:14:04.648Z | `item/completed` で `agentMessage`・本文 `CHILD-OK` |
| 17:14:04.733Z | `turn/completed` で `status=completed` |
| 17:14:07.231Z | `thread/status/changed` で `notLoaded` |

子の `thread/started` は届かなかった。
子のどの通知にも `parentThreadId` は含まれていなかった。
`parentThreadId` は応答後の `thread/list` で初めて得られた。

```json
{"id":"01a11235-3c5b-77d2-8c10-9f449a18358e","parentThreadId":"01a11234-f0ca-74a1-9590-a72d69487b3d","model":"gpt-5.6-luna","reasoningEffort":"high","source":{"subAgent":{"thread_spawn":{"parent_thread_id":"01a11234-f0ca-74a1-9590-a72d69487b3d","depth":1,"agent_path":null,"agent_nickname":"Ampere","agent_role":null}}},"status":{"type":"notLoaded"}}
```

実時間で親子の辺を引くには `spawnAgent` の item を使う。
`senderThreadId` と `receiverThreadIds` が親と子の組を直接示す。
`thread/list` の `parentThreadId` は後からの照合に使える。

### 受信した通知の種類

| 通知 | 件数 |
| --- | --- |
| `item/agentMessage/delta` | 62 |
| `item/started` | 31 |
| `item/completed` | 31 |
| `thread/status/changed` | 24 |
| `thread/tokenUsage/updated` | 18 |
| `account/rateLimits/updated` | 15 |
| `mcpServer/startupStatus/updated` | 15 |
| `turn/started` | 8 |
| `turn/completed` | 8 |
| `thread/settings/updated` | 7 |
| `thread/started` | 3 |
| `deprecationNotice` | 3 |
| `item/commandExecution/requestApproval` | 2 |
| `serverRequest/resolved` | 2 |
| `account/updated` | 2 |
| `remoteControl/status/changed` | 2 |
| `thread/goal/cleared` | 2 |

`deprecationNotice` は `thread/resume` と `thread/fork` の直後に届いた。
本文は三件とも同じで、全文は次のとおりである。

```text
Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.
```

### 動かなかった段

動かなかった段はない。
`error` と `warning` の通知も一件も届かなかった。

## 最初の実行との違い

| 項目 | 最初の実行 | 今回 |
| --- | --- | --- |
| 試作の終了コード | 1 | 0 |
| 応答の最終状態 | 全件 `failed` | 全件 `completed` |
| 接続の誤り | `workspace routing discovery failed` | なし |
| 本文 item | `userMessage` のみ | `agentMessage` と delta が届いた |
| 承認要求 | 0 件 | 2 件・許可後に完了 |
| 再開後の記憶 | 回答なし | 両スレッドが正しい印を回答 |
| 子スレッド | 一覧が空 | 1 件・通知 17 件 |
| 子の `parentThreadId` | 未確認 | `thread/list` で A と一致 |
| 切り替え先のモデル | `gpt-5.6-sol` | `gpt-5.6-luna` |
| `deprecationNotice` | 記録なし | 3 件 |

差の原因は外部通信の有無だけである。
試作の中身は最初の実行と同じものを使った。
分岐の既定モデルが `gpt-6.1-sol` になる点は今回も同じだった。

## 結論

最初の実行で未確認だった三点は、今回すべて実際の値で確かめた。
app-server は常駐の土台として採用してよい。

| 用途 | 使用する API と実装方針 | 確認状況 |
| --- | --- | --- |
| 本文の配送 | delta で逐次表示し `final_answer` の `agentMessage` で確定 | 実測済み |
| 承認 | 要求と同じ `id` で `decision` を返す | 実測済み |
| 承認待ちの表示 | `activeFlags` の `waitingOnApproval` を使う | 実測済み |
| 承認の解消 | `serverRequest/resolved` で画面の要求を閉じる | 実測済み |
| 再起動からの復元 | `thread/resume` 後もモデルが前の内容を覚えている | 実測済み |
| 子の辺の実時間取得 | `spawnAgent` の `senderThreadId` と `receiverThreadIds` | 実測済み |
| 子の辺の照合 | `thread/list` の `parentThreadId` | 実測済み |
| 子の出来事 | 子の `threadId` で分けて受ける | 実測済み |
| 別モデルへの切り替え | `turn/start` の `model` を変える | 今回は未実施 |

子の `thread/started` が届かない点は設計で考慮する。
子の通知が先に届くので、未知の `threadId` も受け入れる。
親子の辺は `spawnAgent` の item が届いた時点で張る。

`thread/resume` は全履歴の読み込みが非推奨になっている。
本番では `excludeTurns: true` を付けて、履歴は別の API で読む。
分岐の既定モデルは元を継がないので、分岐でもモデルを指定する。
別モデルへの切り替えは、必要になった時点で一度だけ確かめる。
