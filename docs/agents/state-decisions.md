# 状態・配達の判定一覧

2026-10-15。正解は `packages/core/test/state/` の入力・期待値の表で固定する。第3版の文章を直す代わりに、以下を `packages/core/src/state/` に実装した。

## 入出力と範囲

- `evaluateState(input, evaluatedAt, policy?)` は生存・所持・閉鎖・turn・結果の段階・表示・理由・証拠ID・期限を返す。
- `evaluateDelivery(input, evaluatedAt, policy?)` は指定した `cmdId` の配達・表示・理由・確度・期限・走査の健康・自動再送禁止を返す。
- `readNativeEvidence` は秘匿済みでも読める原記録の構造を証拠へ写す純粋関数で、既存の分類関数や投影は呼ばない。
- 時刻は UTC の epoch milliseconds とし、出来事／照会完了の `at`、取得の `observedAt`、評価の `evaluatedAt` を分ける。
- `runId`、`turnId`、所有プロセス、依頼・試行、配達対象は呼び出し側が確認済みの対応を渡し、この層は同一性の推定・統合・最新世代選択をしない。
- 配達の `target` は会話・実行・端末の版を含む解決済みの鍵、`bodyKey` は正規化済みの内容の比較用の鍵とし、本文は判定に渡さなくてよい。
- 配達の入力には照合範囲内の他の操作・受信も含め、同文の操作を一件ずつ切り離して一意だと判断しない。
- OS照会、走査、記録の永続化、送出、タイマー、再構築、snapshot配信、画面への接続は今回の範囲外とする。
- schema版、投影版、既存の公開口、既存の状態規則、本番の記録は変更しない。

## 判定の規則（1行1規則）

- R01: 同じ証拠集合と評価時刻・方針から同じ出力を作り、到着順・再読・重複を判定根拠にしない。
- R02: まだ発生していない、またはまだ取得していない証拠は、その評価時点には使わない。
- R03: `supersedes` は指定した証拠IDを撤回し、訂正後に新しい状態証拠がなくなる場合も撤回を保持する。
- R04: 同じ時刻に両立しない状態がある場合は、IDの辞書順で勝者を決めず Unknown にする。
- R05: 生存は登録の PID と `procStart` を OS の現在値と比較して決め、登録の `status`・`updatedAt`・`startedAt` は生存やturnの根拠にしない。
- R06: 対象を含む成功した走査だけが不在を証明し、全体失敗・一件の破損を含む部分成功・対象外の走査からは不在を作らない。
- R07: PIDがあってOS開始値を取得できない場合は不在とも一致ともせず、従前の有効な照会があればその期限まで保つ。
- R08: 確認済みの同じプロセス世代の exit／PIDと開始値の不一致は終了の履歴として保持し、後のPID再利用で生存へ戻さない。
- R09: 走査失敗は健康状態を failed にし、従前の生存・所持の期限を早めも延ばしもしない。
- R10: 所持の不在は期限付きの Not hosted とし、物理終了・論理閉鎖・turn完了へ写さない。
- R11: SessionEnd／thread closed は論理閉鎖と対応するturnの終端とし、物理終了とは区別する。
- R12: 論理閉鎖の後の確認済みの新しいturn開始は open に戻せるが、道具の進行だけでは閉鎖を解除しない。
- R13: turnの開始・進行・待ちの期限は当該出来事の `at` から数え、再読・PID走査・親の生存では延ばさない。
- R14: 期限到達時（`evaluatedAt >= validUntil`）は Unknown にし、終了・成功・不在を作らない。
- R15: Stop／SubagentStopのhook・attachment、終端の `stop_reason` は停止の試みとし、turn終了を確認できないため Unknown／boundary_unavailable にする。
- R16: 本文だけのassistant行・tool_use・tool_resultは進行であり、SubagentHandbackの呼び出しもturn完了にしない。
- R17: `turn_duration`、対応済みの同期Agent completed、SDK result／idle、Codexのturn終端は完了の証拠とし、過去の完了は失効させない。
- R18: 確認済みの完了後に同じturnの進行がある場合は証拠競合として Unknown にし、別turnへの対応を推測して補わない。
- R19: 旧turnの終端や鍵のない終端は選択した別turnを閉じず、run自体が未解決なら代表表示を Unresolved にする。
- R20: 子の生存に同じ所有プロセスを渡せても、子のturnと結果は子自身の証拠だけで決める。
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
- R38: 受信候補は送出開始以降（許容ずれを除く）の同文に限り、取得が遅れても出来事の時刻で照合する。
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

## 本番fixtureと正しい出力

本番DBは `DatabaseSync(path, { readOnly: true })` の読取トランザクション、原記録は `readFileSync` で読んだ。採取は2026-10-15 08:03 UTC（補足の同期子の先頭行はその後に追加）、最大seqはfixtureの `maxSeq` に記録した。16件の台帳、25行の原記録、2件のwatchを保存し、会話本文・道具の入力と出力・パス・認証情報は保存しない。IDは整合した仮名に置換し、原記録の時刻・欄・欠落は保つ。テストの実行中は本番を読まない。

| 実例 | 入力の所在 | 固定した正しい出力 |
| --- | --- | --- |
| E1 | critique E1の親12136/12138、子1/271、seq298560/298573/298574 | 生存unverified、turn unknown/progress_expired、結果launched/incomplete、Unknown（Doneなし） |
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

## 未確認と検証の限界

- 進行・待ちの300秒、配達待ちの60秒、時計ずれ0秒は未計測の仮値であり、偽の入力を使った期限機構の試験は実環境での安全性の保証ではない。
- 照会の期限は入力のvalidForMsで指定し、試験ではClaudeの仮値120秒などを使う；実機の適切な周期は未確認である。
- Codexの旧い2分の不在猶予から成功・終了を作る規則は持たず、完全で成功した走査証拠がない標本は不明に保つ。
- SDK複数入力からturnへの対応、利用中SDKのUUID往復、peerの動的保証は実機未確認であり、それぞれUnknown／Unconfirmedを試験に固定した。
- 純粋関数は再送を許可しないが、永続化・排他・実際の一回性やPTYの継続を保証する実装ではない；runner／apiとの接続は次の段の作業である。
- 入力表は全順列を使い、途中の逐次評価・重複入力・最終出力全体の一致を検査する（E3の7件は5,040順序）。
- 回帰の正解は旧い投影値ではなく固定した表に置き、本文だけの完了・起動の成功化・無期限の進行・同文の受領確定へ戻すと試験が落ちる構造にした。

受け入れは `builtin cd packages/core && node --test test/state/ && node --run test`。Node 24.6では明示的なディレクトリ指定が探索されないため、`test/state/index.js` が同じ試験ファイルを読み込む。通常のcore試験でもすべての新規 `.test.ts` を実行する。
