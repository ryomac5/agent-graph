# 会話のつながりと根と状態の作り直し

2026-10-15。読み手は実装する AI agent である。
対象は、どの会話がどの根に属し、今どの状態かを決める作りである。
設計の正本は `architecture-v2.md` であり、本書はその「会話」「関係」「実行」「名前と別名」の節を具体化する。
本書は設計だけを示す。コードは変えていない。

## 目的

- 会話のつながりの正を 1 つに決め、推測で根を組み立てない
- 根と系列と状態の定義を 1 つずつ固定し、core の投影だけが決める
- 画面と api は core の値をそのまま出し、再計算しない
- 残る推測は根拠と優先の順を明記し、機械で確かめられる受け入れ条件を持つ

## 用語

| 語 | 意味 |
| --- | --- |
| 会話 | provider と native ID で識別する 1 本の履歴。Claude は jsonl 1 ファイル |
| 系列 | 確定したつながりで結ばれた対話の会話の集合。1 本の線として並ぶ |
| 根 | 利用者が話す系列の見出し。一覧の 1 行であり、子の会話を含まない |
| 子 | 根から委譲された会話。native の子、sdk-cli、runner の委譲、審査役 |
| 実行 | 会話をある期間だけ動かした世代。再開ごとに世代が増える |
| つながり | 会話と会話の関係のうち `continued`、`forked`、`adopted` |
| 届いた | 画面から送った発言が、会話の履歴に利用者の発言として現れた |

## 現状

### 情報源と事実

| 情報源 | source | 書く事実 | 会話の識別の形 | 世代の決め方 |
| --- | --- | --- | --- | --- |
| Claude の jsonl | `transcript-claude` | `conversation.created/updated`、`message.*`、`relation.created` の `continued` `compacted` `delegated`、`run.created`、`run.state_changed`、`run.updated` | `["claude","<id>"]` | hook の run があれば行より前に始まった最新の run に結ぶ。無ければ最初の行の時刻を世代にして自前の run を作る |
| hook の通知 | `hook` | `conversation.created`、`conversation.updated` の場所、`run.created`、`run.updated`、`run.state_changed` | `claude:<id>` | adapter が outbox の世代ファイルで決める。startup と resume で新しい値、他は継承 |
| kit の記録 | `kit` | `alias.created` の `kind=kit`、`delegation.*`、`relation.created` の `delegated` | 台帳の会話 ID。native_id が 1 件に一致したときだけ | 持たない |
| runner の記録 | `host-claude` `host-codex` `host-antigravity` `intake` | `conversation.created`、`run.*`、`relation.created` の `forked` `adopted` `delegated` `review_of` | runner の UUID。native ID は `conversation.updated` で後から付く | 1 から数える整数 |
| 旧い daemon の移行 | `legacy` と `kit` の `conversation.updated` | `alias.created`、`conversation.created`、`relation.created` の `continued` `copied` `delegated`、`run.*`、`kit_name` | 旧 ULID と台帳の会話 ID | 持たない |
| 画面の操作 | `ui` | `conversation.renamed`、`conversation.hidden`、`run.state_changed` の訂正 | 根の ID。系列の最初の会話の ID | 持たない |

本番の台帳では、同じ Claude の会話に `claude:<id>` と `["claude","<id>"]` の 2 つの subject がある。
`projectConversationIds` が provider と native_id で同一視し、api は `api_conversation_ids` に写す。
hook の run は `run:claude:<id>:<世代>` を subject にし、transcript の自前の run は `run:["claude","<id>"]:<世代>` を subject にする。
同じ会話に世代の違う run が 2 本並ぶ。投影は generation の大きい方を最新として使う。

関係の種類ごとの件数は次のとおりである。

| source | type | confidence | 件数 |
| --- | --- | --- | --- |
| transcript-claude | continued | confirmed | 7 |
| transcript-claude | compacted | confirmed | 15 |
| transcript-claude | delegated | confirmed / inferred | 336 / 52 |
| intake | delegated / review_of | confirmed | 4 / 1 |
| kit | delegated | inferred / unknown | 45 / 147 |
| legacy | continued / copied / delegated | 混在 | 4 / 4 / 200 |
| rollout-codex | delegated | confirmed | 3 |

観測した Claude の会話には `forked` が 1 件もない。
Claude Code 2.1.299 は fork の親の jsonl に `continued-in` を追記する。
transcript はこれを `continued` として記録する。fork と背景移行は台帳の上で区別されない。
hook の `SessionStart` は `source` に `startup` `resume` `fork` `compact` を持つ。本番の件数は 1401、53、1、3 である。
`clear` は 2.1.299 の読解で `SessionEnd(clear)` が確かめられている。`SessionStart` 側の値は要確認。
この値は `run.created` の `last_evidence.input.source` に残るが、投影は使っていない。

### 会話のつながりの流れ

```
Claude Code                dotfiles hook            api                      core
-----------                -------------            ---                      ----
SessionStart(source) ----> agent_hook.py
                            |-- fork なら親を探す: transcript > pane > process
                            |-- sessions.json に名前を継がせる
                            '-- events.jsonl に session_start を書く
                           hook-v2 adapter -------> hook/index.ts --------> run.created(claude:<id>:<世代>)
                                                                            conversation.created(claude:<id>)
jsonl 追記 ----------------------------------------> observe/claude/index.ts -> conversation.created(["claude",id])
                                                                            message.*, relation(continued/compacted)
                                                    observe/claude/context.ts -> run.state_changed(hook の run か自前の run)
sessions.json ------------------------------------> observe/kit/index.ts --> alias.created(kind=kit)
                                                                                      |
                                                                                      v
                                                    projection-feed.readRoots -> projectRoots(roots.ts)
                                                                                      |
                                                    dashboard lib/roots.ts <----------'  名前・状態・日付を再計算
```

### 投影の組み合わせ

`projectRoots` は `packages/core/src/ledger/projections/roots.ts` にある。
入力は会話の行と関係の行と、user_name を持つ会話の事実である。
手順は次のとおりである。

1. hidden の会話とその関係を除く
2. `continued` の confirmed で、両端が interactive の組を union-find で結ぶ
3. interactive でない会話と、`delegated` の終点と `review_of` の始点を子の群にする
4. `forked` の confirmed を、子の群に含まれない interactive の組だけ結ぶ
5. 同じ project と同じ `kit_name` を持つ会話を結ぶ
6. 群の中で interactive がなく、外から `delegated` か confirmed の関係が入る群は根にしない
7. kit のある project では、`kit_name` を持たない群を根にしない
8. 群を `created_ts` で並べ、先頭を根の ID、project、名前の候補にする
9. 状態は、待ちと実行中を優先し、次に最新の活動時刻で選んだ会話の run の状態にする
10. 日付は、群と子孫の活動時刻の最大にする
11. 自動の名前は、群のどれかの `kit_name`、なければ先頭の会話の名前にする
12. user_name は、系列全体を 1 つの実体として `projectEntities` で時刻順に畳み、最新を使う

`projectRuns` は `runs.ts` にある。run の subject と世代ごとに状態を畳む。
`ended` は根拠の表で確かめる。`session_end` の後は、同じ世代の確かな turn の開始で `running` に戻す。
hook の turn の通知があるときは、transcript の `turn_completed` の idle を補助とみなして捨てる。

`projectConversations` は `conversations.ts` にある。
名前は、subagent なら明示の名前か作業の名前、他は作業の名前、明示の名前、最初の依頼の抜粋の順である。
kit_name は `alias` の `kind=kit` から取り、旧い `conversation.updated` の `kit_name` を後ろに置く。

api の `projection-feed.ts` は `readRoots` で会話の行に run の状態と活動時刻を足し、`projectRoots` を呼ぶ。
user_name を持つ subject の事実だけを SQL で選んで渡す。

### 画面の使い方

| 画面の部品 | 使う投影 | 自分で決め直す値 |
| --- | --- | --- |
| `lib/roots.ts` の `selectRoots` | roots、conversations、runs、messages、message_memberships、relations、projects、delegations | 名前、状態、日付、current_conversation_id、kit の日付名 |
| `lib/roots.ts` の `currentRootConversation` | roots、runs、conversations | 操作先の会話 |
| `lib/roots.ts` の `orderSeries` | conversations、runs | 系列の並び。活動時刻で並べ、つながりの順は使わない |
| `lib/activity.ts` の `resolveActivity` | runs | 系列の状態。待ちと実行中を優先し、最新世代の時刻で選ぶ |
| `lib/conversation-tab.ts` | roots、runs | タブの名前と状態と経過時間 |
| `lib/identities.ts` | api の identities | `claude:<id>` と `["claude","<id>"]` の読み替え |
| `pages/workspace/WorkspacePage.tsx` | roots、tree | 選ぶ根、作業場の session、系列の会話 |
| `lib/panes.ts` の `migrateWorkspaceSeries` | roots の conversation_ids | 系列の古いタブを今の会話へ移す |
| `components/RootViews.tsx` | roots | 並びの群、開始時刻、相対時刻 |

core が決めた名前と状態と日付を、画面が 3 か所で上書きしている。
同じ根を api と画面が違う規則で呼ぶ。これが日付と名前の不一致の元である。

### 推測に頼る箇所

| 場所 | 推測 | 起きた不具合 |
| --- | --- | --- |
| `dotfiles/.agents/bin/agent_hook.py:153-165` `resolve_fork_parent` | transcript に親が無ければ pane と process の直近の session_start を親にする | fork が別の根の名前を継いだ |
| `agent_hook.py:113-150` `find_transcript_parent` | 候補が 1 件のときだけ親にする。2 件なら不明 | 同時 fork で親が決まらない |
| `agent_hook.py:204-214` `resolve_session_name` | 親の名前を子に継がせる。名前の継承が系列の根拠になる | 名前の一致で根が決まる |
| `packages/adapters/src/hook-v2/index.ts:59-75` | 世代を outbox のファイルで決め、startup と resume だけ新しくする | 同じ会話の fork 元と子が別の世代の体系を持つ |
| `packages/api/src/hook/index.ts:42-43, 55` | 会話 ID を `claude:<id>` にし、種別を entrypoint で決める | 2 つの ID の形が残る |
| `packages/api/src/observe/claude/index.ts:137-139` | origin と type を entrypoint と前回の値から決める | 無人と対話の取り違え |
| `packages/api/src/observe/claude/index.ts:293-301` | `continued-in` を `continued` にし、fork と背景移行を区別しない | 作業場のタブが前の会話に残る |
| `packages/api/src/observe/claude/context.ts:116-124` | turn の事実を行より前に始まった最新の hook の run に結ぶ。無ければ行の時刻で自前の run を作る | hook と transcript の run が別々に残る |
| `packages/api/src/observe/claude/sessions.ts:50-58` | `sessions/*.json` の PID が無ければ idle にする | 別の端末の attach で idle に落ちる |
| `packages/api/src/observe/kit/index.ts:103-107` | native_id が 1 件に一致したときだけ別名を付ける | 別名が遅れて付く |
| `packages/core/src/ledger/projections/roots.ts:59-66` | project と kit_name が同じ会話を同じ根に結ぶ | 名前の継承の誤りがそのまま根の誤りになる |
| `roots.ts:80-88` | kit のある project では kit_name の無い系列を根にしない | 名前が付く前の会話が一覧に出ない |
| `roots.ts:89-90, 105` | 最も古い会話を根の ID と名前の候補にする | 根の名前が最も古い会話で決まる |
| `roots.ts:101-104` | 状態と操作先を待ちと時刻の順位で選ぶ | SessionEnd の後の Done |
| `roots.ts:133-139` `connectRootDelegations` | kit の session 名と根の名前の一致で委譲を根に結ぶ | 名前を変えると結びが外れる |
| `packages/core/src/ledger/projections/runs.ts:48-62` | SessionEnd の後の再開を、同じ世代の turn の開始と時刻の前後で判定する | 直したばかりで、時刻のずれに弱い |
| `runs.ts:112-114` | hook の turn があるとき transcript の idle を捨てる | hook が落ちると idle に戻らない |
| `packages/core/src/ledger/projections/conversations.ts:181-190` | 最初の利用者の発言から名前を作る | 圧縮の要約や差し込みが名前になる |
| `packages/core/src/ledger/claude-message-flags.ts:11-16` | isMeta は user かつ中継でないときだけ隠す | isMeta の行が人の発言として出た |
| `packages/core/src/ledger/turns.ts:36` | 端末の操作の印を正規表現で除く | `!` の命令を turn の開始と誤る |
| `packages/api/src/service/send-watch.ts:72-77` | `/compact` 以外のスラッシュは照合しない。`!` は照合する | `!` の命令が未着と出る |
| `packages/api/src/service/projection-feed.ts:527-531` | 会話の活動時刻を run の時刻だけで足す | 日付が最新のやり取りにならない |
| `packages/api/src/observe/session-query.ts:25-26` | `c.id` と `provider:native_id` の 2 形を SQL で同一視する | 2 形の存続 |
| `packages/dashboard/app/src/lib/roots.ts:59-82` `renameKitRoots` | kit 名の正規表現から日付の名前を作り、最初の会話の抜粋で上書きする | 根の名前が最も古い会話で決まる |
| `lib/roots.ts:85-96` `rootName` | 名前が内部の ID に見えたら会話の名前で呼び直す | 名前の揺れ |
| `lib/roots.ts:118-121` | 状態と日付を画面で再計算する | api と画面で日付が違う |
| `lib/roots.ts:160-168` `currentRootConversation` | 投影の値が無ければ時刻で操作先を選ぶ | タブが前の会話に固定 |
| `lib/roots.ts:177-180` `orderSeries` | 活動時刻で系列を並べる | 継続元の再開で並びが変わる |
| `lib/activity.ts:16-19` | 待ちと実行中を優先し、最新世代の時刻で選ぶ | 子の状態の混入は防ぐが世代の違いは見ない |
| `pages/workspace/WorkspacePage.tsx:49-52, 87` | URL の root が無ければ会話として扱う | 根の行が分かれると作業場が揺れる |
| `lib/panes.ts:88-95` `migrateWorkspaceSeries` | 系列に含まれるタブを今の会話へ移す | 系列の判定が誤れば別の会話へ移る |

## あるべき作り

### 原則

1. つながりの正は Claude 自身の記録である。hook と kit と画面は、つながりを決めない
2. 会話の識別は 1 つの形だけを使う。新しい事実は `["claude","<id>"]` の形だけを書く
3. 根と系列と名前と日付と状態は core の `projectRoots` だけが決める。api と画面は再計算しない
4. 推測は `inferred` の関係として残し、統合には使わない。利用者の訂正だけが `confirmed` に上げる
5. 名前の一致は根拠にしない。別名は検索と表示の補助である

### 会話のつながりの正

| つながり | 正とする記録 | 記録する source | 種類と確度 |
| --- | --- | --- | --- |
| Claude の fork と背景移行 | 親の jsonl の `continued-in` 行。`sessionId` と `continuedInSessionId` | transcript-claude | `continued` confirmed。evidence に hook の `SessionStart.source` があれば `fork` か `resume` の別を足す |
| Claude の子側の fork の印 | 子の jsonl の `forkedFrom` 行。将来の版で現れたとき | transcript-claude | `forked` confirmed。親側の `continued` と同じ系列に結ぶ |
| Claude の compact | 同じ jsonl の `compact_boundary` 行 | transcript-claude | `compacted` confirmed。新しい会話を作らない |
| Claude の /clear | 元の会話の `SessionEnd(clear)` と新しい session_id。新しい側の `source` は要確認 | hook | 関係を作らない。新しい系列になる |
| runner の fork と adopt | runner の操作の記録 | host-claude、host-codex | `forked` と `adopted` confirmed |
| Codex の fork | `thread/fork` の `forkedFromId` | host-codex、rollout-codex | `forked` confirmed |
| 委譲 | 受付の依頼 ID。native の子はディレクトリ | intake、transcript-claude、host-codex | `delegated` confirmed |
| kit の親子 | events.jsonl の `codex_start` | kit | `delegated` inferred か unknown。根の判定には使わない |
| 利用者の訂正 | 画面の操作 | ui | 任意の種類を confirmed で足す。取り消しは `relation.state_changed` |

hook の `agent_hook.py` は、親を pane と process から探す経路を捨てる。
transcript の `continued-in` で親が決まらないときは、名前を継がせず新しい番号を取る。
その番号は別名である。根の判定には使わない。

### 定義

| 項目 | 定義 |
| --- | --- |
| 系列 | interactive の会話を、confirmed の `continued` `forked` `adopted` で結んだ連結成分。子の群は除く |
| 根 | 系列そのもの。根の ID は系列の中で `created_ts` が最も早い会話の ID。会話が増えても変わらない |
| 現在の会話 | つながりの末尾の会話。末尾が複数なら `created_ts` の遅い方。別の会話に live な run があればその会話 |
| 根の名前 | 下の名前の規則の最初に当たる値 |
| 根の日付 | 系列と子孫の、最後の発言の時刻と最新の run の根拠の時刻の最大。core が `last_activity_ts` に書く |
| 根の開始 | 系列の最初の会話の最初の発言の時刻。無ければ run の開始。core が `started_ts` に書く |
| 根の状態 | 現在の会話の最新世代の run の状態。子の状態は混ぜない。待ちと実行中の会話が他にあればその会話に切り替える |
| 子の数 | `delegated` で辿れる会話と、runner の委譲の数。状態は `running` だけを数える |

名前の規則は次の順である。先に当たった値を使う。

1. 系列のどの会話でも、最も新しい `user_name`。`ui` の rename と transcript の `custom-title` を同じ優先で時刻順に畳む。null は解除
2. 系列の最も新しい会話の `ai_title`
3. 系列の最初の会話の `first_request_excerpt`
4. kit の別名
5. provider と開始の時刻

`created_ts` が無い会話は末尾に置く。同じ時刻は ID の辞書順で決める。

### 実行と世代

| 項目 | 規則 |
| --- | --- |
| run の ID | `<会話 ID>:<世代>`。会話 ID は `["claude","<id>"]` の形だけ |
| 世代の正 | hook の `SessionStart` の世代。startup と resume と clear と fork で新しい値。compact は継承 |
| transcript の run | hook の run があれば、そこに turn の事実を結ぶ。hook の run が 1 本も無い会話だけ自前の run を作る |
| hook の run が後から来た場合 | 自前の run はそれ以後の事実を受けない。最新世代は hook の run になる |
| 状態の根拠 | hook の `UserPromptSubmit` と `Stop`、transcript の turn の行、runner のホスト。経過時間は使わない |
| 終了の根拠 | `architecture-v2.md` の `ended` の表のとおり |
| SessionEnd の後の turn | 同じ会話の同じ世代の確かな turn の開始で `running` に戻す。今の `canResumeSession` の規則を保つ |
| プロセスの不在 | `sessions/*.json` の PID の不在は `idle` にする。終了にしない |

### 届いたかの判定

| 入力 | 履歴に現れる形 | 判定 |
| --- | --- | --- |
| 普通の発言 | `type=user` の本文 | 本文の一致で届いたとする |
| `/compact` | `<command-name>` の行 | 一致で届いたとする |
| 他のスラッシュ | 現れないことがある | 照合しない。端末の結果で返す |
| `!` の命令 | `<bash-input>` の行 | 照合しない。端末の結果で返す。turn の開始にもしない |
| 圧縮の要約 | `isCompactSummary=true` の user 行 | 人の発言として出さない。turn の根拠にしない |
| isMeta の差し込み | `isMeta=true` の user 行 | 中継の報告以外は出さない。turn の根拠にしない |

### 残る推測と優先の順

| 場面 | 推測 | 根拠の優先 | 残す形 |
| --- | --- | --- | --- |
| 親の jsonl に `continued-in` が無い fork | 旧い版の Claude か、書き込みの遅れ | 1. 後から現れる `continued-in`。2. 利用者の訂正 | 新しい根として出す。関係は作らない |
| hook が無い会話の世代 | transcript の最初の行の時刻 | 1. hook。2. transcript | 自前の run を作り `reason` を残す |
| 会話の種別 | entrypoint の値 | 1. hook の `entrypoint`。2. jsonl の `entrypoint`。3. 前回の値 | `conversation.updated` で訂正できる |
| kit の委譲の親 | session 名と根の名前の一致 | 1. `parent_native_id`。2. 名前の一致は inferred | 木の表示に候補として出す。根の判定に使わない |
| 名前の候補 | 最初の利用者の発言 | 1. user_name。2. ai_title。3. 抜粋 | `name_is_provisional` を残す |

### 場面ごとの振る舞い

| 場面 | 記録 | 系列と根 | 名前 | 状態と日付 | 作業場のタブ |
| --- | --- | --- | --- | --- | --- |
| fork | 親の `continued-in`。hook の `SessionStart(fork)` | 同じ根。現在の会話は子 | 根の名前を保つ。kit の番号は親と同じ別名 | 子の run を使う。日付は子の発言 | 親のタブを子へ移す |
| resume | hook の `SessionStart(resume)` | 同じ会話。新しい世代 | 変わらない | 新しい世代の run。前の世代は `ended` の根拠を保つ | そのまま |
| /clear | hook の `SessionStart(clear)`。新しい session_id | 新しい根 | 新しい番号か最初の依頼 | 新しい run | 新しい根の作業場を開く |
| compact | `compact_boundary`。hook の `SessionStart(compact)` | 同じ会話。関係は `compacted` | 変わらない。要約は名前にしない | 同じ世代の run | そのまま |
| ブラウザの名前の変更 | `ui` の `conversation.renamed`。subject は根の ID | 変わらない | 系列全体の名前になる | 変わらない | タブの名前が変わる |
| 端末の /rename | 子の jsonl の `custom-title`。subject はその会話 | 変わらない | 系列全体の名前になる。時刻の新しい方が勝つ | 変わらない | タブの名前が変わる |
| SessionEnd | hook の `run.state_changed(ended, session_end)` | 変わらない | 変わらない | `ended`。同じ世代の次の turn で `running` に戻す | そのまま |
| 別の端末での attach | 新しい PID の `sessions/*.json`。hook は同じ session_id | 同じ会話 | 変わらない | 同じ世代を続ける。PID の不在は idle に留める | そのまま |
| herdr とダッシュボードの同時の表示 | 同じ台帳 | 同じ根 | kit の別名は herdr の枠の名前。根の名前は規則のとおり | 同じ値 | 影響なし |
| 確認の会話 | cwd が smoke の場所。hook の input に `verification=true` | `hidden` で根から除く | 付けない | 投影には残す | 一覧に出さない |
| Codex の会話 | rollout と host-codex | `["codex","<thread>"]` の系列。fork は `forked` | 最初の依頼の抜粋か user_name | thread の状態 | Claude と同じ |
| 子の会話 | `delegated` の終点 | 根に混ぜない。根の木に出す | 依頼の題 | 子の状態。根の `running_children` に数える | 子のタブ |

### 投影の出力

`RootProjection` に次を足す。画面はこの値だけを使う。

| 列 | 値 |
| --- | --- |
| `started_ts` | 根の開始 |
| `series` | つながりの順に並べた会話の ID。先頭が最初、末尾が現在 |
| `name_source` | `user` `ai_title` `excerpt` `kit` `fallback` のどれか |
| `state_conversation_id` | 状態を取った会話の ID |

画面の `renameKitRoots`、`rootName`、`orderSeries`、`conversationActivity` は削る。
`resolveActivity` は子の木だけに使い、根には使わない。

## 移行

### 制約

- 台帳は追記専用である。`source_event_id` と `payload` は変えない
- 新しい形の事実を足し、古い事実は identities の写しで読み替える
- 本番の台帳は約 7 GB、facts は約 30 万件である
- api の起動し直しは、ブラウザから起こした端末の根を切る。利用者の合意を得て時刻を決める
- 保護対象の会話 `1c0d055c` `354000b1` `fea1ff97` は隠さない

### 投影版の引き上げ

`RUNNER_PROJECTION_VERSION` を 11 から 12 に上げる。
`initializeRunnerProjection` は版の違いで表を作り直し、`projection_state.last_seq` が 0 なら `rebuildInitialProjection` が走る。
要確認: `packages/api/src/service/index.ts:167-168` は `projectedSeq === 0` のときだけ全体投影を選ぶ。版の引き上げで `last_seq` を 0 に戻す経路があるかを確かめる。
無ければ `agent-graph-api rebuild` を手で走らせる。

offline rebuild の所要は未測定である。`perf-baseline.md` には起動時の同一性 SQL が 300 ms、全体の準備が 1.5 秒とある。
run 1 本の 262 件の再投影は 6 ms だった。全件の外挿はしない。
手順は次のとおりである。

1. 台帳を `~/.cache/agent-graph/rebuild/` に `cp` で写す。7 GB の複製の時間を記録する
2. 写しに対して `node packages/api/src/cli.ts rebuild --db <写し>` を走らせ、所要時間と `projection_state` を記録する
3. 写しの `roots` と本番の `roots` を比べ、分かれた根と増えた根の一覧を出す
4. 所要が 10 分以内なら本番で同じ手順を行う。超えるなら段 1 で差分投影だけに留め、全体の rebuild は深夜に回す
5. 本番は api と runner を止め、台帳を退避し、rebuild を走らせ、起動する

### 段 0 計測と標本

- 作るもの: 写しでの rebuild の計測。分かれた根の一覧。`packages/core/test/samples/` に S1 と S4 の実データ由来の標本
- 触るもの: `scripts/`、`packages/core/test/samples/`
- 受け入れ: `node scripts/verify-session-end.mjs` が通る。写しの rebuild が完了し、所要が記録される

### 段 1 core の投影

- 作るもの: `projectRoots` の作り直し。`kit_name` の結びと kit project の除外を削る。`series` `started_ts` `name_source` `state_conversation_id` を足す。名前の規則を実装する。`projectRuns` は変えない
- 触るもの: `packages/core/src/ledger/projections/roots.ts`、`conversations.ts`、`storage.ts`、`packages/core/test/`
- 受け入れ:
  - `pnpm -F @agent-graph/core test` が通る
  - 標本 S1 と S4 で、系列が `continued-in` だけで結ばれ、同じ kit 名の別系列が混ざらない
  - 同じ事実を 2 回流して事実の数が増えない。順序を入れ替えて投影が同じになる
  - `scripts/e2e-ui.mjs` の `projection equals ledger rebuild` が通る

### 段 2 api の識別と取り込み

- 作るもの: hook の事実を `["claude","<id>"]` の形で書く。`SessionStart.source` を `continued` の evidence に足す。`verification` の印を hook の input から読む。`send-watch` で `!` と未確認のスラッシュを照合しない。`readRoots` の活動時刻の再計算を削る
- 触るもの: `packages/api/src/hook/index.ts`、`packages/adapters/src/hook-v2/`、`packages/api/src/observe/claude/`、`packages/api/src/service/send-watch.ts`、`packages/api/src/service/projection-feed.ts`
- 受け入れ:
  - `pnpm -F @agent-graph/api test` と `pnpm -F @agent-graph/adapters test` が通る
  - 新しい hook の事実の subject に `claude:` の形が無い。SQL で `count(*) = 0`
  - `scripts/e2e-ui.mjs` の `projection matches ledger` と `no missing browser patch` が通る
  - `!` の命令を送って未着にならない。要確認: `scripts/e2e/run.mjs` は main に無い。項目名を決めてから足す

### 段 3 画面

- 作るもの: `renameKitRoots` `rootName` `orderSeries` `conversationActivity` の削除。`selectRoots` は投影の値をそのまま返す。作業場のタブは `series` の末尾へ移す
- 触るもの: `packages/dashboard/app/src/lib/roots.ts`、`activity.ts`、`conversation-tab.ts`、`panes.ts`、`pages/workspace/`
- 受け入れ:
  - `pnpm -F @agent-graph/dashboard test` が通る
  - `scripts/e2e-ui.mjs` の `no browser exceptions` が通る
  - サイドバーの根の行の `last_activity_ts` が、投影の `roots` の値と一致する。要確認: `scripts/e2e/run.mjs` に項目を足す

### 段 4 hook の整理

- 作るもの: `agent_hook.py` の pane と process による親の推定を削る。親が決まらない fork は新しい番号にする
- 触るもの: `dotfiles/.agents/bin/agent_hook.py`、`dotfiles` の試験
- 受け入れ:
  - dotfiles の試験が通る
  - 親の無い fork で `sessions.json` に親の名前が継がれない

### 段 5 本番の切り替え

- 作るもの: 投影版 12 で本番を rebuild する。分かれた根の一覧を利用者に見せ、必要な訂正を `ui` の関係で足す
- 受け入れ:
  - `projection_state` の `last_seq` が台帳の最大 `seq` に一致する
  - `scripts/e2e-ui.mjs` が通る
  - 保護対象の会話が一覧に出る

## 危険と決めるべきこと

### 危険

| 危険 | 影響 | 備え |
| --- | --- | --- |
| 旧い版の Claude の fork に `continued-in` が無い | 過去の根が分かれる | 段 0 で一覧を出し、`ui` の `continued` で訂正する |
| 7 GB の rebuild が長い | api の停止が長い | 写しで計測し、10 分を超えたら深夜に回す |
| hook の事実の形を変える | 古い事実と新しい事実が同じ会話に並ぶ | identities の写しで読み替える。古い事実は変えない |
| 名前の規則の変更 | 一覧の名前が一斉に変わる | `name_source` を出し、変わった理由を画面で示す |
| kit の委譲が根に結ばれなくなる | 木から委譲が消える | `parent_native_id` のある委譲だけを結ぶ。無いものは候補として出す |
| api の起動し直し | ブラウザから起こした端末が切れる | 利用者と時刻を決める |

### 決めるべきこと

1. hook の run が後から来たとき、transcript の自前の run を `ended` にするか。新しい `end_evidence.kind` が要る
2. 名前の規則の 2 番を、最新の会話の `ai_title` にするか、最初の会話にするか
3. 親の無い fork を新しい根にするか、`inferred` の候補として前の根に並べるか
4. kit の委譲のうち `parent_native_id` の無いものを、木に出すか隠すか
5. `scripts/e2e/run.mjs` の項目名。本書の受け入れ条件はそこに写す
6. 投影版 12 の rebuild を本番で行う時刻

### 決めたこと

2026-10-15 に根が決めた。

1. hook の run が後から来たら、transcript の自前の run を閉じる。`end_evidence.kind` に `superseded_by_hook` を足す。
2. 名前の規則の 2 番は、最新の会話の `ai_title` にする。今の話題に合う名前を優先する。
3. 親の無い fork は、新しい根にする。推測で前の根に結ばない。
4. `parent_native_id` の無い kit の委譲は、sessions.json の明示の対応で根に結ぶ。対応が無ければ木に出さない。
5. 受け入れ条件の項目名は、scripts/e2e/run.mjs ができたあとに写す。
6. 投影版 12 の rebuild は、写しで所要を測ってから、利用者と時刻を決める。
