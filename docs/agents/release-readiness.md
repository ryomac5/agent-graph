# v2 公開の判定資料

本資料は段七の公開判断に必要となる検証結果を証拠の所在とともに記録するための資料である。
判定の正本には設計書の実測の基準と評価の指標と受け入れの基準を定めた三つの章を使用する。

正本の参照先: [設計書](architecture-v2.md)
各表の結果欄には公開判断の根拠となる合否と実行日と証拠の所在と確認者を漏れなく記入する。
未実施または証拠のない項目が残る場合は根による確認が完了するまで公開の判定を保留する。

| 判定の記録 | 記入欄 |
| --- | --- |
| 対象コミット | 未記入 |
| Node と OS と CPU と RAM | 未記入 |
| 検証日と確認者 | 未記入 |
| テストと型検査の証拠 | 未記入 |
| ブラウザと表示言語と配布対象 OS | 未記入 |
| 公開の判定と未解決事項 | 保留 |

## 共通の検証

標本の入力には実際の履歴の構造を残したまま本文を伏せた値に置き換えた検証用の資料を使う。
各標本には入力ファイルと期待する台帳と期待する投影を揃えて比較の基準となる証拠を残す。

| 項目 | 確かめ方 | 結果と証拠 |
| --- | --- | --- |
| 再送の冪等性 | 同じ入力を二度取り込む試験で再送の前後に台帳の事実件数が変わらないことを確かめる。 | 未実施 |
| 順序の独立性 | 入力の順序を入れ替える試験で元の順序から得た期待する投影と全表が一致することを確かめる。 | 未実施 |
| 再構築の一致 | 保存済みの台帳から再構築する試験で通常の反映経路で得た投影と全表が一致することを確かめる。 | 未実施 |
| 全体の検査 | `npx --yes pnpm@10 test` と `npx --yes pnpm@10 typecheck` | 未実施 |
| 秘匿の入力 | 既知の鍵と環境変数の行と秘密鍵と範囲外の本文と差分内の鍵を入力して保存前の秘匿を確かめる。 | 未実施 |
| 秘匿の保存先 | 台帳と検索索引と差分の保存を検査する試験で標本内の元の秘密の文字列が残らないことを確かめる。 | 未実施 |
| 保持の整理 | 期間を過ぎた本文の消去後の再送で本文の復活と台帳の事実件数の増殖がないことを確かめる。 | 未実施 |

## 受け入れの全標本

各パッケージの標本試験による入力と台帳と投影の照合結果を公開判断の証拠として保存する。
標本 S15 の規模の実測結果は根が囲いの外で取得した公開判断の証拠として本資料に記録する。

| 標本 | 遷移 | 確かめ方と期待 | 結果と証拠 |
| --- | --- | --- | --- |
| S1 | Claude の背景移行と退役と再開 | 同一会話と継続元の再開ごとに全識別子と確定した継続関係と新しい実行世代を台帳で確かめる。 | 未実施 |
| S2 | 四十分のターンの観測 | 長いターンの標本を流す試験で実行の終了と子の失踪が生じず無更新が不明になることを確かめる。 | 未実施 |
| S3 | 再登録後に残る古い PID | 再登録後の世代の標本で古い PID の継承と古いプロセスの死亡による終了がないことを確かめる。 | 未実施 |
| S4 | 独立 fork と同時 fork と compact | 共有の発言の標本で発言が一件で所属が複数となり圧縮では新しい会話を作らないことを確かめる。 | 未実施 |
| S5 | agc と MCP と native の委譲 | 三つの入口の標本で同じ受付を通った親子が同じ形の delegated の関係になることを確かめる。 | 未実施 |
| S6 | Codex のホスト共有と長いターンと承認と復帰 | ホスト共有の標本で承認待ちの状態とアーカイブの終了根拠と復帰後の新しい実行世代を確かめる。 | 未実施 |
| S7 | 無人実行の依頼文 | 依頼文の標本で source=exec が無名の unattended の会話になることを確かめる。 | 未実施 |
| S8 | 同時 commit と失敗と amend と共有ツリー | 同時変更と amend と共有ツリーの標本で共同の帰属と失敗の除外と未追跡差分の収録を確かめる。 | 未実施 |
| S9 | legacy と paginated と時刻の不一致 | 時刻が不一致の標本で内側の作成時刻の採用とページ形式の本文の取得不能という表示を確かめる。 | 未実施 |
| S10 | 枝番号と並行採番と遅延 hook と障害 | 遅延と障害を含む標本で全番号の別名の保持と採番の無衝突と旧 counter への無書込みを確かめる。 | 未実施 |
| S11 | プロセス一覧の失敗と最後の切断 | プロセス一覧の取得失敗と最後の MCP 切断を流す試験で実行の不明と終了記録の不在を確かめる。 | 未実施 |
| S12 | runner の再起動と保留承認 | 再起動前後の標本で実行が不明を経て解ける遷移と保留承認が expired になる遷移を確かめる。 | 未実施 |
| S13 | 不在と停止と受理後の切断と応答喪失 | 四つの障害を注入する標本で起動回数がちょうど一回となり再送の結果が同じになることを確かめる。 | 未実施 |
| S14 | 誤統合の訂正後の履歴と画面と操作先 | 誤統合の訂正の標本で履歴と画面と操作先が同じ関係を指し元の事実が保持されることを確かめる。 | 未実施 |
| S15 | 大量の履歴と五画面の接続 | 一時台帳と五画面の模擬接続による実測で次の表の全基準を満たす証拠を囲いの外で記録する。 | 未実施 |
| S16 | 起動元の会話の観測前後の planner 起動 | 会話の観測前後の標本で確定関係と不明の保留と観測後の確定と起動元の木への表示を確かめる。 | 未実施 |
| S17 | 委譲中の api 再起動 | 委譲中の再起動の標本で実行の継続と一回の起動と出来事の保持と再構築した投影の一致を確かめる。 | 未実施 |
| S18 | 委譲の正常終了と失敗と中断 | 正常終了と失敗と中断の標本で watch の変化ごとの一行の出力と終端の終了コードを確かめる。MCP の同じ標本で初回は受理だけを返し wait では進捗の通知を返すことを確かめる。 | 未実施 |
| S19 | 親の spawnAgent より先に届く子通知 | 子の先行通知の標本で未知の会話の保存と親の通知後の確定関係と先の事実の不変を確かめる。 | 未実施 |

## S15 の実測

台本は利用者の保存先を受け取らず毎回作る一時領域のみを対象にして台帳の生成と計測を行う。
台本はエージェントを起動せず利用者の履歴の観測を止めた構成で実際の API 通信を計測する。
根は囲いの外で固定した依存を導入してから次のコマンドで実測結果の JSON を保存する。
依存の導入には事前に取得済みのキャッシュを使い公開する固定版から変更がないことを確かめる。

```sh
npx --yes pnpm@10 install --offline --frozen-lockfile
node scripts/bench/s15.mjs > /tmp/agent-graph-s15-result.json
```

小規模の確認は --smoke で百件の事実を作る試運転として扱い公開の規模の判定には使わない。
本番の serve と同じ readerOnly による投影経路で初回の追随が完了するまで待機する。
初回投影の準備を含む API の起動時間は api_startup_ms として別に記録する。
初回の表示時間は各画面の要求直前から投影の保持と WebSocket の購読の受理までを測る。
購読の受理は一時領域の不在の runner への読み取り要求に対する利用不能の応答で確かめる。
各画面は投影の行をハッシュで保持するためブラウザの描画時間は別途実機で測って記録する。
五画面の初回投影は全表の行を照合して事実件数と会話件数と接続数の検証結果を記録する。
五画面の識別子の対応表も初回の取得と再接続の完了時に照合して操作先の一致を確かめる。
追記と再接続と検索は五画面で五回ずつ測って全測定値と最大値と基準との比較を JSON に残す。
追記の時間は耐久の追記の直前から五画面それぞれの投影に更新した本文が反映されるまでを測る。
再接続の時間は接続の作成直前から全表と識別子の対応表が期待値と一致するまでを測る。
検索は各画面が同時に出す本文の検索要求から更新した本文を含む応答の読み込みまでを測る。
API のメモリは別プロセスの RSS の高水位を使って起動中を含む負荷全体の最大値を記録する。
未計測の項目が残るため測定済みの基準が全て通る場合も JSON には公開判定の保留を記録する。
計測の途中の失敗でも完了した測定値と開始時刻と終了時刻と失敗の理由を JSON に記録する。
途中の失敗は停止した測定段階と各指標の取得済みの値と不足した測定数を結果の JSON に残す。
測定数が予定に満たない指標は基準以下の値が得られた場合にも合格とは扱わず未完了として残す。
API の起動後に失敗した場合も終了処理でメモリの高水位を取得して結果の JSON に記録する。
runner のメモリ判定は実機で測った RSS を結果欄に記入して証拠を保存するまで保留する。

| 項目 | 基準 | 確かめ方 | 結果と証拠 |
| --- | --- | --- | --- |
| 履歴の量 | 1,000,000 事実と 10,000 会話 | 生成後の台帳の事実件数と会話の作成事実件数を初回の投影の会話件数と照合して規模を確かめる。 | 未実施 |
| 同時の画面 | 5 接続 | 五つの接続を同時に開く試験で各接続に追記の更新が届くことと全検索に応答が届くことを確かめる。 | 未実施 |
| 初回の表示 | 3,000 ms 以下 | `metrics.initial_ms` | 未実施 |
| 追記から反映 | 1,000 ms 以下 | `metrics.append_ms` | 未実施 |
| 再接続から整合 | 5,000 ms 以下 | `metrics.reconnect_ms` | 未実施 |
| 検索の応答 | 1,000 ms 以下 | `metrics.search_ms` | 未実施 |
| api のメモリ | 1,000,000,000 bytes 以下 | `metrics.api_rss_bytes` | 未実施 |
| runner のメモリ | 1,000,000,000 bytes 以下 | 同じ規模の台帳と五画面の接続を使う実機の実行と承認と再接続の負荷で RSS の高水位を測る。 | 未実施 |
| ブラウザの描画 | 初回 3 秒と反映 1 秒と整合 5 秒以下 | 実機の五画面で要求から初回の描画と追記の反映と再接続後の整合までの時間を別途測って記録する。 | 未実施 |

## 評価の指標

設計書に数値の合格閾値がない評価の指標は測定条件と分母と生の値を記録して公開の判断に用いる。
レビューの判断時間は標本試験で代用せず公開前の実際の利用で測って対象の差分の版を記録する。

| 指標 | 確かめ方 | 結果と証拠 |
| --- | --- | --- |
| 帰属の正しさの率 | 帰属を検証する標本の表示と期待値を比較して正しい判定の件数を全判定の件数で割った率を記録する。 | 未実施 |
| 観測の欠落の率 | 期待する観測事実と台帳を照合して欠落した事実の件数を期待する事実件数で割った率を記録する。 | 未実施 |
| 障害からの復旧時間 | 故障を注入した時刻から期待する投影と実行と承認の状態に戻るまでの時間を障害ごとに記録する。 | 未実施 |
| レビューの判断時間 | 公開前の利用で固定した差分の提示時刻から利用者が判断した時刻までの時間を対象の版ごとに記録する。 | 未実施 |

## 実機の確認

根は囲いの外で実機確認の全項目を実行した結果を設計書の決定一の表の該当する行にも書き戻す。
確認済みの遷移が動かない場合は設計書の該当行を未確認へ戻して画面の runner の状態にも示す。

| 番号 | 項目 | 確かめ方 | 結果と証拠 |
| --- | --- | --- | --- |
| 1 | Claude の起動と出力と状態 | runner が起動した Claude の文字差分と状態変化が api に届く証拠を時刻付きで残す。 | 未実施 |
| 2 | 承認の要求と回答 | 道具の承認要求を発生させる実機試験で許可と拒否の回答の到達と回答後の実行の継続を確かめる。 | 未実施 |
| 3 | 中断とモデル変更と再開 | 中断が interrupted となる試験で直後の終了コード一の原因とモデル変更と再開を確かめる。 | 未実施 |
| 4 | Codex の並行起動と操作 | 二スレッドの実機試験で承認と excludeTurns 付き再開と分岐と別モデルへの変更を確かめる。子の関係が親の collabAgentToolCall から結ばれる通知の順序を実機で確かめる。 | 未実施 |
| 5 | 受付による委譲 | 実機の会話から受付に出した委譲の子の実行が親につながることを台帳と画面の双方で確かめる。 | 未実施 |
| 6 | Claude の認証と外部連携の制御 | accountInfo と最初の result による実機の認証と外部連携の停止の結果を記録する。 | 未実施 |
| 7 | ターミナルからの planner 起動 | 端末の Claude から起動した planner と起動元の会話の結合を関係と木の表示で確かめる。 | 未実施 |
| 8 | ブラウザと台帳の一致 | 一覧と会話と承認と変更を台帳と照合する実機試験で api 再起動後の表示と操作先の一致を確かめる。 | 未実施 |

## 本タスクの検査記録

本タスクの局所検査は成果物の存在と台本の構文を対象とするため公開の判定とは別に記録する。
小規模の試運転と百万件による実測の証拠は測定の規模を区別して公開の判定資料に記録する。
今回の試運転は依存の未導入により接続前に停止したため接続を含む測定結果は未取得である。
台帳の生成後に ws の読み込みが失敗したため根は依存を導入して囲いの外で再実行する。

| 検査 | 結果 | 実行日 |
| --- | --- | --- |
| `test -s docs/agents/release-readiness.md` | 合格 | 2026-10-07 |
| `node --check scripts/bench/s15.mjs` | 合格 | 2026-10-07 |
| `--smoke` による接続を含む試運転 | 未完了：ws の未導入による `ERR_MODULE_NOT_FOUND` | 2026-10-07 |
| 依存未導入時の失敗 JSON | 合格：停止段階と測定数と未完了判定を照合 | 2026-10-07 |
| 文章規則と固定依存の一覧 | 合格：文長とセルの文数と固定版の全二百五十二件の対応を照合 | 2026-10-07 |
| 百万件による S15 の実測 | 根が囲いの外で実施 | 未実施 |

## 配布とライセンス

他人に配布する版の認証方式には設計書が定める API キーによる方式を既定値として採用する。
API キーは利用者の Keychain に保存する方式で設定ファイルと台帳への平文の保存を避ける。
本人の購読の利用は本人の手元に限る設計上の条件として配布版の画面の説明と既定値を確かめる。
Claude Agent SDK は MIT ではなく Anthropic の商用利用規約に従う。
固定版の SDK に同梱されるライセンス原文と部品ごとの配布条件は根が公開前に確認して記録する。

| 対象 | 条件と確かめ方 | 結果と証拠 |
| --- | --- | --- |
| 配布の認証 | 配布版の新規設定で認証の既定の API キーと購読の利用条件が表示されることを実機で確かめる。 | 未実施 |
| SDK の規約 | 固定版の SDK と同梱部品の条項の原文を読むことで商用規約と個別ライセンスの適用範囲を確かめる。 | 未実施 |
| SDK の参照先 | [SDK のライセンス](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) と [Anthropic の規約](https://code.claude.com/docs/en/legal-and-compliance) | 固定版の原文は公開前に照合 |
| MIT 以外の依存 | 配布対象の原文を読むことで通知と同梱と変更したソースの扱いを確認した証拠を依存ごとに記録する。 | 未実施 |
| 未確認の配布物 | 対象 OS の配布物を囲いの外で取得して同梱するライセンス原文を確認した証拠を一覧に記録する。 | 未実施 |

### 依存のライセンス一覧

一覧は pnpm-lock.yaml の二百五十二件を対象に間接依存と任意依存と開発依存も含める。
一覧のライセンスの初期値は未検証の参考値として扱い固定版の原文との照合結果を別に残す。
未導入の OS 別の配布物はライセンスを推測せず未確認として公開前の原文の確認対象に残す。
配布する固定版のライセンス原文は LICENSE と README による確認の証拠として保存する。

| 依存と固定版 | ライセンスの初期値 | 原文と配布条件の確認結果 |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.291` | Anthropic Legal Agreements | 未確認 |
| `@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.291` | 未確認 | 未確認 |
| `@anthropic-ai/claude-agent-sdk@0.3.291` | Anthropic Commercial Terms | 未確認 |
| `@anthropic-ai/sdk@0.131.0` | MIT | 未確認 |
| `@asamuzakjp/css-color@7.1.3` | MIT | 未確認 |
| `@asamuzakjp/dom-selector@9.2.4` | MIT | 未確認 |
| `@babel/code-frame@7.29.7` | MIT | 未確認 |
| `@babel/helper-validator-identifier@7.29.7` | MIT | 未確認 |
| `@babel/runtime@7.29.7` | MIT | 未確認 |
| `@bramus/specificity@2.4.3` | MIT | 未確認 |
| `@csstools/color-helpers@6.1.2` | MIT-0 | 未確認 |
| `@csstools/css-calc@3.4.3` | MIT | 未確認 |
| `@csstools/css-color-parser@4.2.6` | MIT | 未確認 |
| `@csstools/css-parser-algorithms@4.0.2` | MIT | 未確認 |
| `@csstools/css-syntax-patches-for-csstree@1.1.15` | MIT-0 | 未確認 |
| `@csstools/css-tokenizer@4.0.2` | MIT | 未確認 |
| `@exodus/bytes@1.16.0` | MIT | 未確認 |
| `@hono/node-server@2.1.3` | MIT | 未確認 |
| `@jridgewell/resolve-uri@3.1.2` | MIT | 未確認 |
| `@jridgewell/sourcemap-codec@1.6.0` | MIT | 未確認 |
| `@jridgewell/trace-mapping@0.3.31` | MIT | 未確認 |
| `@modelcontextprotocol/sdk@1.32.1` | MIT | 未確認 |
| `@oxc-project/types@0.152.0` | MIT | 未確認 |
| `@remix-run/route-pattern@0.22.1` | MIT | 未確認 |
| `@rolldown/binding-android-arm-eabi@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-android-arm64@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-darwin-arm64@1.2.12` | MIT | 未確認 |
| `@rolldown/binding-darwin-x64@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-freebsd-x64@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-arm-gnueabihf@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-arm64-gnu@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-arm64-musl@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-ppc64-gnu@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-s390x-gnu@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-x64-gnu@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-linux-x64-musl@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-openharmony-arm64@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-win32-arm64-msvc@1.2.12` | 未確認 | 未確認 |
| `@rolldown/binding-win32-x64-msvc@1.2.12` | 未確認 | 未確認 |
| `@rolldown/pluginutils@1.0.1` | MIT | 未確認 |
| `@stablelib/base64@1.0.1` | MIT | 未確認 |
| `@testing-library/dom@10.4.2` | MIT | 未確認 |
| `@testing-library/react@16.3.3` | MIT | 未確認 |
| `@testing-library/user-event@14.6.7` | MIT | 未確認 |
| `@types/aria-query@5.0.4` | MIT | 未確認 |
| `@types/chai@5.2.3` | MIT | 未確認 |
| `@types/d3-color@3.1.3` | MIT | 未確認 |
| `@types/d3-drag@3.0.7` | MIT | 未確認 |
| `@types/d3-interpolate@3.0.4` | MIT | 未確認 |
| `@types/d3-selection@3.0.12` | MIT | 未確認 |
| `@types/d3-transition@3.0.9` | MIT | 未確認 |
| `@types/d3-zoom@3.0.9` | MIT | 未確認 |
| `@types/deep-eql@4.0.2` | MIT | 未確認 |
| `@types/estree@1.0.9` | MIT | 未確認 |
| `@types/node@24.0.0` | MIT | 未確認 |
| `@types/react-dom@19.3.0` | MIT | 未確認 |
| `@types/react@19.3.0` | MIT | 未確認 |
| `@types/ws@8.18.2` | MIT | 未確認 |
| `@vitejs/plugin-react@6.1.2` | MIT | 未確認 |
| `@vitest/mocker@5.0.3` | MIT | 未確認 |
| `@vitest/spy@5.0.3` | MIT | 未確認 |
| `@xyflow/react@12.12.0` | MIT | 未確認 |
| `@xyflow/system@0.0.83` | MIT | 未確認 |
| `accepts@2.0.0` | MIT | 未確認 |
| `ajv-formats@3.0.1` | MIT | 未確認 |
| `ajv@8.20.0` | MIT | 未確認 |
| `ansi-regex@5.0.1` | MIT | 未確認 |
| `ansi-styles@5.2.0` | MIT | 未確認 |
| `aria-query@5.3.0` | Apache-2.0 | 未確認 |
| `assertion-error@2.0.1` | MIT | 未確認 |
| `bidi-js@1.1.0` | MIT | 未確認 |
| `body-parser@2.3.0` | MIT | 未確認 |
| `bytes@3.1.2` | MIT | 未確認 |
| `call-bind-apply-helpers@1.0.2` | MIT | 未確認 |
| `call-bound@1.0.4` | MIT | 未確認 |
| `chai@6.3.0` | MIT | 未確認 |
| `classcat@5.0.5` | MIT | 未確認 |
| `content-disposition@1.1.0` | MIT | 未確認 |
| `content-type@1.0.5` | MIT | 未確認 |
| `content-type@2.1.0` | MIT | 未確認 |
| `cookie-es@3.1.1` | MIT | 未確認 |
| `cookie-signature@1.2.2` | MIT | 未確認 |
| `cookie@0.7.2` | MIT | 未確認 |
| `cors@2.8.6` | MIT | 未確認 |
| `cross-spawn@7.0.6` | MIT | 未確認 |
| `css-tree@3.2.1` | MIT | 未確認 |
| `csstype@3.2.3` | MIT | 未確認 |
| `d3-color@3.1.0` | ISC | 未確認 |
| `d3-dispatch@3.0.1` | ISC | 未確認 |
| `d3-drag@3.0.0` | ISC | 未確認 |
| `d3-ease@3.0.1` | BSD-3-Clause | 未確認 |
| `d3-interpolate@3.0.1` | ISC | 未確認 |
| `d3-selection@3.0.0` | ISC | 未確認 |
| `d3-timer@3.0.1` | ISC | 未確認 |
| `d3-transition@3.0.1` | ISC | 未確認 |
| `d3-zoom@3.0.0` | ISC | 未確認 |
| `data-urls@8.0.0` | MIT | 未確認 |
| `debug@4.4.3` | MIT | 未確認 |
| `decimal.js@10.6.0` | MIT | 未確認 |
| `depd@2.0.0` | MIT | 未確認 |
| `dequal@2.0.3` | MIT | 未確認 |
| `detect-libc@2.1.2` | Apache-2.0 | 未確認 |
| `dom-accessibility-api@0.5.16` | MIT | 未確認 |
| `dunder-proto@1.0.1` | MIT | 未確認 |
| `ee-first@1.1.1` | MIT | 未確認 |
| `encodeurl@2.0.0` | MIT | 未確認 |
| `entities@8.1.0` | BSD-2-Clause | 未確認 |
| `es-define-property@1.0.1` | MIT | 未確認 |
| `es-errors@1.3.0` | MIT | 未確認 |
| `es-module-lexer@2.3.2` | MIT | 未確認 |
| `es-object-atoms@1.1.2` | MIT | 未確認 |
| `escape-html@1.0.3` | MIT | 未確認 |
| `estree-walker@3.0.3` | MIT | 未確認 |
| `etag@1.8.1` | MIT | 未確認 |
| `eventsource-parser@3.1.1` | MIT | 未確認 |
| `eventsource@3.0.7` | MIT | 未確認 |
| `expect-type@1.4.0` | Apache-2.0 | 未確認 |
| `express-rate-limit@8.7.1` | MIT | 未確認 |
| `express@5.2.1` | MIT | 未確認 |
| `fast-deep-equal@3.1.3` | MIT | 未確認 |
| `fast-sha256@1.3.0` | Unlicense | 未確認 |
| `fast-uri@3.1.8` | BSD-3-Clause | 未確認 |
| `fdir@6.5.0` | MIT | 未確認 |
| `finalhandler@2.1.1` | MIT | 未確認 |
| `forwarded@0.2.0` | MIT | 未確認 |
| `fresh@2.0.0` | MIT | 未確認 |
| `fsevents@2.3.3` | MIT | 未確認 |
| `function-bind@1.1.2` | MIT | 未確認 |
| `get-intrinsic@1.3.0` | MIT | 未確認 |
| `get-proto@1.0.1` | MIT | 未確認 |
| `gopd@1.2.0` | MIT | 未確認 |
| `has-symbols@1.1.0` | MIT | 未確認 |
| `hasown@2.0.4` | MIT | 未確認 |
| `hono@4.13.13` | MIT | 未確認 |
| `html-encoding-sniffer@7.0.0` | MIT | 未確認 |
| `http-errors@2.0.1` | MIT | 未確認 |
| `iconv-lite@0.7.3` | MIT | 未確認 |
| `inherits@2.0.4` | ISC | 未確認 |
| `ip-address@10.7.3` | MIT | 未確認 |
| `ipaddr.js@1.9.1` | MIT | 未確認 |
| `is-potential-custom-element-name@1.0.1` | MIT | 未確認 |
| `is-promise@4.0.0` | MIT | 未確認 |
| `isexe@2.0.0` | ISC | 未確認 |
| `jose@6.2.12` | MIT | 未確認 |
| `js-tokens@4.0.0` | MIT | 未確認 |
| `jsdom@30.1.2` | MIT | 未確認 |
| `json-schema-to-ts@3.1.1` | MIT | 未確認 |
| `json-schema-traverse@1.0.0` | MIT | 未確認 |
| `json-schema-typed@8.0.2` | BSD-2-Clause | 未確認 |
| `lightningcss-android-arm64@1.33.0` | 未確認 | 未確認 |
| `lightningcss-darwin-arm64@1.33.0` | MPL-2.0 | 未確認 |
| `lightningcss-darwin-x64@1.33.0` | 未確認 | 未確認 |
| `lightningcss-freebsd-x64@1.33.0` | 未確認 | 未確認 |
| `lightningcss-linux-arm-gnueabihf@1.33.0` | 未確認 | 未確認 |
| `lightningcss-linux-arm64-gnu@1.33.0` | 未確認 | 未確認 |
| `lightningcss-linux-arm64-musl@1.33.0` | 未確認 | 未確認 |
| `lightningcss-linux-x64-gnu@1.33.0` | 未確認 | 未確認 |
| `lightningcss-linux-x64-musl@1.33.0` | 未確認 | 未確認 |
| `lightningcss-win32-arm64-msvc@1.33.0` | 未確認 | 未確認 |
| `lightningcss-win32-x64-msvc@1.33.0` | 未確認 | 未確認 |
| `lightningcss@1.33.0` | MPL-2.0 | 未確認 |
| `lru-cache@11.5.3` | BlueOak-1.0.0 | 未確認 |
| `lz-string@1.5.0` | MIT | 未確認 |
| `magic-string@1.4.3` | MIT | 未確認 |
| `math-intrinsics@1.1.0` | MIT | 未確認 |
| `mdn-data@2.27.1` | CC0-1.0 | 未確認 |
| `media-typer@1.1.1` | MIT | 未確認 |
| `merge-descriptors@2.0.0` | MIT | 未確認 |
| `mime-db@1.54.0` | MIT | 未確認 |
| `mime-types@3.0.2` | MIT | 未確認 |
| `ms@2.1.3` | MIT | 未確認 |
| `nanoid@3.3.20` | MIT | 未確認 |
| `negotiator@1.1.0` | MIT | 未確認 |
| `object-assign@4.1.1` | MIT | 未確認 |
| `object-inspect@1.13.4` | MIT | 未確認 |
| `obug@2.2.1` | MIT | 未確認 |
| `on-finished@2.4.1` | MIT | 未確認 |
| `once@1.4.0` | ISC | 未確認 |
| `parse5@8.0.1` | MIT | 未確認 |
| `parseurl@1.3.3` | MIT | 未確認 |
| `path-key@3.1.1` | MIT | 未確認 |
| `path-to-regexp@8.4.2` | MIT | 未確認 |
| `picocolors@1.1.1` | ISC | 未確認 |
| `picomatch@4.0.7` | MIT | 未確認 |
| `pkce-challenge@5.0.1` | MIT | 未確認 |
| `postcss@8.5.29` | MIT | 未確認 |
| `pretty-format@27.5.1` | MIT | 未確認 |
| `proxy-addr@2.0.8` | MIT | 未確認 |
| `punycode@2.3.1` | MIT | 未確認 |
| `qs@6.16.0` | BSD-3-Clause | 未確認 |
| `range-parser@1.3.0` | MIT | 未確認 |
| `raw-body@3.0.2` | MIT | 未確認 |
| `react-dom@19.3.0` | MIT | 未確認 |
| `react-is@17.0.2` | MIT | 未確認 |
| `react-router@8.4.0` | MIT | 未確認 |
| `react@19.3.0` | MIT | 未確認 |
| `require-from-string@2.0.2` | MIT | 未確認 |
| `rolldown@1.2.12` | MIT | 未確認 |
| `router@2.2.0` | MIT | 未確認 |
| `safer-buffer@2.1.2` | MIT | 未確認 |
| `saxes@6.0.0` | ISC | 未確認 |
| `scheduler@0.28.0` | MIT | 未確認 |
| `send@1.2.1` | MIT | 未確認 |
| `serve-static@2.2.1` | MIT | 未確認 |
| `setprototypeof@1.2.0` | ISC | 未確認 |
| `shebang-command@2.0.0` | MIT | 未確認 |
| `shebang-regex@3.0.0` | MIT | 未確認 |
| `side-channel-list@1.0.1` | MIT | 未確認 |
| `side-channel-map@1.0.1` | MIT | 未確認 |
| `side-channel-weakmap@1.0.2` | MIT | 未確認 |
| `side-channel@1.1.1` | MIT | 未確認 |
| `source-map-js@1.2.2` | BSD-3-Clause | 未確認 |
| `standardwebhooks@1.1.1` | MIT | 未確認 |
| `statuses@2.0.2` | MIT | 未確認 |
| `std-env@4.3.0` | MIT | 未確認 |
| `tinybench@6.2.1` | MIT | 未確認 |
| `tinyexec@1.3.1` | MIT | 未確認 |
| `tinyglobby@0.2.17` | MIT | 未確認 |
| `tldts-core@7.4.16` | MIT | 未確認 |
| `tldts@7.4.16` | MIT | 未確認 |
| `toidentifier@1.0.1` | MIT | 未確認 |
| `tough-cookie@6.0.2` | BSD-3-Clause | 未確認 |
| `tr46@7.0.0` | MIT | 未確認 |
| `ts-algebra@2.0.0` | MIT | 未確認 |
| `type-is@2.1.0` | MIT | 未確認 |
| `typescript@5.9.3` | Apache-2.0 | 未確認 |
| `undici-types@7.8.0` | MIT | 未確認 |
| `undici@8.11.2` | MIT | 未確認 |
| `unpipe@1.0.0` | MIT | 未確認 |
| `use-sync-external-store@1.7.0` | MIT | 未確認 |
| `vary@1.1.2` | MIT | 未確認 |
| `vite@8.3.3` | MIT | 未確認 |
| `vitest@5.0.3` | MIT | 未確認 |
| `w3c-xmlserializer@6.0.0` | MIT | 未確認 |
| `webidl-conversions@8.0.1` | BSD-2-Clause | 未確認 |
| `whatwg-mimetype@5.0.0` | MIT | 未確認 |
| `whatwg-url@17.2.0` | MIT | 未確認 |
| `which@2.0.2` | ISC | 未確認 |
| `why-is-node-running@3.2.1` | MIT | 未確認 |
| `wrappy@1.0.2` | ISC | 未確認 |
| `ws@8.22.0` | MIT | 未確認 |
| `xml-name-validator@5.0.0` | Apache-2.0 | 未確認 |
| `xmlchars@2.2.0` | MIT | 未確認 |
| `zod-to-json-schema@3.25.2` | ISC | 未確認 |
| `zod@4.6.5` | MIT | 未確認 |
| `zustand@4.5.7` | MIT | 未確認 |
