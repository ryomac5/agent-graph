# 状態と配達の定義書

2026-10-15。読み手は実装と試験を行う AI agent と、それを監督する人である。
本書は作り直しの 1 段目であり、後のすべての実装と試験の正本である。
コードの基準は main の `f5adc24` である。`file:line` はこの作業ツリーの位置を示す。
時刻は UTC で書く。
本書は定義だけを示す。コードは変えていない。
第 3 版である。`state-contract-review.md` の指摘 1〜12 と `state-contract-review-2.md` の R1〜R8 を反映した。

## 要点

- 過去の知らせは、現在の確証にならない。確証には取った時刻と有効期限がある。
- 状態は 5 つの軸に分ける。生存、turn、依頼の結果、配達、観測の健康である。生存はプロセスの生存と実行の閉鎖と所持に分ける。
- 画面の Done は依頼の結果にだけ結び付ける。turn の停止、不在、子の起動通知、報告の呼び出しから Done を作らない。
- 不在を言えるのは、その範囲の走査が成功したときだけである。不在の証拠には期限がある。
- 受領の確定は、送信の操作と受信の記録を結ぶ相関証拠に限る。本文と時刻の一致は候補に留める。
- 送出は 1 つの所有者が 1 回だけ進める。再接続は送出の許可にならない。`cmd_id` の墓標を残す。
- 同じ入力に対する正解は 1 つである。表示は 4.2 の決定表だけが決める。
- 決められない値は、決める方法と仮の値を書く。仮の値は「分からない」の側に倒す。

## 用語

| 語 | 意味 |
| --- | --- |
| 証拠 | ある情報源がある時刻に取った観測の記録。値と時刻と有効期限と範囲と確度を持つ |
| 照会の証拠 | 本製品が外の世界へ問い合わせて得た証拠。走査、heartbeat、PID の確認 |
| 出来事の証拠 | 外の世界が書いた記録を読んで得た証拠。transcript の行、hook、rollout の行 |
| 有効期限 | その証拠を現在の根拠として使ってよい時刻の上限。`valid_until` と書く |
| 失効 | 現在時刻が有効期限を過ぎた状態。失効した証拠は履歴としてだけ残る |
| 走査 | 対象の範囲を網羅して読む操作。成功と失敗と部分成功を区別する |
| 不在 | 走査が成功し、その範囲に対象が見つからなかったこと |
| 照合器 | 台帳の投影と証拠と走査の結果から、現在状態の snapshot を作る処理 |
| snapshot | 照合器の出力。実体ごとの各軸の値と根拠と評価時刻と版を持つ |
| cmd_id | 画面の操作ごとに作る識別子。配達の記録の主キーになる |
| 墓標 | 配達の記録の本文を消した後も残す、`cmd_id` と最終の値と時刻の行 |
| 相関 ID | 受信側が持つ識別子のうち、送信要求と結び付けられるもの |
| 所有者 | 実行のプロセスを直接持ち、送出と終了の記録を行う常駐。今は api、移行後は runner |
| 所有プロセス世代 | 所有者が起こしたプロセスの 1 回分。PID と OS の開始値の組で識別する |
| 出来事の時刻 | 原記録に書かれた時刻。`event_ts` |
| 取得時刻 | 本製品がその記録を読んだ時刻。`taken_ts` |
| 仮の値 | 計測で決めるまでの間に使う値。3.2 の表に置く |

## 1 確かさの原則

### 1.1 過去の知らせと現在の確証

- 開始の通知を知っていることと、今も動いていることは別である。
- 状態の値には、その値を支える証拠の時刻と有効期限を必ず付ける。
- 期限内の証拠がない値は、現在の確証にならない。履歴としてだけ残す。
- 本番の `runs` には 29 時間前の `turn_started` だけを根拠に running を保つ行がある。これは確証ではない。

### 1.2 証拠の時刻と有効期限

- 照会の証拠の期限は取得時刻から数える。`valid_until = taken_ts + 間隔 × 係数`。
- 出来事の証拠の期限は出来事の時刻から数える。`valid_until = event_ts + 窓`。
- 出来事の証拠を再読しても、`event_ts` は変わらない。再読で期限は延びない。
- 証拠を取り直すたびに照会の証拠の `taken_ts` が進む。古い証拠は新しい証拠で置き換える。
- 証拠の取り直しに失敗したときは、前の証拠の `valid_until` を延ばさない。
- 間隔と係数と窓は 3.2 で決める。決まるまで仮の値を使う。

### 1.3 不在の条件

- 不在を言えるのは、その範囲の走査が成功したときだけである。
- 不在は照会の証拠である。期限を持つ。恒久の状態にしない。
- 走査の範囲は証拠に書く。範囲の外にある実体には、その不在を適用しない。
- 走査の失敗と部分成功では、既存の値を保つが、その値の有効期限は延ばさない。
- 今の実装は、この原則を一部で守っている。`packages/api/src/observe/claude/sessions.ts:17-38` は失敗で何も書かない。

### 1.4 失効から作ってはならない値

- 失効した値から、成功を作らない。
- 失効した値から、終了を作らない。
- 失効した値から、不在を作らない。
- 失効した値から作ってよいのは、不明だけである。不明には最後の証拠と理由を付ける。
- 無出力の長い処理はある。無出力だけで停止と判断しない。無出力が窓を超えれば不明にする。

### 1.5 証拠の確度

- 証拠は `confirmed` と `inferred` の確度を持つ。
- 相関 ID で結んだ証拠、所有者が直接得た証拠、終端の記録は `confirmed` である。
- 本文や時刻の近さで結んだ証拠、終端でない停止の印は `inferred` である。
- `inferred` の証拠から、確定した値を作らない。値に確度を付けて候補として残す。
- 1 つの軸の値は、その軸の証拠から作る。別の軸の証拠を流用しない。

### 1.6 正解の一意性

- 同じ入力に対して、本書のどの節を読んでも同じ値になる。節の間で違えば本書の誤りである。
- 表示は 4.2 と 4.3 と 4.5 の表だけが決める。他の節の表示の例は、その表から引いた結果である。
- 理由と欄の語彙は 6.7 の一覧だけに置く。他の節は一覧の語を使う。

## 2 状態の軸

状態は 5 つの軸に分ける。軸ごとに独立した証拠を持つ。
1 つの軸の値から、別の軸の値を暗黙に導かない。導いてよい関係は 2.6 に限る。
今の `RunPayload.state` は軸の混在である。移行の間は、旧い `state` を軸に写した値も snapshot に残す。

### 2.1 実行の生存

生存は 3 つに分ける。プロセスの生存、所持、実行の閉鎖である。
プロセスの生存は OS のプロセスについて言う。所持は「どれかのプロセスがこの会話を持つか」の照会である。閉鎖は session と thread と run の論理の状態である。

#### プロセスの生存

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `alive_confirmed` | 期限内の生存証拠がある | 所有プロセス世代の PID と OS の開始値の組が現在の表と一致した。所有者の handle が生きている。heartbeat が期限内 | `valid_until` を過ぎる。終了証拠が来る | 所有者の handle と heartbeat。PID と OS の開始値の照合 |
| `exited_confirmed` | 物理的な終了証拠がある | 所有者が exit を受けた。PID と開始値の組が、成功した走査で現在の表と一致しなかった | 戻らない。新しい所有プロセス世代は別の実体である | `host_exit`。`process_check` の `matches = false` と `succeeded = true` |
| `unverified` | 期限内の証拠がない | 生存証拠が失効した。走査が失敗した。PID と開始値を持たない | 生存証拠か終了証拠が来る | 最後の証拠と `taken_ts` と理由 |

- 開始値は OS から取る。`sessions/*.json` の `procStart` は登録時に OS から写した値である。比較の相手は登録ファイル同士ではなく、OS の現在の値である。
- `sessions/*.json` の `startedAt` は登録時の壁時計である。開始指紋には使わない。
- PID と開始値を持たない実体は `unverified` のままである。登録の不在や開いたファイルの不在から `exited_confirmed` を作らない。
- 今の `runs.ts:31-33` の `process_check` の規則は保つ。`pid` と `start_fingerprint` の両方を要求する。
- 子は親と同じプロセスの中で動く。子のプロセスの生存は、親の所有プロセス世代の値をそのまま取る。

#### 所持

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `hosted` | 期限内に、この会話を持つプロセスが見つかった | 成功した走査で、登録か開いたファイルがこの会話を指した | `valid_until` を過ぎる。不在の走査が来る | `sessions/*.json` の登録。`lsof` の開いた rollout |
| `not_hosted` | 期限内に、この会話を持つプロセスがなかった | 成功した走査で、範囲内に登録も開いたファイルもなかった | `valid_until` を過ぎる。`hosted` の走査が来る | 走査の範囲と完了時刻 |
| `unknown` | 期限内の走査がない | 走査が失敗した。走査が期限を過ぎた。範囲の外 | 走査が来る | 最後の走査と理由 |

- 所持は照会の証拠である。1 回の不在を恒久の閉鎖にしない。
- `not_hosted` は走査の時点と範囲について言う。特定のプロセスの終了は意味しない。
- 同じ turn の途中で再び開かれたファイルが見つかれば、次の走査で `hosted` に戻る。
- `not_hosted` の期限は走査の間隔から数える。期限を過ぎれば `unknown` に戻る。

#### 実行の閉鎖

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `open` | 実行が閉じていない | 開始の証拠がある。閉鎖の後に同じ世代の turn の開始証拠が来た | 閉鎖の証拠が来る | `SessionStart`、`run.created`、`thread/started` |
| `closed` | 論理的に閉じた | 閉鎖の証拠がある | 同じ世代の確かな turn の開始証拠が来る。物理終了の後は戻らない | `SessionEnd`、`thread_closed`、`archived` |
| `unknown` | 判定できない | 証拠がない | 証拠が来る | 最後の証拠と理由 |

- 閉鎖は出来事の証拠であり、失効しない。再起動の後も保つ。
- 閉鎖はプロセスの終了を意味しない。所持の不在も閉鎖の証拠にしない。
- `SessionEnd` の後に同じ世代の `UserPromptSubmit` が来る実例がある。seq 301135 と 301443 である。これは論理の再開であり、`runs.ts:48-62` の規則は閉鎖の軸で保つ。
- `SessionEnd` の `reason` は 2.1.299 と 2.1.300 で `clear`、`resume`、`logout`、`prompt_input_exit`、`other` の 5 値である。本番では `other` が 1,502 件、`prompt_input_exit` が 8 件ある。欄は `payload.last_evidence.input.reason` である。
- `reason` は閉鎖の種類の証拠である。物理終了の証拠にはしない。

### 2.2 turn の進行

会話の中で、エージェントの応答が今どの段階かを表す。
turn は自分の鮮度を持つ。プロセスの生存と所持で turn の鮮度を更新しない。
turn の値は確度を持つ。`completed` と `running` は `confirmed` か `inferred` のどちらかである。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `running` | turn の実行中 | turn の開始か進行の証拠があり、その証拠が窓の内である | 終端の証拠が来る。進行の証拠が失効する。プロセスの生存が `exited_confirmed` になる | 開始は hook の `UserPromptSubmit`、transcript の turn の開始行、Codex の `turn/started` と `task_started`、managed の `running`。進行は transcript の `tool_call` と `tool_result`、Codex の item、managed の delta の確定 |
| `waiting_approval` | 承認を待つ | 承認の要求があり、回答がなく、要求の証拠が窓の内である | 回答か中断か閉鎖が来る。要求の証拠が失効する | `canUseTool`、`requestApproval`、`waitingOnApproval` |
| `waiting_input` | 利用者の入力を待つ | 入力待ちの通知があり、窓の内である | 入力が届く。通知が失効する | Codex の `waitingOnUserInput`。managed の入力待ちの通知 |
| `completed` | 直近の turn が終わった | 終端の証拠がある | 新しい turn の開始証拠が来る | 2.2.1 の終端の表 |
| `unknown` | 判定できない | turn の証拠がない。進行か待ちの証拠が失効した。終端を取れない形式である | 新しい turn の証拠が来る | 最後の turn の証拠と理由 |

- `running` の鮮度は進行の証拠で更新する。窓は `event_ts` から数える。再読で延びない。
- 進行の証拠がないまま窓を超えたら `unknown` にする。理由は `progress_expired` である。
- `waiting_*` の鮮度は要求か通知の `event_ts` から数える。回答の観測が落ちたまま窓を超えたら `unknown` にする。理由は `waiting_expired` である。managed の承認は runner が持つため、runner の heartbeat が期限内なら窓を適用しない。
- プロセスが生きていても、turn の `running` は保証されない。CLI は応答を終えても待機する。親は子が終わっても生き続ける。
- `completed` は過去の turn の終了である。入力を受け付けられることを保証しない。
- hook と transcript が同じ turn を別の形で伝えるときは、どちらの証拠も使う。終端の確度は 2.2.1 の表に従う。
- 今の `runs.ts:106-114` は hook が running の間、transcript の完了を捨てる。この規則は廃止する。
- turn の鍵は 2.7 の表に従う。行の uuid だけを鍵にしない。

#### 2.2.1 終端の証拠

モデルの応答の終わり、報告の配達、turn の終了は別のものである。turn の終了には次の表だけを使う。

| 情報源 | 証拠 | 確度 | 理由 |
| --- | --- | --- | --- |
| transcript の Claude | `type = system` かつ `subtype = turn_duration` の行 | `confirmed` | 利用者の turn が終わったときだけ書かれる。`turns.ts:62` |
| transcript の Claude | `stop_reason` が `end_turn`、`stop_sequence`、`max_tokens`、`refusal`、`model_context_window_exceeded` の assistant 行 | `inferred` | モデルの応答の終端であり、Stop hook の続行で turn が続くことがある |
| transcript の Claude | `attachment.hookEvent = Stop` の行 | `inferred` | Stop hook は `stop_hook_blocking` で続行を要求できる。2.1.300 の実行ファイルで確認 |
| transcript の Claude の子 | `attachment.hookEvent = SubagentStop` の行 | `inferred` | 同上 |
| transcript の Claude の子 | 親の `Agent` の `tool_result` で `toolUseResult.status = completed` | `confirmed` | 同期の子の応答が親へ返った。2.1.291 と 2.1.292 の実記録 3 件と 2.1.299 と 2.1.300 の実行ファイルで確認 |
| transcript の Claude | `[Request interrupted by user]` の user 行 | `confirmed` | 中断は終端である |
| hook | `Stop` の出来事 | `inferred` | Stop hook の続行で turn が続くことがある |
| hook | `SessionEnd` | `confirmed` | 閉鎖は turn も終える |
| Codex の rollout | `turn/completed`、`task_complete`、`task_completed`、`turn_aborted` | `confirmed` | turn の終端の通知である |
| managed の Claude | `result` の受信。`session_state_changed = idle` | `confirmed` | ホストが直接受ける |
| managed の Codex | `turn/completed` の通知 | `confirmed` | ホストが直接受ける |

- `inferred` の終端だけがあるときは、turn は `completed` で確度 `inferred` である。
- `inferred` の終端の後に、同じ turn の鍵で進行の証拠が来たら、`running` に戻す。
- `inferred` の終端の後に `confirmed` の終端が来たら、`completed` の確度を `confirmed` に上げる。
- 本文だけの assistant 行を終端にしない。`turns.ts:90-93` の規則は廃止する。2.1.299 の実物では、`stop_reason` が null の説明文の後に同じ `message.id` で道具の呼び出しが続く。
- `SubagentHandback` の呼び出しと、その `tool_result` は、turn の終端にしない。報告の段階の証拠である。
- 終端を取れない形式は `unknown` にする。理由は `boundary_unavailable` である。
- 過去に保存した `turn_completed` の事実は、解釈の版の移行対象である。原記録と旧い判定を残す。

### 2.3 依頼の結果

依頼として出した仕事の結果を表す。対象は委譲、managed の実行、Claude の子、Codex の子、タスクグラフの節である。
結果は試行ごとに持つ。試行の中で、段階の証拠は累積する。
対話の会話には依頼の結果を付けない。

#### 段階

| 段階 | 意味 | 根拠となる証拠 |
| --- | --- | --- |
| `launched` | 起動を受理した | 親の `Agent` の `tool_result` で `status = async_launched`。受付の `accepted`。`spawnAgent` の item |
| `responded` | 最終の応答を作った | `final_answer` の確定。managed の `result` で `is_error = false`。親の `Agent` の `tool_result` で `status = completed`。Codex の子の `collabAgentToolCall` の結果 |
| `reported` | 報告を親へ渡した | 子の `SubagentHandback` の呼び出しに対応する `tool_result` で `toolUseResult.success = true` |
| `verified` | 受け入れ検証に合格した | 受付の検証の結果が合格 |
| `reviewed` | レビューに合格した | レビューの結果が合格 |

- 段階は試行の中で戻らない。`reported` の後に `success = false` の報告が来ても `reported` は保つ。
- `async_launched` は起動の受理である。完了にしない。
- `SubagentHandback` の呼び出しだけでは `reported` にしない。呼び出しの行と結果の行は別の事実である。`A535:190` と `:192` が実物である。
- 2.1.300 の実行ファイルには、既に報告済みの場合と親が受け付けない場合の `success = false` がある。これは報告の操作の失敗であり、依頼の失敗ではない。

#### 必要な段階

| 依頼の種類 | 識別の方法 | 成功に必要な段階 |
| --- | --- | --- |
| Claude の子の同期の起動 | 親の `Agent` の `tool_use` に `run_in_background = false`、結果に `isAsync` がない | `responded` |
| Claude の子の非同期の起動 | 結果が `async_launched` で `isAsync = true` | `reported` |
| Codex の子 | 親の `spawnAgent` の item | `responded` |
| 画面から起こした managed の実行 | 受付を通らない `session.launch` | 結果を付けない。対話の会話と同じ |
| 受け入れ条件のない委譲 | 受付の `accept` が空 | `responded` |
| 受け入れ条件のある委譲 | 受付の `accept` が空でない | `verified` |
| レビューを含む委譲 | 受付の役割にレビュアーがある | `reviewed` |
| タスクグラフの節 | planner の task | その task の `accept` と review の有無で上の委譲と同じ |

- 種類を識別できない依頼は、必要な段階を `unknown` にする。判定は `unknown` のままである。

#### 判定

| 値 | 意味 | 入る条件 | 出る条件 |
| --- | --- | --- | --- |
| `incomplete` | 必要な段階に達していない | 依頼が受理された | 段階が進む。他の値に入る |
| `succeeded` | 必要な段階に達した | その試行に必要な段階の証拠が揃った | 利用者の訂正だけ。新しい試行は別の結果を持つ |
| `failed` | 必要な段階で失敗した | 受け入れ検証の不合格。レビューの不合格。最終の応答が `is_error = true` | 利用者の訂正だけ。新しい試行は別の結果を持つ |
| `interrupted` | 中断された | 中断の要求と対応する終了がある | 利用者の訂正だけ |
| `unknown` | 判定できない | 必要な段階の証拠がないまま、プロセスの生存が `exited_confirmed` になった。必要な段階が `unknown` | 証拠が来る。利用者の訂正 |

- 報告の操作の失敗は `failed` にしない。結果の `report_failures` に理由を累積し、判定は `incomplete` のままにする。
- 道具の `tool_result` の `is_error` は結果の証拠にしない。最終の応答の `is_error` だけを使う。
- `failed` と `succeeded` は同じ試行の中で互いに覆さない。先に成立した方を保つ。両方の証拠があれば `conflicts` に記録する。
- 子の結果で親の turn を変えない。親の turn は親の証拠から決める。
- Claude の子の `idle` を Done に読み替える `packages/dashboard/app/src/lib/roots.ts:249` は廃止する。

### 2.4 入力の配達

画面から送った入力が、受信側に届いたかを表す。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `accepted` | 送信要求を記録した | 所有者が `cmd_id` と対象を永続化した | 所有者が送出を始める。所有者が送出前に止める | 配達の記録の行 |
| `emitting` | 送出を始めた | 最初の端末への書き込みか SDK の呼び出しの直前に記録した | 送出が終わる。所有者が止まる | 送出の開始時刻 |
| `emitted` | 送出を終えた | Enter の書き込みか SDK の呼び出しが返った | 受信の証拠が来る。期限を過ぎる | 送出の完了時刻と対象の版 |
| `received` | 受信側の相関証拠がある | 相関 ID が送信要求と結び付いた | 変わらない | 受信側の相関 ID |
| `received_candidate` | 受信の候補がある | 相関 ID はないが、5.4 の範囲内に一致する受信の記録が 1 件ある | 相関証拠が来る。候補が増える | 一致した記録と、照合の範囲と確度 |
| `terminal_handled` | 端末が処理した | 画面の読み取りで、コマンドの結果か選択欄を確認した | 変わらない | 画面の差分。確度は `inferred` |
| `rejected` | 送らなかった | 最初の端末への書き込みより前に止めた | 変わらない | 止めた理由 |
| `unverifiable` | 確認できない | `emitting` か `emitted` のまま期限を過ぎた。所有者が送出の途中で止まった | 相関証拠か候補が後から来る | 送出の記録と、照合の範囲と期限 |

- `received` は相関証拠だけから作る。本文と時刻の一致からは作らない。
- `received_candidate` は確定ではない。画面には候補として出す。
- `rejected` は終わりの値である。受信の照合の対象にしない。後から同じ文が入っても変わらない。
- `rejected` だけが「届いていない」を意味する。端末に 1 文字も書いていないからである。
- `emitting` の途中で止めた操作は `unverifiable` にする。理由は `aborted_after_write` である。
- `unverifiable` は「届いていない」ではない。「この照合器が確認できなかった」である。
- 今の `api_send_watches` の `closed` は `received_candidate` に写す。`failed` は `unverifiable` に写す。写した記録には `migrated_from` を付ける。
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

- 観測が `failed` か `delayed` の間、その範囲に依存する照会の証拠の有効期限は延びない。
- 観測が `failed` のとき、既存の値は保つ。値の横に観測の失敗を出す。
- 内容の競合は `conflicts` として別に持つ。走査の成功で競合は消えない。解決の証拠があるときだけ消える。
- 競合の記録は、原記録の位置、拒否した事実の識別、双方の値、解釈の版を持つ。今の seq 301024 は件数と理由だけである。
- 観測の健康状態は snapshot の版の一部として配信する。投影 seq だけでは足りない。

### 2.6 軸の間の規則

軸の間で導いてよい関係は次の表に限る。表にない導出はしない。

| 元の軸 | 先の軸 | 規則 |
| --- | --- | --- |
| プロセスの生存 | turn | `exited_confirmed` なら、`running` と `waiting_*` は `unknown` に落ちる。理由 `process_exited`。`completed` は保つ |
| プロセスの生存 | turn | `unverified` でも turn は自分の鮮度で決める。`alive_confirmed` でも turn の鮮度は延びない |
| プロセスの生存 | 結果 | `exited_confirmed` で必要な段階に達していなければ、結果は `unknown`。`succeeded` にしない |
| 所持 | turn | 導かない。`not_hosted` で turn を変えない |
| 所持 | 閉鎖 | 導かない。`not_hosted` を `closed` にしない |
| 閉鎖 | turn | `closed` でも、同じ世代の turn の開始証拠があれば `open` に戻す。閉鎖から turn の終端を作るのは `SessionEnd` と `thread_closed` だけ |
| turn | 結果 | 導かない。`completed` は結果の証拠ではない |
| 結果 | turn | 導かない。子の結果で親の turn を変えない |
| 配達 | turn | `received` と `received_candidate` は turn の開始の候補になる。`emitted` と `unverifiable` と `rejected` はならない |
| 観測 | 生存と所持 | `failed` なら、その範囲の照会の証拠は失効を早めない。延ばしもしない |
| 親 | 子 | 子のプロセスの生存は親の所有プロセス世代と同じ値。子の turn と結果は子の証拠で決める |

### 2.7 同一性の入力

本書は同一性の設計を決めない。同一性の設計は `identity-redesign.md` を正本にする。
ただし本書の規則は、次の鍵がなければ実装できない。鍵の作り方を provider ごとに定める。
`identity-redesign.md` はこの表を取り込む。

#### 鍵の作り方

| 対象 | 会話の鍵 | run の鍵 | turn の鍵 | 依頼と試行の鍵 |
| --- | --- | --- | --- | --- |
| 外の Claude の対話 | `["claude", <jsonl のファイル名の ID>]` | hook の世代があれば `(会話, 世代)`。なければ `(会話, "transcript", 最初の行の時刻)` で対応表の解決待ち | turn を始めた user 行の uuid。assistant 行は `parentUuid` の連なりで結ぶ。hook の出来事は run に付き、turn には `inferred` で付く | 付けない |
| 外の Claude の子 | `["claude", <toolUseResult.agentId>]` | `(会話, 親の tool_use_id)` | 子の jsonl の turn を始めた行の uuid | 依頼は `(親の run, tool_use_id)`。試行は 1。再起動は新しい `tool_use_id` で新しい依頼 |
| 外の Codex | `["codex", <session_meta の id>]` | `(会話, rollout のファイル)`。再開で新しいファイルなら新しい run | `turn/started` か `task_started` の `turnId` | 付けない |
| Codex の子 | `["codex", <receiverThreadId>]` | `(会話, rollout のファイル)` | `turnId` | 依頼は `(親の run, collabAgentToolCall の item ID)`。試行は 1 |
| managed の Claude | runner の会話 ID。native は `init` の `session_id` で別名 | runner の run ID | SDK の `user_message_uuid` が返れば入力の uuid。返らなければ runner の入力 ID で対応表の解決待ち | 受付の `requestId` と試行の番号 |
| managed の Codex | runner の会話 ID。native は `threadId` で別名 | runner の run ID | `turn/start` の応答の `turnId` | 受付の `requestId` と試行の番号 |
| 旧い kit の記録 | 台帳の会話 ID。`native_id` が 1 件に一致したときだけ | 付けない | 付けない | 記録のファイルと位置 |

#### 未解決の扱い

| 鍵 | 未解決のときの扱い |
| --- | --- |
| 会話 | 会話を `unresolved` にする。確定した単一の会話として表示しない |
| run | 複数の run を 1 つに見せない。`unresolved` にする |
| 所有プロセス世代 | プロセスの生存は `unverified` |
| turn | 同じ turn の照合をしない。後着の終端で別の turn を閉じない |
| 依頼と試行 | 結果を付けない。判定は `unknown` |

- 対応表の版は snapshot の版に含める。
- 情報源を横断して、世代の数値の大小で新旧を決めない。
- 旧い turn の終端が、新しい turn の開始の後に届いても、新しい turn を閉じない。
- 試験は存在しない鍵を補わない。鍵が作れない入力は未解決のまま期待する。

## 3 情報源ごとの証拠と有効期限

### 3.1 証拠の形

すべての証拠は次の形で保存する。

```text
evidence {
  subject        対象の実体。会話か実行か情報源
  axis           process、hosting、closure、turn、result、delivery、observation のどれか
  value          軸の値
  source         情報源
  kind           証拠の種類。process_check、heartbeat、hook_event など
  confidence     confirmed か inferred
  event_ts       出来事の時刻。原記録の時刻。照会の証拠では null
  taken_ts       取得した時刻
  valid_until    有効期限。null は失効しない
  scope          走査の範囲。走査でなければ null
  scan_ok        走査が成功したか。走査でなければ null
  ref            元の記録への参照。fact_id、ファイルと位置、cmd_id
}
```

- `valid_until` が null の証拠は、過去の事実である。終端、閉鎖、結果の段階がこれに当たる。
- `valid_until` を持つ照会の証拠は、`taken_ts` から数える。生存、所持、heartbeat がこれに当たる。
- `valid_until` を持つ出来事の証拠は、`event_ts` から数える。turn の進行と待ち、配達の `emitted` がこれに当たる。

### 3.2 計測の方法と仮の値

根拠のない秒数を規則にしない。計測して決める値は、次の方法で決める。
決まるまでは仮の値を使う。仮の値は、不明に倒れる側に置く。
計測の目標は、誤った確信を減らすことである。期限を延ばすだけでは目標に届かない。

1. 隔離した環境で、偽 CLI の状態を正解にする。製品の投影を正解にしない。
2. 情報源の更新の間隔、走査の成功の間隔、対象の進行の間隔を別々に採取する。
3. 停止、遅延、欠測、時計のずれを注入した標本を混ぜる。更新が止まった標本は、完了した間隔の分布に入らない。
4. 候補の値ごとに、誤った Working と Delivered の最大継続時間と、不要な Unknown の割合を測る。
5. 両方が許容内になる値を選ぶ。許容は利用者と決める。
6. 本番の読み取り専用の台帳で、選んだ値で過去 1 週間を再評価し、結果を記録する。
7. 決めた値と採取の記録を、この表に追記する。計測していない経路は「保証未確定」と明記する。

| 名前 | 使う場所 | 仮の値 | 仮の値の根拠 |
| --- | --- | --- | --- |
| `heartbeat_interval` | managed の heartbeat の間隔 | 10 秒 | 根拠なし。短い側に置く |
| `heartbeat_factor` | heartbeat の期限の係数 | 3 | 根拠なし |
| `claude_scan_interval` | `sessions/*.json` の走査の間隔 | 60 秒 | `sessions.ts:44` の今の値 |
| `codex_scan_interval` | `ps` と `lsof` の走査の間隔 | 30 秒 | `codex/sessions.ts:7` の今の値 |
| `scan_factor` | 走査の照会の証拠の期限の係数 | 2 | 根拠なし。短い側に置く |
| `progress_window` | turn の進行の窓 | 5 分 | 根拠なし。S2 の 40 分の turn は道具の行で進行が続く前提。続かなければ Unknown に倒す |
| `waiting_window` | 観測した待ちの窓 | 5 分 | `progress_window` と同じ |
| `delivery_deadline` | 配達の期限 | 60 秒 | `send-watch.ts:8` の今の値。計測なし |
| `delivery_max_wait` | キューの候補を待つ上限 | 24 時間 | `send-watch.ts:11` の今の値 |
| `clock_skew` | 候補の時刻の許容 | 0 秒 | 根拠なし。候補を落とす側に置く |
| `body_retention` | 配達の記録の本文の保持 | 7 日 | `send-watch.ts:10` の今の値 |
| `tombstone_retention` | 墓標の保持 | 無期限 | 再送の禁止は墓標が正本 |
| `codex_absent_grace` | Codex の不在の猶予 | 2 分 | `codex/sessions.ts:8` の今の値。E6 で 155.5 秒の一例。妥当性は未確認 |

### 3.3 情報源の表

| 情報源 | 出せる証拠 | 証拠の種類 | 期限の起点 | 今の実装の位置 |
| --- | --- | --- | --- | --- |
| managed の runner | 子プロセスの handle、PID、OS の開始値、heartbeat、終了コード、`session_state_changed`、承認、結果、送信の相関 ID | 照会と出来事 | heartbeat は `taken_ts`。状態の通知は `event_ts` | `packages/runner/src/supervisor.ts:125-145`、`recovery.ts:69` |
| ブラウザから起こした端末 | PTY の pid と OS の開始値、`onExit`、画面の内容、`sessions/<pid>.json` の sessionId | 照会 | 所有者が直接知る。所有者が api の間は api の寿命が上限 | `packages/api/src/terminal/hosts.ts:161-224`、`292-298`、`354` |
| 外で動く Claude の会話 | jsonl の行、`sessions/*.json` の PID と `procStart` | 出来事と照会 | 行は `event_ts`。走査は `taken_ts` | `packages/api/src/observe/claude/sessions.ts`、`context.ts` |
| Claude の子 | `subagents/*.jsonl` の行、`SubagentStop`、`SubagentHandback` の呼び出しと結果、親の `Agent` の `tool_use` と `tool_result` | 出来事 | `event_ts`。プロセスの生存は親の照会に従う | `packages/api/src/observe/session-query.ts:28` は子を走査から除く |
| Codex | rollout の行、`ps` と `lsof` の走査、`thread/status/changed` | 出来事と照会 | 行は `event_ts`。走査は `taken_ts` | `packages/api/src/observe/codex/sessions.ts:44-81`、`119-132` |
| hook | `SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd` と `reason`、世代 | 出来事 | `event_ts`。失効しない | `packages/api/src/hook/index.ts:40-77` |
| transcript | 行の種類と時刻、`message.id`、`parentUuid`、`stop_reason`、attachment の `hookEvent`、`turn_duration`、`compact_boundary`、`continued-in` | 出来事 | `event_ts` | `packages/core/src/ledger/turns.ts:53-95`、`observe/claude/context.ts:114-141` |
| `sessions/*.json` | `pid`、`procStart`、`sessionId`、`cwd`、`status`、`kind`、`messagingSocketPath` | 照会 | `taken_ts` | `sessions.ts:17-38` |

### 3.4 情報源ごとの注意

#### managed の runner

- runner は起動時に `pid` を書く。`supervisor.ts:137`。heartbeat は書かない。
- 再起動時は `markUnknown("restart")` で全実行を `unknown` にする。`supervisor.ts:58-64`。この規則は保つ。
- heartbeat を新設する。runner が所有プロセス世代ごとに `taken_ts` を更新する。台帳の事実にはせず、証拠の表に書く。
- 子プロセスの終了は `host_exit` で物理終了になる。`supervisor.ts:200-204`。この規則は保つ。
- `send` は今は戻り値がない。`packages/runner/src/hosts/claude/index.ts:158`、`hosts/codex/index.ts:164`。送信ごとに相関 ID を作り、`cmd_id` との対応を永続化し、受信側の応答と結ぶ。
- Codex は `turn/start` の応答の `turnId` を相関 ID にする。
- Claude の SDK には `user_message_uuid` と `user_message_uuids` の欄がある。2.1.299 と 2.1.300 の実行ファイルで確認した。複数の入力を 1 つの turn にまとめる形式があり、常に一対一ではない。
- 利用中の SDK の設定で、送信の uuid と受信の uuid が往復することは未確認である。既存の transcript 759 件に標本がない。往復が確認できるまで、この経路の上限は `received_candidate` である。
- 欠けた ID を FIFO や本文で補って `received` にしない。

#### ブラウザから起こした端末

- 今は api が PTY を所有する。api の `close` は PTY を kill する。`hosts.ts:354`。
- PTY の `onExit` は listener に通知するだけで、台帳に終了を残さない。`hosts.ts:292-298`。
- 所有を runner へ移す。これは本書の受け入れの前提である。移るまで 8 節の `14-api-restart-keeps-pty` は通らず、受け入れは合格にならない。
- 移るまでの間は、api の停止を「プロセスの生存 `unverified`、理由 `owner_restarted`」として扱う。終了と結果と閉鎖の事実は保つ。
- 端末の sessionId は `sessions/<pid>.json` から読む。`hosts.ts:161-171`。`/clear` で変わる。
- 端末の画面は送出の可否と `terminal_handled` の根拠にする。`received` の根拠にはしない。
- 端末の画面の読み取りの結果は `screen` の欄に持つ。値は `prompt`、`panel`、`selection`、`blocked`、`unknown` である。`sessions/*.json` の `status` とは別の欄である。
- `hosts.ts:118` の拒否判定は、`:111` の Ctrl-U と `:115` の貼り付けより後にある。この位置で止めた操作は `rejected` ではなく `unverifiable` である。

#### 外で動く Claude の会話

- プロセスの生存は PID と OS の開始値の走査で決める。登録に PID があり、OS に同じ組があれば `alive_confirmed` である。
- 走査が成功し、登録の PID が OS にないときは、その所有プロセス世代は `exited_confirmed` である。登録自体がない会話は所持 `not_hosted` である。
- 今の `sessions.ts:55-58` は不在を `idle` と書く。これを「所持 `not_hosted`、turn は変えない」に改める。
- `sessions/*.json` の `status` は出来事のときに更新される。固定周期の heartbeat ではない。生存にも終了にも使わない。
- `status` の値は 2.1.299 と 2.1.300 の読み取りで `busy`、`shell`、`idle`、`waiting` の 4 値である。`waiting` は入力待ちと承認待ちの両方を含む。`status = waiting` だけで `waiting_approval` にしない。
- `interactive` は `kind` の値である。`status` の値ではない。
- `kind` は対話と委譲を一意に分ける仕様とは確認できていない。単独で結果の適用対象を決めない。

#### Claude の子

- 子は `subagents/<agent id>.jsonl` に記録される。`sessionId` は親を指す。
- 親の `Agent` の `tool_use` と `tool_result` を `tool_use_id` で結ぶ。`tool_result` の行のトップレベルの `toolUseResult.agentId` が子の ID である。`tool_result` ブロックの中の欄ではない。
- 非同期の起動は `toolUseResult.status = async_launched` と `isAsync = true` である。段階は `launched`。本番の関連付けできた記録は 379 件である。
- 同期の起動は `tool_use` の `run_in_background = false` で、結果は `toolUseResult.status = completed`、`agentId`、`content` の text ブロックの配列である。`isAsync` はない。2.1.291 と 2.1.292 の実記録 3 件で確認した。段階は `responded` で、turn の終端は `confirmed` である。
- `completed` は子が応答を返した形式である。受け入れ検証やレビューの合格ではない。
- 子の turn の終端は 2.2.1 の表に従う。`SubagentStop` は `inferred`、親の `completed` は `confirmed` である。
- 子のプロセスの生存は親の所有プロセス世代に従う。子の turn の鮮度は子の行で決める。
- 親が `exited_confirmed` で子に必要な段階の証拠がなければ、子の結果は `unknown` である。

#### Codex

- 走査は `ps` と `lsof` で、codex プロセスが開く rollout を集める。`sessions.ts:44-81`。
- 走査の部分成功は例外で捨てる。`:79`。この規則は保つ。
- 今は不在を `idle` と書く。`:126-129`。これを「所持 `not_hosted`」に改め、turn は最後の turn の証拠のままにする。
- 開いたファイルの不在は、特定のプロセスの終了を意味しない。プロセスの生存は PID と開始値を持つ managed だけで決める。
- 2 分の猶予は、最後の記録時刻と最後の証拠時刻の大きい方から数える。`:122`。作成時刻からではない。
- E6 では最後の行から不在の記録まで 155.539 秒だった。一例であり、2 分が安全である測定ではない。保存された不在の証拠には PID も開始値も走査の全結果もない。
- 発見の遅れと、活動中にファイルが開かれていない期間を分けて測る。3.2 の方法に従う。

#### hook

- hook は出来事のときだけ動く。生存の根拠にしない。
- 世代は outbox のファイルで決める。`hook-v2/index.ts:59-88`。`startup` と `resume` で新しくなる。
- 会話 ID は `claude:<id>` の形で書く。`hook/index.ts:40`。2.7 の対応表で結ぶ。
- `SessionEnd` は同じ世代の閉鎖になる。その後の同じ世代の turn の開始で、閉鎖を `open` に戻す。`runs.ts:48-62` の規則は保つ。
- `Stop` は `inferred` の終端である。Stop hook の続行で turn が続くからである。
- hook の `UserPromptSubmit` は transcript の turn の鍵と確定して結べない。hook の出来事は run に付き、turn には `inferred` で付く。

#### transcript

- 行の読み替えは `turns.ts:53-95` の規則に従う。版は `TURN_RULE_VERSION = 3` である。
- `turns.ts:90-93` の「本文だけの行を完了にする」規則は廃止する。版を上げる。
- `turns.ts:58` と `:62` と `:88` の終端は、2.2.1 の確度を付けて保つ。
- 同じ状態が続く行から新しい事実を作らない。`context.ts:134`。進行の鮮度は、事実ではなく証拠の表で `event_ts` から決める。
- `isMeta`、`isCompactSummary`、`<bash-input>` などの行は turn の根拠にしない。`turns.ts:36`、`claude-message-flags.ts`。
- transcript の `run.created` は hook がないときだけ作る。`context.ts:116-124`。hook の後着で別の run が残る問題は 2.7 の run の対応表で結ぶ。
- message の解釈の訂正は、turn の解釈の版とは別の版を持つ。E4 が実例である。

#### `sessions/*.json`

- 1 件でも読めないか壊れていれば、その周期の走査は失敗である。`sessions.ts:27-28`、`:35`、`:38`。
- 失敗した周期では不在を書かない。この規則は保つ。
- 失敗した周期では、観測の健康状態を `failed` にする。これを新設する。
- `kill(pid, 0)` の `EPERM` は生存とも不在とも判定しない。`:35`。この規則は保つ。
- `messagingSocketPath` の peer protocol には `peer_message_status` と `orig_msg_id` による返答がある。値は `held`、`denied`、`expired`、`delivered`、`refused`、`dropped` である。
- 任意の入力に受領の返答が返ること、重複を排除すること、再起動後に照会できることは未確認である。この経路は相関 ID の手段として使わない。5.4 の表にも載せない。

## 4 画面の言葉

### 4.1 代表の状態と結果の印

行には代表の状態を 1 つ出す。依頼の種類の実体には、結果の印を別に 1 つ添える。
代表の状態は 4.2 の決定表だけが決める。結果の印は 4.3 の表だけが決める。
2.6 と 6.4 と 7 と 8 の表示は、この 2 つの表から引いた結果である。
過去の成功と現在の生存は併記できる。混ぜない。

### 4.2 代表の状態の決定表

次の順で最初に当たった行を使う。順を飛ばさない。
入力は同一性、プロセスの生存、所持、閉鎖、turn の値と確度である。

| 順 | 条件 | 画面の言葉 | 添える情報 |
| --- | --- | --- | --- |
| 1 | 同一性が `unresolved` | Unresolved | 候補の数 |
| 2 | プロセスの生存が `exited_confirmed` | Stopped | 終了の根拠の種類 |
| 3 | turn が `waiting_approval` | Needs approval | 待ち始めからの時間。生存が `unverified` なら「liveness unverified」 |
| 4 | turn が `waiting_input` | Waiting | 待ち始めからの時間。生存が `unverified` なら「liveness unverified」 |
| 5 | turn が `running` | Working | 最後の進行の時刻。生存が `unverified` なら「liveness unverified」 |
| 6 | 閉鎖が `closed` | Closed | 閉鎖の根拠の種類 |
| 7 | 所持が `not_hosted` | Not hosted | 走査の時刻。turn が `completed` なら「last turn finished」 |
| 8 | turn が `completed` で確度 `confirmed` | Idle | 生存が `alive_confirmed` でなければ「last seen」 |
| 9 | turn が `completed` で確度 `inferred` | Idle | 「unconfirmed」と、生存が `alive_confirmed` でなければ「last seen」 |
| 10 | turn が `unknown` | Unknown | 最後の証拠の時刻と理由 |

- この表はすべての組を 1 つの行に写す。turn の 5 値と確度、生存の 3 値、所持の 3 値、閉鎖の 3 値、同一性の 2 値の全組に対して、順 1 から 10 のどれかが当たる。
- 順 3 から 5 は、生存が `unverified` でも turn の値を出す。確かめられた turn の情報を Unknown で覆わない。
- 親が `exited_confirmed` の子は、順 2 で Stopped になる。2.6 の規則で turn は `unknown` に落ちているが、順 2 が先に当たる。
- Stopped と Closed と Not hosted は Done ではない。
- 今の `packages/dashboard/app/src/lib/i18n.ts:14-15` は `ended` を Done に写す。これを Stopped か Closed に改める。

### 4.3 結果の印

| 判定 | 画面の言葉 | 添える情報 |
| --- | --- | --- |
| `succeeded` | Done | 達した段階 |
| `failed` | Failed | 失敗した段階と原因 |
| `interrupted` | Interrupted | なし |
| `incomplete` | 印なし | 達した段階と `report_failures` を詳細に出す |
| `unknown` | No result | 最後の証拠の時刻と理由 |

- Done は `succeeded` からだけ出す。他の値からは出さない。
- 対話の会話と、画面から起こした managed の実行には結果の印を出さない。
- 子と委譲とタスクの節は、代表の状態と結果の印の両方を出す。例は「Idle · Done」と「Stopped · No result」である。
- 成功した旧い試行と実行中の新しい試行は、試行ごとに出す。行の代表は最新の試行である。

### 4.4 不明の見せ方

- Unknown と Unresolved は灰色の破線で出す。色だけに頼らない。
- Unknown には必ず「last seen」と最後の証拠の時刻を添える。例は「Unknown · last seen 29h ago · progress expired」である。
- 理由は 6.7 の語彙から選ぶ。
- 観測が `failed` か `delayed` の範囲があるときは、画面の上に 1 行で出す。例は「Observation of Claude sessions failed since 14:02」である。
- 未解決の競合がある会話には、見出しに「History conflict · unresolved」を出す。
- 画面が切断しているか、受け取った版が古いときは、「as of 14:02」と出す。現在の状態だと誤認させない。
- Unknown を Idle や Done に丸めない。Unknown の件数を一覧に出す。

### 4.5 配達の言葉

| 画面の言葉 | 配達の値と条件 | 見せ方 |
| --- | --- | --- |
| Sending | `accepted`、`emitting`、`emitted` | 吹き出しの横に出す。上限は受信か期限まで |
| Queued | `received` で、相関 ID が未吸収のキューの項目を指す | 吹き出しの横に出す |
| Likely queued | `received_candidate` で、候補が `queued_command` の記録であり、対応する user 行がない | 吹き出しの横に薄く出す。詳細に候補の根拠を出す |
| Delivered | `received` | 印を出さない。通知もしない |
| Likely delivered | `received_candidate` | 薄い印を出す。詳細に候補の根拠を出す |
| Handled in terminal | `terminal_handled` | 端末の結果を一時表示する |
| Not delivered | `rejected` | 警告と理由を出す。Resend を出す |
| Unconfirmed | `unverifiable` | 注意と範囲を出す。Resend は出すが、二重になり得ると明記する |

- Not delivered は `rejected` にだけ使う。
- 今の `Message.tsx:113` は `failed` を Not delivered と出す。これを Unconfirmed に改める。
- Queued は、相関 ID のない経路では出ない。PTY の経路の上限は Likely queued である。

## 5 配達の契約

### 5.1 所有者と一回性

- 送出は所有者だけが行う。所有者は今は api、移行後は runner である。
- 所有者は `cmd_id` ごとに、`accepted` から `emitting` へ 1 回だけ進める。並行する同じ `cmd_id` は 1 つにまとめる。
- 同じ `cmd_id` で本文か対象が違う要求は、配達の値を作らず誤りの ack を返す。理由は `cmd_id_conflict` である。
- 今の `ws/index.ts:224-247` はメモリ上の `sessionCommands` で抑止する。`send-watch.ts:82-101` は送出の後に記録する。どちらも改める。

### 5.2 記録と墓標

配達の記録は 2 つの部分に分ける。本文と墓標である。

| 部分 | 内容 | 保持 |
| --- | --- | --- |
| 本文 | 本文のハッシュ、添付の一覧、候補の根拠、画面の結果 | `body_retention` を過ぎたら消す |
| 墓標 | `cmd_id`、対象の会話 ID、本文のハッシュ、最終の値、最終の時刻、`retry_of` | 消さない |

- 墓標は再送の禁止の正本である。本文を消しても墓標は残る。
- 所有者は `cmd_id` を受けたら、まず墓標を引く。墓標があれば最終の値を返し、送出しない。
- 墓標がなく本文もない `cmd_id` だけを新しい操作として扱う。
- 本文を消した後の `cmd_id` の再送は、墓標の値を返す。理由に `body_expired` を添える。
- 画面は `cmd_id` に接続の世代を含めない。墓標が同一性の唯一の根拠である。

### 5.3 送信の前の記録

1. 画面は操作ごとに `cmd_id` を作る。再送でも同じ値を使う。
2. 所有者は副作用の前に、`cmd_id`、対象の会話 ID、対象の実行の世代、端末 ID か所有プロセス世代、本文のハッシュ、添付の一覧、受付時刻を永続化する。値は `accepted` である。墓標も同時に作る。
3. 永続化が成功してから送出に進む。永続化に失敗したら送出せず、失敗の ack を返す。
4. 所有者は最初の端末への書き込みか SDK の呼び出しの直前に `emitting` と `emitting_ts` を記録する。
5. 対象の確認は `emitting` の記録と同じ時点で行う。確認から最初の書き込みまでの間に、起動待ちと添付の処理を挟まない。
6. Enter の書き込みか SDK の呼び出しが返ったら `emitted` と `emitted_ts` を記録する。

### 5.4 対象の確認と拒否

- `emitting` の直前に、対象の会話 ID と端末の sessionId が一致することを確かめる。`hosts.ts:93-95` の規則は保つ。
- 対象の実行の世代が、記録した世代と違えば `rejected` にする。理由は `target_changed` である。
- 画面が `blocked`、`panel`、`selection` なら `rejected` にする。理由は `terminal_blocked` である。この確認は最初の書き込みより前に行う。
- `rejected` は最初の書き込みより前に止めた操作だけである。書き込みの後の中止は `unverifiable` にする。
- `rejected` は下書きを保つ。画面は本文を消さない。

### 5.5 受信側の証拠の優先

受信の証拠は、強い順に次を使う。上の証拠があれば下は使わない。
照合の対象は `emitting`、`emitted`、`unverifiable` の記録だけである。`rejected` は照合しない。

| 順 | 証拠 | 得られる経路 | 値 | 確度 |
| --- | --- | --- | --- | --- |
| 1 | 受信側の相関 ID | Codex の `turn/start` の `turnId`。Claude の SDK で `user_message_uuid` の往復が確認できた設定 | `received` | `confirmed` |
| 2 | 範囲内の唯一の候補 | 対象の会話の記録に、5.6 の時刻の範囲内で、正規化した本文が一致する受信の記録が 1 件だけある | `received_candidate` | `inferred` |
| 3 | 端末の画面の結果 | スラッシュコマンドの結果か選択欄を画面で確認した | `terminal_handled` | `inferred` |
| 4 | 端末の画面の反応 | 入力欄が空になり、応答の描画が始まった | `emitted` の補強 | `inferred` |

- 候補が 2 件以上なら `unverifiable` にする。どれが自分の送信か決められないからである。
- 候補が 1 件でも `received` にしない。本製品の送信が失われ、外から同じ文が 1 回入った世界と、届いた世界は同じ観測だからである。
- `queued_command` の attachment、`<bash-input>` の行、`<command-name>` の行は、入力の種類の印である。順 2 の候補として扱う。
- peer protocol は順 1 に含めない。3.4 の未確認が解けるまで使わない。
- PTY の Claude には相関 ID がない。この経路の上限は `received_candidate` である。

### 5.6 時刻の範囲

- 候補の受信の記録は、`event_ts` が `emitting_ts − clock_skew` 以上のものだけを使う。
- `emitting_ts` は所有者の時計である。`event_ts` は CLI の時計である。同じ計算機だが、ずれを `clock_skew` で許す。
- `clock_skew` の仮の値は 0 秒である。ずれで `event_ts` が先になった記録は候補から落ち、結果は `unverifiable` に倒れる。
- `clock_skew` は 3.2 の方法で、CLI の記録の時刻と所有者の送出の時刻の差を採取して決める。
- 時刻の比較は候補の範囲を絞るためだけに使う。相関の代わりにしない。
- 候補の上限の時刻は置かない。遅く取り込まれた記録も `event_ts` が範囲内なら候補になる。

### 5.7 期限

| 送出の時点の turn | 期限の起点 | 期限 |
| --- | --- | --- |
| `completed` か `unknown` | `emitted_ts` | `delivery_deadline` |
| `running`、`waiting_approval`、`waiting_input` | `emitted_ts` | キューの候補が現れるまで待つ。上限は `delivery_max_wait` |
| 待ちの途中で turn が `completed` か `unknown` になった | turn が変わった `event_ts` | `delivery_deadline` |

- 期限を過ぎたら `unverifiable` にする。「未着」と断定しない。
- キューの候補が現れたら `received_candidate` にし、期限を外す。吸収で user 行が現れても値は変えない。
- 所有者が `emitting` か `emitted` のまま止まった場合は、再起動後に `unverifiable` にする。理由は `owner_restarted` である。
- 所有者が `accepted` のまま止まった場合は、再起動後に `rejected` にする。理由は `not_emitted` である。端末に書いていないからである。
- `unverifiable` の後に相関証拠が来たら `received` に直す。候補が来たら `received_candidate` に直す。
- 旧い `failed` から写した `unverifiable` も同じ規則で直す。旧い記録には `emitting_ts` がないため、`sent_ts` を代わりに使う。

### 5.8 自動で再送しない

- 所有者は自動で再送しない。api も runner も再送しない。
- 画面の再接続時に `cmd_id` を送り直すのは、ack を取り直すためである。所有者は墓標か記録の値を返す。送出しない。
- 利用者の Resend は新しい `cmd_id` を作る。元の操作との関係 `retry_of` を墓標に書く。元の値は変えない。
- `unverifiable` と `received_candidate` の Resend には「届いていた場合は二重になる」と表示する。

### 5.9 入力の種類ごとの扱い

| 入力 | 送出の形 | 受信の証拠 | 配達の上限 | turn への影響 |
| --- | --- | --- | --- | --- |
| 普通の発言 | 貼り付けと Enter | 5.5 の順 | PTY は `received_candidate`。相関 ID のある経路は `received` | 候補か確定で turn の開始の候補になる |
| 作業中の発言 | 貼り付けと Enter | `queued_command` の attachment の候補 | `received_candidate`。画面は Likely queued | turn は変えない。吸収で user 行が出る |
| `!` の命令 | 貼り付けと Enter | `<bash-input>` の行の候補。先頭の `!` とタグを除いて比べる | `received_candidate` | turn の開始にしない。`turns.ts:36` の規則は保つ |
| `/compact` | 貼り付けと Enter | `<command-name>` の行の候補 | `received_candidate` | turn の開始にしない |
| 他のスラッシュコマンド | 貼り付けと Enter と画面の読み取り | 端末の画面の結果 | `terminal_handled` | 変えない。`/clear` は対象を変える |
| 選択画面を開くコマンド | 貼り付けと Enter | 画面が `selection` になった | `terminal_handled`。`screen = selection` | 変えない。端末タブへ引き継ぐ |
| 同じ文を別の端末から打った | 本製品は送出していない | 候補が増えるか、本製品の候補と区別できない | 本製品の送信は `received_candidate` か `unverifiable` | その行は turn の開始の候補になる |

- 同じ文を 2 回続けて送った場合、PTY では 2 件の候補が 2 つの `cmd_id` に一意に結べない。両方 `unverifiable` にする。
- 相関 ID のある経路だけが、同じ文の 2 回を両方 `received` にできる。
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
- 再構築は、観測の集合と `taken_ts` と `evaluated_ts` を入力に取る。同じ入力なら同じ snapshot になる。

### 6.3 いつ動くか

| 契機 | 動き |
| --- | --- |
| 周期 | 1 秒ごとに全実体の有効期限を見る。期限切れを `unverified` と `unknown` に落とす。周期は `OBSERVATION_POLL_MS` と同じにする |
| 事実の追記 | 追記された実体の軸を再計算する |
| 走査の完了 | 走査の範囲にある実体の生存と所持を更新する。失敗なら観測の健康状態だけ更新する |
| 配達の記録の更新 | `cmd_id` の記録を更新する。受信の証拠を探す |
| 対応表の更新 | 影響する実体を再計算する。`identity_version` を進める |
| 解釈の版の有効化 | 範囲の再読が終わった実体を新しい版で再計算する |
| 画面の接続 | 最新の snapshot の版を返す |
| api の起動 | 失効する照会の証拠だけを `unverified` と `unknown` にする。理由は `owner_restarted`。終端と閉鎖と結果の事実は保つ |

### 6.4 どう直すか

この表の画面の言葉は 4.2 と 4.3 から引いた結果である。

| 画面の値 | 外の世界の今 | 軸の変化 | 直した後の画面 |
| --- | --- | --- | --- |
| Working | 進行の証拠が失効した | turn `unknown`、理由 `progress_expired` | Unknown |
| Working | 生存証拠が失効した | 生存 `unverified`。turn は変わらない | Working と「liveness unverified」 |
| Working | 走査が成功し、PID と OS の開始値が不在 | 生存 `exited_confirmed`。turn `unknown`、理由 `process_exited` | Stopped |
| Working | 親が終了確認済みの子 | 生存 `exited_confirmed`。turn `unknown`。結果 `unknown` | Stopped と No result |
| Working | 親が生きていて、子の進行の証拠が失効した | turn `unknown`、理由 `progress_expired` | Unknown |
| Working | Stop の attachment が来て、その後に進行がない | turn `completed`、確度 `inferred` | Idle と「unconfirmed」 |
| Idle と「unconfirmed」 | Stop hook が続行し、進行の証拠が来た | turn `running` | Working |
| Idle と「unconfirmed」 | `turn_duration` が来た | turn `completed`、確度 `confirmed` | Idle |
| Closed | 同じ世代の新しい turn の開始証拠が来た | 閉鎖 `open`。turn `running` | Working |
| Not hosted | 次の走査で登録か開いたファイルが見つかった | 所持 `hosted` | turn に従う |
| Not hosted | 走査が期限を過ぎた | 所持 `unknown` | turn に従う |
| Stopped | 同じ所有プロセス世代の新しい証拠が来た | 変えない。別の所有プロセス世代として扱う | Stopped |
| Idle | 生存証拠が失効した | 生存 `unverified` | Idle と「last seen」 |
| Done | 必要な段階の証拠がない | 結果 `incomplete` か `unknown` | 印なしか No result |
| 単一の実行 | 対応表が未解決になった | 同一性 `unresolved` | Unresolved |
| Unconfirmed | 受信の候補か相関証拠が後から来た | 配達 `received_candidate` か `received` | Likely delivered か Delivered |
| Not delivered | 同じ文が後から記録に入った | 変えない。`rejected` は照合しない | Not delivered |
| 最新の表示 | 観測が遅れている | 観測 `delayed` | 「Observation delayed」 |
| 現在の表示 | 画面が切断した | 変えない | 「as of」と最後の版の時刻 |

### 6.5 解釈の版の移行

- 解釈の版を上げるときは、新しい版の事実を準備中の版に蓄える。
- 対象の範囲の再読が終わるまで、その範囲の実体は旧い版で表示し、観測の健康状態を `delayed` にする。理由は `reinterpretation_pending` である。
- 範囲の再読が終わったら、一括で新しい版を有効にする。`interpretation_version` を進める。
- 再読が中断したら、再開後に続きから読む。中断の時点を記録する。
- 部分的に失敗した範囲は、旧い版のまま `delayed` を保つ。
- 原記録が欠けた範囲は、旧い版を保ち、理由に `source_missing` を書く。
- turn の解釈と message の解釈は別の版を持つ。
- 原記録にある情報を解釈が落としていた場合は、再解釈で拾う。E4 のフラグがこれに当たる。
- 原記録にない情報は、訂正の事実が来るまで分からない。来るまでは原記録どおりに表示し、来たら訂正に従う。
- 今の `runs.ts:79-93` は subject ごとの最大の版を選ぶ。範囲の完了を待たないため、一括の有効化に置き換える。

### 6.6 競合の扱い

- 競合は、原記録の位置、拒否した事実の識別、双方の値、解釈の版を持つ記録として残す。
- 競合は走査の成功で消えない。原記録の再読で双方の値が一致したとき、利用者が訂正したときだけ解決する。
- 競合がある範囲の turn の証拠は、解決まで `inferred` に落とす。
- 今の seq 301024 の記録には位置と識別がない。解決の証拠を作れないため、未解決として残す。

### 6.7 語彙と欄

理由の語彙はこの一覧だけである。snapshot の欄もここで定める。

| 理由 | 使う軸 | 意味 |
| --- | --- | --- |
| `liveness_expired` | 生存 | 生存の照会の証拠が失効した |
| `progress_expired` | turn | 進行の出来事の証拠が窓を超えた |
| `waiting_expired` | turn | 待ちの証拠が窓を超えた |
| `process_exited` | turn | プロセスの生存が `exited_confirmed` になった |
| `boundary_unavailable` | turn | 終端を取れない形式である |
| `scan_failed` | 生存、所持、観測 | 走査が失敗した |
| `scan_expired` | 所持 | 走査の照会の証拠が失効した |
| `out_of_scope` | 観測 | 走査の範囲外である |
| `owner_restarted` | 生存、配達 | 所有者が再起動した |
| `parent_exited` | 結果 | 親が終了し、必要な段階に達していない |
| `missing_evidence` | すべて | 証拠がない |
| `reinterpretation_pending` | 観測 | 解釈の再読が途中である |
| `source_missing` | 観測 | 原記録が欠けている |
| `identity_unresolved` | 同一性 | 対応表が未解決である |
| `required_stage_unknown` | 結果 | 依頼の種類を識別できない |
| `target_changed` | 配達 | 対象の世代が変わった |
| `terminal_blocked` | 配達 | 画面が塞がれていた |
| `not_emitted` | 配達 | 所有者が送出前に止まった |
| `aborted_after_write` | 配達 | 書き込みの後に中止した |
| `cmd_id_conflict` | 配達 | 同じ ID で本文か対象が違う |
| `body_expired` | 配達 | 本文を消した後の再送である |

| 欄 | 値 |
| --- | --- |
| `screen` | `prompt`、`panel`、`selection`、`blocked`、`unknown` |
| `confidence` | `confirmed`、`inferred` |
| `report_failures` | 報告の操作の失敗の理由の一覧 |
| `migrated_from` | 旧い配達の記録の値 |

## 7 本番の実例

実例は `architecture-critique.md` の E1 から E6 である。レビューの再照合に合わせて当てはめを直した。
時点は 2026-10-15 の 06:13 から 06:53 の読み取りである。表示は 4.2 と 4.3 から引く。

### E1 29 時間以上前の開始証拠で子を running に保つ

- 対象は `agent-a46a60f85e3267c52` である。`runs` は running で、`last_evidence_ts` は `2026-10-14T00:10:09.463Z` である。
- 親の記録では、`Agent` の `tool_result` が `async_launched` で、`toolUseResult.agentId` が子を指す。seq 298560 である。段階は `launched`、必要な段階は `reported` である。
- 子の記録は 271 行で、末尾は `00:18:12.045Z` の Bash の呼び出しである。終端はない。
- プロセスの生存は `unverified` である。子は PID と開始値を持たず、親の所有プロセス世代も確認できない。親の後の `SessionEnd` は閉鎖であり、物理終了ではない。
- turn は `unknown` である。理由は `progress_expired`。最後の進行は `00:18:12.045Z` である。
- 結果は `incomplete` である。親が `exited_confirmed` と確認できないため `unknown` にはならない。
- 4.2 の順 10 で、表示は「Unknown · last seen 2026-10-14 00:18 · progress expired」である。結果の印は印なしで、詳細に段階 `launched` を出す。
- 同じ親子の形の `agent-a5358e578dcf966d6` は、読み取り時点で `SubagentHandback` の呼び出し、`toolUseResult.success = true`、`SubagentStop` が揃っている。seq 307689、307695、307699 である。
- その時点の軸は、turn `completed` で確度 `inferred`、段階 `reported`、判定 `succeeded` である。
- 4.2 の順 9 で、表示は「Idle · unconfirmed · last seen」と結果の印「Done」である。親の生存だけで Working にしない。

### E2 届いた二件を未着として保存する

- 対象の会話は `1c0d055c-8912-452b-b273-47e9874df7e8` である。watch は `896eb201` と `8dceda21` で、調査時も `failed` だった。
- jsonl には `<bash-input>` の行が、送出の 13 ms 後と 11 ms 後の出来事の時刻である。本文は正規化後に一致する。
- `<bash-input>` は入力の種類の印である。本製品の `cmd_id` を含まない。送信元を証明しない。
- 旧い `failed` は `unverifiable` に写す。その後の照合で候補が 1 件ずつ見つかり、`received_candidate` になる。
- 4.5 で、表示は「Likely delivered」の薄い印である。Not delivered も Unconfirmed も出さない。Delivered の確定も出さない。
- turn は変えない。`!` の命令は turn の開始にしない。

### E3 同じ会話に別々の世代と終状態が残る

- 対象は `396247a1-5fc0-48e2-b984-2f4a8dac1f17` である。transcript の run は idle、hook の run は ended で、二本が残っている。
- seq 301178 は transcript の完了、301179 は `SessionEnd` で `reason = other`、301180 は後着の `Stop` である。
- 両方の run に PID と開始値がない。調査時の PID の有無は未確認である。過去の ps の出力は現在の証明に使えない。
- 2.7 の run の対応表が未解決である。2 つの run を 1 つの実行として表示しない。
- 4.2 の順 1 で、表示は「Unresolved · 2 runs」である。Stopped も Done も出さない。
- 対応表が 2 つを同じ実行に結んだ後は、閉鎖 `closed` と turn `completed` から、順 6 で「Closed · session end」になる。

### E4 圧縮要約の意味は後日の再解釈で修正されている

- 対象の message は `8f97c4a9-1cd5-4caf-947f-e9cf39e6ebcb` である。seq 251644 にフラグがなく、seq 289242 の `message.corrected` で足した。
- 原記録にはフラグがある。解釈がフラグを落としていた。これは 6.5 の再解釈で拾う場合である。
- 現行の `turns.ts:65` はこの行を turn の根拠から除く。過去のすべての投影が無影響だったとは証明しない。
- 再解釈の有効化の前は、旧い版の表示を保つ。その会話に「Reinterpretation pending」を出す。
- 有効化の後は、要約を利用者の発言として出さない。状態の軸には影響しない。

### E5 競合を記録して旧い内容を保持する

- 対象は `354000b1-4a87-45e8-baa7-6c1fa209d741.jsonl` で、seq 301024 に `observation.unsupported` がある。count は 5 である。
- count は `AppendResult` の競合の数である。`service/index.ts:333`、`:343`。原記録 5 行や turn 5 件を意味しない。
- 記録には競合した事実の識別と原記録の位置がない。元の 5 件は特定できない。
- 6.6 の未解決の競合である。走査の成功で消えない。
- 表示は、見出しに「History conflict · unresolved · 5 rejected appends」を出すことである。範囲は特定できないため、会話全体に出す。
- 代表の状態は生存と turn の証拠に従う。競合の範囲を特定できないため、この会話の turn の証拠は `inferred` に落とす。

### E6 Codex には不在照合が実際に働いている

- 対象は `01a12a12-39e2-7e10-a459-95926539bae6` の世代 1 である。seq 259872 で `process_absent` の idle になった。
- rollout は 43 行で、末尾は `08:27:21.582Z` の assistant の `commentary` である。`task_complete` も `turn_aborted` もない。
- 最後の行から不在の記録まで 155.539 秒だった。保存された証拠には PID も開始値も走査の全結果もない。
- 走査の時点では、所持が `not_hosted` で、範囲はローカルの codex プロセスが開く rollout である。この証拠は走査の間隔の係数倍で失効する。
- 読み取りの時点では、所持は `unknown` である。理由は `scan_expired`。
- プロセスの生存は `unverified` である。閉鎖は `open` である。閉鎖の証拠がない。
- turn は `unknown` である。理由は `progress_expired`。最後の進行は `08:27:21.582Z` の `task_started` 以降の行である。
- 4.2 の順 10 で、表示は「Unknown · last seen 2026-10-11 08:27 · progress expired」である。Stopped でも Closed でもない。
- 走査の直後の時点なら、順 7 で「Not hosted」である。

## 8 受け入れの条件

`scripts/e2e/run.mjs` に次の項目を足す。項目の名前は既存の `1-claude` から `10` に続ける。
正解は偽 CLI の `state.json` と `events.jsonl` に持つ。製品の投影を正解にしない。
期待は `/snapshot` の値で判定する。snapshot には軸の値を次の名前で出す。

```text
projection.state[<entity id>] = {
  identity:    { value, version },
  process:     { value, taken_ts, valid_until, reason },
  hosting:     { value, taken_ts, valid_until, scope, reason },
  closure:     { value, event_ts, reason },
  turn:        { value, confidence, event_ts, valid_until, reason },
  result:      { stage, value, attempt, required_stage, report_failures, reason },
  observation: { <source>/<scope>: { value, last_ok_ts, reason } },
  conflicts:   [ { ref, version } ],
  screen:      value,
}
projection.deliveries[<cmd_id>] = { value, confidence, emitting_ts, emitted_ts, received_ts, retry_of, migrated_from, reason }
snapshot.version, snapshot.evaluated_ts
```

### 8.1 前提

- PTY の所有を runner へ移す。移すまで `14-api-restart-keeps-pty` は通らない。未実行は失敗であり、受け入れは合格にならない。
- 配達の記録と墓標を所有者が永続化する。移すまで `14-*` の項目は通らない。
- 偽 CLI に次の操作を足す。子だけを止める。Stop と SessionEnd と task_complete を個別に落とす。本文だけの説明行を書く。`async_launched` と `completed` の `Agent` の結果を書く。Stop の attachment の後に続行する。handback の `success = false` を返す。
- 偽 CLI は OS の PID を選べない。プロセスの表の照会に試験用の差し込み口を置き、PID と開始値の表を注入できるようにする。本物の OS で開始値を取る経路は別の項目で確かめる。
- 試験は存在しない鍵を補わない。鍵が作れない入力は `unresolved` を期待する。

### 8.2 項目

| 項目 | 壊し方 | 期待する結果 |
| --- | --- | --- |
| `11-missing-stop` | `drop-hook: Stop` で Stop だけを落とし、`stop_reason = end_turn` と `turn_duration` で応答を終える | `turn.value === 'completed'`、`confidence === 'confirmed'`。行に Working が出ない |
| `11-stop-then-continue` | Stop の attachment を書き、その後に同じ turn で道具の呼び出しを続け、最後に `turn_duration` を書く | attachment の時点で `turn.value === 'completed'`、`confidence === 'inferred'`。道具の行で `running`。`turn_duration` で `completed` と `confirmed`。途中で行に Idle の確定が出ない |
| `11-partial-text` | 実物の順序で、`stop_reason` が null の説明行の後に同じ `message.id` で道具の呼び出しを書く。説明行の直後に読む | 説明行の時点で `turn.value === 'running'`。`completed` にならない。`turns.ts:90` の規則に戻すと落ちる |
| `11-missing-session-end` | `drop-hook: SessionEnd` で終え、プロセスを `exit` させる。PID の走査は続ける | 走査の後、`process.value === 'exited_confirmed'`、`reason === 'process_check'`。行は Stopped |
| `11-missing-task-complete` | Codex の偽 CLI で `task_complete` を落として応答を終える。プロセスは生かす | `progress_window` の後、`turn.value === 'unknown'`、`reason === 'progress_expired'`。`completed` にならない |
| `11-waiting-expiry` | Codex の偽 CLI で `requestApproval` を書き、回答の記録を落とす | 要求の時点で `turn.value === 'waiting_approval'`。`waiting_window` の後に `unknown`、`reason === 'waiting_expired'` |
| `12-child-launch` | 親が `Agent` を呼び、`async_launched` の `tool_result` を書く。子は道具を呼び続ける | 子の `result.stage === 'launched'`、`required_stage === 'reported'`、`result.value === 'incomplete'`。行は Working。Done が出ない |
| `12-child-sync` | 親が `run_in_background = false` で `Agent` を呼び、`completed` の `tool_result` を書く | 子の `turn.value === 'completed'`、`confidence === 'confirmed'`。`result.stage === 'responded'`、`required_stage === 'responded'`、`value === 'succeeded'`。印は Done |
| `12-child-stops-parent-alive` | 子だけを止め、親を生かす。PID の走査は続ける | `progress_window` の後、子の `turn.value === 'unknown'`、`reason === 'progress_expired'`。`process.value === 'alive_confirmed'`。行は Unknown。親の行は変わらない |
| `12-child-vanishes` | 子を起こし、`tool_use` を書いた直後に親ごと `kill -9` する | 走査の後、子の `process.value === 'exited_confirmed'`、`result.value === 'unknown'`、`reason === 'parent_exited'`。行は Stopped と No result |
| `12-child-handback` | 子が `SubagentHandback` を呼び、`success = true` の `tool_result` と `SubagentStop` を書く。3 行を別々の周期で読む | 呼び出しの時点で `result.stage !== 'reported'`。結果の行で `stage === 'reported'`、`value === 'succeeded'`。印は Done。`SubagentStop` で `turn.confidence === 'inferred'`。親の `turn` は親の証拠のまま |
| `12-handback-fail-then-succeed` | handback の `tool_result` を `success = false` で返し、子が再び handback して `success = true` を返す | 1 回目で `result.value === 'incomplete'`、`report_failures.length === 1`。2 回目で `stage === 'reported'`、`value === 'succeeded'` |
| `12-handback-succeed-then-fail` | `success = true` の後に、2 回目の handback が `success = false` を返す | `stage === 'reported'`、`value === 'succeeded'` のまま。`report_failures.length === 1`。Failed が出ない |
| `12-responded-then-verify-fail` | 受け入れ条件のある委譲で、最終の応答の後に検証が不合格になる | `stage === 'responded'`、`required_stage === 'verified'`、`value === 'failed'`。印は Failed |
| `13-reorder` | hook、transcript、親子の記録、Codex の rollout を 3 通りの順で取り込む。各記録の `taken_ts` と `evaluated_ts` は入力として固定する | 3 通りで `projection.state` の全軸と根拠と `identity` と対象が一致する。run の ID と所属が一致する |
| `13-reorder-late-stop` | 旧い turn の Stop を新しい turn の開始の後に届ける | 新しい turn が `completed` にならない。旧い turn の鍵に `inferred` の終端が付く |
| `13-reread` | 同じ transcript を 2 回読む。2 回目の `taken_ts` を進める | `turn.valid_until` が変わらない。`event_ts` が変わらない |
| `13-unresolved-keys` | E3 の形で hook と transcript の run を別々に作る。Codex の子を `collabAgentToolCall` なしで起こす | `identity.value === 'unresolved'`。行は Unresolved。Codex の子の `result.value === 'unknown'`、`reason === 'required_stage_unknown'` |
| `14-stop-after-accept` | 配達の記録の直後、最初の書き込みの前に所有者を止めて起動し直す | 偽 CLI の `events.jsonl` に `input` がない。`deliveries[cmd_id].value === 'rejected'`、`reason === 'not_emitted'` |
| `14-stop-after-first-write` | Ctrl-U と貼り付けの直後、Enter の前に所有者を止めて起動し直す | `input` が 0 件か 1 件。`deliveries[cmd_id].value === 'unverifiable'`。再接続後に同じ `cmd_id` を送っても `input` は増えない |
| `14-api-restart-after-enter` | Enter の直後、受信確認の前に所有者を止めて起動し直す | `input` が 1 件だけ。`deliveries[cmd_id].value` が `received_candidate` か `unverifiable`。再送しても `input` は増えない |
| `14-concurrent-same-id` | 同じ `cmd_id` を 2 本の接続から同時に送る | `input` が 1 件だけ。両方の ack が同じ値を返す |
| `14-conflicting-same-id` | 同じ `cmd_id` で本文を変えて送る | 2 件目は誤りの ack で `reason === 'cmd_id_conflict'`。`input` は 1 件 |
| `14-tombstone` | 配達の本文を消し、所有者を起動し直し、古い `cmd_id` を再送する | `input` が増えない。ack は墓標の値で `reason === 'body_expired'` |
| `14-api-restart-keeps-pty` | 会話を起こしたまま api を起動し直す | 偽 CLI の PID が同じで生きている。再起動後 `process.value === 'alive_confirmed'` に戻る。終端と閉鎖と結果の事実が消えない |
| `15-pid-reuse` | 偽 CLI を終える。プロセスの表の差し込み口に、同じ PID で別の開始値の行を注入する。古い登録は残す | 元の会話の `process.value === 'exited_confirmed'`。別のプロセスを生存証拠にしない |
| `15-fingerprint-unavailable` | 差し込み口が開始値を返さない | `process.value === 'unverified'`、`reason === 'scan_failed'`。`exited_confirmed` にも `alive_confirmed` にもしない |
| `15-real-os-fingerprint` | 本物の OS で偽 CLI を起こし、差し込み口なしで開始値を取る | 取れた開始値が登録の `procStart` と一致する。一致で `alive_confirmed` |
| `16-broken-sessions` | `sessions/` に壊れた JSON を 1 件置き、別の会話を終える | `observation['claude_sessions/<dir>'].value === 'failed'`。終えた会話は走査で `exited_confirmed` にならない。期限の後に `process.value === 'unverified'`、`reason === 'scan_failed'`。壊れた JSON を消すと `exited_confirmed` に戻る |
| `16-not-hosted-rehosted` | Codex の偽 CLI が rollout を閉じ、走査の後に同じ turn で再び開いて進行を書く | 閉じた後の走査で `hosting.value === 'not_hosted'`。再び開いた後の走査で `hosted`。`closure.value === 'open'` のまま。行は Working に戻る |
| `16-not-hosted-expiry` | 不在の走査の後に走査を止める | `hosting.valid_until` の後に `hosting.value === 'unknown'`、`reason === 'scan_expired'` |
| `17-same-text-external` | ブラウザから送った本文を `drop-next` で落とし、同じ本文を端末タブから 1 回打つ | `deliveries[cmd_id].value === 'received_candidate'`、`confidence === 'inferred'`。`received` にならない。行は Working |
| `17-same-text-twice-pty` | 同じ本文を 2 回続けて PTY へ送る | 両方 `unverifiable`。`input` は 2 件 |
| `17-same-text-twice-correlated` | 相関 ID のある経路で同じ本文を 2 回送る | 2 つの `cmd_id` が別の相関 ID で `received`。`input` は 2 件 |
| `17-rejected-then-external` | 画面を塞いで `rejected` にし、同じ本文を端末タブから打つ | `deliveries[cmd_id].value === 'rejected'` のまま。Not delivered のまま |
| `17-clock-skew` | CLI の時計を `clock_skew` の範囲内で遅らせる場合と、範囲を超えて遅らせる場合の 2 通りで送る | 範囲内は `received_candidate`。範囲外は `unverifiable`。`rejected` にならない |
| `17-late-ingest` | `!` と `/compact` を送り、原記録の取り込みを送出より遅らせる | `received_candidate`。`rejected` と `unverifiable` にならない |
| `17-deadline-by-turn` | turn が `completed`、`running`、`waiting_approval`、`unknown` の 4 つの状態で送り、受信の記録を落とす | `completed` と `unknown` は `delivery_deadline` の後に `unverifiable`。`running` と `waiting_approval` は `delivery_max_wait` の後に `unverifiable` |
| `18-rule-version` | `TURN_RULE_VERSION` を上げ、会話の再読を途中で止めて起動し直す | 再読が終わるまで `observation['transcript/<file>'].value === 'delayed'`、`reason === 'reinterpretation_pending'`。turn の値が旧版のまま。再読の完了で `healthy` になり `interpretation_version` が進む |
| `18-message-reinterpret` | E4 の形で、原記録にフラグがあり、解釈がフラグを落とした要約を取り込む。再解釈を途中で止める | 有効化の前は旧い版の表示で「Reinterpretation pending」。有効化の後は要約が利用者の発言として出ない |
| `18-message-correction` | 原記録にフラグがない要約を取り込み、後から訂正の事実を足す | 訂正の前は原記録どおり利用者の発言として出る。訂正の後は出ない。turn の値は変わらない |
| `18-conflict-then-scan` | 識別できる競合を 1 件作り、その後に正常な走査を 3 回行う | `conflicts` に 1 件残る。走査の成功で消えない。原記録を直すと消える |
| `19-version-consistency` | 投影の更新中に `/snapshot` と `/conversation` を連続で読む。`version` を指定して読む | 各応答の中で `version` と全軸が同じ版から作られている。指定した版を返せなければ 409 |
| `19-expiry-without-append` | 台帳に追記せず、進行の窓を過ぎさせる | `snapshot.version` が進み、patch が出る。行が Unknown になる |
| `19-ui-disconnect` | 画面の WebSocket を切り、窓を過ぎさせる | 画面に「as of」と最後の版の時刻が出る。Working のまま現在として出ない |
| `19-rebuild-determinism` | 同じ観測の集合と `taken_ts` と `evaluated_ts` で snapshot を 2 回作る | 2 回の snapshot が一致する |
| `20-done-only-from-result` | 対話の会話を終え、子を結果なしで終える | 対話の行に Done が出ない。子の行に Done が出ない。`result.value === 'succeeded'` の実体だけが Done |
| `20-display-complete` | 同一性 2 値、生存 3 値、所持 3 値、閉鎖 3 値、turn 5 値と確度 2 値の全組を snapshot に注入する | 4.2 の表で一意に 1 つの言葉になる。該当なしがない。6.4 の各行の「直した後の画面」と一致する |
| `21-liveness-expiry` | 偽 CLI を `SIGSTOP` で止める。PID の走査は続ける。heartbeat は止まる | `progress_window` の後に `turn.value === 'unknown'`、`reason === 'progress_expired'`。`process.value === 'alive_confirmed'` のまま。行は Unknown。`SIGCONT` の後に進行の証拠で Working へ戻る |
| `21-scan-stops` | PID の走査を止める | 期限の後に `process.value === 'unverified'`、`reason === 'liveness_expired'`。`observation` が `delayed`。turn が `running` なら行は Working と「liveness unverified」 |

### 8.3 既存の項目の改め

- `7` は Working の判定を `turn.value === 'running'` で行う。`process.value` は添える情報の判定に使う。
- `9-missing` は Unconfirmed を期待する。Not delivered を期待しない。
- `9-bang` は Likely delivered を期待する。Delivered の確定を期待しない。
- `journeys.mjs:151` は Idle と Done のどちらも受け入れる。これを Idle だけに改める。
- 各項目は正常な並びに加えて、遅延と重複を組み合わせた並びでも通す。
- 受け入れは `scripts/e2e/run.mjs` の終了コード 0 で判定する。項目の未実行は失敗である。
- 旧い規則に戻すと落ちる項目は、`11-partial-text`、`11-stop-then-continue`、`12-child-launch`、`12-handback-succeed-then-fail`、`13-reread`、`14-tombstone`、`17-rejected-then-external` である。

## 9 architecture-v2.md の改める箇所

| 箇所 | 今の記述 | 改める内容 |
| --- | --- | --- |
| 決定 2 外の会話の従の経路 | 確かでない状態は不明と表示する。経過時間だけで終了を断定しない | 保つ。「経過時間で終了にしない。経過時間で不明にはする」と足す |
| 決定 3 事実の台帳 | 画面の状態は台帳から組み立てる | 履歴は台帳から、現在状態は照合器の snapshot から組み立てると改める |
| 決定 12 WebSocket | 同じ `cmd_id` の再送は 1 回だけ作用する | 再送の抑止は所有者が永続化した墓標で行う。副作用の前に記録し、再接続を送出の許可にしないと足す |
| 決定 13 runner と api の分離 | api はいつでも再起動できる。実行は止まらない | ブラウザから起こした端末の PTY を runner へ移す。移すまで api の再起動で生存が `unverified` になると明記する |
| プロセスの分離の表 | api の再起動で実行は止まらない | 同上 |
| 出来事を失わない仕組み | api は 500 ms ごとに台帳の seq を確かめる | 保つ。照合器の周期と snapshot の版の配信を足す |
| データモデル 実行 | 状態は 8 値の 1 つの列 | 軸に分ける。プロセスの生存と所持と閉鎖を別に持つ。旧い `state` は移行の間だけ写す |
| 実行 `ended` の根拠表 | 5 つの根拠を同じ `ended` にする | 物理終了は `host_exit` と `process_check` だけ。`session_end`、`thread_closed`、`archived` は閉鎖の根拠に移す |
| 実行 `ended` の根拠表 | プロセスの確認は PID と開始指紋の組 | 保つ。開始指紋は OS の現在の開始値と比較すると明記する。`startedAt` は使わない |
| 実行 終了の根拠にしない事象 | 一定時間の無更新は `unknown` にする | 保つ。窓と期限の定義を本書に委ねると足す |
| 実行 SessionEnd の後の turn | 同じ世代の turn の開始で running へ戻す | 保つ。戻すのは閉鎖と turn であり、物理終了は戻さないと足す |
| 接続 | 種類は `mcp`、`herdr`、`app`、`pid`、`ws` | `pid` の接続に OS の開始値と `valid_until` を持たせる。heartbeat を足す |
| 出所の優先 外の会話の状態 | hook、次に履歴。経過時間は根拠にしない | hook と履歴は turn の根拠として対等にし、終端の確度を 2.2.1 で決める。生存は走査と指紋で決める。経過時間は不明の根拠にする |
| Claude のホスト | `idle` をターンの終わりの合図に使う | 保つ。`idle` を依頼の結果に使わないと足す |
| Claude のホスト | `send` の戻り値を定めていない | 送信ごとに相関 ID を作り、`user_message_uuid` の往復が確認できた設定でだけ `received` にすると足す |
| 実行の監督 | api の再起動は実行の状態を変えない | PTY の所有が移るまで成り立たないと明記する |
| 委譲 状態と試行 | 試行は受け入れとレビューの結果を持つ | 結果を段階と判定に分け、依頼の種類ごとに必要な段階を決めると足す。報告の操作の失敗を依頼の失敗にしない |
| 外の会話の観測 不明の扱い | 観測の根拠が途切れた実行は `unknown` にする | 保つ。走査の成功を不在の条件にし、不在に期限を持たせる。観測の健康状態と競合を配信すると足す |
| 画面 共通の規則 | 状態の語彙は 6 値 | 4 節の表に置き換える。代表の状態と結果の印を分ける。Done を依頼の結果に限る |
| 画面 一覧 不明のとき | 最後の根拠の時刻を添える | 保つ。理由の語彙を 6.7 に合わせる |
| 画面 エージェントの会話と入力 | 端末送信の契約を `terminal-slash-commands.md` に委ねる | 配達の契約は本書の 5 節を正本にする。`terminal-slash-commands.md` は送出の手順に限る |
| 受け入れの基準 標本 S2 | 無更新は `unknown` になる | 保つ。本書の 8 節の項目を受け入れに足す |
| 受け入れの基準 標本 S3 | 新しい世代が古い PID を引き継がない | 保つ。`15-pid-reuse` と対応づける |
| 受け入れの基準 標本 S11 | プロセス一覧の取得の失敗で `unknown` | 保つ。観測の健康状態が `failed` になると足す |
| 復旧の契約の表 | 5 点の故障の注入 | 8 節の `14-*` を足す |

`identity-redesign.md` にも矛盾がある。本書と合わせて次を改める。

- 「状態の根拠に経過時間は使わない」を「経過時間は不明の根拠にする」に改める。
- 「`sessions/*.json` の PID の不在は `idle` にする」を「所持 `not_hosted` にし、turn は変えない」に改める。
- 「普通の発言は本文の一致で届いたとする」を、5.5 の順に改める。本文の一致は候補である。
- 「`!` の命令は照合しない」を、`<bash-input>` の行を候補にすると改める。
- 「hook の run が後から来たら自前の run を `superseded_by_hook` で閉じる」を、run の対応表での結合に改める。閉鎖の証拠にしない。
- 「実行と世代」の表に、本書 2.7 の鍵の作り方の表を取り込む。

## 要確認

- 利用中の SDK の設定で、送信の `user_message_uuid` と受信の uuid が往復するか。確認できるまで managed の Claude の上限は `received_candidate` である。
- 同期の `Agent` の結果の形式が 2.1.299 と 2.1.300 でも同じか。実記録は 2.1.291 と 2.1.292 である。
- peer protocol が任意の入力に受領の返答を返すか。本物の Claude が要る。確認できるまで使わない。
- `sessions/*.json` の `status` と OS の生存と turn の対応。隔離した環境で OS の PID と開始値と登録の変更を同時に採る。
- Codex の 2 分の猶予の妥当性。走査の発見の遅れと、活動中にファイルが開かれていない期間を分けて測る。
- E3 の調査時の PID の有無。過去時点の走査の結果が保存されていないため、復元できない。
- E5 の競合した 5 件の位置。記録に識別がないため、特定できない。
- 3.2 の仮の値のすべて。計測で決めるまで保証未確定である。

## 回答済みの要確認

| 項目 | 回答 | 反映した節 |
| --- | --- | --- |
| `sessions/*.json` の `status` と `updatedAt` | 出来事ごとの更新であり heartbeat ではない。値は `busy`、`shell`、`idle`、`waiting` の 4 値。`interactive` は `kind` の値 | 3.3、3.4 |
| `procStart` と `startedAt` | `procStart` は OS の開始値、`startedAt` は登録時の壁時計 | 2.1 |
| 親の `tool_result` と子の ID | 行のトップレベルの `toolUseResult.agentId`。`async_launched` は起動の受理 | 2.3、3.4 |
| 同期の `Agent` の結果 | `status = completed`、`agentId`、`content` の text ブロック。実記録 3 件 | 2.2.1、2.3、3.4 |
| SDK の入力 ID | `user_message_uuid` と `user_message_uuids` の欄と経路はある。往復は未確認 | 3.4、5.5 |
| peer protocol | 相関付きの返答の仕組みはある。受領の保証は未確認。使わない | 3.4、5.5 |
| `SessionEnd` の `reason` | 5 値。本番は `other` 1,502 件、`prompt_input_exit` 8 件。欄は `payload.last_evidence.input.reason` | 2.1 |
| E6 の末尾 | `commentary` であり `task_complete` ではない。不在まで 155.539 秒 | 3.4、7 |
| Codex の 2 分 | 最後の記録時刻からの猶予。妥当性は未確認 | 3.2、3.4 |
| PTY の移行の時期 | 推測で決めない。受け入れの前提にし、完了まで合格にしない | 8.1 |

## レビューへの対応

### 第 1 回の指摘

| 指摘 | 直した節 | 直し方 |
| --- | --- | --- |
| 1 送信元を識別できない証拠で受領を確定 | 2.4、5.5、5.9、7 E2 | `received` は相関 ID だけにした。本文と時刻の一致は `received_candidate` で確度 `inferred` にした。旧い `closed` は候補に写す |
| 2 再接続の再送と部分送出 | 2.4、5.1〜5.4、5.7、5.8、8.2 の `14-*` | 所有者が `accepted` から `emitting` へ 1 回だけ進める。再接続は墓標か記録の値を返すだけで送出しない。書き込み後の中止は `unverifiable`、記録だけで止まった操作は `rejected`。第 3 版で墓標を足した |
| 3 子の起動通知を完了と取り違え | 2.3、3.4、7 E1、8.2 の `12-*` | `Agent` の `tool_result` の `toolUseResult.agentId` で子を同定し、`async_launched` を段階 `launched` にした。第 3 版で同期の `completed` を加えた |
| 4 途中の説明を完了にする規則 | 2.2、2.2.1、3.4、8.2 の `11-partial-text` | `turns.ts:90-93` の規則を廃止した。第 3 版で終端の証拠に確度を付け、Stop を `inferred` にした |
| 5 プロセスの終了と論理の閉鎖の混同 | 2.1、2.6、7 E3 と E6 | 生存をプロセスの生存と所持と閉鎖に分けた。物理終了は `host_exit` と `process_check` だけ |
| 6 新鮮な PID が古い turn を Working に保つ | 2.2、2.6、6.4、8.2 の `12-child-stops-parent-alive` と `21-*` | turn に自分の鮮度と `progress_expired` を持たせた。生存の走査で turn を更新しない |
| 7 同一性を範囲外にしたまま同じ run を前提 | 2.7、7 E3、8.2 の `13-*` | 必須の入力を定めた。第 3 版で provider ごとの鍵の作り方の表を足した |
| 8 報告と最終応答と検証合格を同じ成功に | 2.3、4.3、8.2 の `12-*` | 結果を段階と判定に分けた。第 3 版で必要な段階を種類ごとに網羅し、報告の失敗を依頼の失敗から分けた |
| 9 snapshot の版と時刻と再起動の契約の不足 | 6.2、6.3、8.2 の `19-*` | 版を 7 つの構成と通し番号と評価時刻にした。再起動は失効する照会の証拠だけを落とす |
| 10 観測失敗と未解決の競合を同じ回復規則で | 2.5、6.5、6.6、7 E5 | 健康状態を情報源と範囲の組に付けた。競合を別の記録にし、走査の成功で消さない |
| 11 画面への写像が一意でも網羅的でもない | 4.1〜4.5、8.2 の `20-display-complete` | 代表の状態と結果の印を分け、順序付きの表で全組を 1 つに写した。第 3 版で 6.4 を表から引いた結果に揃えた |
| 12 期限の決め方が誤った確信を減らす目標でない | 3.2、3.4、5.6、5.7 | 偽 CLI を正解にし、更新と走査と進行を別に測る方法にした。第 3 版で照会と出来事の期限の起点を分け、仮の値の表を足した |

### 第 2 回の指摘

| 指摘 | 直した節 | 直し方 |
| --- | --- | --- |
| R1 終了を試みた記録を終了の証拠に | 2.2.1、2.3、3.4、6.4、8.2 の `11-stop-then-continue` と `12-handback-*` | 終端の証拠を情報源ごとに確度付きで表にした。Stop と SubagentStop と終端の `stop_reason` は `inferred`、`turn_duration` と親の `completed` と Codex の通知と managed の受信は `confirmed`。`inferred` の後の進行で `running` に戻す。handback の `tool_result` は `reported` の証拠に限り、turn の終端から外した |
| R2 期限の起点と `not_hosted` の解除 | 1.2、2.1、2.2、3.1、3.2、6.4、8.2 の `13-reread` と `16-not-hosted-*` と `11-waiting-expiry` | 照会の証拠は `taken_ts`、出来事の証拠は `event_ts` から期限を数える。再読で延びない。`not_hosted` を閉鎖から所持の軸へ移し、走査の期限を持たせ、`hosted` の走査で解除し、期限切れで `unknown` に戻す。`waiting_*` に `waiting_window` と `waiting_expired` を足した |
| R3 生存未確認時の turn と子の表示 | 2.2、2.6、4.2、6.4、7 | 生存 `unverified` では turn を落とさない規則に統一した。4.2 の決定表を唯一の正解にし、`unverified` でも turn の値を出し「liveness unverified」を添える。親が終了した子は順 2 で Stopped に統一し、6.4 を表から引いた結果に書き直した |
| R4 拒否と時刻とキューの候補の規則 | 2.4、4.5、5.5、5.6、5.7、6.4、8.2 の `17-*` | `rejected` を終わりの値にし、照合の対象から外した。旧い `failed` から写した `unverifiable` だけを救済する。`clock_skew` を定義し仮の値 0 で候補を落とす側に倒した。期限を turn の全値で表にした。候補のキューは Likely queued にし、Queued は相関 ID のある経路に限った |
| R5 保持期限後の再送禁止の識別 | 用語、3.2、5.2、8.2 の `14-tombstone` | 配達の記録を本文と墓標に分けた。墓標は消さず、再送の禁止の正本にした。本文を消した後の再送は墓標の値を返す |
| R6 同一性の必須の入力を作れない対象 | 2.3、2.7、8.2 の `13-unresolved-keys` と `12-child-sync` | provider ごとの会話と run と turn と依頼の鍵の作り方を表にした。外の子は親の `tool_use_id` と `agentId`、Codex は `turnId` と item ID。受付を通らない子にも依頼の鍵を定めた。作れない鍵は `unresolved` で、試験は補わない |
| R7 結果の必要な段階と handback の失敗 | 2.3、4.3、8.2 の `12-handback-*` と `12-responded-then-verify-fail` | 依頼の種類ごとの必要な段階を網羅した。段階は試行の中で累積し戻らない。報告の操作の失敗は `report_failures` に累積し判定を変えない。`failed` は検証とレビューと最終の応答の `is_error` だけ |
| R8 成立条件のない試験の期待 | 3.4、6.5、6.7、8.1、8.2 の `13-reorder` と `13-reread` と `18-message-*` と `15-*` | `13-reorder` は `taken_ts` と `evaluated_ts` を固定した入力にし、再読の検査を `13-reread` に分けた。`18-message-correction` を原記録にフラグがある再解釈と、フラグがない後着の訂正に分けた。`15-pid-reuse` はプロセスの表の差し込み口を使い、本物の OS の開始値は別の項目にした。`screen` の欄を `sessions.status` から分け、理由の語彙と欄を 6.7 に集めた |

反映しなかった指摘はない。
