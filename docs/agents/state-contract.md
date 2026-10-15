# 状態と配達の定義書

2026-10-15。読み手は実装と試験を行う AI agent と、それを監督する人である。
本書は作り直しの 1 段目であり、後のすべての実装と試験の正本である。
コードの基準は main の `f5adc24` である。`file:line` はこの作業ツリーの位置を示す。
時刻は UTC で書く。
本書は定義だけを示す。コードは変えていない。
第 2 版である。外の目のレビュー `docs/agents/state-contract-review.md` の指摘 1〜12 を反映した。

## 要点

- 過去の知らせは、現在の確証にならない。確証には取った時刻と有効期限がある。
- 状態は 5 つの軸に分ける。生存、turn、依頼の結果、配達、観測の健康である。生存はプロセスの生存と実行の閉鎖に分ける。
- 画面の Done は依頼の結果にだけ結び付ける。turn の停止、不在、子の起動通知から Done を作らない。
- 不在を言えるのは、その範囲の走査が成功したときだけである。不在が言えるのは走査の範囲に限る。
- 受領の確定は、送信の操作と受信の記録を結ぶ相関証拠に限る。本文と時刻の一致は候補に留める。
- 送出は 1 つの所有者が 1 回だけ進める。再接続は送出の許可にならない。
- 照合器が外の世界と画面を突き合わせ、期限切れの値を不明に落とす。
- 受け入れは、壊し方の確認が通ることで判定する。正常な並びだけでは合格にしない。

## 用語

| 語 | 意味 |
| --- | --- |
| 証拠 | ある情報源がある時刻に取った観測の記録。値と取得時刻と有効期限と範囲を持つ |
| 有効期限 | その証拠を現在の根拠として使ってよい時刻の上限。`valid_until` と書く |
| 失効 | 現在時刻が有効期限を過ぎた状態。失効した証拠は履歴としてだけ残る |
| 走査 | 対象の範囲を網羅して読む操作。成功と失敗と部分成功を区別する |
| 不在 | 走査が成功し、その範囲に対象が見つからなかったこと |
| 照合器 | 台帳の投影と証拠と走査の結果から、現在状態の snapshot を作る処理 |
| snapshot | 照合器の出力。実体ごとの各軸の値と根拠と評価時刻と版を持つ |
| cmd_id | 画面の操作ごとに作る識別子。配達の記録の主キーになる |
| 相関 ID | 受信側が持つ識別子のうち、送信要求と結び付けられるもの |
| 所有者 | 実行のプロセスを直接持ち、送出と終了の記録を行う常駐。今は api、移行後は runner |
| 所有プロセス世代 | 所有者が起こしたプロセスの 1 回分。PID と OS の開始値の組で識別する |
| 出来事の時刻 | 原記録に書かれた時刻。`source_ts` |
| 取得時刻 | 本製品がその記録を読んだ時刻。`taken_ts` |

## 1 確かさの原則

### 1.1 過去の知らせと現在の確証

- 開始の通知を知っていることと、今も動いていることは別である。
- 状態の値には、その値を支える証拠の取得時刻と有効期限を必ず付ける。
- 期限内の証拠がない値は、現在の確証にならない。履歴としてだけ残す。
- 本番の `runs` には 29 時間前の `turn_started` だけを根拠に running を保つ行がある。これは確証ではない。

### 1.2 証拠の時刻と有効期限

- 証拠は `taken_ts` と `valid_until` を持つ。`valid_until` は情報源ごとに決める。
- 出来事の時刻と取得時刻は分ける。再読で取得時刻が進んでも、出来事は新しくならない。
- 期限の決め方は 3 節に書く。根拠のない秒数は書かない。
- 証拠を取り直すたびに `taken_ts` が進む。古い証拠は新しい証拠で置き換える。
- 証拠の取り直しに失敗したときは、前の証拠の `valid_until` を延ばさない。

### 1.3 不在の条件

- 不在を言えるのは、その範囲の走査が成功したときだけである。
- 走査の範囲は証拠に書く。範囲の外にある実体には、その不在を適用しない。
- 走査の失敗と部分成功では、既存の値を保つが、その値の有効期限は延ばさない。
- 今の実装は、この原則を一部で守っている。`packages/api/src/observe/claude/sessions.ts:17-38` は失敗で何も書かない。
- 守っていない点は、失敗後に前の running が無期限に残ることである。

### 1.4 失効から作ってはならない値

- 失効した値から、成功を作らない。
- 失効した値から、終了を作らない。
- 失効した値から、不在を作らない。
- 失効した値から作ってよいのは、不明だけである。不明には最後の証拠と理由を付ける。
- 無出力の長い処理はある。無出力だけで停止と判断しない。無出力が続けば不明にする。

### 1.5 証拠の種類と確度

- 証拠は `confirmed` と `inferred` の確度を持つ。
- 相関 ID で結んだ証拠は `confirmed` である。本文や時刻の近さで結んだ証拠は `inferred` である。
- `inferred` の証拠から、確定した値を作らない。候補として残す。
- 1 つの軸の値は、1 つの証拠から作る。別の軸の証拠を流用しない。

## 2 状態の軸

状態は 5 つの軸に分ける。軸ごとに独立した証拠を持つ。
1 つの軸の値から、別の軸の値を暗黙に導かない。
今の `RunPayload.state` は軸の混在である。移行の間は、旧い `state` を軸に写した値も snapshot に残す。

### 2.1 実行の生存

生存は 2 つに分ける。プロセスの生存と、実行の閉鎖である。
プロセスの生存は OS のプロセスについて言う。実行の閉鎖は session と thread と run について言う。

#### プロセスの生存

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `alive_confirmed` | 期限内の生存証拠がある | 所有プロセス世代の PID と OS の開始値の組が現在の表と一致した。所有者の handle が生きている | `valid_until` を過ぎる。終了証拠が来る | managed の子プロセスの handle と heartbeat。PID と OS の開始値の照合 |
| `exited_confirmed` | 物理的な終了証拠がある | 所有者が exit を受けた。PID と開始値の組が、成功した走査で現在の表と一致しなかった | 戻らない。新しい所有プロセス世代は別の実体である | `host_exit`。`process_check` の `matches = false` と `succeeded = true` |
| `unverified` | 期限内の証拠がない | 生存証拠が失効した。走査が失敗した。PID と開始値を持たない | 生存証拠か終了証拠が来る | 最後の証拠と `taken_ts` と理由 |

- 開始値は OS から取る。`sessions/*.json` の `procStart` は登録時に OS から写した値である。比較の相手は登録ファイル同士ではなく、OS の現在の値である。
- `sessions/*.json` の `startedAt` は登録時の壁時計である。開始指紋には使わない。
- PID と開始値を持たない実体は `unverified` のままである。登録の不在や開いたファイルの不在から `exited_confirmed` を作らない。
- 今の `runs.ts:31-33` の `process_check` の規則は保つ。`pid` と `start_fingerprint` の両方を要求する。
- 子は親と同じプロセスの中で動く。子のプロセスの生存は、所有プロセス世代の生存と同じ値を取る。

#### 実行の閉鎖

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `open` | 実行が閉じていない | 開始の証拠がある。閉鎖の後に同じ世代の turn の開始証拠が来た | 閉鎖の証拠が来る | `SessionStart`、`run.created`、`thread/started` |
| `closed` | 論理的に閉じた | 閉鎖の証拠がある | 同じ世代の確かな turn の開始証拠が来る。物理終了の後は戻らない | `SessionEnd`、`thread_closed`、`archived`、成功した走査でこの会話を持つプロセスの不在 |
| `unknown` | 判定できない | 証拠がない | 証拠が来る | 最後の証拠と理由 |

- 閉鎖は論理の状態である。プロセスの終了を意味しない。
- `SessionEnd` の後に同じ世代の `UserPromptSubmit` が来る実例がある。seq 301135 と 301443 である。これは論理の再開であり、`runs.ts:48-62` の規則は閉鎖の軸で保つ。
- `SessionEnd` の `reason` は 2.1.299 と 2.1.300 で `clear`、`resume`、`logout`、`prompt_input_exit`、`other` の 5 値である。本番では `other` が 1,502 件、`prompt_input_exit` が 8 件ある。欄は `payload.last_evidence.input.reason` である。
- `reason` は閉鎖の種類の証拠である。物理終了の証拠にはしない。
- 成功した走査で、この会話を持つプロセスが 1 つもないときは、閉鎖の証拠 `not_hosted` を作る。範囲は走査の範囲である。
- `not_hosted` は「今はどのプロセスもこの会話を持たない」を意味する。特定のプロセスの終了は意味しない。

### 2.2 turn の進行

会話の中で、エージェントの応答が今どの段階かを表す。
turn は自分の鮮度を持つ。プロセスの生存で turn の鮮度を更新しない。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `running` | turn の実行中 | turn の開始か進行の証拠があり、その証拠が期限内である | 完了か中断の証拠が来る。進行の証拠が失効する。プロセスの生存が `exited_confirmed` になる | hook の `UserPromptSubmit`。transcript の `turn_started`、`tool_call`、`tool_result`。Codex の `task_started` と item の通知。managed の `session_state_changed` |
| `waiting_approval` | 承認を待つ | 承認の要求があり、回答がない | 回答か中断か閉鎖が来る | `canUseTool`、`requestApproval`、`waitingOnApproval` |
| `waiting_input` | 利用者の入力を待つ | 入力待ちの通知がある | 入力が届く | Codex の `waitingOnUserInput`。managed の入力待ち通知 |
| `completed` | 直近の turn が終わった | 終了境界の証拠がある | 新しい turn の開始証拠が来る | hook の `Stop`。transcript の `Stop` と `SubagentStop` の attachment、`turn_duration` の system 行、`stop_reason` が終端の assistant 行。Codex の `task_complete`、`turn_aborted`。managed の `idle` と `result` |
| `unknown` | 判定できない | turn の証拠がない。進行の証拠が失効した。終了境界を取れない形式である。プロセスの生存が `unverified` で turn が `running` だった | 新しい turn の証拠が来る | 最後の turn の証拠と理由 |

- `running` の鮮度は、進行の証拠で更新する。進行の証拠は、道具の呼び出しと結果、Codex の item、managed の delta の確定である。
- 進行の証拠がないまま期限を過ぎたら `unknown` にする。理由は `progress_expired` である。期限は 3.2 の方法で計測して決める。
- プロセスが生きていても、turn の `running` は保証されない。CLI は応答を終えても待機する。親は子が終わっても生き続ける。
- 本文だけの assistant 行を完了にしない。`turns.ts:90-93` の規則は廃止する。2.1.299 の実物では、`stop_reason` が null の説明文の後に同じ `message.id` で道具の呼び出しが続く。
- 終了境界は、`stop_reason` が終端の値、`Stop` と `SubagentStop` の attachment、`turn_duration` の system 行から取る。取れない形式は `unknown` にする。
- 過去に保存した `turn_completed` の事実は、解釈の版の移行対象である。原記録と旧い判定を残す。
- hook と transcript が同じ turn を別の形で伝えるときは、どちらの完了証拠も有効である。片方の欠落を、もう片方で補う。
- 今の `runs.ts:106-114` は hook が running の間、transcript の完了を捨てる。この規則は廃止する。
- `completed` は過去の turn の終了である。入力を受け付けられることを保証しない。
- turn の照合の鍵は 2.7 の同一性の入力に従う。行の uuid だけを鍵にしない。

### 2.3 依頼の結果

依頼として出した仕事の結果を表す。対象は委譲、managed の実行、Claude の子、タスクグラフの節である。
結果は段階と判定の組で持つ。段階は依頼の種類ごとに必要な到達点を決める。

#### 段階

| 段階 | 意味 | 根拠となる証拠 |
| --- | --- | --- |
| `launched` | 起動を受理した | 親の `Agent` の `tool_result` で `status = async_launched`。受付の `accepted`。`spawnAgent` の item |
| `responded` | 最終の応答を作った | `final_answer` の確定。`result` の受信。子の `SubagentStop` |
| `reported` | 報告を親へ渡した | 子の `SubagentHandback` の呼び出しと、対応する `tool_result` の `toolUseResult.success = true` |
| `verified` | 受け入れ検証に合格した | 受付の検証の結果 |
| `reviewed` | レビューに合格した | レビューの結果 |

- 依頼の種類ごとに、成功に必要な段階を決める。子は `reported`、受け入れ条件のある委譲は `verified`、レビューを含む委譲は `reviewed` である。
- `SubagentHandback` の呼び出しだけでは `reported` にしない。呼び出しの行と結果の行は別の事実である。`A535:190` と `:192` が実物である。
- `async_launched` は起動の受理である。完了の証拠にしない。

#### 判定

| 値 | 意味 | 入る条件 | 出る条件 |
| --- | --- | --- | --- |
| `incomplete` | 必要な段階に達していない | 依頼が受理された | 段階が進む |
| `succeeded` | 必要な段階に達した | その依頼に必要な段階の証拠が揃った | 新しい試行の開始。利用者の訂正 |
| `failed` | 必要な段階で失敗した | 検証かレビューの不合格。最終の応答が `is_error` | 新しい試行の開始。利用者の訂正 |
| `interrupted` | 中断された | 中断の要求と対応する終了がある | 新しい試行の開始 |
| `unknown` | 判定できない | 必要な段階の証拠がないまま、プロセスの生存が `exited_confirmed` か `unverified` になった | 証拠が来る |

- `is_error` は道具の失敗と最終の失敗を区別する。道具の `tool_result` の `is_error` は結果の証拠にしない。
- 新しい試行は過去の結果を消さない。試行ごとに結果を持つ。
- 子の結果で親の turn を変えない。親の turn は親の証拠から決める。
- 対話の会話には依頼の結果を付けない。対話の会話は Done にならない。
- Claude の子の `idle` を Done に読み替える `packages/dashboard/app/src/lib/roots.ts:249` は廃止する。

### 2.4 入力の配達

画面から送った入力が、受信側に届いたかを表す。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `accepted` | 送信要求を記録した | 所有者が `cmd_id` と対象を永続化した | 所有者が送出を始める。所有者が送出前に止める | 配達の記録の行 |
| `emitting` | 送出を始めた | 最初の端末への書き込みか SDK の呼び出しの直前に記録した | 送出が終わる。所有者が止まる | 送出の開始時刻 |
| `emitted` | 送出を終えた | Enter の書き込みか SDK の呼び出しが返った | 受信の証拠が来る。期限を過ぎる | 送出の完了時刻と対象の版 |
| `received` | 受信側の相関証拠がある | 相関 ID が送信要求と結び付いた | 変わらない | 受信側の相関 ID。`peer_message_status` の `delivered` |
| `received_candidate` | 受信の候補がある | 相関 ID はないが、範囲内に一致する受信の記録が 1 件ある | 相関証拠が来る。候補が増える | 一致した記録と、照合の範囲と確度 |
| `terminal_handled` | 端末が処理した | 画面の読み取りで、コマンドの結果か選択欄を確認した | 変わらない | 画面の差分。確度は `inferred` |
| `rejected` | 送らなかった | 最初の端末への書き込みより前に止めた | 利用者が新しい操作を出す | 止めた理由 |
| `unverifiable` | 確認できない | `emitting` か `emitted` のまま期限を過ぎた。所有者が送出の途中で止まった | 相関証拠か候補が後から来る | 送出の記録と、照合の範囲と期限 |

- `received` は相関証拠だけから作る。本文と時刻の一致からは作らない。
- `received_candidate` は確定ではない。画面には候補として出す。
- `rejected` だけが「届いていない」を意味する。端末に 1 文字も書いていないからである。
- `emitting` の途中で止めた操作は `unverifiable` にする。理由は `aborted_after_write` である。Ctrl-U と貼り付けの後で止めた場合がこれに当たる。
- `unverifiable` は「届いていない」ではない。「この照合器が確認できなかった」である。
- 今の `api_send_watches` の `closed` は `received_candidate` に写す。旧い照合は本文の一致だけだからである。`failed` は `unverifiable` に写す。
- `retried` は配達の値ではない。Resend は新しい `cmd_id` の操作であり、元の操作との関係 `retry_of` を持つ。
- 配達の記録は台帳の rebuild の対象ではない。独立した表として保ち、`cmd_id` で引ける形にする。

### 2.5 観測の健康状態

情報源と走査の範囲の組ごとに、観測が今どの程度信じられるかを表す。
走査の成否と、内容の競合は別に持つ。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `healthy` | 直近の走査が成功した | 走査が成功し、遅れが許容内である | 走査が失敗する。遅れが許容を超える | 走査の完了時刻と結果 |
| `delayed` | 走査は続いているが遅い | 最後の成功から許容を超えた。再解釈が途中である | 成功する。失敗する。再解釈が終わる | 最後の成功時刻 |
| `failed` | 直近の走査が失敗した | 走査が例外か部分成功で終わった | 成功する | 失敗の理由と時刻 |
| `out_of_scope` | この範囲の対象外 | 走査の範囲に含まれない実体を見ている | 範囲に含める | 範囲の定義 |

- 観測が `failed` か `delayed` の間、その範囲に依存する生存証拠の有効期限は延びない。
- 観測が `failed` のとき、既存の値は保つ。値の横に観測の失敗を出す。
- 内容の競合は `conflicts` として別に持つ。走査の成功で競合は消えない。解決の証拠があるときだけ消える。
- 競合の記録は、原記録の位置、拒否した事実の識別、双方の値、解釈の版を持つ。今の seq 301024 は件数と理由だけである。
- 観測の健康状態は snapshot の版の一部として配信する。投影 seq だけでは足りない。
- 今の実装には、止まった情報源を知らせる仕組みがない。`incident-review.md` の I4 と I14 がその結果である。

### 2.6 軸の間の規則

| 規則 | 内容 |
| --- | --- |
| プロセスの生存から turn へ | 生存が `exited_confirmed` なら、turn の `running` と `waiting_*` は `unknown` に落ちる。`completed` は保つ |
| プロセスの生存から turn へ | 生存が `unverified` でも turn は自分の鮮度で決める。生存が `alive_confirmed` でも turn の鮮度は延びない |
| 閉鎖から turn へ | 閉鎖が `closed` でも、同じ世代の turn の開始証拠があれば `open` に戻す。閉鎖から turn の完了を作らない |
| 生存から結果へ | 生存が `exited_confirmed` で必要な段階に達していなければ、結果は `unknown` にする。`succeeded` にしない |
| turn から結果へ | 導かない。`completed` は結果の証拠ではない |
| 結果から turn へ | 導かない。子の結果で親の turn を変えない |
| 配達から turn へ | `received` と `received_candidate` は turn の開始の候補になる。`emitted` と `unverifiable` はならない |
| 観測から生存へ | 観測が `failed` なら、その範囲の生存証拠は失効を早めない。延ばしもしない |
| 親から子へ | 子のプロセスの生存は親の所有プロセス世代と同じ。子の turn と結果は子の証拠で決める |

### 2.7 同一性の入力

本書は同一性の設計を決めない。同一性の設計は `identity-redesign.md` を正本にする。
ただし本書の規則は、次の入力がなければ実装できない。これらを必須の入力として参照する。

| 入力 | 内容 | 未解決のときの扱い |
| --- | --- | --- |
| 会話の対応表 | provider と native ID を安定 ID に結ぶ表。別名を持つ。版を持つ | 会話を `unresolved` にする |
| run の対応表 | 情報源ごとの run を 1 つの実行の区間に結ぶ表。版を持つ | 複数の run を 1 つに見せない。`unresolved` にする |
| 所有プロセス世代 | run とプロセスの PID と OS の開始値の組 | プロセスの生存は `unverified` |
| turn の鍵 | 応答の `message.id` と、行の uuid の連なりと、hook の prompt ID の組 | 同じ turn の照合をしない。後着の完了証拠で別の turn を閉じない |
| request と attempt の鍵 | 受付の `requestId` と試行の番号 | 結果を付けない |

- 対応表の版は snapshot の版に含める。
- `unresolved` の実体は、確定した単一の実行として表示しない。
- 情報源を横断して、世代の数値の大小で新旧を決めない。
- 旧い turn の完了証拠が、新しい turn の開始の後に届いても、新しい turn を閉じない。

## 3 情報源ごとの証拠と有効期限

### 3.1 証拠の形

すべての証拠は次の形で保存する。

```text
evidence {
  subject        対象の実体。会話か実行か情報源
  axis           生存、閉鎖、turn、結果、配達、観測のどれか
  value          軸の値
  source         情報源
  kind           証拠の種類。process_check、heartbeat、hook_event など
  confidence     confirmed か inferred
  event_ts       出来事の時刻。原記録の時刻。null は走査
  taken_ts       取得した時刻
  valid_until    有効期限。null は失効しない
  scope          走査の範囲。null は走査でない
  scan_ok        走査が成功したか。走査でなければ null
  ref            元の記録への参照。fact_id、ファイルと位置、cmd_id
}
```

- `valid_until` が null の証拠は、過去の事実である。完了や終了の証拠がこれに当たる。
- `valid_until` を持つ証拠は、現在の状態の根拠である。生存と turn の進行と配達の `emitted` がこれに当たる。
- 期限は `taken_ts + 間隔 × 係数` で決める。間隔は情報源の取得周期、係数は計測で決める。

### 3.2 計測の方法

根拠のない秒数は書かない。計測して決める値は、次の方法で決める。
計測の目標は、誤った確信を減らすことである。期限を延ばすだけでは目標に届かない。

1. 隔離した環境で、偽 CLI の状態を正解にする。製品の投影を正解にしない。
2. 情報源の更新の間隔、走査の成功の間隔、対象の進行の間隔を別々に採取する。
3. 停止、遅延、欠測、時計のずれを注入した標本を混ぜる。更新が止まった標本は、完了した間隔の分布に入らない。
4. 候補の期限ごとに、誤った Working と Delivered の最大継続時間と、不要な Unknown の割合を測る。
5. 両方が許容内になる期限を選ぶ。許容は利用者と決める。
6. 本番の読み取り専用の台帳で、選んだ期限で過去 1 週間を再評価し、結果を記録する。
7. 決めた値と採取の記録を、本書のこの節に追記する。計測していない経路は「保証未確定」と明記する。

### 3.3 情報源の表

| 情報源 | 出せる証拠 | 今の取得周期 | 有効期限の決め方 | 今の実装の位置 |
| --- | --- | --- | --- | --- |
| managed の runner | 子プロセスの handle、PID、終了コード、`session_state_changed`、承認、結果、送信の相関 ID | 出来事ごと。heartbeat はない | heartbeat を新設する。間隔と係数は計測して決める。保証未確定 | `packages/runner/src/supervisor.ts:125-145`、`recovery.ts:69` |
| ブラウザから起こした端末 | PTY の pid と OS の開始値、`onExit`、画面の内容、`sessions/<pid>.json` の sessionId | 500 ms の発見周期。`hosts.ts:20` | PTY の生存は所有者が直接知る。所有者が api の間は api の寿命が上限 | `packages/api/src/terminal/hosts.ts:161-224`、`292-298`、`354` |
| 外で動く Claude の会話 | jsonl の行、`sessions/*.json` の PID と `procStart` | ファイルの変更検知と 1 秒の観測周期。`service/index.ts:43` | プロセスの生存は PID と OS の開始値の走査で決める。走査の周期は 1 分。`sessions.ts:44`。期限は走査周期の係数倍。保証未確定 | `packages/api/src/observe/claude/sessions.ts`、`context.ts` |
| Claude の子 | `subagents/*.jsonl` の行、`SubagentStop`、`SubagentHandback` の呼び出しと結果、親の `Agent` の `tool_result` | 親と同じ | プロセスの生存は親の所有プロセス世代に従う。turn は子の行の進行で決め、期限は親と同じ | `packages/api/src/observe/session-query.ts:28` は子を走査から除く |
| Codex | rollout の行、`ps` と `lsof` の走査、`thread/status/changed` | 走査は 30 秒。`codex/sessions.ts:7`。最後の記録から 2 分の猶予。`:8`、`:122` | 閉鎖の `not_hosted` は走査の成功した周期で決める。プロセスの生存は PID を持つ managed だけ。期限は計測して決める。保証未確定 | `packages/api/src/observe/codex/sessions.ts:44-81`、`119-132` |
| hook | `SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd` と `reason`、世代、prompt ID | 出来事ごと。送信は 500 ms、再送の予算は 1 秒。`hook-v2/index.ts:7-8` | 失効しない。過去の事実である。生存の根拠にはしない | `packages/api/src/hook/index.ts:40-77` |
| transcript | 行の種類と時刻、`message.id`、`stop_reason`、attachment の `hookEvent`、`turn_duration`、`compact_boundary`、`continued-in` | ファイルの変更検知 | 失効しない。turn の根拠にする。進行の鮮度は行の出来事の時刻で決める | `packages/core/src/ledger/turns.ts:53-95`、`observe/claude/context.ts:114-141` |
| `sessions/*.json` | `pid`、`procStart`、`sessionId`、`cwd`、`status`、`updatedAt`、`kind`、`messagingSocketPath`、`peerFeatures` | 1 秒の観測周期で読む | `kill(pid, 0)` と OS の開始値の一致で生存。走査は全ファイルの成功を要求する。`status` と `updatedAt` は出来事ごとの更新であり、期限を持たせない | `sessions.ts:17-38` |

### 3.4 情報源ごとの注意

#### managed の runner

- runner は起動時に `pid` を書く。`supervisor.ts:137`。heartbeat は書かない。
- 再起動時は `markUnknown("restart")` で全実行を `unknown` にする。`supervisor.ts:58-64`。この規則は保つ。
- heartbeat を新設する。runner が所有プロセス世代ごとに `taken_ts` を更新する。台帳の事実にはせず、証拠の表に書く。
- 子プロセスの終了は `host_exit` で物理終了になる。`supervisor.ts:200-204`。この規則は保つ。
- `send` は今は戻り値がない。`packages/runner/src/hosts/claude/index.ts:158`、`hosts/codex/index.ts:164`。送信ごとに相関 ID を作り、`cmd_id` との対応を永続化し、受信側の応答と結ぶ。
- Codex は `turn/start` の応答の turn ID を相関 ID にする。Claude の SDK で入力の ID が応答に返るかは要確認である。返らなければ、その経路は `received_candidate` までである。

#### ブラウザから起こした端末

- 今は api が PTY を所有する。api の `close` は PTY を kill する。`hosts.ts:354`。
- PTY の `onExit` は listener に通知するだけで、台帳に終了を残さない。`hosts.ts:292-298`。
- 所有を runner へ移す。これは本書の受け入れの前提である。移るまで 8 節の `14-api-restart-keeps-pty` は通らず、受け入れは合格にならない。
- 移るまでの間は、api の停止を「プロセスの生存 `unverified`、理由 `owner_restarted`」として扱う。終了と結果の事実は保つ。
- 端末の sessionId は `sessions/<pid>.json` から読む。`hosts.ts:161-171`。`/clear` で変わる。
- 端末の画面は送出の可否と `terminal_handled` の根拠にする。`received` の根拠にはしない。
- `hosts.ts:118` の拒否判定は、`:111` の Ctrl-U と `:115` の貼り付けより後にある。この位置で止めた操作は `rejected` ではなく `unverifiable` である。

#### 外で動く Claude の会話

- プロセスの生存は PID と OS の開始値の走査で決める。登録に PID があり、OS に同じ組があれば `alive_confirmed` である。
- 走査が成功し、登録の PID が OS にないときは、その所有プロセス世代は `exited_confirmed` である。登録自体がない会話は `not_hosted` の閉鎖の証拠にする。
- 今の `sessions.ts:55-58` は不在を `idle` と書く。これを「閉鎖 `not_hosted`、turn は変えない」に改める。
- `sessions/*.json` の `status` は出来事のときに更新される。実行ファイルの読解で、状態の変化と名前と socket の更新で `updatedAt` が変わると確かめられている。固定周期の heartbeat ではない。
- `status` の値は `busy`、`waiting`、`idle`、`shell` を見た。新しい値を生存の証拠にしない。古い値を終了の証拠にしない。
- `kind = bg` は対話と委譲を一意に分ける仕様とは確認できていない。単独で結果の適用対象を決めない。

#### Claude の子

- 子は `subagents/<agent id>.jsonl` に記録される。`sessionId` は親を指す。
- 親の `Agent` の `tool_use` と `tool_result` を `tool_use_id` で結ぶ。`tool_result` の行のトップレベルの `toolUseResult.agentId` が子の ID である。`tool_result` ブロックの中の欄ではない。
- `toolUseResult.status = async_launched` と `isAsync = true` は起動の受理である。結果の段階は `launched` になる。完了にしない。
- 子の turn の完了は、子の行の `SubagentStop` の attachment と、`SubagentHandback` の呼び出しの `tool_result` で決める。親の `tool_result` から子の完了を作らない。
- 同期の `Agent` の `tool_result` が結果を含む形式は要確認である。確認できるまで、その形式の子の結果は `unknown` にする。
- 子のプロセスの生存は親の所有プロセス世代に従う。子の turn の鮮度は子の行で決める。
- 親が `exited_confirmed` で子に必要な段階の証拠がなければ、子の結果は `unknown` である。

#### Codex

- 走査は `ps` と `lsof` で、codex プロセスが開く rollout を集める。`sessions.ts:44-81`。
- 走査の部分成功は例外で捨てる。`:79`。この規則は保つ。
- 今は不在を `idle` と書く。`:126-129`。これを「閉鎖 `not_hosted`」に改め、turn は最後の turn の証拠のままにする。
- 開いたファイルの不在は、特定のプロセスの終了を意味しない。プロセスの生存は PID と開始値を持つ managed だけで決める。
- 2 分の猶予は、最後の記録時刻と最後の証拠時刻の大きい方から数える。`:122`。作成時刻からではない。値の妥当性は未確認であり、3.2 で計測して決め直す。

#### hook

- hook は出来事のときだけ動く。生存の根拠にしない。
- 世代は outbox のファイルで決める。`hook-v2/index.ts:59-88`。`startup` と `resume` で新しくなる。
- 会話 ID は `claude:<id>` の形で書く。`hook/index.ts:40`。これは同一性の課題であり、2.7 の対応表で結ぶ。
- `SessionEnd` は同じ世代の閉鎖になる。その後の同じ世代の turn の開始で、閉鎖を `open` に戻す。`runs.ts:48-62` の規則は保つ。
- `UserPromptSubmit` の prompt ID は turn の鍵の一部である。

#### transcript

- 行の読み替えは `turns.ts:53-95` の規則に従う。版は `TURN_RULE_VERSION = 3` である。
- `turns.ts:90-93` の「本文だけの行を完了にする」規則は廃止する。版を上げる。
- 同じ状態が続く行から新しい事実を作らない。`context.ts:134`。進行の鮮度は、事実ではなく証拠の表で更新する。
- `isMeta`、`isCompactSummary`、`<bash-input>` などの行は turn の根拠にしない。`turns.ts:36`、`claude-message-flags.ts`。
- transcript の `run.created` は hook がないときだけ作る。`context.ts:116-124`。hook の後着で別の run が残る問題は 2.7 の run の対応表で結ぶ。
- message の解釈の訂正は、turn の解釈の版とは別の版を持つ。E4 が実例である。

#### `sessions/*.json`

- 1 件でも読めないか壊れていれば、その周期の走査は失敗である。`sessions.ts:27-28`、`:35`、`:38`。
- 失敗した周期では不在を書かない。この規則は保つ。
- 失敗した周期では、観測の健康状態を `failed` にする。これを新設する。
- `kill(pid, 0)` の `EPERM` は生存とも不在とも判定しない。`:35`。この規則は保つ。
- `messagingSocketPath` の peer protocol には `peer_message_status` と `orig_msg_id` による返答がある。値は `held`、`denied`、`expired`、`delivered`、`refused`、`dropped` である。
- 任意の入力に必ず受領の返答が返ること、重複を排除すること、PTY の代替になることは未確認である。確認できるまで、この経路を相関 ID の手段にしない。

## 4 画面の言葉

### 4.1 代表の状態と結果の印

行には代表の状態を 1 つ出す。依頼の種類の実体には、結果の印を別に 1 つ添える。
代表の状態は生存と閉鎖と turn から決める。結果の印は依頼の結果から決める。
過去の成功と現在の生存は併記できる。混ぜない。

### 4.2 代表の状態の決め方

次の順で最初に当たった行を使う。順を飛ばさない。

| 順 | 条件 | 画面の言葉 | 添える情報 |
| --- | --- | --- | --- |
| 1 | 同一性が `unresolved` | Unresolved | 候補の run の数 |
| 2 | プロセスの生存が `exited_confirmed` | Stopped | 終了の根拠の種類 |
| 3 | 閉鎖が `closed` で生存が `alive_confirmed` でない | Closed | 閉鎖の根拠の種類 |
| 4 | プロセスの生存が `unverified` で turn が `completed` でない | Unknown | 最後の証拠の時刻と理由 |
| 5 | turn が `waiting_approval` | Needs approval | 待ち始めからの時間 |
| 6 | turn が `waiting_input` | Waiting | 待ち始めからの時間 |
| 7 | turn が `running` | Working | 開始からの時間と最後の進行の時刻 |
| 8 | turn が `completed` で生存が `alive_confirmed` | Idle | なし |
| 9 | turn が `completed` で生存が `unverified` | Idle | 「last seen」と最後の生存証拠の時刻 |
| 10 | turn が `unknown` | Unknown | 最後の証拠の時刻と理由 |

- この表はすべての組を 1 つの行に写す。該当しない組があれば、それは軸の値の誤りである。
- 順 9 の Idle には必ず「last seen」を添える。生存の確証がないからである。
- Stopped と Closed は Done ではない。
- 今の `packages/dashboard/app/src/lib/i18n.ts:14-15` は `ended` を Done に写す。これを Stopped か Closed に改める。

### 4.3 結果の印

| 判定 | 画面の言葉 | 添える情報 |
| --- | --- | --- |
| `succeeded` | Done | 達した段階 |
| `failed` | Failed | 失敗した段階と原因 |
| `interrupted` | Interrupted | なし |
| `incomplete` | 印なし | 達した段階を詳細に出す |
| `unknown` | No result | 最後の証拠の時刻 |

- Done は `succeeded` からだけ出す。他の値からは出さない。
- 対話の会話には結果の印を出さない。
- 子と委譲とタスクの節は、代表の状態と結果の印の両方を出す。例は「Idle · Done」と「Unknown · No result」である。
- 成功した旧い試行と実行中の新しい試行は、試行ごとに出す。行の代表は最新の試行である。

### 4.4 不明の見せ方

- Unknown と Unresolved は灰色の破線で出す。色だけに頼らない。
- Unknown には必ず「last seen」と最後の証拠の時刻を添える。例は「Unknown · last seen 29h ago · progress expired」である。
- 理由は定義済みの語彙から選ぶ。`liveness_expired`、`progress_expired`、`scan_failed`、`out_of_scope`、`owner_restarted`、`parent_exited`、`parent_unverified`、`missing_evidence`、`boundary_unavailable`、`reinterpretation_pending`、`identity_unresolved` である。
- 観測が `failed` か `delayed` の範囲があるときは、画面の上に 1 行で出す。例は「Observation of Claude sessions failed since 14:02」である。
- 未解決の競合がある会話には、見出しに「History conflict · unresolved」を出す。
- 画面が切断しているか、受け取った版が古いときは、「as of 14:02」と出す。現在の状態だと誤認させない。
- Unknown を Idle や Done に丸めない。Unknown の件数を一覧に出す。

### 4.5 配達の言葉

| 画面の言葉 | 配達の値 | 見せ方 |
| --- | --- | --- |
| Sending | `accepted`、`emitting`、`emitted` | 吹き出しの横に出す。上限は受信か期限まで |
| Queued | `received` か `received_candidate` で、その入力が未吸収のキューにある | 吹き出しの横に出す。`queued_command` の記録と、対応する user 行の不在を根拠にする |
| Delivered | `received` | 印を出さない。通知もしない |
| Likely delivered | `received_candidate` | 薄い印を出す。詳細に候補の根拠を出す |
| Handled in terminal | `terminal_handled` | 端末の結果を一時表示する |
| Not delivered | `rejected` | 警告と理由を出す。Resend を出す |
| Unconfirmed | `unverifiable` | 注意と範囲を出す。Resend は出すが、二重になり得ると明記する |

- Not delivered は `rejected` にだけ使う。`unverifiable` と `received_candidate` に使わない。
- 今の `Message.tsx:113` は `failed` を Not delivered と出す。これを Unconfirmed に改める。
- Queued は、その入力自身がキューにあることを要求する。turn が `running` なだけでは Queued にしない。

## 5 配達の契約

### 5.1 所有者と一回性

- 送出は所有者だけが行う。所有者は今は api、移行後は runner である。
- 所有者は `cmd_id` ごとに、`accepted` から `emitting` へ 1 回だけ進める。並行する同じ `cmd_id` は 1 つにまとめる。
- 同じ `cmd_id` で本文か対象が違う要求は、配達の値を作らず誤りの ack を返す。理由は `cmd_id_conflict` である。
- 配達の記録には保持期間を置く。期間を過ぎた `cmd_id` の再送は送出せず、誤りの ack を返す。理由は `record_expired` である。
- 今の `ws/index.ts:224-247` はメモリ上の `sessionCommands` で抑止する。`send-watch.ts:82-101` は送出の後に記録する。どちらも改める。

### 5.2 送信の前の記録

1. 画面は操作ごとに `cmd_id` を作る。再送でも同じ値を使う。
2. 所有者は副作用の前に、`cmd_id`、対象の会話 ID、対象の実行の世代、端末 ID か所有プロセス世代、本文のハッシュ、添付の一覧、受付時刻を永続化する。値は `accepted` である。
3. 永続化が成功してから送出に進む。永続化に失敗したら送出せず、失敗の ack を返す。
4. 所有者は最初の端末への書き込みか SDK の呼び出しの直前に `emitting` を記録する。
5. 対象の確認は `emitting` の記録と同じ時点で行う。確認から最初の書き込みまでの間に、起動待ちと添付の処理を挟まない。
6. Enter の書き込みか SDK の呼び出しが返ったら `emitted` を記録する。

### 5.3 対象の確認と拒否

- `emitting` の直前に、対象の会話 ID と端末の sessionId が一致することを確かめる。`hosts.ts:93-95` の規則は保つ。
- 対象の実行の世代が、記録した世代と違えば `rejected` にする。理由は `target_changed` である。
- 画面が塞がれていれば `rejected` にする。理由は `terminal_blocked` である。この確認は最初の書き込みより前に行う。
- `rejected` は最初の書き込みより前に止めた操作だけである。書き込みの後の中止は `unverifiable` にする。
- `rejected` は下書きを保つ。画面は本文を消さない。

### 5.4 受信側の証拠の優先

受信の証拠は、強い順に次を使う。上の証拠があれば下は使わない。

| 順 | 証拠 | 得られる経路 | 値 | 確度 |
| --- | --- | --- | --- | --- |
| 1 | 受信側の相関 ID | Codex の `turn/start` の turn ID。SDK で入力の ID が返る経路。peer protocol の `delivered` | `received` | `confirmed` |
| 2 | 範囲内の唯一の候補 | 対象の会話の記録に、送出の開始より後の出来事の時刻で、正規化した本文が一致する受信の記録が 1 件だけある | `received_candidate` | `inferred` |
| 3 | 端末の画面の結果 | スラッシュコマンドの結果か選択欄を画面で確認した | `terminal_handled` | `inferred` |
| 4 | 端末の画面の反応 | 入力欄が空になり、応答の描画が始まった | `emitted` の補強 | `inferred` |

- 候補が 2 件以上なら `unverifiable` にする。どれが自分の送信か決められないからである。
- 候補が 1 件でも `received` にしない。本製品の送信が失われ、外から同じ文が 1 回入った世界と、届いた世界は同じ観測だからである。
- `queued_command` の attachment、`<bash-input>` の行、`<command-name>` の行は、入力の種類の印である。本製品の送信の印ではない。順 2 の候補として扱う。
- 本文の一致は、送出の開始より前の出来事の時刻の行を候補にしない。今の `send-watch.ts:175` は `seq` を境界にする。これを出来事の時刻に改める。
- 時刻の比較は候補の範囲を絞るためだけに使う。相関の代わりにしない。所有者の時計と CLI の時計は同じ計算機だが、ずれの許容を 3.2 で計測する。
- PTY の Claude には相関 ID がない。この経路の上限は `received_candidate` である。

### 5.5 確認不能の扱い

- 期限内に受信の証拠がなければ `unverifiable` にする。「未着」と断定しない。
- 期限は、turn が `completed` なら送出の完了からの一定時間とする。今の値は 60 秒である。`send-watch.ts:8`。根拠のある計測はなく、3.2 で決める。
- turn が `running` なら、その入力自身が `queued_command` に現れるまで待つ。`send-watch.ts:200-205` の規則は保つ。待ちの上限は 24 時間である。`:194`。
- turn が `unknown` に落ちたら、その時点から `completed` と同じ期限を数える。
- 所有者が `emitting` か `emitted` のまま止まった場合は、再起動後に `unverifiable` にする。理由は `owner_restarted` である。
- 所有者が `accepted` のまま止まった場合は、再起動後に `rejected` にする。理由は `not_emitted` である。端末に書いていないからである。
- `unverifiable` の後に相関証拠が来たら `received` に直す。候補が来たら `received_candidate` に直す。今の `send-watch.ts:187-192` の規則は、確度を付けて保つ。

### 5.6 自動で再送しない

- 所有者は自動で再送しない。api も runner も再送しない。
- 画面の再接続時に `cmd_id` を送り直すのは、ack を取り直すためである。記録があれば所有者は記録の値を返す。送出しない。
- 記録がない `cmd_id` だけを新しい操作として扱う。
- 利用者の Resend は新しい `cmd_id` を作る。元の操作との関係 `retry_of` を記録する。元の値は変えない。
- `unverifiable` と `received_candidate` の Resend には「届いていた場合は二重になる」と表示する。

### 5.7 入力の種類ごとの扱い

| 入力 | 送出の形 | 受信の証拠 | 配達の上限 | turn への影響 |
| --- | --- | --- | --- | --- |
| 普通の発言 | 貼り付けと Enter | 5.4 の順 | PTY は `received_candidate`。相関 ID のある経路は `received` | 候補か確定で turn の開始の候補になる |
| 作業中の発言 | 貼り付けと Enter | `queued_command` の attachment の候補 | `received_candidate`。画面は Queued | turn は変えない。吸収で user 行が出る |
| `!` の命令 | 貼り付けと Enter | `<bash-input>` の行の候補。先頭の `!` とタグを除いて比べる | `received_candidate` | turn の開始にしない。`turns.ts:36` の規則は保つ |
| `/compact` | 貼り付けと Enter | `<command-name>` の行の候補 | `received_candidate` | turn の開始にしない |
| 他のスラッシュコマンド | 貼り付けと Enter と画面の読み取り | 端末の画面の結果 | `terminal_handled` | 変えない。`/clear` は対象を変える |
| 選択画面を開くコマンド | 貼り付けと Enter | 画面に選択欄が出た | `terminal_handled`。`status = interactive` | 変えない。端末タブへ引き継ぐ |
| 同じ文を別の端末から打った | 本製品は送出していない | 候補が増えるか、本製品の候補と区別できない | 本製品の送信は `received_candidate` か `unverifiable` | その行は turn の開始の候補になる |

- 同じ文が別の端末から入った場合、本製品の送信の候補と区別できない。確定にしない。
- 同じ文を 2 回続けて送った場合、PTY では 2 件の候補が 2 つの `cmd_id` に一意に結べない。相関 ID のある経路だけが両方を `received` にできる。
- `!` の命令の照合は、今の `normalizeSentBody` では一致しない。`send-watch.ts:34-39`。`<bash-input>` の正規化を足す。

## 6 照合器の振る舞い

### 6.1 役割

- 照合器は、台帳の投影と証拠の表と走査の結果と配達の記録から、現在状態の snapshot を作る。
- 照合器は台帳の事実を書き換えない。走査の結果は観測の事実として追記する。
- 照合器の派生した値は snapshot にだけ置く。rebuild では証拠の表と評価時刻から作り直す。
- 照合器は api に置く。managed の生存証拠は runner が書き、照合器はそれを読む。

### 6.2 snapshot の版

snapshot は評価時刻と版を持つ。版は派生した状態の全体を一意にする。

| 版の構成 | 内容 |
| --- | --- |
| `projection_seq` | 投影が反映した台帳の seq |
| `evidence_epoch` | 証拠の表の更新の通し番号 |
| `observation_checkpoint` | 情報源と範囲ごとの走査の到達点 |
| `identity_version` | 2.7 の対応表の版 |
| `interpretation_version` | turn と message の解釈の版 |
| `delivery_epoch` | 配達の記録の更新の通し番号 |
| `evaluated_ts` | 照合器が評価した時刻 |
| `version` | 上のどれかが変わるたびに増える通し番号 |

- 期限切れだけで状態が変わったときも `version` を進め、patch を出す。
- 画面は `version` の大小で新旧を決める。古い版の patch は捨てる。
- `/snapshot` と `/conversation` は `version` を返す。`/conversation` は `version` の指定を受け、指定した版を返せなければ 409 を返す。画面は 409 で snapshot を取り直す。
- 1 つの応答の中の値は、すべて同じ `version` から作る。

### 6.3 いつ動くか

| 契機 | 動き |
| --- | --- |
| 周期 | 1 秒ごとに全実体の有効期限を見る。期限切れを `unverified` と `unknown` に落とす。周期は `OBSERVATION_POLL_MS` と同じにする |
| 事実の追記 | 追記された実体の軸を再計算する |
| 走査の完了 | 走査の範囲にある実体の生存と閉鎖を更新する。失敗なら観測の健康状態だけ更新する |
| 配達の記録の更新 | `cmd_id` の記録を更新する。受信の証拠を探す |
| 対応表の更新 | 影響する実体を再計算する。`identity_version` を進める |
| 解釈の版の有効化 | 範囲の再読が終わった実体を新しい版で再計算する |
| 画面の接続 | 最新の snapshot の版を返す |
| api の起動 | 失効する生存証拠だけを `unverified` にする。理由は `owner_restarted`。終了と結果と閉鎖の事実は保つ |

### 6.4 どう直すか

| 画面の値 | 外の世界の今 | 直し方 |
| --- | --- | --- |
| Working | 進行の証拠が失効した | Unknown にする。理由 `progress_expired`。turn の履歴は残す |
| Working | 生存証拠が失効した | Unknown にする。理由 `liveness_expired` |
| Working | 走査が成功し、PID と OS の開始値が不在 | Stopped にする。根拠は `process_check` |
| Working | 親が終了確認済みの子 | Unknown にする。理由 `parent_exited`。結果は `unknown` |
| Working | 親が生きていて、子の進行の証拠が失効した | Unknown にする。理由 `progress_expired`。親の生存で延ばさない |
| Closed | 同じ世代の新しい turn の開始証拠が来た | Working に戻す。`runs.ts:48-62` の規則に従う |
| Stopped | 同じ所有プロセス世代の新しい証拠が来た | 戻さない。別の所有プロセス世代として扱う |
| Idle | 生存証拠が失効した | Idle のまま「last seen」を添える |
| Done | 必要な段階の証拠がない | Done を出さない。結果の印は印なしか No result |
| 単一の実行 | 対応表が未解決になった | Unresolved にする。候補の run を並べる |
| Not delivered | 受信の候補か相関証拠が後から来た | Likely delivered か Delivered に直す |
| Unconfirmed | 受信の候補か相関証拠が後から来た | Likely delivered か Delivered に直す |
| 最新の表示 | 観測が遅れている | 「Observation delayed」を出す。最新と言わない |
| 現在の表示 | 画面が切断した | 「as of」と最後の版の時刻を出す |

### 6.5 解釈の版の移行

- 解釈の版を上げるときは、新しい版の事実を準備中の版に蓄える。
- 対象の範囲の再読が終わるまで、その範囲の実体は旧い版で表示し、観測の健康状態を `delayed` にする。理由は `reinterpretation_pending` である。
- 範囲の再読が終わったら、一括で新しい版を有効にする。`interpretation_version` を進める。
- 再読が中断したら、再開後に続きから読む。中断の時点を記録する。
- 部分的に失敗した範囲は、旧い版のまま `delayed` を保つ。
- 原記録が欠けた範囲は、旧い版を保ち、理由に `source_missing` を書く。
- turn の解釈と message の解釈は別の版を持つ。E4 は message の解釈の訂正である。
- 今の `runs.ts:79-93` は subject ごとの最大の版を選ぶ。範囲の完了を待たないため、一括の有効化に置き換える。

### 6.6 競合の扱い

- 競合は、原記録の位置、拒否した事実の識別、双方の値、解釈の版を持つ記録として残す。
- 競合は走査の成功で消えない。原記録の再読で双方の値が一致したとき、利用者が訂正したときだけ解決する。
- 競合がある範囲の turn の証拠は、解決まで `inferred` に落とす。
- 今の seq 301024 の記録には位置と識別がない。解決の証拠を作れないため、未解決として残す。

## 7 本番の実例

実例は `architecture-critique.md` の E1 から E6 である。レビューの再照合に合わせて当てはめを直した。
時点は 2026-10-15 の 06:13 から 06:29 の読み取りである。

### E1 29 時間以上前の開始証拠で子を running に保つ

- 対象は `agent-a46a60f85e3267c52` である。`runs` は running で、`last_evidence_ts` は `2026-10-14T00:10:09.463Z` である。
- 親の記録では、`Agent` の `tool_result` が `async_launched` で、`toolUseResult.agentId` が子を指す。seq 298560 である。これは起動の受理であり、結果の段階は `launched` である。
- 子の記録は 271 行で、末尾は `00:18:12.045Z` の Bash の呼び出しである。終了境界はない。
- プロセスの生存は `unverified` である。子は PID と開始値を持たない。親の後の `SessionEnd` は閉鎖の証拠であり、子の物理終了には流用しない。
- turn は `unknown` である。理由は `progress_expired`。最後の進行は `00:18:12.045Z` である。
- 結果は `unknown` である。必要な段階 `reported` の証拠がない。
- 正しい表示は「Unknown · last seen 2026-10-14 00:18 · progress expired」と結果の印「No result」である。
- 同じ親子の形の `agent-a5358e578dcf966d6` は、読み取り時点で `SubagentHandback` の呼び出し、`toolUseResult.success = true`、`SubagentStop` が揃っている。seq 307689、307695、307699 である。
- その時点の正しい表示は、代表の状態が Idle で「last seen」付き、結果の印が Done である。親の生存だけで Working にしない。

### E2 届いた二件を未着として保存する

- 対象の会話は `1c0d055c-8912-452b-b273-47e9874df7e8` である。watch は `896eb201` と `8dceda21` で、調査時も `failed` だった。
- jsonl には `<bash-input>` の行が、送出の 13 ms 後と 11 ms 後の出来事の時刻である。本文は正規化後に一致する。
- `<bash-input>` は入力の種類の印である。本製品の `cmd_id` を含まない。送信元を証明しない。
- 本書の定義では、配達は `received_candidate` である。確度は `inferred`。
- 正しい表示は「Likely delivered」の薄い印である。Not delivered も Unconfirmed も出さない。Delivered の確定も出さない。
- turn は変えない。`!` の命令は turn の開始にしない。現行の分類でもこれは確認できる。

### E3 同じ会話に別々の世代と終状態が残る

- 対象は `396247a1-5fc0-48e2-b984-2f4a8dac1f17` である。transcript の run は idle、hook の run は ended で、二本が残っている。
- seq 301178 は transcript の完了、301179 は `SessionEnd` で `reason = other`、301180 は後着の `Stop` である。
- 両方の run に PID と開始値がない。調査時の PID の有無は未確認である。過去の ps の出力は現在の証明に使えない。
- 本書の定義では、run の対応表が未解決である。2 つの run を 1 つの実行として表示しない。
- 閉鎖は、hook の run については `closed` で根拠は `session_end` である。プロセスの生存は `unverified` である。
- 正しい表示は「Unresolved · 2 runs」である。Stopped も Done も出さない。
- 対応表が 2 つを同じ実行に結んだ後は、閉鎖 `closed` と turn `completed` から「Closed」になる。

### E4 圧縮要約の意味は後日の再解釈で修正されている

- 対象の message は `8f97c4a9-1cd5-4caf-947f-e9cf39e6ebcb` である。seq 251644 にフラグがなく、seq 289242 の `message.corrected` で足した。
- これは message の解釈の版の課題である。turn の解釈とは別の版で移行する。
- 現行の `turns.ts:65` はこの行を turn の根拠から除く。過去のすべての投影が無影響だったとは証明しない。
- 正しい表示は、要約を利用者の発言として出さないことである。状態の軸には影響しない。
- 移行の途中では、未訂正の行を含む会話に「Reinterpretation pending」を出す。半分だけの新解釈を確定表示しない。

### E5 競合を記録して旧い内容を保持する

- 対象は `354000b1-4a87-45e8-baa7-6c1fa209d741.jsonl` で、seq 301024 に `observation.unsupported` がある。count は 5 である。
- count は `AppendResult` の競合の数である。`service/index.ts:333`、`:343`。原記録 5 行や turn 5 件を意味しない。
- 記録には競合した事実の識別と原記録の位置がない。元の 5 件は特定できない。
- 本書の定義では、未解決の競合である。走査の成功で消えない。
- 正しい表示は、見出しに「History conflict · unresolved · 5 rejected appends」を出すことである。範囲は特定できないため、会話全体に出す。
- 代表の状態は生存と turn の証拠に従う。競合の範囲を特定できないため、この会話の turn の証拠は `inferred` に落とす。

### E6 Codex には不在照合が実際に働いている

- 対象は `01a12a12-39e2-7e10-a459-95926539bae6` の世代 1 である。seq 259872 で `process_absent` の idle になった。
- rollout は 43 行で、末尾は `08:27:21.582Z` の assistant の `commentary` である。`task_complete` も `turn_aborted` もない。
- 走査は成功している。本書の定義では、閉鎖が `closed` で根拠は `not_hosted`、範囲はローカルの codex プロセスが開く rollout である。
- プロセスの生存は `unverified` である。PID と開始値を持たない。
- turn は `unknown` である。理由は `boundary_unavailable`。不在から `completed` を作らない。
- 正しい表示は「Closed · not hosted · last turn unknown」である。Stopped ではない。

## 8 受け入れの条件

`scripts/e2e/run.mjs` に次の項目を足す。項目の名前は既存の `1-claude` から `10` に続ける。
正解は偽 CLI の `state.json` と `events.jsonl` に持つ。製品の投影を正解にしない。
期待は `/snapshot` の値で判定する。snapshot には軸の値を次の名前で出す。

```text
projection.state[<entity id>] = {
  identity:    { value, version },
  process:     { value, taken_ts, valid_until, reason },
  closure:     { value, taken_ts, reason },
  turn:        { value, taken_ts, valid_until, reason },
  result:      { stage, value, attempt, taken_ts, reason },
  observation: { <source>/<scope>: { value, last_ok_ts, reason } },
  conflicts:   [ { ref, version } ],
}
projection.deliveries[<cmd_id>] = { value, confidence, emitting_ts, emitted_ts, received_ts, retry_of, reason }
snapshot.version, snapshot.evaluated_ts
```

### 8.1 前提

- PTY の所有を runner へ移す。移すまで `14-api-restart-keeps-pty` は通らない。未実行は失敗であり、受け入れは合格にならない。
- 配達の記録を所有者が永続化する。移すまで `14-*` の項目は通らない。
- 偽 CLI に、子だけを止める操作、Stop や SessionEnd や task_complete を個別に落とす操作、本文だけの説明行を書く操作、`async_launched` の返答を足す。

### 8.2 項目

| 項目 | 壊し方 | 期待する結果 |
| --- | --- | --- |
| `11-missing-stop` | `drop-hook: Stop` で Stop だけを落とし、`stop_reason = end_turn` で応答を終える | 応答の後、`turn.value === 'completed'`。根拠は `stop_reason` か `turn_duration`。行に Working が出ない |
| `11-partial-text` | 実物の順序で、`stop_reason` が null の説明行の後に同じ `message.id` で道具の呼び出しを書く。説明行の直後に読む | 説明行の時点で `turn.value === 'running'`。`completed` にならない。`turns.ts:90` の規則に戻すと落ちる |
| `11-missing-session-end` | `drop-hook: SessionEnd` で終え、プロセスを `exit` させる。PID の走査は続ける | 走査の後、`process.value === 'exited_confirmed'`、`reason === 'process_check'`。行は Stopped |
| `11-missing-task-complete` | Codex の偽 CLI で `task_complete` を落として応答を終える。プロセスは生かす | 進行の期限の後、`turn.value === 'unknown'`、`reason === 'progress_expired'`。`completed` にならない。`exit` の後は `closure.value === 'closed'` |
| `12-child-launch` | 親が `Agent` を呼び、`async_launched` の `tool_result` を書く。子は道具を呼び続ける | 子の `result.stage === 'launched'`、`result.value === 'incomplete'`。行は Working。Done が出ない |
| `12-child-stops-parent-alive` | 子だけを止め、親を生かす。PID の走査は続ける | 進行の期限の後、子の `turn.value === 'unknown'`、`reason === 'progress_expired'`。`process.value === 'alive_confirmed'`。行は Unknown。親の行は変わらない |
| `12-child-vanishes` | 子を起こし、`tool_use` を書いた直後に親ごと `kill -9` する | 走査の後、子の `process.value === 'exited_confirmed'`、`result.value === 'unknown'`。行は Stopped と No result |
| `12-child-handback` | 子が `SubagentHandback` を呼び、`success = true` の `tool_result` と `SubagentStop` を書く。3 行を別々の周期で読む | 呼び出しの時点で `result.stage !== 'reported'`。結果の行で `stage === 'reported'`、`value === 'succeeded'`。印は Done。親の `turn` は親の証拠のまま |
| `12-child-handback-failed` | `SubagentHandback` の `tool_result` を `success = false` にする | `result.value === 'failed'`。Done が出ない |
| `13-reorder` | hook、transcript、親子の記録を 3 通りの順で取り込む。旧い turn の Stop を新しい turn の開始の後に届ける | 3 通りで `projection.state` の全軸と根拠と `identity` と対象が一致する。run の ID と所属が一致する。旧い Stop で新しい turn が `completed` にならない |
| `14-stop-after-accept` | 配達の記録の直後、最初の書き込みの前に所有者を止めて起動し直す | 偽 CLI の `events.jsonl` に `input` がない。`deliveries[cmd_id].value === 'rejected'`、`reason === 'not_emitted'` |
| `14-stop-after-first-write` | Ctrl-U と貼り付けの直後、Enter の前に所有者を止めて起動し直す | `input` が 0 件か 1 件。`deliveries[cmd_id].value === 'unverifiable'`。再接続後に同じ `cmd_id` を送っても `input` は増えない |
| `14-api-restart-after-enter` | Enter の直後、受信確認の前に所有者を止めて起動し直す | `input` が 1 件だけ。`deliveries[cmd_id].value` が `received_candidate` か `unverifiable`。再送しても `input` は増えない |
| `14-concurrent-same-id` | 同じ `cmd_id` を 2 本の接続から同時に送る | `input` が 1 件だけ。両方の ack が同じ値を返す |
| `14-conflicting-same-id` | 同じ `cmd_id` で本文を変えて送る | 2 件目は誤りの ack で `reason === 'cmd_id_conflict'`。`input` は 1 件 |
| `14-expired-id` | 保持期間を過ぎた `cmd_id` を再送する | 誤りの ack で `reason === 'record_expired'`。`input` は増えない |
| `14-api-restart-keeps-pty` | 会話を起こしたまま api を起動し直す | 偽 CLI の PID が同じで生きている。再起動後 `process.value === 'alive_confirmed'` に戻る。終了と結果の事実が消えない |
| `15-pid-reuse` | 偽 CLI を終え、同じ PID で別のプロセスを起こす。古い登録は残す | 元の会話の `process.value === 'exited_confirmed'`。別のプロセスを生存証拠にしない |
| `15-fingerprint-unavailable` | OS の開始値を取得できなくする | `process.value === 'unverified'`、`reason === 'scan_failed'`。`exited_confirmed` にも `alive_confirmed` にもしない |
| `16-broken-sessions` | `sessions/` に壊れた JSON を 1 件置き、別の会話を終える | `observation['claude_sessions/<dir>'].value === 'failed'`。終えた会話は走査で `exited_confirmed` にならない。有効期限の後に `process.value === 'unverified'`、`reason === 'scan_failed'`。壊れた JSON を消すと `exited_confirmed` に戻る |
| `17-same-text-external` | ブラウザから送った本文を `drop-next` で落とし、同じ本文を端末タブから 1 回打つ | `deliveries[cmd_id].value === 'received_candidate'`、`confidence === 'inferred'`。`received` にならない。行は Working |
| `17-same-text-twice-pty` | 同じ本文を 2 回続けて PTY へ送る | 2 つの `cmd_id` がどちらも `received` にならない。`received_candidate` か `unverifiable`。`input` は 2 件 |
| `17-same-text-twice-correlated` | 相関 ID のある経路で同じ本文を 2 回送る | 2 つの `cmd_id` が別の相関 ID で `received`。`input` は 2 件 |
| `17-tagged-and-late` | `!` と `/compact` を送り、原記録の取り込みを送出より遅らせる。CLI の時計を 2 秒ずらす | `received_candidate` になる。`rejected` と `unverifiable` にならない。時計のずれで候補を落とさない |
| `18-rule-version` | `TURN_RULE_VERSION` を上げ、会話の再読を途中で止めて起動し直す | 再読が終わるまで `observation['transcript/<file>'].value === 'delayed'`、`reason === 'reinterpretation_pending'`。turn の値が旧版のまま。再読の完了で `healthy` になり `interpretation_version` が進む |
| `18-message-correction` | E4 の形でフラグなしの要約を取り込み、後から訂正を足す | 訂正の前後で要約が利用者の発言として出ない。turn の値が変わらない |
| `18-conflict-then-scan` | 識別できる競合を 1 件作り、その後に正常な走査を 3 回行う | `conflicts` に 1 件残る。走査の成功で消えない。原記録を直すと消える |
| `19-version-consistency` | 投影の更新中に `/snapshot` と `/conversation` を連続で読む。`version` を指定して読む | 各応答の中で `version` と全軸が同じ版から作られている。指定した版を返せなければ 409 |
| `19-expiry-without-append` | 台帳に追記せず、生存証拠の期限を過ぎさせる | `snapshot.version` が進み、patch が出る。行が Unknown になる |
| `19-ui-disconnect` | 画面の WebSocket を切り、期限を過ぎさせる | 画面に「as of」と最後の版の時刻が出る。Working のまま現在として出ない |
| `20-done-only-from-result` | 対話の会話を終え、子を結果なしで終える | 対話の行に Done が出ない。子の行に Done が出ない。`result.value === 'succeeded'` の実体だけが Done |
| `20-display-complete` | 軸の値のすべての組を snapshot に注入する | 4.2 の表で一意に 1 つの言葉になる。該当なしがない |
| `21-liveness-expiry` | 偽 CLI を `SIGSTOP` で止める。PID の走査は続ける。heartbeat は止まる | 進行の期限の後に `turn.value === 'unknown'`、`reason === 'progress_expired'`。`process.value === 'alive_confirmed'` のまま。行は Unknown。`SIGCONT` の後に進行の証拠で Working へ戻る |
| `21-scan-stops` | PID の走査を止める | 期限の後に `process.value === 'unverified'`、`reason === 'liveness_expired'`。`observation` が `delayed` |

### 8.3 既存の項目の改め

- `7` は Working の判定を `turn.value === 'running'` と `process.value === 'alive_confirmed'` の両方で行う。
- `9-missing` は Unconfirmed を期待する。Not delivered を期待しない。
- `9-bang` は Likely delivered を期待する。Delivered の確定を期待しない。
- `journeys.mjs:151` は Idle と Done のどちらも受け入れる。これを Idle だけに改める。
- 各項目は正常な並びに加えて、遅延と重複を組み合わせた並びでも通す。
- 受け入れは `scripts/e2e/run.mjs` の終了コード 0 で判定する。項目の未実行は失敗である。

## 9 architecture-v2.md の改める箇所

| 箇所 | 今の記述 | 改める内容 |
| --- | --- | --- |
| 決定 2 外の会話の従の経路 | 確かでない状態は不明と表示する。経過時間だけで終了を断定しない | 保つ。「経過時間で終了にしない。経過時間で不明にはする」と足す |
| 決定 3 事実の台帳 | 画面の状態は台帳から組み立てる | 履歴は台帳から、現在状態は照合器の snapshot から組み立てると改める |
| 決定 12 WebSocket | 同じ `cmd_id` の再送は 1 回だけ作用する | 再送の抑止は所有者が永続化した記録で行う。副作用の前に記録し、再接続を送出の許可にしないと足す |
| 決定 13 runner と api の分離 | api はいつでも再起動できる。実行は止まらない | ブラウザから起こした端末の PTY を runner へ移す。移すまで api の再起動で生存が `unverified` になると明記する |
| プロセスの分離の表 | api の再起動で実行は止まらない | 同上 |
| 出来事を失わない仕組み | api は 500 ms ごとに台帳の seq を確かめる | 保つ。照合器の周期と snapshot の版の配信を足す |
| データモデル 実行 | 状態は 8 値の 1 つの列 | 軸に分ける。プロセスの生存と閉鎖を別に持つ。旧い `state` は移行の間だけ写す |
| 実行 `ended` の根拠表 | 5 つの根拠を同じ `ended` にする | 物理終了は `host_exit` と `process_check` だけ。`session_end`、`thread_closed`、`archived` は閉鎖の根拠に移す |
| 実行 `ended` の根拠表 | プロセスの確認は PID と開始指紋の組 | 保つ。開始指紋は OS の現在の開始値と比較すると明記する。`startedAt` は使わない |
| 実行 終了の根拠にしない事象 | 一定時間の無更新は `unknown` にする | 保つ。有効期限の定義を本書に委ねると足す |
| 実行 SessionEnd の後の turn | 同じ世代の turn の開始で running へ戻す | 保つ。戻すのは閉鎖と turn であり、物理終了は戻さないと足す |
| 接続 | 種類は `mcp`、`herdr`、`app`、`pid`、`ws` | `pid` の接続に OS の開始値と `valid_until` を持たせる。heartbeat を足す |
| 出所の優先 外の会話の状態 | hook、次に履歴。経過時間は根拠にしない | hook と履歴は turn の根拠として対等にする。生存は走査と指紋で決める。経過時間は不明の根拠にする |
| Claude のホスト | `idle` をターンの終わりの合図に使う | 保つ。`idle` を依頼の結果に使わないと足す |
| Claude のホスト | `send` の戻り値を定めていない | 送信ごとに相関 ID を作り、応答と結ぶと足す |
| 実行の監督 | api の再起動は実行の状態を変えない | PTY の所有が移るまで成り立たないと明記する |
| 委譲 状態と試行 | 試行は受け入れとレビューの結果を持つ | 結果を段階と判定に分け、依頼の種類ごとに必要な段階を決めると足す |
| 外の会話の観測 不明の扱い | 観測の根拠が途切れた実行は `unknown` にする | 保つ。走査の成功を不在の条件にする。観測の健康状態と競合を配信すると足す |
| 画面 共通の規則 | 状態の語彙は 6 値 | 4 節の表に置き換える。代表の状態と結果の印を分ける。Done を依頼の結果に限る |
| 画面 一覧 不明のとき | 最後の根拠の時刻を添える | 保つ。理由の語彙を 4.4 に合わせる |
| 画面 エージェントの会話と入力 | 端末送信の契約を `terminal-slash-commands.md` に委ねる | 配達の契約は本書の 5 節を正本にする。`terminal-slash-commands.md` は送出の手順に限る |
| 受け入れの基準 標本 S2 | 無更新は `unknown` になる | 保つ。本書の 8 節の項目を受け入れに足す |
| 受け入れの基準 標本 S3 | 新しい世代が古い PID を引き継がない | 保つ。`15-pid-reuse` と対応づける |
| 受け入れの基準 標本 S11 | プロセス一覧の取得の失敗で `unknown` | 保つ。観測の健康状態が `failed` になると足す |
| 復旧の契約の表 | 5 点の故障の注入 | 8 節の `14-*` を足す |

`identity-redesign.md` にも矛盾がある。本書と合わせて次を改める。

- 「状態の根拠に経過時間は使わない」を「経過時間は不明の根拠にする」に改める。
- 「`sessions/*.json` の PID の不在は `idle` にする」を「閉鎖 `not_hosted` にし、turn は変えない」に改める。
- 「普通の発言は本文の一致で届いたとする」を、5.4 の順に改める。本文の一致は候補である。
- 「`!` の命令は照合しない」を、`<bash-input>` の行を候補にすると改める。
- 「hook の run が後から来たら自前の run を `superseded_by_hook` で閉じる」を、run の対応表での結合に改める。閉鎖の証拠にしない。

## 要確認

- Claude の SDK で、送った入力の ID が応答に返るか。返らなければその経路は `received_candidate` までである。
- 同期の `Agent` の `tool_result` が結果を含む形式と、その欄。
- peer protocol が任意の入力に受領の返答を返すか。隔離した送受信者で、即時受け入れ、保留解除、拒否、失効、切断、同じ `msg_id` の再送、再起動後の照会を確かめる。本物の Claude が要る。
- `sessions/*.json` の `status` の値の一覧と、turn との対応。隔離した環境で OS の PID と開始値と登録の変更を同時に採る。
- Codex の 2 分の猶予の妥当性。走査の発見の遅れと、活動後にファイルが開かれていない期間を分けて測る。
- E3 の調査時の PID の有無。過去時点の走査の結果が保存されていないため、復元できない。
- E5 の競合した 5 件の位置。記録に識別がないため、特定できない。

## 回答済みの要確認

| 項目 | 回答 | 反映した節 |
| --- | --- | --- |
| `sessions/*.json` の `status` と `updatedAt` | 出来事ごとの更新であり heartbeat ではない。3 分の静止で変化しなかった | 3.3、3.4 |
| `procStart` と `startedAt` | `procStart` は OS の開始値、`startedAt` は登録時の壁時計 | 2.1 |
| 親の `tool_result` と子の ID | 行のトップレベルの `toolUseResult.agentId`。`async_launched` は起動の受理 | 2.3、3.4 |
| `SessionEnd` の `reason` | 5 値。本番は `other` 1,502 件、`prompt_input_exit` 8 件。欄は `payload.last_evidence.input.reason` | 2.1 |
| E6 の末尾 | `commentary` であり `task_complete` ではない | 7 |
| Codex の 2 分 | 最後の記録時刻からの猶予。妥当性は未確認 | 3.4 |
| PTY の移行の時期 | 推測で決めない。受け入れの前提にし、完了まで合格にしない | 8.1 |

## レビューへの対応

| 指摘 | 直した節 | 直し方 |
| --- | --- | --- |
| 1 送信元を識別できない証拠で受領を確定 | 2.4、5.4、5.7、7 E2 | `received` は相関 ID だけにした。本文と時刻の一致は `received_candidate` で確度 `inferred` にした。`<bash-input>` と `queued_command` と `<command-name>` を候補に落とした。画面の結果は `terminal_handled` に分けた。旧い `closed` は候補に写す。SDK と app-server の相関 ID の往復と永続化を 3.4 に書いた。E2 は Likely delivered にした |
| 2 再送禁止と再接続の送出の矛盾と部分送出 | 2.4、5.1、5.2、5.3、5.5、5.6、8.2 の `14-*` | 所有者が `accepted` から `emitting` へ 1 回だけ進める。再接続は記録の値を返すだけで送出しない。`emitting` を最初の書き込みの前に記録し、書き込み後の中止は `unverifiable`、記録だけで止まった操作は `rejected` にした。`retried` を値から外し `retry_of` の関係にした。同一 ID の異なる本文、並行、保持期限後を定めた |
| 3 子の起動通知を完了と取り違え | 2.3、3.4、7 E1、8.2 の `12-*` | `Agent` の `tool_result` の `toolUseResult.agentId` で子を同定し、`async_launched` を段階 `launched` にした。親の `tool_result` から完了を作る規則を削った。`12-child-launch` を足した |
| 4 途中の説明を完了にする規則の引き継ぎ | 2.2、3.4、8.2 の `11-partial-text` | `turns.ts:90-93` の規則を廃止し、終了境界を `stop_reason` と attachment と `turn_duration` に限った。取れない形式は `unknown`。過去の `turn_completed` を解釈の版の移行対象にした |
| 5 プロセスの終了と論理の閉鎖の混同 | 2.1、2.6、6.4、7 E3 と E6、9 | 生存をプロセスの生存と閉鎖に分けた。物理終了は `host_exit` と `process_check` だけ。`session_end`、`thread_closed`、`archived`、`not_hosted` を閉鎖の証拠にした。`procStart` は OS の現在値と比べる。物理終了は戻さず、閉鎖だけ再開で戻る |
| 6 新鮮な PID が古い turn を Working に保つ | 2.2、2.6、3.3、6.4、8.2 の `12-child-stops-parent-alive` と `21-*` | turn に自分の鮮度と `progress_expired` を持たせた。生存の走査で turn を更新しない。子の turn は子の証拠で決める。親を生かして子だけ止める項目と、走査を続けたまま `SIGSTOP` する項目を足した |
| 7 同一性を範囲外にしたまま同じ run を前提 | 2.7、7 E3、8.2 の `13-reorder` | 必須の入力として会話と run の対応表、所有プロセス世代、turn の鍵、request と attempt の鍵を定めた。未解決は `unresolved` にし単一の実行として出さない。出来事の時刻と取得時刻を分けた。`13-reorder` は ID と所属と全軸の一致を求める |
| 8 報告と最終応答と検証合格を同じ成功に | 2.3、4.3、8.2 の `12-child-handback*` | 結果を段階と判定に分け、依頼の種類ごとに必要な段階を決めた。handback の呼び出しと結果を別の事実にした。`is_error` の区別と試行ごとの結果を書いた。子の結果で親の turn を変えない |
| 9 snapshot の版と時刻と再起動の契約の不足 | 6.2、6.3、8.2 の `19-*` | 版を 7 つの構成と通し番号と評価時刻にした。期限切れと配達と対応表と解釈の変更を版の契機にした。再起動は失効する生存証拠だけを落とす。版指定の読み取りと 409 を定めた。切断は「as of」と出す |
| 10 観測失敗と未解決の競合を同じ回復規則で | 2.5、6.5、6.6、7 E5 | 健康状態を情報源と範囲の組に付けた。競合を別の記録にし、走査の成功で消さない。解釈の再読は準備中の版に蓄え、範囲の完了で一括で有効化する。中断と部分失敗と原記録の欠落を定めた。E5 は未解決として留保した |
| 11 画面への写像が一意でも網羅的でもない | 4.1〜4.5、8.2 の `20-display-complete` | 代表の状態と結果の印を分け、順序付きの表ですべての組を 1 つに写した。子にも同じ語彙を使う。理由の語彙を揃えた。Queued はその入力自身のキューの状態を要求する |
| 12 期限の決め方が誤った確信を減らす目標でない | 3.2、3.4、5.4、5.5 | 偽 CLI を正解にし、更新と走査と進行を別に測り、誤った Working と Delivered の最大継続と不要な Unknown を評価する方法にした。`updatedAt` を heartbeat にしない。60 秒の根拠の主張を取り下げた。`running` の待ちに 24 時間の上限と turn の `unknown` からの期限を足した。時刻の比較を相関の代わりにしない |

反映しなかった指摘はない。指摘 7 の同一性の全設計は本書の範囲外のままであり、必須の入力の参照に留めた。
