# 状態・配達の判定一覧

2026-10-15。正解は `packages/core/test/state/` の入力・期待値の表で固定する。第3版の文章を直す代わりに、以下を `packages/core/src/state/` に実装した。

## 入出力と範囲

- `evaluateState(input, evaluatedAt, policy?)` は生存・所持・閉鎖・turn・結果の段階・表示・理由・証拠ID・期限を返す。
- `evaluateDelivery(input, evaluatedAt, policy?)` は指定した `cmdId` の配達・表示・理由・確度・期限・走査の健康・自動再送禁止を返す。
- `readNativeEvidence` は秘匿済みでも読める原記録の構造を証拠へ写す純粋関数で、既存の分類関数や投影は呼ばない。
- `Signal.tools` は開始／結果と呼び出しIDを保持する。`source=claude_session` はsessionsのsnapshotを読み、`activity=session_busy` とPID・procStartを伴う進行へ写す。
- 時刻は UTC の epoch milliseconds とし、出来事／照会完了の `at`、取得の `observedAt`、評価の `evaluatedAt` を分ける。
- `runId`、`turnId`、所有プロセス、依頼・試行、配達対象は呼び出し側が確認済みの対応を渡し、この層は同一性の推定・統合・最新世代選択をしない。
- 親に生存を頼る子は、起動時に記録したPID・procStartを `parentProcessAtLaunch` に固定し、現在の親を `process` に渡す。起動時の組が未記録なら省略または `null` とし、生存をunverified／missing_evidenceにする。独立した実行だけ `"independent"` を明示する。現在の親の組で起動時の組を補完・更新しない。
- 配達の `target` は会話・実行・端末の版を含む解決済みの鍵、`bodyKey` は正規化済みの内容の比較用の鍵とし、本文は判定に渡さなくてよい。
- 配達の入力には照合範囲内の他の操作・受信も含め、同文の操作を一件ずつ切り離して一意だと判断しない。
- OS照会、走査、記録の永続化、送出、タイマー、再構築、snapshot配信、画面への接続は純粋な判定関数の外で行う。API の接続規則は後述する。
- schema版、投影版、既存の公開口、既存の状態規則、本番の記録は変更しない。

## 判定の規則（1行1規則）

- R01: 証拠IDは不変の事実を識別し、同じIDの再読は最初のobservedAtを保持して一件にする；順序はat・idで決め、JSONのキー順を使わない（内容の訂正は別IDとsupersedesで渡す）。
- R02: まだ発生していない、またはまだ取得していない証拠は、その評価時点には使わない。
- R03: `supersedes` は指定した証拠IDを撤回し、訂正後に新しい状態証拠がなくなる場合も撤回を保持する。
- R04: 同じ時刻に両立しない状態がある場合は、IDの辞書順で勝者を決めず Unknown にする。
- R05: 生存は登録のPID・procStartとOSの現在値で決める；登録のbusyと有限のstatusUpdatedAtは、対応済みのturn・一致するPID・procStartに限り進行の証拠とし、その時刻から300秒有効とする（生存・完了の証拠にはせず、updatedAt・startedAt・再読時刻では延ばさない）。
- R06: 対象を含む成功した走査だけが不在を証明し、全体失敗・一件の破損を含む部分成功・対象外の走査からは不在を作らない。
- R07: PIDがあってOS開始値を取得できない場合は不在とも一致ともせず、従前の有効な照会があればその期限まで保つ。
- R08: 確認済みの同じプロセス世代の exit／PIDと開始値の不一致は終了の履歴として保持し、後のPID再利用で生存へ戻さない。
- R09: 走査失敗は健康状態を failed にし、従前の生存・所持の期限を早めも延ばしもしない。
- R10: 所持の不在は期限付きの Not hosted とし、物理終了・論理閉鎖・turn完了へ写さない。
- R11: SessionEnd／thread closed／archive は論理閉鎖と対応するturnの終端とし、物理終了とは区別する。
- R12: 論理閉鎖の後の確認済みの新しいturn開始は open に戻せるが、道具の進行だけでは閉鎖を解除しない。
- R13: 通常の開始・進行・待ちは出来事のatから期限を数える；同じturnの未完了toolがあり所有プロセスの生存を確認できる間だけ、生存確認のvalidUntilを根拠にWorking／running_toolとrunning toolの印を返す。親に生存を頼る子はR20の起動回の一致も必須とし、不一致・欠落なら通常の進行のatから300秒でUnknownへ落とす。
- R14: 証拠の期限到達時（evaluatedAt >= validUntil）はその証拠による保持を解く；長いtoolの生存が失効し通常の進行も古ければUnknownとし、終了・成功・不在を作らない。
- R15: Stop／SubagentStopのhook・attachment、終端の `stop_reason` は停止の試みとし、turn終了を確認できないため Unknown／boundary_unavailable にする。
- R16: 本文・tool・PreToolUse／PostToolUse（hookとattachment）は進行とし、toolの開始と結果を呼び出しIDで対応させる；AskUserQuestionのtool_useとPreToolUse hookはinput、Notification hookのpermission_promptはapproval、idle_promptはstop_attempt（Unknown／boundary_unavailable）へ写す。対応結果／PostToolUse・Stop・待ち・idle_prompt・turn終端・プロセス終了で未完了toolの保持を解き、後の通常進行・生存確認では古いtoolを復活させない。SubagentHandbackやidle_promptをturn完了にしない。
- R17: turn_duration、対応済みの同期Agent completed、SDK result／idle、Codexのturn終端は完了の証拠とし、過去の完了は失効させない；run_in_backgroundのfalse／"false"は同期、true／"true"は非同期として読む。
- R17a: 親のtask-notificationはqueue-operation/enqueueのcontentまたはuserの本文から読む。task-idがchildIdと完全一致するstoppedはchild_stopped、completedはcompleteへ写す。親のpromptIdを子へ流用せず、responded・Done・物理終了は作らない。child_stoppedはUnknown／boundary_unavailableとし、未完了toolの保持を解く。確かな利用者のEsc中断（ClaudeのRequest interrupted、Codexのturn_aborted／status=interrupted）はcomplete＋interruptedのままIdleへ戻す。
- R18: 確認済みの完了後に同じturnの進行がある場合は証拠競合として Unknown にし、別turnへの対応を推測して補わない。
- R19: 旧turnの終端や鍵のない終端は選択した別turnを閉じず、run自体が未解決なら代表表示を Unresolved にする。
- R20: 子の生存は起動時の親のPID・procStartと現在の親の組が両方一致するときだけOS走査から確認する。同じsession_idでもどちらかが変わればunverified／owner_restarted、起動時の組が未記録ならunverified／missing_evidenceとし、新しい親の生存を引き継がない。一致する起動回の長いtoolは保持するが、子のturnと結果は子に対応する証拠だけで決める。親のtask-notificationも、task-idがchildIdと完全一致し、呼び出し側が子のturnに対応付けた場合に限り採る。
- R21: Agent async_launched と Codex spawnAgent の操作完了は launched のみであり、応答・完了・Doneを作らない。
- R22: Codexのcollabからrespondedを得るには、完了したwait、対象のreceiverThreadIds、対象のagentsStatesのcompletedと応答、解決済みの依頼への対応をすべて要求する。
- R23: closeAgentや応答のないwaitはrespondedを作らず、子の最終応答と親の操作の完了を区別する。
- R24: 結果の段階は同じ試行の証拠を累積し、必要な段階そのものが確認できた場合だけ succeeded にする（中間段階は捏造しない）。
- R25: 応答後の検証不合格は failed とし、最終応答だけでverified／reviewedへ進めない。
- R26: handbackの成功はreported、失敗はreportFailuresであり、失敗から依頼全体のfailedを作らない。
- R27: Claudeの最終is_errorとCodexのfailed turnは依頼の失敗とし、一般のtool_resultのis_errorは依頼の失敗にしない。
- R28: 同じturn・試行の先行する中断要求へ明示的に結び付く終了エラーは interrupted とし、そのエラーを failed と重ねない。
- R29: succeeded・failed・interruptedが同じ試行で競合したら Unknown／evidence_conflict とし、先着した結果を固定しない。
- R30: 必要な結果段階を得ずに所有プロセスの終了が確定したら結果は Unknown とし、生存未確認だけなら incomplete を保つ。
- R31: 履歴競合は正常走査で消さず、競合行の UUID／ファイル内 offset で対応した turn にだけ inferred と unconfirmed を添える。位置不明の旧い記録から全 run へ印を広げない。対象ファイルの完全な全件再読で再現しなかった場合は supersedes で撤回する。
- R32: 代表表示の優先順は Unresolved、Stopped、Needs approval、Waiting、Working、Closed、Not hosted、Idle、Unknown とし、Doneは結果の別の印だけにする。
- R32a: API の `renderConversationState` は、親の代表が Idle で、現在の子の少なくとも一つが Working または Needs approval、かつその試行が stage=launched または value=incomplete のとき、親を Waiting for agents として配る。親の turn は completed のままとする。Unknown／Stopped の子、古い世代の子、親自身の Stopped／Closed／Not hosted はこの表示にしない。子の期限切れ・停止・完了でも再計算し、画面は API の値だけを読む。
- R33: 生存未確認でも新鮮なturnは Working／Waiting 等を表示し、liveness unverified を添える。
- R34: 配達の同じcmdIdで対象かbodyKeyが異なる場合は cmd_id_conflict とし、受領を確定しない。
- R35: 送出前の拒否だけを Not delivered とし、送出の試みと拒否が競合する記録は Unconfirmed にする。
- R36: acceptedのまま所有者が停止した記録は送出なし、emitting以降の中止・所有者停止は Unconfirmed とする。
- R37: 受領を確定するのは対象と永続化された相関IDが一致する受信証拠だけであり、本文・タグ・時刻・端末画面では Delivered を作らない。
- R38: 各操作の受信候補は最初の送出開始−許容ずれ以上、送出開始＋配達期限未満の同文に限り、取得が遅れても出来事の時刻で照合する（上限は時計ずれで延ばさない）。
- R39: 候補が一入力だけで、他の送信操作と共有されない場合だけ Likely delivered／Likely queued とする。
- R40: 複数入力または複数操作への対応が残る候補は Unconfirmed とし、過去に出した候補も集合から再評価して取り消せる。
- R41: キューと吸収後のuser行は同じ受信inputIdがある場合だけ一入力にまとめ、本文一致だけでまとめない。
- R42: 相関付き受領は候補や端末処理済みからも昇格でき、相関が別操作と共有される場合は競合として確定しない。
- R43: 配達待ちの上限は最初の送出開始から60秒とし、emittedの戻り・turn変化・再接続によって延ばさない（送出開始前の滞留は最初の受付から数える）。
- R44: 配達期限切れ・受信記録の不在・走査失敗はいずれも Unconfirmed であり、Not deliveredを作らない。
- R45: 再接続・同じcmdIdの再提示・墓標だけの復旧は追加の送出を許可せず、すべての出力でresendAutomatically=falseを返す。
- R46: 確定受領・送出前拒否の墓標は保持し、Unconfirmedの墓標には後着の相関付き受領を適用できる。
- R47: peerと未検証SDKの相関欄は確定受領に使わず、対応保証がない入力の結論を Unconfirmed に固定する。

## 第3版／第3回レビューからの決定

| 指摘 | 固定した決め方・第3版との差 | 試験 |
| --- | --- | --- |
| N1 | collabの一括respondedを廃止し、起動・waitの応答・closeを分ける | `N1 Codex collab…`、`N1 wait requires…`、E1 |
| N2 | 「先に成立した方」を廃止し、結果の競合はUnknown、中断に対応するerrorは中断とする | `success and failure conflict…`、`N2 success, failure…`、`matching interruption…` |
| N3 | 全同一性は範囲外のまま、prompt_id／promptId、payload.turn_id、params.turn.id、result.turn.idだけを読む；SDKの入力UUID集合や行UUIDをturnにしない | `native correlation fields…`、`SDK aggregated…`、E3 |
| N4 | Stop等を無期限のcompleted/inferredにする規則を削除し、境界不明へ落とす；報告とturn終了も分ける | `Stop is a boundary attempt…`、`blocking Stop…`、実物handback |
| N5 | 候補／端末処理済みも集合から再評価する；操作と入力の双方で一意性を確認する | `two same-text inputs revoke…`、`N5 two same-text sends…`、queue吸収、相関昇格 |
| N6 | hook開始も期限付き、走査失敗は期限を維持；turn別の60秒／24時間と途中の期限延長を削除して最初の送出開始基準に統一する | `expiry is exact…`、`one corrupt sessions…`、`send call never returns…`、`duplicate cmd acceptance…` |
| N7 | 一つの表示関数に固定し、生存未確認の新鮮な進行をWorking、推定にはunconfirmedを添える | 代表表示270組、`inferred progress…`、E6時点別 |
| N8 | E4の「元々turn証拠なし」と、誤った開始証拠の訂正を分ける；証拠kindではなく固定されたreason型を返す | E4、`N8 a later summary correction…`、PID走査 |

第3版E6の不在直後のNot hostedは採らない：実時刻は進行窓内なのでWorkingが優先し、そもそも旧台帳には走査成功と完全な範囲が保存されていないため、このfixtureだけからnot_hostedを作らない。
第3版のmanaged承認待ちをプロセスheartbeatだけで無期限に保つ例外は採らない：現在もその要求を待つ証拠の照会が渡されない限り、他の待ちと同じ期限でUnknownにする。
旧い移行済みclosedはそれだけで候補とせず、保存した受信候補が再評価できる場合にだけLikely deliveredとする。

## f9e61dfのレビューからの修正

一律の「最後のprogressから300秒」という根拠を、通常の進行の鮮度と「未完了tool＋生存確認」の二つに分けた。toolの開始・結果を取り込み時に捨てないことで、Bashや同期Agentの無出力を期限延長の例外として列挙せず扱う。tool保持の出力には開始・最新進行・生存走査の証拠IDと生存期限を含める。

| 指摘 | 固定した規則・回帰試験 |
| --- | --- |
| 長いtoolをUnknownに落とす | 生存確認中はWorking＋running tool；死亡・PID再利用・生存期限境界・走査失敗・Stop・結果・待ち・閉鎖を検査。単なるstartや本文だけの進行は従来どおり失効する |
| sessionsとtool hookの証拠を捨てる | busyのstatusUpdatedAtを進行時刻に使用。世代違い・turn未解決・未来・時刻欠落・古いbusyは採らない。Pre／Postを実物のattachmentと台帳hookで検査 |
| run_in_backgroundの文字列 | falseと"false"のresponded／completedを確認し、true・"true"・欄なしからは作らない |
| JSONキー順に依存 | 同じID・入れ替えたキー順・ネストのキー順・再読で一件になることを検査。既存の配達試験で異なる証拠に使っていた同じIDを分け、期待するDeliveredは維持 |
| 配達候補の上限なし | 期限直前の受信は遅れて取得しても候補、期限ちょうど以降の同文入力はUnconfirmed。別操作の窓も独立に照合する |

ID付きの並行toolは別々に閉じる。IDのない開始は次の結果で、IDのない結果は先行する開始を閉じる。Stopや待ちより前のtoolを、後の通常進行・busy・生存再確認だけでは復活させない。Codexのfunction_call／custom_tool_callとそのoutput、commandExecution／mcpToolCall／collabAgentToolCallの開始・完了も同じtool証拠へ写す。

新鮮なbusyは通常の進行と同じく生存未確認でもWorking＋liveness unverifiedになり得る。busyを再読しても期限は延びず、確定した死亡・新しいStop・完了を上書きしない。生存未確認の新鮮な進行を表示するR33と、300秒を越えるtool保持の条件を区別する。

配達期限内のqueueと期限後の吸収が同じinputIdを持つ場合は、一入力のLikely deliveredへ進める。期限後に新しく手入力した同文は候補にしない。相関IDで確定した受領は、この候補用の窓に制限しない。

## 0c1b908のレビューからの修正

生存の根拠を「現在の親」から「子を起動した回の親」へ絞った。`parentProcessAtLaunch` は呼び出し側が保持する起動時の組であり、純粋関数は永続化や現在値からの補完をしない。不一致を物理終了とは断定せず、通常の進行の期限へ戻す。同じ回でも、生存期限・失敗した走査・停止・待ち・結果などの既存の制約は維持する。

NotificationとAskUserQuestionは、既存のapproval／input／stop_attemptへ写す。toolの名前や通知ごとの保持例外を状態判定に増やさず、既存の待ち・停止境界で未完了toolを解く。AskUserQuestionの直後のPreToolUse hookもinputにすることで、質問中に通常toolへ戻らない。

- E1の子の実物記録に、新しい親の生存走査と別の起動回の組を与えると、開始から31時間後でもUnknownになる。同じ回の組でも停止通知があればUnknown／boundary_unavailableとなる。停止通知がない入力ではWorking／running_toolを保つ。
- PIDだけの変更、同じPIDでprocStartの変更、両方の変更、起動時の組の欠落を別々に検査する。旧い親がOS上に残る場合でも、新しい親へ生存を付け替えない。
- permission_promptはNeeds approval、AskUserQuestionはWaiting、idle_promptはUnknownになる。生存しているまま15,492秒後へ進めてもWorkingにならず、結果や新しいtoolで進行を再開できる。
- 起動時のPID・procStartとOS走査、待ちの原記録は合成条件である。15,492秒はレビュー報告の長さを使った試験であり、今回の本番再計測ではない。
- 作業ツリー内の隔離コピーでexecution.tsだけを0c1b908へ戻すと起動回の5試験、records.tsだけを戻すと待ちの5試験が失敗することを確認した。作業中の実装は戻していない。

## f64f276のレビューからの修正

E1の親12153行目をreadFileSyncだけで読み、queue-operation/enqueueのtimestamp・task-id・statusをfixtureへ追加した。IDは既存のnative-7に合わせ、本文・パスは保存していない。stoppedの原文は前の会話で完了記録が見つからず、停止または親終了時に実行中だった可能性を述べているため、物理終了やIdleを断定しない。子の停止通知はchild_stoppedとして、会話を再利用できる確かな利用者の中断（Idle）と区別する。

起動時の組の省略による生存の借用を廃止した。独立した実行は明示値independentへ移し、子の組の欠落・不一致は同じ安全側の判定へ集めた。試験の共通ヘルパーも独立実行を明示する。停止・完了、ID不一致・欠落、子turn未対応、queueとuserの両形式、停止通知なしの継続、起動時の組の省略を回帰試験で検査する。隔離コピーでrecords.tsだけをf64f276へ戻すと2件、execution.tsだけを戻すと3件が失敗することを確認した。

## 本番fixtureと正しい出力

本番DBは `DatabaseSync(path, { readOnly: true })` の読取トランザクション、原記録は `readFileSync` で読んだ。採取は2026-10-15 08:03 UTC（補足の同期子の先頭行はその後に追加）、最大seqはfixtureの `maxSeq` に記録した。16件の台帳、26行の原記録（E1の停止通知12153行目を追加）、2件のwatchを保存し、会話本文・道具の入力と出力・パス・認証情報は保存しない。IDは整合した仮名に置換し、原記録の時刻・欄・欠落は保つ。テストの実行中は本番を読まない。

| 実例 | 入力の所在 | 固定した正しい出力 |
| --- | --- | --- |
| E1 | critique E1の親12136/12138/12153、子1/271、seq298560/298573/298574 | 停止通知なしの断片はUnknown/progress_expired；12153を子のturnへ対応付けると同じ親の生存中もUnknown/boundary_unavailable、結果launched/incomplete（Doneなし） |
| E2 | critique E2の137/145、seq301136/301145、watch2件 | 両方received_candidate／Likely delivered；確定Delivered・Not deliveredにはしない |
| E3 | critique E3の5/31/32、seq301161〜301180の該当7件 | run対応未解決の入力はUnresolved；物理終了と統合を推定しない |
| E4 | critique E4の136、seq251644/289242 | 要約はturn証拠なし；この断片だけではUnknown；別標本で誤った開始の撤回も検査 |
| E5 | seq301024、count=5 | この断片だけではUnknown＋History conflict · unresolved；5件の位置は不明のまま |
| E6 | critique E6のrollout2/8/42/43、seq259872 | 不在記録時刻ではWorking＋liveness unverified；後の評価時刻ではUnknown/progress_expired；Stopped・Closed・Doneを作らない |

- E1末尾と先頭の対応は全271行のparentUuidの連なりを読み取りで確認し、fixtureにその確認結果を残した；本関数内で同一性を構築したわけではない。
- E2は元のwatch本文の先頭`!`と受信の`<bash-input>`タグをメモリ内で除いて一致を確認し、本文の代わりに異なる二つのbodyKeyと一致の事実だけを残した。
- 補足の実物は第3回レビューの同期Agent（2.1.291）の呼出し37／結果39と子の先頭、および第1回レビューの子A535の1／13／14／176／177／190／192／194とする。
- 同期子のpromptIdは親の結果行のpromptIdと一致することを確認し、試験のためだけのturn鍵は足していない。
- E3の二runの対応、E5の競合位置、E6の当時のPID・走査成功は不明のままであり、固定表の期待に補完しない。

### 長いtoolの追加fixture

`test/state/fixtures/long-tools.json` は2026-10-15 08:45 UTCに採取した。transcriptはreadFileSync、台帳はreadOnlyの読取トランザクションで読み、最大seqは308440。原記録8行とhook2件の時刻・構造を残し、本文・入力・出力・パスを除去しIDを仮名化した。結果のtool_use_idとparentUuidが呼び出しに一致することを確認し、結果行のpromptIdで対応を与える。テスト中に本番を読む処理はない。

| fixture | 入力の所在・確かめた長さ | 固定した出力 |
| --- | --- | --- |
| 長いBash | fea1ff97の580→588、2026-10-11 07:52:29.628→08:24:02.195 UTC、1,892.567秒 | 結果直前、生存証拠ありはWorking＋running tool；生存証拠なしはUnknown；結果到着後は通常のprogress |
| 同期Agentの親と子 | 92d75d6fの33／38／39／40、20:32:13.875→20:46:50.959 UTC、877.084秒。子の1／327、promptId一致 | 子の327行目の時点で、親は生存証拠ありならWorking＋running tool、子は自身の進行でWorking；親の結果到着後は通常のprogress |
| hook | seq305231のPreToolUse、seq303631のPostToolUse（異なる呼び出し） | 各々progressとtool開始／結果を保持 |

当時のOS生存確認はこれらの原記録にない。fixtureの経過時間は実測であり、生存の走査は試験側で与えた条件である。実際にその時点のOS確認が成功していたとは断定しない。

## 未確認と検証の限界

- 通常進行・待ちの300秒、配達待ちの60秒、時計ずれ0秒は未計測の仮値であり、偽の入力を使った期限機構の試験は実環境での安全性の保証ではない。確認中の未完了toolに300秒を上限として当てない。
- 照会の期限は入力のvalidForMsで指定し、試験ではClaudeの仮値120秒などを使う；実機の適切な周期は未確認である。
- Codexの旧い2分の不在猶予から成功・終了を作る規則は持たず、完全で成功した走査証拠がない標本は不明に保つ。
- SDK複数入力からturnへの対応、利用中SDKのUUID往復、peerの動的保証は実機未確認であり、それぞれUnknown／Unconfirmedを試験に固定した。
- 純粋関数は再送を許可しないが、永続化・排他・実際の一回性やPTYの継続を保証する実装ではない；runner／apiとの接続は次の段の作業である。
- 入力表は全順列を使い、途中の逐次評価・重複入力・最終出力全体の一致を検査する（E3の7件は5,040順序）。
- 回帰の正解は旧い投影値ではなく固定した表に置く。今回のexecution・records・evidence・deliveryをそれぞれHEAD f9e61dfの実装に置き換えた隔離コピーで、対応する回帰試験が落ちることを確認した。作業ツリーの実装は戻していない。

受け入れは `builtin cd packages/core && node --test test/state/ && node --run test`。Node 24.6では明示的なディレクトリ指定が探索されないため、`test/state/index.js` が同じ試験ファイルを読み込む。通常のcore試験でもすべての新規 `.test.ts` を実行する。

## API と画面への接続

純粋関数の導入時に範囲外とした走査・永続化・配信を API に接続した。台帳の投影は原記録のメタデータだけを持ち、API の `CurrentState` が構造化した原記録と sessions の走査から `evaluateState` を呼ぶ。評価時刻・証拠 ID・期限を判定と一緒に配り、事実の seq が進まなくても期限で再評価する。schema 版と投影版は変えない。

配信する `state_decisions` とその `decision_id` は評価時刻 `evaluatedAt` を含めず、証拠・期限・判定内容から作る。評価時刻は台帳の事実ではなく照会のメタ情報なので、snapshot／patch の外側の `evaluated_at` で配り、投影本体の再構築比較から外す。期限をまたいで判定内容が変われば ID も変わる。同じ内容の判定を保持するキャッシュの有無やプロセスの再起動で ID は変わらない。会話の到着も実行の対応付けを変えるため、会話の事実が増えたときは対応付けを作り直す。

子の起動より前に得た有効な親の PID・OS 開始値を API に固定して永続化する。起動時の組がない既存の子は `null` のまま扱い、後から見つけた親で補完しない。親の通知は task-id と子の turn に対応付け、親の入力にはしない。走査は成功・部分失敗・全体失敗と完了時刻を保存し、現在の判定に必要な走査だけをメモリに読む。物理終了の最初の証拠は後の成功走査や API 再起動でも保持する。

配達は送出前の受付と送出開始を永続化して `evaluateDelivery` に渡す。同文だけの受信は候補にとどめ、API が返す `message_id`／`queue_id` で画面の行を結ぶ。画面は状態・配達・時計を再判定せず、英語の表示と API の優先順を使う。

`state-journeys.mjs` に Stop 欠落、SessionEnd 欠落、子の tool 中の停止、子停止通知、親再起動、承認待ち、長い tool、別端末の同文、走査失敗、Esc 後の再開を置く。本番サービスや本物の CLI を使わず、隔離した偽 CLI から原記録を生成する。

### c690e9f の再構築と性能の再確認（2026-10-15）

確かめたこと:

- S17 のソケット試験は単独 5 回とも待受の EPERM で既存の skip。通信を使わない既存 S17 は 5 回合格したが、時計を固定していた。
- 時計を進める新しい S17 回帰試験は、旧実装では `decision_id` と `evaluatedAt` の deep-equal 不一致で落ちる。時刻の修正だけでは、会話を遅らせた逐次取り込みで `last_activity_ts`／`last_evidence_ts` が欠けて落ちる。両方の修正後は再構築・再起動・逆順と巡回順の逐次取り込みで投影全体が一致する。旧実装の確認には作業ツリー内の隔離コピーを使った。
- 会話の到着で全実行を再計算する修正案は API の大量取り込み試験で単独でも遅延 131.8 ms / 上限 100 ms となった。再計算の根拠を「変更された会話に属する実行」に絞り、同じ試験で遅延 93.6 ms、投影更新 83.3 ms を確認した。
- API 全試験の再実行では同測定だけが 103.2 ms で超過した。未修正の `c690e9f` の隔離コピーでも単独で 105.6 ms の超過を確認したため、この境界付近の揺らぎは今回の修正前にも存在する。
- 判定の準備処理には remote 会話を探す全台帳の走査があった。検索条件に一致する API の部分索引を追加し、全台帳の走査を除いた。単独 3 回の最大遅延は 85.9 / 80.3 / 80.4 ms、投影更新は 73.7 / 69.3 / 70.2 ms で全回合格した。索引は既存 API の索引と同様に起動時に作り、schema 版・投影版は変えない。
- runner は `git archive c690e9f^` と `git archive c690e9f` の隔離コピーで `node --import ./test/setup.ts --test test/scale.test.ts` を交互に各 3 回実行した。各実行は性能の試験ファイルだけを指定し、依存は既存の node_modules を参照した。全 6 回合格した。最も重い artifact の 7 標本の中央値は次のとおり。review は全回約 0.06 ms、intake と supervisor は約 0.01 ms。上限 50 ms は変更していない。

| 回 | 変更前 200k / 400k (ms) | 変更後 200k / 400k (ms) |
| --- | --- | --- |
| 1 | 23.38 / 24.32 | 25.40 / 23.86 |
| 2 | 23.33 / 23.49 | 23.70 / 24.15 |
| 3 | 23.48 / 24.82 | 23.42 / 24.95 |

推測: 前後の性能差を再現できず、報告の 53.5 ms は一時的な負荷変動と判断する。当時の負荷は記録されていないため、競合した処理までは特定できない。

最終確認: `ws.test.ts` は最終コードで 5 回とも失敗なし（各回 6 合格・ソケット禁止による 6 skip）。core は 552 合格、API は 838 合格・既存の 21 skip、dashboard `test:app` は 934 合格。API と dashboard app の型検査と `git diff --check` も合格した。ソケット版 S17 の実際の待受と再起動は、この環境では未確認である。

### 状態の置き換えのレビュー 8 点（2026-10-16）

- プロセスの開始値は epoch milliseconds に正規化する。公開型の `procStart` は文字列のまま epoch を格納する。Claude sessions の ctime は UTC、保存済み ps と Codex の開始値は OS のローカル時刻として読む。新しい ps は `LC_ALL=C TZ=UTC` で取得する。API 起動時に保存済み所持者と走査も正規化し、過去の文字列不一致を死亡証拠として残さない。
- Claude の uuid→parentUuid の辺は、信号のない attachment でも保持する。本文は保存しない。既読範囲は一度だけ読み直して欠けた辺を追記し、補完済みの事実と cursor の印で再起動後の全件再読を防ぐ。
- 旧送信行は baseline_seq と message_id を引き継ぐ。closed＋message_id は received の墓標、failed は元の baseline から候補を再評価する。誤って移行済みの行も元表から補修する。これはユーザーが指定した移行契約であり、旧 closed を一律候補にする以前の記述に優先する。
- state だけを送るホストは supervisor が turn の鍵を付ける。running・待ち・idle は同じ鍵を共有し、idle 後の running で新しい鍵にする。鍵のない過去の host 終端を、別の turn へ推定で付け替えない。
- Codex の SubAgentActivity completed は、agent_thread_id が子 ID と一致し、その時点の子自身の turn が既知の場合にだけ complete にする。親の turn_id を使わず、responded や Done は作らない。started は launched、interacted は相手の状態を変えない。
- 走査の削除は feed の CurrentState だけが行う。worker の個体は削除しない。
- 受信照合は投影済み seq の差分を読む。候補を保持したまま後着の同文・相関を再評価する。所属の後着・訂正・再構築では受信集合を読み直す。状態の評価では走査ごとに session/PID を索引化し、対象 PID の照会結果だけを純粋関数へ渡す。
- 通知は idle と result の succeeded/failed を読む。Stopped・Not hosted・Unknown・Closed を成功通知にしない。グラフは API の状態をそのまま使い、承認の有無で上書きしない。承認・入力待ちでも turn_started_ts を保持する。

schema 版・投影版・依存は変更しない。UUID 補完の印は既存の conversation.updated の空 payload として追記するため、台帳の事実数だけが一会話につき一件増える。

本番の確認は `node scripts/e2e/prod-replay.mjs`。`--db`、`--claude-home`、`--codex-home` で読み取り元を指定でき、`--keep` は隔離コピーを調査用に残す。readOnly 接続の VACUUM INTO でコピーし、HOME・XDG の書き先を隔離して取り込む。元の outbox は消さず、CLI や API/runner は起動しない。終了値は 0=全判定成功、1=期待との差、2=読み取り／走査未完了。E1 はコピーから組み立てた子の現在値、E2 は実 watch ID の移行結果、E3 は対応未解決という表の入力条件のままコピーの原台帳7件を再生して検査する。E3 の現在の別世代との同一性を新しく断定する試験ではない。

### socket と本番の写しで見つけた不具合（2026-10-16）

- 同じ cmd_id の再提示は、受付時と再提示時の宛先を同じ解決の後で比べる。受付の後で会話と run の別名が解決しても、R34 の衝突にしない。送信履歴も会話の別名を解決して引く。
- agent_id を持つ SubagentStart／SubagentStop hook は、親の session に届いた子の出来事である。親の turn の境界や進行にしない。Notification の permission_prompt など、他の hook は agent_id があっても親自身の証拠として読む。
- Claude の原記録の時刻は親子の順と一致しない。PostToolUse の attachment は親の tool_result より前の時刻を持つ。turn の対応は uuid の辺を先に集め、祖先の promptId を辿って決める。
- 本番の旧い api は failed の送信行を 24 時間で消す。prod-replay は E2 の行が写しに無いとき、critique の E2 の表の値で写しにだけ戻す。本文は受信行の `<bash-input>` から復元するので、本文の一致はこの再生では検査していない。
- E1 の表の Unknown は親の生存中の値である。親の不在を走査が示せば、R32 の優先順で Not hosted が代表になる。prod-replay は所持の値に応じて代表を検査し、turn と結果の段階は表のまま検査する。

### 本番規模での第2回レビュー（HEAD 4ece917 からの修正）

増分読み取りを止める根拠を台帳全体の `observation.unsupported` の有無から、競合ファイルに属する実行へ変えた。通常は更新された実行だけを読み、親の相関が変わった場合に限って子を更新する。親子の索引を一度作り、子ごとの全実行探索をやめる。原記録は子の起動結果・task-notification・Codex の collab／SubAgentActivity だけを保持し、通常の本文・tool・UUID の辺は証拠へ変換後に解放する。

競合の記録には原記録の時刻と UUID／offset を残す。競合したファイルは初回と変更時に全件再読し、再現する競合は範囲を訂正し、再現しない競合は既存の observation.unsupported への supersedes で撤回する。途中までの行を残す読み取りや差分だけの成功を撤回の根拠にはしない。位置のない E5 の断片を直接 core に渡す標本は従来の期待を保持するが、API はその位置を推定して現在の turn に付けない。

| 入力・試験 | 固定する出力 |
| --- | --- |
| 競合ファイル＋12 subagent の後に別実行へ一件追記 | 更新実行と競合ファイルだけ再読。再起動の全件評価と投影が一致 |
| 通常本文100件＋後着の子停止通知 | 通常の records 保持は0件、通知だけ1件。子の停止判定は再起動でも一致 |
| 同じファイルの旧 turn の行が競合 | 対象 turn だけ競合印。別 run・後続 turn には付かない |
| Claude／Codex の旧い競合が全件再読で再現しない | supersedes を追記し、再起動でも復活しない |
| agent_id 付き Notification permission_prompt／PreToolUse／UserPromptSubmit | 承認・進行・開始の親の証拠を保持 |
| Idle の親＋Working／Needs approval の子＋launched／incomplete | Waiting for agents。親の turn は completed のまま |
| 子が Unknown／Stopped／Idle／Waiting、または試行が完了 | 親を Waiting for agents にしない |
| 親自身が Working／Stopped／Unknown／Needs approval | 子の表示で上書きしない |
| 子の進行が期限切れ、後着の停止通知、再起動 | 親の代表表示と decision_id・配信 patch が追従 |
| 直近7日の Claude／Codex、古い run・未来の run | 提供元ごとに turn 鍵欠落の分母・件数・割合を算出。古い run・未来は除外 |

prod-replay の上限は一件追記後の同期 refresh が **300 ms**、GC 後の評価プロセスのヒープが **400 MiB**。300 ms は設計書の追記から表示まで1秒から、poll 500 ms と配信・描画の余裕200 msを除いた予算であり、実測で決めた値ではない。最大の履歴を持つ既存実行へコピー内で一件追記して測る。取り込み worker の snapshot は閉じて解放し、評価用サービスを開き直す。`node --expose-gc scripts/e2e/prod-replay.mjs` で実行し、GC が使えない場合はヒープを未確認とする。

turn 鍵欠落率の上限は提供元別 **1%（暫定）**。`readTurnCoverage` の分母は最終証拠（なければ開始）が直近7日以内の実行とし、0件は理由付き skip とする。open/close だけの信号から「依頼なし」は証明できないので、信号では除外しない。証拠なし・部分取り込みも turn 鍵がなければ欠落に数える。分母から外すのは、turn 鍵がなく、台帳の外の独立した記録が依頼なしを示す実行だけである。一つは使用量確認で、製品の一覧の除外と同じく unattended かつ cwd が `USAGE_PROBE_PATH` の会話とする。もう一つは対話の実行で、原記録が無いか、開始から終了までに時刻を持つ行が無いものとする。判定は prod-replay の `noRequestEvidence` が原記録を直接読んで行い、外した件数を `excludedWithoutRequest` に出す。E1〜E3 の元の ID が消えている場合は失敗でなく unavailable、busy 会話がなければ理由付き skip とする。終了コードは不一致があれば1、失敗がなく未確認があれば2、それ以外は0。単体試験は3300 ms・1 GiB・欠落率2%を拒否する。

偽 CLI の e2e 項目 `state-waiting-agents` は、背景の子の起動→親 Waiting for agents→子停止通知→子 Unknown／親 Idle を、API とブラウザの双方で検査する。本番コピーでの実測、socket の待受、ブラウザ e2e の実行結果は別環境で記録する。schema 版・投影版・依存は変更していない。

回帰の確認: 作業ツリー内の隔離コピーで、`current-state.ts`、取り込みの `index.ts`、core の `execution.ts`、`prod-replay.mjs` をそれぞれ `4ece917` に差し替えた。対応する追加試験は順に6件・3件・1件・4件失敗した。作業ツリーの実装と Git の履歴は戻していない。本番の時間・ヒープの改善値はここでは測定していない。

受け入れの結果: core 562合格、API 994合格・21 skip、runner 213合格・8 skip、dashboard 48合格、dashboard app 937合格。build:app と prod-replay の構文検査も成功した。最後の状態配信の変更は current-state／maintenance の57合格・1 skipと、代表表示の120組で再確認した。APIとdashboard appの型検査、prod-replay単体6件、差分の空白検査も成功。skipは環境のsocket制約による既存の扱いで、試験の上限と期待値は緩めていない。

### 本番の写しの関門での直し（2026-10-16）

HEAD 11c8e36 で三つの関門を流し、次の六つが落ちた。いずれも原因を測ってから直した。上限と既存の期待値は変えていない。試験の側で変えたのは、turn 鍵の欠落率の分母の定義と、e2e の操作の順序だけである。

| 落ちたもの | 原因 | 直し |
| --- | --- | --- |
| realdata の RSS 414 MB | 観測 worker の初回の取り込みで、キットの観測が登録プロジェクトのたびに全会話を投影していた。照合を待つ名前がなくても約 88 MB を一時に割り当て、GC の間合いでヒープが膨らむ。 | 全会話の投影は、照合を待つ名前があるときだけ作る。競合の記録は snapshot の続きだけを読む。単独の計測で 355〜381 MB が 313〜332 MB になった。 |
| 一件追記後の refresh 82 秒 | 原記録ごとの run.updated で、長い実行は 1.6 万〜3.5 万件の事実を持つ。依存と検索の参照は事実ごとに同じ鍵を持ち、起点の自己結合が件数の二乗になっていた。投影も状態の評価も、追記のたびに実行の全事実を読み直していた。 | 下の表の通り、追記一件の処理を実行の事実数によらない形にした。 |
| Codex の turn 鍵の欠落 189/189 | 状態の原記録を持たない旧い cursor で、印だけを立てて既読の行の原記録を補っていなかった。 | 既読の行は原記録の事実だけを補う。発言や件数の事実は重ねない。 |
| e2e の state-waiting-agents の送信の拒否 | 送出前の受付を保存する接続は待ち時間 0 で、観測の worker や runner の書き込みと重なった瞬間に SQLITE_BUSY で利用者の送信を拒否していた。 | 主スレッドを止めずに 20 ms 間隔で最大 2 秒読み直す。保存できなければ従来どおり runner を呼ばずに拒否する。 |
| e2e の state-same-text | 試験は送信のボタンを押した直後に別端末の同文を起こしていた。API の受付より 11 ms 前の同文は R38 の通り候補にならず、製品は規則どおりだった。 | 試験の側で、送出が始まってから別端末の入力を起こす。 |
| Claude の turn 鍵の欠落 1005/1192 | 当時は開始と終了の hook だけの実行を「使用量確認で依頼なし」と推定した。部分取り込みとの区別は確認できていなかった。 | 当時の除外は下記 P5 で撤回した。用途の独立した証拠がない実行は分母に含める。 |

| 追記一件の経路 | 変えたこと |
| --- | --- |
| 依存と検索の展開 | 起点の鍵を先に一意にしてから結合する。起点は主キーで引く。 |
| 検索の更新 | `createStableRunLinkCheck` が履歴全体の明示された会話と世代を調べ、すべて同じ対応の場合だけ読み直しを省く。到着順の隣接値では判定しない。 |
| 投影 | 証拠だけの run.updated でも、上と同じ安定した対応を要求する。複数世代では、generation を省いた後続属性の所属を全件から決める。実体の記録は既存より厳密に後に並ぶ証拠だけ重ね、それ以外は全事実から作り直す。一回の反映の中では subject の事実を一度だけ読む。 |
| 状態の評価 | 展開後の証拠が 500 件以上の実行は、読み取りの途中の状態を残し、次の差分では新しい証拠だけを読む。時刻逆転・後着祖先・既知 uuid の変更・競合変更などでは全件を読み直す。開始時刻の補完値は正式な started_ts がないときだけ使う。 |
| 子と根 | 親の原記録は名指しする子の id ごとに一度だけ分ける。根の名前は起動時に作る部分索引で引く。 |

当時の本番の写しの実測は、最大の Codex の実行 34,977 件への一件追記で 119 ms、評価後のヒープ 188 MB だった。旧定義の turn 鍵の欠落は Claude 0/183、Codex 0/190 だったが、部分取り込みの欠落がない根拠には使わない。この会話 354000b1 は Waiting for agents、生存は alive_confirmed だった。競合の印は二つの実行の 84 turn のうち、旧い実行の 1 turn だけに付いた。

回帰試験は、証拠だけの事実と全件再構築の一致、2 万件の実行への追記が 60 ms 未満、旧い Codex の cursor の原記録の補完、状態の評価の続きと全件の読み直しの一致の四つを足した。続きの判定の条件は一つずつ外すと、対応する試験が落ちることを確かめた。`prod-replay.mjs --inspect <会話 ID>` は判定に加えず、その会話の表示と競合の印の数を報告する。schema 版・投影版・依存は変えていない。

### HEAD 87dc0cc のレビュー6点への修正（2026-10-16）

| 指摘 | 関数の規則・回帰試験 |
| --- | --- |
| P1 保存失敗と一回性 | `persistSend` は受付と段階保存だけを BUSY 時に20 ms間隔・最大2秒再試行する。`savePhase` の emitting 保存が成功してから送出する。PTY は各再試行で対象と画面を確認する。送出後の `finishPhase` 保存失敗は再送や aborted の根拠にしない。同じ cmd_id は直列化し、再提示は保存済みの配達を返す。ack は `hasEmission` でも送出の記録を確認するため、accepted のまま期限切れになっても成功にはしない。`send-watch.test.ts` は一過性BUSY・恒久失敗を emitting/emitted に注入し、runner/PTYの送出回数、並行再提示、拒否も保存不能な場合を固定する。 |
| P2 暗黙の世代 | `isEvidenceOnly` と `createStableRunLinkCheck` の両方を満たす場合だけ投影を省く。100=gen1、200=gen2、400=世代なし終了の後に300=gen1の証拠を足すと、gen1に終了が移る。別々の取り込み／同じ取り込みの両方を `rebuild.test.ts` で全件再構築と照合する。 |
| P3 正式な開始時刻 | `CurrentState` の継続経路は `started_ts ??= state.derived?.startedTs` とし、補完値で正式値を上書きしない。501証拠の後の正式値 .100Z を、証拠付き／属性だけの更新で新規個体と比較する。 |
| P4 検索の会話 | 検索も `createStableRunLinkCheck` を使う。会話a/100→b/1000→後着a/200→a/1200で、artifactの検索先はaになり、再構築と一致する。複数対応がある履歴の省略は行わない。 |
| P5 欠落率 | `readTurnCoverage` からopen/closeだけの除外を削除した。SessionStart＋user発言＋所属がありnative証拠がない入力を runs=1/missing=1 とする。外す判定は呼び出し側が独立した記録で与え、turn 鍵のない実行にだけ問う。 |
| P6 証拠の保持と圧縮 | `captureNativeRecord` は信号を持つ構造と、信号のない行のuuid/parentUuid/promptIdまたはCodex turn_idだけを残す。`createNativeEvidenceBuffer` と `packNativeEvidence` が同じ実行・会話・世代の新しい証拠を最大128行の可逆なtupleへまとめる。128→1事実、600→5事実、20ファイル2020事実相当→60事実を検査し、再読・再起動・時刻逆転・後着祖先・訂正・再構築後の判定を非圧縮と比較する。 |

P5の後の本番の写しでは、Claude の欠落が 970/1158 になった。欠落の実行は、使用量確認と、依頼前に閉じた対話 7 件だった。7 件のうち 6 件は原記録が無く、1 件は resume の後に原記録へ行が無かった。どれも SessionStart と SessionEnd だけを持つ。上の規則で外した再実行では、使用量確認 960 件と対話 7 件が外れた。残りは Claude 0/188、Codex 0/192 だった。7 日の窓が動くため、二つの実行の件数は少しずれる。

P6の保持単位は経過日数ではなく、再構築に必要な構造である。旧turnや失効した進行の証拠も、後着のUUID祖先・tool・子の相関に必要になるため捨てない。補完で新しく保存する古い証拠も圧縮し、繰り返す実行・会話・世代・ファイル・observed_tsを共有する。信号の本文は「存在」や境界の印にし、本文保持期限からは独立させる。`retainNativeMetadata` はmetadata保存範囲と保持処理でもこの構造だけを残し、秘匿処理は通す。

`expandNativeEvidence` は元のevent IDから同じfact ID、source_ts、observed_ts、cursorを復元する。訂正で元の一行を名指せる依存キーは残し、実行・会話の重複キーと検索参照はまとめる。圧縮事実全体の訂正も内部の行を置き換える。再読の重複判定は展開した元のevent IDで行うため、読み取りの区切りが変わっても追記しない。配達の照合が直接引くqueued_commandは独立した事実に保つ。一度の読み取り内でflushし、未保存の証拠を残したままcursorを進めない。既存のfacts・索引を圧縮し直す処理はない。schema版・投影版・依存は変更しない。

#### 確かめたこと：写しの集計

`scripts/measure-state-evidence.mjs` は本番を `DatabaseSync(..., {readOnly:true})`、`query_only=ON` で開き、backupで作業ツリー内へ複製する。写しも読み取り専用で開き、保存済みcursorまでの原記録だけを読む。本文は出力・保存しない。今回の写しはmax seq=314554、最終observed_ts=`2026-10-15T21:52:42.121Z`。1735パス中、消失1、JSON不正0、時刻欠落0だった。

JSTの10/9〜10/15の既存事実は57,142件、旧captureによる追加原記録候補は85,281件。最小構造への絞り込み後も、この7日分の候補数は85,281件であり、行数の削減はまとめて保存する効果による。同じ入力を新しいbufferへ渡した結果は、1秒区間で区切る場合37,473事実、日ごとの一括補完では1,145事実だった。候補FactInputのJSON長は79,217,997 Bから58,562,369 B（1秒区切り）へ減った。これはSQLiteの索引やページを含む容量ではない。

#### 推測：今後の一日あたりの増分

| 条件 | 原記録の追加/日 | 既存分を足した合計/日 |
| --- | ---: | ---: |
| 修正前 | 12,183 | 20,346 |
| 修正後：1秒区間で近似 | 5,353 | 13,516 |
| 修正後：一括補完 | 164 | 8,327 |
| 修正後：毎回1行しか到着しない | 12,183 | 20,346 |

1秒近似では原記録の事実数が56%、全体が34%減る見積もりである。実到着時刻・観測周期は未記録なのでsource_tsの連続する1秒区間で近似し、世代は固定した。世代変更・後日補完・消失ファイル・新しいメタ事実は誤差要因になる。一括補完は通常運転の予測ではない。既存分をobserved_tsで数えた9,189件/日を使う場合、同じ近似は修正前21,372→修正後14,542件/日となる。既存DBの縮小、将来の実容量、増加量の上限を保証する数値ではない。

再測定: リポジトリの根で `node scripts/measure-state-evidence.mjs --copy .agents/measure/prod.db --output .agents/measure/growth.json`。指定した写しがすでに存在すれば再利用する。新しい時点を測る場合は別のcopy名を指定する。socket、prod-replay、e2eの関門は別環境で行う。

回帰の反証確認: Nodeのload hookで対象モジュールだけを `git show 87dc0cc:<path>` に差し替え、作業ツリーを戻さず実行した。P1は6件、P2は2件、P3は2件、P4は1件、P5は1件、P6はcaptureとCodex取り込みで各1件が失敗した。圧縮の互換性試験は、比較元の非圧縮入力の判定も含めて固定している。

受け入れ結果: core **570合格**、API **1,012合格・21 skip**、runner **213合格・8 skip**、dashboard **48合格**、dashboard app **937合格**。`build:app`、core/APIの型検査、`git diff --check`も成功した。skipは既存のsocket制約で、socketの実待受・prod-replay・e2eは別環境での確認分として残る。

一時書き込み先も作業ツリー内の `t/` に隔離した。通常の一時領域と同じ条件にするため、Gitの探索上限をそのディレクトリに置き、偽CLI用にCommonJSを指定した。macOSの長さ制限を超えるUNIX socketだけは、試験用のpreloadで同じ場所の相対パスに変換した。待受や接続を模擬したり、エラーをskipに変換したりする補正は加えていない。試験の期待値と性能上限は維持し、圧縮に伴う物理件数の変更は元の証拠数の検査も併せて固定した。
