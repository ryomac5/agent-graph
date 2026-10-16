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
- OS照会、走査、記録の永続化、送出、タイマー、再構築、snapshot配信、画面への接続は今回の範囲外とする。
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
- R17a: 親のtask-notificationはqueue-operation/enqueueのcontentまたはuserの本文から読む。task-idがchildIdと完全一致するstoppedはcomplete＋interrupted、completedはcompleteへ写す。親のpromptIdを子へ流用せず、responded・Done・物理終了は作らない。completeと同時刻のinterruptedがあるturnはUnknown／boundary_unavailableとし、未完了toolの保持を解く。
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
- R31: 履歴競合は正常走査で消さず、未解決の範囲のturnには inferred と unconfirmed を添える。
- R32: 代表表示の優先順は Unresolved、Stopped、Needs approval、Waiting、Working、Closed、Not hosted、Idle、Unknown とし、Doneは結果の別の印だけにする。
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

E1の親12153行目をreadFileSyncだけで読み、queue-operation/enqueueのtimestamp・task-id・statusをfixtureへ追加した。IDは既存のnative-7に合わせ、本文・パスは保存していない。stoppedの原文は前の会話で完了記録が見つからず、停止または親終了時に実行中だった可能性を述べているため、物理終了やIdleを断定しない。complete＋interruptedの区別を既存の完了判定に加えたのは、turnの型に中断状態がなく、通常完了のIdleを避けるためである。

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
