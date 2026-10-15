# 状態と配達の定義書

2026-10-15。読み手は実装と試験を行う AI agent と、それを監督する人である。
本書は作り直しの 1 段目であり、後のすべての実装と試験の正本である。
コードの基準は main の `784f5cd` である。`file:line` はこの作業ツリーの位置を示す。
時刻は UTC で書く。
本書は定義だけを示す。コードは変えていない。

## 要点

- 過去の知らせは、現在の確証にならない。確証には取った時刻と有効期限がある。
- 状態は 5 つの軸に分ける。生存、turn、依頼の結果、配達、観測の健康である。
- 画面の Done は依頼の結果にだけ結び付ける。turn の停止や不在から Done を作らない。
- 不在を言えるのは、その範囲の走査が成功したときだけである。
- 配達は送信の前に記録し、受信側の証拠を本文の一致より優先する。確認できなければ確認不能と出す。
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
| snapshot | 照合器の出力。会話と実行ごとの 5 軸の値と根拠と版を持つ |
| cmd_id | 画面の操作ごとに作る識別子。配達の記録の主キーになる |
| 相関 ID | 受信側が持つ識別子のうち、送信要求と結び付けられるもの |

## 1 確かさの原則

### 1.1 過去の知らせと現在の確証

- 開始の通知を知っていることと、今も動いていることは別である。
- 状態の値には、その値を支える証拠の取得時刻と有効期限を必ず付ける。
- 期限内の証拠がない値は、現在の確証にならない。履歴としてだけ残す。
- 本番の `runs` には 29 時間前の `turn_started` だけを根拠に running を保つ行がある。これは確証ではない。

### 1.2 証拠の時刻と有効期限

- 証拠は `taken_ts` と `valid_until` を持つ。`valid_until` は情報源ごとに決める。
- 期限の決め方は 3 節に書く。根拠のない秒数は書かない。
- 証拠を取り直すたびに `taken_ts` が進む。古い証拠は新しい証拠で置き換える。
- 証拠の取り直しに失敗したときは、前の証拠の `valid_until` を延ばさない。

### 1.3 不在の条件

- 不在を言えるのは、その範囲の走査が成功したときだけである。
- 走査の失敗と部分成功では、既存の値を保つが、その値の有効期限は延ばさない。
- 走査の対象外の実体には、不在を適用しない。対象外であることを snapshot に書く。
- 今の実装は、この原則を一部で守っている。`packages/api/src/observe/claude/sessions.ts:17-38` は失敗で何も書かない。
- 守っていない点は、失敗後に前の running が無期限に残ることである。

### 1.4 失効から作ってはならない値

- 失効した値から、成功を作らない。
- 失効した値から、終了を作らない。
- 失効した値から、不在を作らない。
- 失効した値から作ってよいのは、不明だけである。不明には最後の証拠と理由を付ける。
- 無出力の長い処理はある。無出力だけで停止と判断しない。

## 2 状態の軸

状態は 5 つの軸に分ける。軸ごとに独立した証拠を持つ。
1 つの軸の値から、別の軸の値を暗黙に導かない。
今の `RunPayload.state` は 5 軸の混在である。移行の間は、旧い `state` を軸に写した値も snapshot に残す。

### 2.1 実行の生存

実行を動かすプロセスが、今も存在するかを表す。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `alive_confirmed` | 期限内の生存証拠がある | 生存証拠を取得し、`valid_until` が現在より後である | `valid_until` を過ぎる。終了証拠が来る | managed の子プロセスの handle と heartbeat。PID と開始指紋の一致。Codex の rollout を開くプロセスの存在 |
| `exited_confirmed` | 終了証拠がある | 終了の根拠表に合う証拠を受けた | 新しい世代の実行が始まる。同じ世代へは戻らない | `host_exit`、`thread_closed`、`session_end`、`archived`、成功した走査での不在、利用者の訂正 |
| `unverified` | 期限内の証拠がない | 生存証拠が失効した。走査が失敗した。対象外である | 生存証拠か終了証拠が来る | 最後の証拠と `taken_ts` と理由 |

- `exited_confirmed` は世代ごとに持つ。世代が変われば新しい実行として扱う。
- 成功した走査での不在は、PID と開始指紋の組で判定する。PID だけでは判定しない。
- `sessions/*.json` には `procStart` と `startedAt` がある。これを開始指紋にする。
- 親の会話が `exited_confirmed` なら、その子の会話も `exited_confirmed` にする。子は親のプロセスの中で動くからである。
- 今の `ended` の根拠表は `docs/agents/architecture-v2.md` の「実行」にある。`process_check` の規則はそのまま使う。

### 2.2 turn の進行

会話の中で、エージェントの応答が今どの段階かを表す。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `running` | turn の実行中 | turn の開始か途中の証拠があり、生存が `alive_confirmed` である | 完了か中断の証拠が来る。生存が `alive_confirmed` でなくなる | hook の `UserPromptSubmit`。transcript の `turn_started`、`tool_call`、`tool_result`。Codex の `task_started`。managed の `session_state_changed` |
| `waiting_approval` | 承認を待つ | 承認の要求があり、回答がない | 回答か中断か終了が来る | `canUseTool`、`requestApproval`、`waitingOnApproval` |
| `waiting_input` | 利用者の入力を待つ | 入力待ちの通知がある | 入力が届く | Codex の `waitingOnUserInput`。managed の入力待ち通知 |
| `completed` | 直近の turn が終わった | 完了か中断の証拠がある | 新しい turn の開始証拠が来る | hook の `Stop`。transcript の `turn_completed`、`turn_interrupted`。Codex の `task_complete`、`turn_aborted`。managed の `idle` |
| `unknown` | 判定できない | turn の証拠がない。生存が `unverified` で turn が `running` だった。観測が失敗した | 新しい turn の証拠が来る | 最後の turn の証拠と理由 |

- `running` は生存に従属する。生存が `unverified` に落ちたら turn は `unknown` に落ちる。
- `completed` は生存に従属しない。完了の証拠は過去の事実であり、失効しない。
- `completed` は入力待ちの待機を意味する。依頼の成功を意味しない。
- hook と transcript が同じ turn を別の形で伝えるときは、どちらの完了証拠も有効である。片方の欠落を、もう片方で補う。
- 今の `packages/core/src/ledger/projections/runs.ts:106-114` は hook が running の間、transcript の完了を捨てる。この規則は廃止する。

### 2.3 依頼の結果

依頼として出した仕事の結果を表す。対象は委譲、managed の実行、Claude の子、タスクグラフの節である。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `incomplete` | 結果がまだない | 依頼が受理された | 結果の証拠が来る | 受付の `accepted` |
| `succeeded` | 成功の結果がある | 結果の証拠が成功を示す | 利用者の訂正だけ | `SubagentHandback` の呼び出し。委譲の `done`。`final_answer` の確定。受け入れ検証の合格 |
| `failed` | 失敗の結果がある | 結果の証拠が失敗を示す | 試行の追加。利用者の訂正 | 委譲の `failed`。`is_error` の結果。受け入れ検証の不合格 |
| `interrupted` | 中断された | 中断の要求と対応する終了がある | 試行の追加 | `run.interrupt_requested` と `error_during_execution` の組 |
| `unknown` | 結果が分からない | 結果の証拠がないまま、生存が `exited_confirmed` か `unverified` になった | 結果の証拠が来る | 最後の証拠と理由 |

- `succeeded` は結果の証拠だけから作る。turn の `completed` から作らない。
- Claude の子の `idle` を Done に読み替える `packages/dashboard/app/src/lib/roots.ts:249` は廃止する。
- 子の `SubagentHandback` は `turns.ts:81-83` で turn の完了として読んでいる。これを依頼の結果の証拠にも使う。
- 対話の会話には依頼の結果を付けない。対話の会話は Done にならない。

### 2.4 入力の配達

画面から送った入力が、受信側に届いたかを表す。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `accepted` | 送信要求を記録した | `cmd_id` と対象を永続化した | 送出するか拒否する | 配達の記録の行 |
| `emitted` | 受信側へ送出した | PTY への書き込みか SDK の `send` が返った | 受信の証拠が来る。期限を過ぎる | 送出の時刻と対象の版 |
| `received` | 受信側の証拠がある | 相関 ID か、受信側の記録が送出と結び付いた | 変わらない | 受信側の相関 ID。`queued_command` の記録。jsonl の user 行 |
| `rejected` | 送らなかった | 送出前の確認で送れないと分かった | 利用者が再送する | 塞がれた画面の判定。対象の版の不一致。ホストの不在 |
| `unverifiable` | 確認できない | 送出後、期限内に受信の証拠が得られなかった。送出の成否が分からない | 受信の証拠が後から来る | 送出の記録と、照合の範囲と期限 |

- `unverifiable` は「届いていない」ではない。「この照合器が確認できなかった」である。
- `rejected` だけが「届いていない」を意味する。送出前に止めたからである。
- 今の `api_send_watches` の `failed` は `unverifiable` に写す。`closed` は `received` に写す。
- 配達の記録は台帳の rebuild の対象ではない。独立した表として保ち、`cmd_id` で引ける形にする。

### 2.5 観測の健康状態

情報源ごとの観測が、今どの程度信じられるかを表す。会話ではなく情報源に付く。

| 値 | 意味 | 入る条件 | 出る条件 | 根拠となる証拠 |
| --- | --- | --- | --- | --- |
| `healthy` | 直近の走査が成功した | 走査が成功し、遅れが許容内である | 走査が失敗する。遅れが許容を超える | 走査の完了時刻と結果 |
| `delayed` | 走査は続いているが遅い | 最後の成功から許容を超えた | 成功する。失敗する | 最後の成功時刻 |
| `failed` | 直近の走査が失敗した | 走査が例外か部分成功で終わった | 成功する | 失敗の理由と時刻 |
| `out_of_scope` | この情報源の対象外 | 走査の範囲に含まれない実体を見ている | 範囲に含める | 範囲の定義 |

- 観測が `failed` か `delayed` の間、その情報源に依存する生存証拠の有効期限は延びない。
- 観測が `failed` のとき、既存の値は保つ。値の横に観測の失敗を出す。
- 観測の健康状態は snapshot の版の一部として配信する。投影 seq だけでは足りない。
- 今の実装には、止まった情報源を知らせる仕組みがない。`incident-review.md` の I4 と I14 がその結果である。

### 2.6 軸の間の規則

| 規則 | 内容 |
| --- | --- |
| 生存から turn へ | 生存が `unverified` なら、turn の `running` と `waiting_*` は `unknown` に落ちる。`completed` は保つ |
| 生存から結果へ | 生存が `exited_confirmed` で結果がなければ、結果は `unknown` にする。`succeeded` にしない |
| turn から結果へ | 導かない。`completed` は結果の証拠ではない |
| 配達から turn へ | `received` は turn の開始証拠になり得る。`emitted` と `unverifiable` はならない |
| 観測から生存へ | 観測が `failed` なら、その情報源の生存証拠は失効の扱いを早めない。延ばしもしない |
| 親から子へ | 親の生存が `exited_confirmed` なら子も同じ。親が `unverified` なら子も `unverified` |

## 3 情報源ごとの証拠と有効期限

### 3.1 証拠の形

すべての証拠は次の形で保存する。

```text
evidence {
  subject        対象の実体。会話か実行か情報源
  axis           生存、turn、結果、配達、観測のどれか
  value          軸の値
  source         情報源
  kind           証拠の種類。process_check、heartbeat、hook_event など
  taken_ts       取得した時刻
  valid_until    有効期限。null は失効しない
  scope          走査の範囲。null は走査でない
  scan_ok        走査が成功したか。走査でなければ null
  ref            元の記録への参照。fact_id、ファイルと位置、cmd_id
}
```

- `valid_until` が null の証拠は、過去の事実である。完了や終了の証拠がこれに当たる。
- `valid_until` を持つ証拠は、現在の状態の根拠である。生存と配達の `emitted` がこれに当たる。
- 期限は `taken_ts + 間隔 × 係数` で決める。間隔は情報源の取得周期、係数は計測で決める。

### 3.2 計測の方法

根拠のない秒数は書かない。計測して決める値は、次の方法で決める。

1. 隔離した環境で、情報源の更新間隔を 24 時間分採取する。
2. 間隔の分布から、99 パーセンタイルを取る。
3. 有効期限は、その値の 3 倍を起点にする。3 倍は誤検知を減らすための初期値であり、採取で見直す。
4. 本番の読み取り専用の台帳で、期限切れの誤判定の件数を 1 週間数える。
5. 誤判定が 0 でなければ係数を上げ、再度数える。
6. 決めた値と採取の記録を、本書のこの節に追記する。

### 3.3 情報源の表

| 情報源 | 出せる証拠 | 今の取得周期 | 有効期限の決め方 | 今の実装の位置 |
| --- | --- | --- | --- | --- |
| managed の runner | 子プロセスの handle、PID、終了コード、`session_state_changed`、承認、結果 | 出来事ごと。heartbeat はない | heartbeat を新設する。間隔は計測して決める。期限は間隔の係数倍 | `packages/runner/src/supervisor.ts:125-145`、`recovery.ts:69` |
| ブラウザから起こした端末 | PTY の pid、`onExit`、画面の内容、`sessions/<pid>.json` の sessionId | 500 ms の発見周期。`hosts.ts:20` | PTY の生存は所有者が直接知る。期限は不要。所有者が api から runner へ移るまでは api の寿命が上限 | `packages/api/src/terminal/hosts.ts:161-224`、`292-298`、`354` |
| 外で動く Claude の会話 | jsonl の行、`sessions/*.json` の PID と `procStart` と `status` と `updatedAt` | ファイルの変更検知と 1 秒の観測周期。`service/index.ts:43` | 生存は PID と指紋の走査で決める。走査の周期は 1 分。`sessions.ts:44`。`status` と `updatedAt` の更新間隔は計測して決める | `packages/api/src/observe/claude/sessions.ts`、`context.ts` |
| Claude の子 | `subagents/*.jsonl` の行、`SubagentHandback`、親の `tool_result` | 親と同じ | 生存は親に従う。turn は子の行と親の `tool_result` で決める。独自の期限は持たない | `packages/api/src/observe/session-query.ts:28` は子を走査から除く |
| Codex | rollout の行、`ps` と `lsof` の走査、`thread/status/changed` | 走査は 30 秒。`codex/sessions.ts:7`。起動猶予は 2 分。`:8` | 生存は走査の成功した周期で決める。期限は走査周期の係数倍。係数は計測して決める | `packages/api/src/observe/codex/sessions.ts:44-81`、`119-132` |
| hook | `SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd`、世代 | 出来事ごと。送信は 500 ms、再送の予算は 1 秒。`hook-v2/index.ts:7-8` | 失効しない。過去の事実である。生存の根拠にはしない | `packages/api/src/hook/index.ts:40-77` |
| transcript | 行の種類と時刻、`stop_reason`、`compact_boundary`、`continued-in` | ファイルの変更検知 | 失効しない。turn の根拠にする。ファイルの mtime は活動の補助証拠にし、生存の根拠にしない | `packages/core/src/ledger/turns.ts:53-95`、`observe/claude/context.ts:114-141` |
| `sessions/*.json` の PID | `pid`、`procStart`、`startedAt`、`sessionId`、`cwd`、`status`、`updatedAt`、`kind` | 1 秒の観測周期で読む。追記は 1 分か集合の変化 | `kill(pid, 0)` と `procStart` の一致で生存。走査は全ファイルの成功を要求する。1 件の失敗で周期を捨てる今の規則は保つ | `sessions.ts:17-38` |

### 3.4 情報源ごとの注意

#### managed の runner

- runner は起動時に `pid` を書く。`supervisor.ts:137`。heartbeat は書かない。
- 再起動時は `markUnknown("restart")` で全実行を `unknown` にする。`supervisor.ts:58-64`。この規則は保つ。
- heartbeat を新設する。runner が実行ごとに `taken_ts` を更新する。台帳の事実にはせず、証拠の表に書く。
- 子プロセスの終了は `host_exit` で終了確認になる。`supervisor.ts:200-204`。この規則は保つ。

#### ブラウザから起こした端末

- 今は api が PTY を所有する。api の `close` は PTY を kill する。`hosts.ts:354`。
- PTY の `onExit` は listener に通知するだけで、台帳に終了を残さない。`hosts.ts:292-298`。
- 所有を runner へ移す。移すまでの間は、api の停止を「生存 `unverified`、理由 `api_restart`」として扱う。
- 端末の sessionId は `sessions/<pid>.json` から読む。`hosts.ts:161-171`。`/clear` で変わる。
- 端末の画面は送出の可否の根拠にする。受信の根拠にはしない。

#### 外で動く Claude の会話

- 生存は PID の走査で決める。走査が成功し、PID がない会話は `exited_confirmed` になる。
- `procStart` を開始指紋にする。PID が同じでも指紋が違えば別のプロセスである。
- 今の `sessions.ts:55-58` は不在を `idle` と書く。これを「生存 `exited_confirmed`、turn は変えない」に改める。
- `sessions/*.json` の `status` は Claude 自身が書く。`busy` と `idle` の値を見た。要確認: 更新の間隔と、値が turn と一致するか。
- `sessions/*.json` の `kind` に `bg` がある。要確認: 対話の会話と背景の会話の区別に使えるか。

#### Claude の子

- 子は `subagents/<agent id>.jsonl` に記録される。`sessionId` は親を指す。
- 子の生存は親に従う。親が `alive_confirmed` なら子も `alive_confirmed` である。
- 子の turn は、子の行と親の記録で決める。`SubagentHandback` の呼び出しで `completed` と結果 `succeeded` になる。
- 親の記録に、その子を起こした `Task` の `tool_result` があれば、子の turn は `completed` である。要確認: `tool_result` と `agent id` の対応をどの欄で取るか。
- 親が `exited_confirmed` で子に結果がなければ、子の結果は `unknown` である。

#### Codex

- 走査は `ps` と `lsof` で、codex プロセスが開く rollout を集める。`sessions.ts:44-81`。
- 走査の部分成功は例外で捨てる。`:79`。この規則は保つ。
- 今は不在を `idle` と書く。`:126-129`。これを「生存 `exited_confirmed`」に改め、turn は最後の turn の証拠のままにする。
- 起動猶予の 2 分は、rollout の作成からプロセスの発見までの遅れに対する値である。`:8`。根拠は要確認。計測して決め直す。

#### hook

- hook は出来事のときだけ動く。生存の根拠にしない。
- 世代は outbox のファイルで決める。`hook-v2/index.ts:59-88`。`startup` と `resume` で新しくなる。
- 会話 ID は `claude:<id>` の形で書く。`hook/index.ts:40`。これは同一性の課題であり、本書の範囲外である。
- `SessionEnd` は同じ世代の終了確認になる。その後の同じ世代の turn の開始で、生存を `alive_confirmed` に戻してよい。`runs.ts:48-62` の規則は保つ。
- `SessionEnd` の `reason` は要確認。本番の台帳で `other` の値を見たと `incident-review.md` の I23 にある。

#### transcript

- 行の読み替えは `turns.ts:53-95` の規則に従う。版は `TURN_RULE_VERSION = 3` である。
- 同じ状態が続く行から新しい事実を作らない。`context.ts:134`。このため最後の行の時刻は活動の時刻である。
- `isMeta`、`isCompactSummary`、`<bash-input>` などの行は turn の根拠にしない。`turns.ts:36`、`claude-message-flags.ts`。
- transcript の `run.created` は hook がないときだけ作る。`context.ts:116-124`。hook の後着で別の run が残る問題は同一性の課題である。

#### `sessions/*.json` の PID

- 1 件でも読めないか壊れていれば、その周期の走査は失敗である。`sessions.ts:27-28`、`:35`、`:38`。
- 失敗した周期では不在を書かない。この規則は保つ。
- 失敗した周期では、観測の健康状態を `failed` にする。これを新設する。
- `kill(pid, 0)` の `EPERM` は生存とも不在とも判定しない。`:35`。この規則は保つ。

## 4 画面の言葉

### 4.1 対応表

画面の言葉は 5 軸の値の組から決める。英語を既定にする。

| 画面の言葉 | 生存 | turn | 結果 | 使う場面 |
| --- | --- | --- | --- | --- |
| Working | `alive_confirmed` | `running` | 任意 | 行とタブと見出し |
| Needs approval | `alive_confirmed` | `waiting_approval` | 任意 | 行と受け箱 |
| Waiting | `alive_confirmed` | `waiting_input` | 任意 | 行と見出し |
| Idle | `alive_confirmed` | `completed` | `incomplete` か対象外 | 対話の会話の行 |
| Done | 任意 | 任意 | `succeeded` | 子と委譲とタスクの節だけ |
| Failed | 任意 | 任意 | `failed` | 子と委譲とタスクの節だけ |
| Interrupted | 任意 | 任意 | `interrupted` | 子と委譲とタスクの節だけ |
| Stopped | `exited_confirmed` | 任意 | 結果なし | 対話の会話の行。終了の根拠の種類を添える |
| Unknown | `unverified` | 任意 | 任意 | すべて。最後の証拠の時刻と理由を添える |

- Done は依頼の結果 `succeeded` からだけ出す。他の組からは出さない。
- Stopped は終了確認がある対話の会話に出す。Done と区別する。
- Idle は対話の会話にだけ出す。子の Idle は出さない。子は Working か Done か Failed か Unknown である。
- 今の `packages/dashboard/app/src/lib/i18n.ts:14-15` は `ended` を Done に写す。これを Stopped に改める。

### 4.2 不明の見せ方

- Unknown は灰色の破線で出す。色だけに頼らない。
- Unknown には必ず「Last seen」と最後の証拠の時刻を添える。例は「Unknown · last seen 29h ago · no liveness check for subagents」である。
- 理由は定義済みの語彙から選ぶ。`liveness_expired`、`scan_failed`、`out_of_scope`、`api_restart`、`parent_unverified`、`missing_evidence` である。
- 観測が `failed` か `delayed` の情報源があるときは、画面の上に 1 行で出す。例は「Observation of Claude sessions failed since 14:02」である。
- Unknown を Idle や Done に丸めない。Unknown の件数を一覧に出す。

### 4.3 配達の言葉

| 画面の言葉 | 配達の値 | 見せ方 |
| --- | --- | --- |
| Sending | `accepted` と `emitted` | 吹き出しの横に出す。上限は送出の確認まで |
| Queued | `received` で turn が `running` | 吹き出しの横に出す。`queued_command` の記録を根拠にする |
| Delivered | `received` | 印を出さない。通知もしない |
| Handled in terminal | `received` で `delivery = terminal` | 端末の結果を一時表示する |
| Not delivered | `rejected` | 警告と理由を出す。Resend を出す |
| Unconfirmed | `unverifiable` | 注意と範囲を出す。Resend は出すが、二重になり得ると明記する |

- Not delivered は `rejected` にだけ使う。`unverifiable` に使わない。
- 今の `Message.tsx:113` は `failed` を Not delivered と出す。これを Unconfirmed に改める。

## 5 配達の契約

### 5.1 送信の前の記録

1. 画面は操作ごとに `cmd_id` を作る。再送でも同じ値を使う。
2. api は副作用の前に、`cmd_id`、対象の会話 ID、対象の実行の世代、端末 ID、本文のハッシュ、添付の一覧、受付時刻を永続化する。
3. 永続化が成功してから送出する。永続化に失敗したら送出せず、失敗の ack を返す。
4. 同じ `cmd_id` の再送は、記録を引いて現在の状態を返す。再び送出しない。
5. 記録の表は api の再起動をまたいで残る。メモリ上の抑止だけに頼らない。
6. 今の `ws/index.ts:224-247` はメモリ上の `sessionCommands` で抑止する。`send-watch.ts:82-101` は送出の後に記録する。どちらも改める。

### 5.2 対象の確認

- 送出の直前に、対象の会話 ID と端末の sessionId が一致することを確かめる。`hosts.ts:93-95` の規則は保つ。
- 対象の実行の世代が、記録した世代と違えば `rejected` にする。理由は `target_changed` である。
- 画面が塞がれていれば `rejected` にする。理由は `terminal_blocked` である。`hosts.ts:106`、`:118` の規則は保つ。
- `rejected` は下書きを保つ。画面は本文を消さない。

### 5.3 受信側の証拠の優先

受信の証拠は、強い順に次を使う。上の証拠があれば下は使わない。

| 順 | 証拠 | 得られる経路 | 値 |
| --- | --- | --- | --- |
| 1 | 受信側の相関 ID | managed の SDK と app-server。送った入力の ID が応答に返る | `received` confirmed |
| 2 | 受信側の記録に残る送信の印 | `queued_command` の attachment。`<bash-input>` と `<command-name>` の行 | `received` confirmed |
| 3 | 範囲内の唯一の候補 | 対象の会話の jsonl に、送出後の時刻で、本文が一致する user 行が 1 件だけある | `received` inferred |
| 4 | 端末の画面の反応 | 入力欄が空になり、応答の描画が始まった | `emitted` の補強。`received` にはしない |

- 候補が 2 件以上なら `unverifiable` にする。どれが自分の送信か決められないからである。
- 本文の一致は、送出の時刻より前の行を候補にしない。今の `send-watch.ts:175` は `seq` を境界にする。これを行の `source_ts` と送出時刻の比較に改める。
- PTY の Claude には相関 ID がない。要確認: `sessions/*.json` の `messagingSocketPath` と `peerFeatures` が、入力の受領を返す手段を持つか。

### 5.4 確認不能の扱い

- 期限内に受信の証拠がなければ `unverifiable` にする。「未着」と断定しない。
- 期限は、turn が `completed` なら送出から 60 秒を起点にする。`send-watch.ts:8` の値である。根拠は本番での誤通知が出なかったことであり、計測して確定する。
- turn が `running` なら期限を置かない。`queued_command` の記録を待つ。`send-watch.ts:200-205` の規則は保つ。
- 送出の直後に api が止まった場合は、記録が `accepted` のまま残る。再起動後は `unverifiable` にする。理由は `emit_unknown` である。
- `unverifiable` の後に受信の証拠が来たら `received` に直す。今の `send-watch.ts:187-192` の規則は保つ。

### 5.5 自動で再送しない

- api は自動で再送しない。runner も再送しない。
- 画面の再接続時の再送は、`cmd_id` の記録を引いて、`accepted` 以前のものだけ送出する。`emitted` 以後は記録の状態を返す。
- 利用者の Resend は新しい `cmd_id` を作る。元の `cmd_id` を `retried` にする。
- `unverifiable` の Resend には「届いていた場合は二重になる」と表示する。

### 5.6 入力の種類ごとの扱い

| 入力 | 送出の形 | 受信の証拠 | 配達の値 | turn への影響 |
| --- | --- | --- | --- | --- |
| 普通の発言 | 貼り付けと Enter | 5.3 の順 | 証拠に従う | `received` で turn の開始証拠になる |
| 作業中の発言 | 貼り付けと Enter | `queued_command` の attachment | `received`。画面は Queued | turn は変えない。吸収で user 行が出る |
| `!` の命令 | 貼り付けと Enter | `<bash-input>` の行。先頭の `!` とタグを除いて比べる | `received` | turn の開始にしない。`turns.ts:36` の規則は保つ |
| `/compact` | 貼り付けと Enter | `<command-name>` の行 | `received` | turn の開始にしない |
| 他のスラッシュコマンド | 貼り付けと Enter と画面の読み取り | 端末の画面の結果 | `received`。`delivery = terminal` | 変えない。`/clear` は対象を変える |
| 選択画面を開くコマンド | 貼り付けと Enter | 画面に選択欄が出た | `received`。`status = interactive` | 変えない。端末タブへ引き継ぐ |
| 同じ文を別の端末から打った | 本製品は送出していない | 候補が増える | 本製品の送信は `unverifiable` | その行は turn の開始証拠になる |

- 同じ文が別の端末から入った場合、本製品の送信の受信確認にしない。候補が 2 件になるからである。
- 本製品の送信と外の入力が同じ会話に並ぶことは許す。turn の証拠としては両方を使う。
- `!` の命令の照合は、今の `normalizeSentBody` では一致しない。`send-watch.ts:34-39`。`<bash-input>` の正規化を足す。

## 6 照合器の振る舞い

### 6.1 役割

- 照合器は、台帳の投影と証拠の表と走査の結果から、現在状態の snapshot を作る。
- 照合器は台帳の事実を書き換えない。走査の結果は観測の事実として追記する。
- 照合器の派生した値は snapshot にだけ置く。rebuild では証拠の表から作り直す。
- 照合器は api に置く。managed の生存証拠は runner が書き、照合器はそれを読む。

### 6.2 いつ動くか

| 契機 | 動き |
| --- | --- |
| 周期 | 1 秒ごとに全実体の有効期限を見る。期限切れを `unverified` に落とす。周期は `OBSERVATION_POLL_MS` と同じにする |
| 事実の追記 | 追記された実体の軸を再計算する |
| 走査の完了 | 走査の範囲にある実体の生存を更新する。失敗なら観測の健康状態だけ更新する |
| 配達の ack | `cmd_id` の記録を更新する。受信の証拠を探す |
| 画面の接続 | 最新の snapshot の版を返す。版は投影 seq と証拠の世代と観測の到達点の組である |
| api の起動 | 全実体の生存を `unverified` にする。理由は `api_restart`。走査の成功で戻す |

### 6.3 どう直すか

| 画面の値 | 外の世界の今 | 直し方 |
| --- | --- | --- |
| Working | 生存証拠が失効した | Unknown にする。理由 `liveness_expired`。turn の値は履歴に残す |
| Working | 走査が成功し、PID と指紋が不在 | Stopped にする。終了の根拠は `process_check` |
| Working | 親が終了確認済みの子 | Unknown にする。理由 `parent_exited`。結果は `unknown` |
| Stopped | 同じ世代の新しい turn の開始証拠が来た | Working に戻す。`runs.ts:48-62` の規則に従う |
| Idle | 生存証拠が失効した | Unknown にする。turn の `completed` は保つ |
| Done | 結果の証拠がない | Done を出さない。turn の値から Working か Unknown を出す |
| Not delivered | 受信の証拠が後から来た | Delivered に直す。警告を消す |
| Unconfirmed | 受信の証拠が後から来た | Delivered に直す |
| 最新の表示 | 観測が遅れている | 「Observation delayed」を出す。最新と言わない |

### 6.4 版の整合

- snapshot の版は、投影 seq、証拠の世代、観測の到達点の 3 つを持つ。
- patch は同じ版の値だけを含む。版の途中で読んだ値を混ぜない。
- 今の `projection-feed.ts:318-335` は変更一覧を読んで COMMIT した後に行を読む。読む範囲を同じ取引に入れる。
- 画面は snapshot の値を再計算しない。配置と表示形式だけを担う。

## 7 本番の実例

実例は `architecture-critique.md` の E1 から E6 である。本番の台帳を読み取り専用で確かめた。

### E1 29 時間前の開始証拠で子を running に保つ

- 対象は `agent-a46a60f85e3267c52` である。調査時も `runs` は running で、`last_evidence_ts` は `2026-10-14T00:10:09.463Z` のままだった。
- 本書の定義では、生存は `unverified` である。子は走査の対象外で、親の生存も失効している。
- turn は `unknown` である。理由は `parent_unverified`。
- 結果は `unknown` である。`SubagentHandback` の記録がない。
- 正しい表示は「Unknown · last seen 2026-10-14 00:18 · parent unverified」である。
- 同じ形の子が調査時にもう 1 件あった。`agent-a5358e578dcf966d6` である。これは生存中である可能性がある。定義は同じで、親が `alive_confirmed` なら Working になる。

### E2 届いた二件を未着として保存する

- 対象の会話は `1c0d055c-8912-452b-b273-47e9874df7e8` である。watch は `896eb201` と `8dceda21` で、調査時も `failed` だった。
- jsonl には `<bash-input>` の行が送出の後にある。これは受信側の記録に残る送信の印である。5.3 の順 2 に当たる。
- 本書の定義では、配達は `received` confirmed である。
- 正しい表示は印なしの Delivered である。Not delivered も Unconfirmed も出さない。
- turn は変えない。`!` の命令は turn の開始にしない。

### E3 同じ会話に別々の世代と終状態が残る

- 対象は `396247a1-5fc0-48e2-b984-2f4a8dac1f17` である。transcript の run は idle、hook の run は ended で、二本が残っている。
- これは同一性の課題である。本書は二本を一本に戻す規則を決めない。
- 本書の定義では、同じ会話の最新世代に対して、生存は PID の走査で決める。調査時の PID の有無は要確認である。
- 走査が成功して PID が不在なら、生存は `exited_confirmed` で表示は Stopped である。根拠は `session_end` か `process_check` である。
- 世代の数値の大小で新旧を決めない。hook の `SessionEnd` は終了確認であり、transcript の idle はそれを覆さない。
- 正しい表示は Stopped である。Done ではない。

### E4 圧縮要約の意味は後日の再解釈で修正されている

- 対象の message は `8f97c4a9-1cd5-4caf-947f-e9cf39e6ebcb` である。元の事実にフラグがなく、訂正で足した。
- これは解釈の版の課題である。本書の 8 節の「解釈の版の移行」で扱う。
- 本書の定義では、訂正の前の投影は turn の根拠として `isCompactSummary` の行を使っていない。`turns.ts:65` が除くからである。
- 正しい表示は、要約を利用者の発言として出さないことである。状態の軸には影響しない。
- 移行の途中では、未訂正の行を含む会話に「Reinterpretation pending」を出す。半分だけの新解釈を確定表示しない。

### E5 競合を記録して旧い内容を保持する

- 対象は `354000b1-4a87-45e8-baa7-6c1fa209d741.jsonl` で、seq 301024 に `observation.unsupported` がある。count は 5 である。
- 本書の定義では、競合は観測の健康状態の `failed` に当たる。情報源は transcript、範囲はそのファイルである。
- その会話の turn の証拠は、競合した範囲では信じない。生存は PID の走査で別に決める。
- 正しい表示は、状態の横に「Observation conflict in history · 5 records」を出すことである。
- 状態そのものは、生存の証拠に従う。生存が `alive_confirmed` で turn が `completed` なら Idle である。

### E6 Codex には不在照合が実際に働いている

- 対象は `01a12a12-39e2-7e10-a459-95926539bae6` の世代 1 である。seq 259872 で `process_absent` の idle になった。
- 走査は成功している。本書の定義では、生存は `exited_confirmed` で、範囲はローカルの codex プロセスである。
- turn は、最後の turn の証拠で決める。最終行は `2026-10-11T08:27:21.582Z` で、要確認: その行が `task_complete` かどうか。
- `task_complete` があれば turn は `completed`、なければ `unknown` である。不在から `completed` を作らない。
- 正しい表示は Stopped である。根拠は `process_check`。turn が `unknown` なら「Stopped · last turn unknown」である。

## 8 受け入れの条件

`scripts/e2e/run.mjs` に次の項目を足す。項目の名前は既存の `1-claude` から `10` に続ける。
正解は偽 CLI の `state.json` と `events.jsonl` に持つ。製品の投影を正解にしない。
期待は `/snapshot` の値で判定する。snapshot には 5 軸の値を次の名前で出す。

```text
projection.state[<conversation id>] = {
  liveness: { value, taken_ts, valid_until, reason },
  turn:     { value, taken_ts, reason },
  result:   { value, taken_ts, reason },
  observation: { <source>: { value, last_ok_ts, reason } },
}
projection.deliveries[<cmd_id>] = { value, emitted_ts, received_ts, reason }
```

| 項目 | 壊し方 | 期待する結果 |
| --- | --- | --- |
| `11-missing-stop` | 偽 CLI に `drop-hook: Stop` を足し、Stop だけを落として応答を終える | 応答の後、`turn.value === 'completed'` になる。根拠は transcript の `turn_completed`。行に Working が出ない |
| `11-missing-session-end` | `drop-hook: SessionEnd` で終了し、プロセスを `exit` させる | 次の走査の後、`liveness.value === 'exited_confirmed'`、`reason === 'process_check'`。行は Stopped |
| `11-missing-task-complete` | Codex の偽 CLI で `task_complete` を落として応答を終える | `turn.value === 'completed'` にならない。`liveness` が `alive_confirmed` の間は Working。`exit` の後は Stopped で `turn.value === 'unknown'` |
| `12-child-vanishes` | 子を起こし、`tool_use` を書いた直後に親ごと `kill -9` する | 走査の後、子の `liveness.value === 'exited_confirmed'`、`result.value === 'unknown'`。子の行は Unknown か Stopped。Working と Done は出ない |
| `12-child-handback` | 子が `SubagentHandback` を書いて終える | 子の `result.value === 'succeeded'`。行は Done。親の行は Idle |
| `13-reorder` | hook、transcript、親子の記録を 3 通りの順で取り込む | 3 通りの `projection.state` の 5 軸が一致する。`runs` の本数が同じ |
| `14-api-restart-after-enter` | 送信の Enter の直後、ack の前に api を止めて起動し直す | 偽 CLI の `events.jsonl` に同じ本文の `input` が 1 件だけ。`deliveries[cmd_id].value` が `received` か `unverifiable`。`rejected` ではない。再接続後に同じ `cmd_id` を再送しても `input` は増えない |
| `14-api-restart-keeps-pty` | 会話を起こしたまま api を起動し直す | 偽 CLI の PID が同じで生きている。再起動後 `liveness.value === 'alive_confirmed'` に戻る。この項目は PTY の所有を runner へ移した後に有効にする |
| `15-pid-reuse` | 偽 CLI を終え、同じ PID で別の `sessions/<pid>.json` を書く。`procStart` は変える | 元の会話の `liveness.value === 'exited_confirmed'`。別のプロセスを生存証拠にしない |
| `16-broken-sessions` | `sessions/` に壊れた JSON を 1 件置き、別の会話を終える | `observation.claude_sessions.value === 'failed'`。終えた会話は走査で `exited_confirmed` にならない。有効期限の後に `liveness.value === 'unverified'`、`reason === 'scan_failed'`。壊れた JSON を消すと `exited_confirmed` に戻る |
| `17-same-text` | ブラウザから送った本文を `drop-next` で落とし、同じ本文を端末タブから打つ | `deliveries[cmd_id].value === 'unverifiable'`。`received` にしない。端末の入力は turn の開始証拠になり、行は Working |
| `17-same-text-twice` | 同じ本文を 2 回続けて送る | 2 つの `cmd_id` が別の user 行に結ばれる。両方 `received`。`message_id` が重複しない |
| `18-rule-version` | `TURN_RULE_VERSION` を上げ、会話の再読を途中で止める | 再読が終わるまで、その会話に `observation.transcript.value === 'delayed'`、`reason === 'reinterpretation_pending'`。turn の値が旧版と新版で混ざらない。再読の完了で `healthy` に戻る |
| `19-read-during-projection` | 投影の更新中に `/snapshot` と `/conversation` を連続で読む | 返った `seq` と `generation` と `observation` の到達点が、同じ応答の中で一致する。snapshot の `runs` と `conversation` の run の状態が同じ版で矛盾しない |
| `20-done-only-from-result` | 対話の会話を終え、子を結果なしで終える | 対話の行に Done が出ない。子の行に Done が出ない。`result.value` が `succeeded` の実体だけが Done |
| `21-liveness-expiry` | 偽 CLI を `SIGSTOP` で止め、heartbeat と走査を止める | 有効期限の後に `liveness.value === 'unverified'`、`reason === 'liveness_expired'`。行は Unknown で「last seen」が出る。`SIGCONT` の後に `alive_confirmed` へ戻る |

- 既存の項目 `7` と `9-missing` と `9-bang` は、本書の言葉に合わせて期待を改める。`9-missing` は Unconfirmed を期待する。`9-bang` は Delivered を期待する。
- 既存の `journeys.mjs:151` は Idle と Done のどちらも受け入れる。これを Idle だけに改める。
- 各項目は正常な並びに加えて、遅延と重複を組み合わせた並びでも通す。
- 受け入れは `scripts/e2e/run.mjs` の終了コード 0 で判定する。項目の未実行は失敗である。

## 9 architecture-v2.md の改める箇所

| 箇所 | 今の記述 | 改める内容 |
| --- | --- | --- |
| 決定 2 外の会話の従の経路 | 確かでない状態は不明と表示する。経過時間だけで終了を断定しない | 保つ。「経過時間で終了にしない。経過時間で不明にはする」と足す |
| 決定 3 事実の台帳 | 画面の状態は台帳から組み立てる | 履歴は台帳から、現在状態は照合器の snapshot から組み立てると改める |
| 決定 12 WebSocket | 同じ `cmd_id` の再送は 1 回だけ作用する | 再送の抑止は永続化した記録で行う。副作用の前に記録すると足す |
| 決定 13 runner と api の分離 | api はいつでも再起動できる。実行は止まらない | ブラウザから起こした端末の PTY を runner へ移す。移すまでは api の再起動で生存が `unverified` になると明記する |
| プロセスの分離の表 | api の再起動で実行は止まらない | 同上 |
| 出来事を失わない仕組み | api は 500 ms ごとに台帳の seq を確かめる | 保つ。照合器の周期と観測の到達点の配信を足す |
| データモデル 実行 | 状態は 8 値の 1 つの列 | 5 軸に分ける。旧い `state` は移行の間だけ写す |
| 実行 `ended` の根拠表 | プロセスの確認は PID と開始指紋の組 | 保つ。開始指紋は `sessions/*.json` の `procStart` と明記する |
| 実行 終了の根拠にしない事象 | 一定時間の無更新は `unknown` にする | 保つ。有効期限の定義を本書に委ねると足す |
| 実行 SessionEnd の後の turn | 同じ世代の turn の開始で running へ戻す | 保つ。戻すのは turn であり、生存は走査で別に決めると足す |
| 接続 | 種類は `mcp`、`herdr`、`app`、`pid`、`ws` | `pid` の接続に `procStart` と `valid_until` を持たせる。heartbeat を足す |
| 出所の優先 外の会話の状態 | hook、次に履歴。経過時間は根拠にしない | hook と履歴は turn の根拠として対等にする。生存は走査と指紋で決める。経過時間は不明の根拠にする |
| Claude のホスト | `idle` をターンの終わりの合図に使う | 保つ。`idle` を依頼の結果に使わないと足す |
| 実行の監督 | api の再起動は実行の状態を変えない | PTY の所有が移るまで成り立たないと明記する |
| 外の会話の観測 不明の扱い | 観測の根拠が途切れた実行は `unknown` にする | 保つ。走査の成功を不在の条件にする。観測の健康状態を配信すると足す |
| 画面 共通の規則 | 状態の語彙は 6 値 | 4 節の対応表に置き換える。Done を依頼の結果に限る。Stopped と Unconfirmed を足す |
| 画面 一覧 不明のとき | 最後の根拠の時刻を添える | 保つ。理由の語彙を 4.2 に合わせる |
| 画面 エージェントの会話と入力 | 端末送信の契約を `terminal-slash-commands.md` に委ねる | 配達の契約は本書の 5 節を正本にする。`terminal-slash-commands.md` は送出の手順に限る |
| 受け入れの基準 標本 S2 | 無更新は `unknown` になる | 保つ。本書の 8 節の項目を受け入れに足す |
| 受け入れの基準 標本 S3 | 新しい世代が古い PID を引き継がない | 保つ。`15-pid-reuse` と対応づける |
| 受け入れの基準 標本 S11 | プロセス一覧の取得の失敗で `unknown` | 保つ。観測の健康状態が `failed` になると足す |
| 復旧の契約の表 | 5 点の故障の注入 | 8 節の項目を足す。`14-api-restart-after-enter` を含める |

`identity-redesign.md` にも矛盾がある。本書と合わせて次を改める。

- 「状態の根拠に経過時間は使わない」を「経過時間は不明の根拠にする」に改める。
- 「`sessions/*.json` の PID の不在は `idle` にする」を「生存 `exited_confirmed` にし、turn は変えない」に改める。
- 「普通の発言は本文の一致で届いたとする」を、5.3 の順に改める。
- 「`!` の命令は照合しない」を、`<bash-input>` の行を受信の証拠にすると改める。

## 要確認

- `sessions/*.json` の `status` と `updatedAt` の更新間隔。生存証拠に使えるかを計測で決める。
- `sessions/*.json` の `messagingSocketPath` と `peerFeatures` が、入力の受領を返す手段を持つか。
- 親の記録の `Task` の `tool_result` から、子の `agent id` を取る欄。
- hook の `SessionEnd` の `reason` の値の一覧。本番の台帳では `reason` の欄が確認できなかった。
- Codex の起動猶予 2 分の根拠。
- E3 の会話の調査時の PID の有無。
- E6 の rollout の最終行が `task_complete` かどうか。
- `14-api-restart-keeps-pty` を有効にする時期。PTY の所有を runner へ移す段と合わせる。
