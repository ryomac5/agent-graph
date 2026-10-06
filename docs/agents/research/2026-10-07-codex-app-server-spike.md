# Codex app-server 常駐試作

## 手順

既存の調査資料と設計書を先に読み終えてから導入済みの実行ファイルで通信仕様の型を生成した。
試作は外部ライブラリを一切追加せずに標準機能だけを使う単独の実行ファイルとして実装した。
認証情報だけを一時領域へ複製する方法を最初に試してから通常設定を読まずにサーバーを起動した。

| 項目 | 値 |
| --- | --- |
| 調査日 | 2026-10-07 JST |
| 実行ファイル | `/Users/r/.nodebrew/current/bin/codex` |
| 版 | `codex-cli 0.160.1` |
| 起動引数 | `app-server --listen stdio://` |
| 通信 | 改行区切り JSON-RPC |
| 初期化 | `initialize` → `initialized` |
| 初期化 capability | `experimentalApi: true` |
| 認証元 | `~/.codex/auth.json` |
| 複製先のファイルモード | `0600` |
| 一時 CODEX_HOME のモード | `0700` |
| 複製するファイル | `auth.json` のみ |
| 初期モデル | `gpt-5.6-luna` |
| 型の確認 | `codex app-server generate-ts --experimental --out /tmp/s2-codex-schema/types` |
| 承認方式 | `untrusted` |
| sandbox | `workspace-write` |
| RPC 待機上限 | 30 秒 |
| turn 待機上限 | 120 秒 |

```sh
node spikes/codex-app-server/run.mjs > /tmp/codex-app-server-spike.jsonl
```

開始要求を二件並行で送った後に別々の記憶用文字列を与えて各スレッドの通知を識別して記録した。
承認の発生を促すために二秒の待機コマンドを実行する指示を両方のスレッドへ最初に送信した。
再開時の入力には記憶用文字列を含めずに以前の会話から文字列を回答するように明示して指示した。
試作が持つ認証情報の複製は終了処理で一時領域ごと消すようにして実際の削除まで最後に確認した。

## 結果

実機の各スレッドに送信した全ての応答要求はモデルの接続先を探索する段階で同じエラーになった。
以下の表は診断出力を補った最終版の再実行から抽出した値であり初回の試行結果とは区別している。

### 隔離と起動

| 項目 | 実測値 |
| --- | --- |
| 開始 | 2026-10-06T17:03:03.867Z |
| 終了 | 2026-10-06T17:04:30.215Z |
| CODEX_HOME | `/var/folders/07/wtfd17vj0pbfk26xvgyv73r00000gn/T/codex-app-server-spike-FerzrQ/home` |
| cwd | `/var/folders/07/wtfd17vj0pbfk26xvgyv73r00000gn/T/codex-app-server-spike-FerzrQ/work` |
| 初回 PID | 16519 |
| 再起動後 PID | 17331 |
| hook 通知 | 0 件 |
| 複製ファイル一覧 | `["auth.json"]` |
| 試作の終了コード | 1 |
| サーバーの終了コード | 両方 0 |
| 終了後のプロセス群確認 | 16519 と 17331 は `ESRCH` |
| 一時ホームの終了後の存在 | `false` |
| 初回試行の片付け | PID 13437 と 14373 は `ESRCH`・一時ホームなし |

一時ホームには利用者のフック設定を複製しておらず今回の試行中にフックの通知は一件も発生しなかった。

### 各段の実測

| 段 | 操作 | 実測値 | 判定 |
| --- | --- | --- | --- |
| 1 | 二件の `thread/start` | A: `01a1122b-4088-7050-a73a-f458234b1463`<br>B: `01a1122b-4088-7050-a73a-f44f7cb7f0cb` | 両方成功 |
| 1 | 開始応答 | 両方 `ephemeral=false`・`model=gpt-5.6-luna`・`status.type=idle`・`source=vscode` | 永続スレッド |
| 2 | 同時稼働の通知 | B が 17:03:10.047Z に active・A が 17:03:10.048Z に active | 期間の重複あり |
| 2 | 通知数 | A: 56 件・B: 69 件・分岐: 3 件 | ID ごとに分離 |
| 2 | 最初の応答 | 両方 `status=failed`・`messages=[]`・エラー E1 | 本文の流れは未確認 |
| 3 | 承認要求 | `approvals=0` | E1 により要求発生前に停止 |
| 4 | 再起動後の `thread/resume` | 両方同じ ID・`turns=1`・`reasoningEffort=low` | API 成功 |
| 4 | 保存済み入力 | A: `AMBER-731`・B: `VIOLET-482` | 両方 `expectedMarkerPresent=true` |
| 4 | 入力の混在 | 両方 `otherMarkerPresent=false` | 混在なし |
| 4 | 記憶の回答 | 両方 `messages=[]`・エラー E1 | モデルの記憶は未確認 |
| 5 | `thread/fork` | `01a1122c-232d-7e10-889f-7b7767ef2a3f` | 成功 |
| 5 | 分岐元 | `forkedFromId=01a1122b-4088-7050-a73a-f458234b1463` | A と一致 |
| 5 | 分岐の属性 | `parentThreadId=null`・`turns=2`・`ephemeral=false` | 子エージェントとは別の関係 |
| 5 | 分岐の既定モデル | `model=gpt-6.1-sol`・`reasoningEffort=null` | モデル未指定の分岐で観測 |
| 6 | 子の作成指示 | 親の応答 `status=failed`・エラー E1 | 実行不可 |
| 6 | 子一覧 | `children=[]`・エラー E2 | 子の通知と親 ID は未確認 |
| 7 | モデルと effort の変更 | 次表の全七応答で指定値と読出値が一致 | 設定反映のみ確認 |

### 各応答の設定

| スレッド | turnId | model | effort | 最終状態 |
| --- | --- | --- | --- | --- |
| B | `01a1122b-4cd6-7340-bf6f-ec9efad763f9` | `gpt-5.6-luna` | `low` | failed・E1 |
| A | `01a1122b-4cd6-7340-bf6f-eca75d5f7546` | `gpt-5.6-luna` | `low` | failed・E1 |
| A | `01a1122b-92a7-7ca1-b9f6-8560df2aa639` | `gpt-5.6-luna` | `medium` | failed・E1 |
| B | `01a1122b-d536-71c1-bb82-c126cb675c1e` | `gpt-5.6-luna` | `medium` | failed・E1 |
| A | `01a1122c-2356-7f80-a5ce-cd7e9d070944` | `gpt-5.6-luna` | `high` | failed・E1 |
| B | `01a1122c-3cfb-7632-bcb9-880d2e62738e` | `gpt-5.6-sol` | `low` | failed・E1 |
| B | `01a1122c-60de-73b1-a8d7-9399caead5ed` | `gpt-5.6-luna` | `high` | failed・E1 |

分岐でモデルを省略した場合には元の設定を継がなかったため採用時には分岐要求でもモデルを指定する。
設定の読み戻しは実行モデルを証明する情報ではないため今回の変更確認は設定の反映だけに限定する。

### 受信した通知

`thread/started`、`mcpServer/startupStatus/updated`、`thread/settings/updated`、`thread/status/changed`、`turn/started`、`item/started`、`item/completed`、`error`、`warning`、`turn/completed`、`thread/goal/cleared`

| 状態の観測 | 値 |
| --- | --- |
| 応答中 | `active`・`activeFlags=[]` |
| 接続失敗後 | `systemError` |
| 再開後 | `idle` |
| 本文 item | `userMessage` のみ |
| 承認待ち | 観測なし |
| 子スレッド通知 | 観測なし |

| model/list の対象 | supportedReasoningEfforts |
| --- | --- |
| `gpt-5.6-luna` | low・medium・high・xhigh・max |
| `gpt-5.6-sol` | low・medium・high・xhigh・max・ultra |


### エラーの全文と原因

モデルへの接続失敗は経路探索の段階で発生しており承認と記憶の回答と子の実行まで到達しなかった。
実行環境には外部通信の制限があるため今回の接続失敗だけで認証情報の不備までは判断できない。

E1 は各 turn の `turn/completed` に含まれたエラー全体。

```json
{"message":"workspace routing discovery failed","codexErrorInfo":"other","additionalDetails":null,"misalignment":null}
```

再接続時の通知は次に示す形式のまま回数の部分だけが一回目から五回目まで順番に変化していた。

```json
{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}},"additionalDetails":"workspace routing discovery failed","misalignment":null}
```

接続経路の切り替え時に届いた警告も通信失敗と同じ原因を示していたためその本文全体を次に示す。

```text
Falling back from WebSockets to HTTPS transport. workspace routing discovery failed
```

標準エラーに記録された二種類の失敗の本文全体を時刻と表示の色指定だけを取り除いて次に示す。

```text
ERROR codex_models_manager::manager: failed to refresh available models: Connection failed: error sending request
ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (https://chatgpt.com/backend-api/ps/mcp)")))
```

子の一覧が空だったことを検査する試作側の処理で生成されたエラー全文を次の E2 として示す。

```text
No child thread observed; parent turn failed
```

子一覧が空だった原因は親の応答失敗にあるため今回の結果から子スレッドの対応可否は断定できない。

### 受け入れ確認

| 検査 | 結果 |
| --- | --- |
| `test -s spikes/codex-app-server/run.mjs` | 終了コード 0 |
| `test -s docs/agents/research/2026-10-07-codex-app-server-spike.md` | 終了コード 0 |
| `grep -qxF '## 結果' docs/agents/research/2026-10-07-codex-app-server-spike.md` | 終了コード 0 |
| `grep -qxF '## 結論' docs/agents/research/2026-10-07-codex-app-server-spike.md` | 終了コード 0 |
| `node --check spikes/codex-app-server/run.mjs` | 終了コード 0 |

## 結論

単一プロセスで複数の永続スレッドを保持できた事実から常駐の土台として採用する候補にはできる。
承認とモデル応答と子の通知はまだ実証できていないため今回だけで全面採用を決める根拠にはしない。

| 用途 | 使用する API と実装方針 | 確認状況 |
| --- | --- | --- |
| 常駐接続 | app-server を子として保持し stdio で初期化 | 実測済み |
| 会話の作成 | `thread/start` に `ephemeral: false` を指定 | 二件並行で実測済み |
| 会話への入力 | `turn/start` に `threadId` と入力を指定 | 受付と失敗通知を実測済み |
| 出来事の配送 | 通知の `threadId` と `turnId` で分離 | 実測済み |
| 再起動からの復元 | 保存した ID を `thread/resume` に渡す | 保存済み入力の復元まで実測済み |
| 分岐の辺 | `thread/fork` の `forkedFromId` を使用 | 実測済み |
| 承認 | `item/commandExecution/requestApproval` へ同じ要求 ID で `decision: accept` を返す | 実装済み・受信未確認 |
| ファイル変更の承認 | `item/fileChange/requestApproval` へ同様に返す | 実装済み・受信未確認 |
| 子の辺 | 子の `parentThreadId` を使用 | 型のみ・実測未確認 |
| 子の補完 | `thread/list` の `parentThreadId` と `sourceKinds` で照合 | 空の一覧まで実測済み |
| 次の応答の設定 | `turn/start` の `model` と `effort` を毎回指定 | 設定反映のみ実測済み |
| 時間超過 | `turn/interrupt` で中断して失敗を記録 | 実装済み・時間超過未発生 |
| 終了 | stdin を閉じて専用プロセス群の残存も停止 | 実測済み |

本番の承認処理ではブラウザへ要求を転送した後に利用者の回答を同じ要求識別子で返す形を採る。
本番の保存領域は再起動をまたいで維持する必要があるため今回の一時領域を削除する処理は使わない。
再実行では同じ試作を外部通信できる環境で動かして未確認の各項目を実際の応答で確かめる必要がある。
