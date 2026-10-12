# agent-graph 性能ベースライン

本報告は製品コードを変更せずに測った値から、利用者の待ち時間を減らす優先順位を整理する。

本番へのローカル接続が実行環境から拒否され、ブラウザの体感時間は今回まだ計測できていない。

台帳の写しを用いた測定と合成履歴の試験を分け、本番で観測した時間と混同しないように記録する。

## 測定条件

| 項目 | 値 |
| --- | --- |
| 測定開始 JST | 2026-10-13 00:27:04 |
| 機種 | Apple M3 Ultra / darwin arm64 |
| Node | v24.6.0 |
| 対象 commit | `757ee56ecb88ae2d7b68fbfadccc3624f9dfa474` |
| 本番 URL | http://127.0.0.1:7420 |
| 台帳の事実 | 278,467 件 |
| 会話 / 発言 / 所属 | 3,026 / 113,890 / 116,828 |
| 台帳の写し | 6,693,539,840 bytes / .perf/ledger.db |
| 長い会話 | 16429 発言 / ["codex","019debcd-4d23-7391-8ff3-3c786e29370c"] |
| 短い会話 | 20 発言 / ["claude","2369c69f-ba57-4337-b683-fff06b4ad8de"] |
| 例外 | 初期化と build は各 1 回 / 本番計測は接続拒否 |

計測は同一台本を順番に実行する方法に統一し、各項目の繰り返しを五回として中央値を採用した。

初回の測定を含めた最小値と最大値も併記し、キャッシュの温まりによる差を読み取れるようにする。

本番の台帳には書き込まずに写しを作成し、投影と観測が書き込む先も作業ツリー内に隔離した。

最初に他の計測と重ねて流した試験の値は採用せず、順番に測り直した五回だけを表に記録した。

## 体感への効き目による暫定順位

順位は実測した処理時間と応答量を根拠に置き、体感への効き目は未検証の見込みとして記載する。

| 順位 | 対象 | 数値の根拠 | 原因の見立て | 直し方の案 | 見込みの効き目 |
| --- | --- | --- | --- | --- | --- |
| 1 | 長い会話の表示と巻き戻し | 673.145 ms / 83 要求 / 28,657,967 bytes | 最新 200 件の表示にも全履歴の逐次取得 | 時刻と順序で最新窓と前の窓を取得 / 変更ファイル用情報は別取得 | 初回要求 83→1 で 98.8% 減の案 / 体感改善は未測定 |
| 2 | 初回表示の本文量 | 初期 JS 1,994,001 bytes / snapshot 2,407,203 bytes | 編集機能の初期バンドルと多数の一覧行 | ページと編集機能の遅延読込 / 一覧の初期対象を限定 | 初期 JS と JSON の削減 / 削減率は分割後に再測定 |
| 3 | 長い会話の要約更新 | 19.461 ms / 16,429 発言 | 最後の発言を得るための所属と発言の再走査 | 最新時刻と順序の索引または差分更新 | 発言ごとの全走査を削減 / 本番の反映時間は未測定 |
| 4 | API 起動時の投影配信準備 | 1497.731 ms / 同一性 SQL 299.845 ms | 全同一性と全要約の再生成 | 同一性の対象索引 / 要約の再利用と差分更新 | 起動時の約 1.5 秒を短縮する余地 / 既存画面への効き目は小 |
| 5 | 無更新時の観測 | 33.642 ms / Codex 対応付け 23.739 ms | 履歴一覧と直接起動の対応付けを毎周実行 | 変更ファイルだけに対応付けを限定 | 対応付けが周期の約 71% / 操作への直接効果は未確認 |

長い会話では全ページを順番に取得しており、最後に表示する二百件のために全履歴を読み込んでいる。

古い発言を読み戻す場合も全ページを取得するため、巻き戻しの待ち時間が繰り返し発生する可能性がある。

上位の改善を実装した後は同じ台本を再実行し、操作時間と転送量が実際に減ることを確認する。

## ダッシュボードと応答量

ビルドは既存の依存だけを使用して実行し、出力先を隔離して本番が配信するファイルを保護した。

会話の取得処理は本番と同じ関数をそのまま使い、通信と描画を除いた経路の所要時間を測定した。

応答の大きさは圧縮前の JSON 本文を数えた値であり、本番の通信路で転送された量の実測ではない。

| 項目 | 中央値または大きさ | 最小〜最大 ms | 測り方 | 回数 |
| --- | ---: | ---: | --- | ---: |
| build:app 全出力 | 2,461,796 bytes | — | 隔離出力のファイルサイズ | 1 |
| JS 全チャンク | 2,326,384 bytes | — | 隔離出力のファイルサイズ | 1 |
| CSS | 134,288 bytes | — | 隔離出力のファイルサイズ | 1 |
| addon-fit-DIOBYJe3.js | 1,205 bytes / gzip 496 bytes | — | ファイルサイズ / Node gzip | 1 |
| index-CGJxvtlZ.js | 1,994,001 bytes / gzip 643,525 bytes | — | ファイルサイズ / Node gzip | 1 |
| index-CHivM7AR.css | 134,288 bytes / gzip 23,316 bytes | — | ファイルサイズ / Node gzip | 1 |
| xterm-ScmBfeDI.js | 331,178 bytes / gzip 82,649 bytes | — | ファイルサイズ / Node gzip | 1 |
| 長い会話の取得処理 | 673.145 ms | 671.382〜681.100 | 実際の loadConversationWindow / 通信と描画を除外 | 5 |
| 長い会話の API 処理合計 | 307.240 ms | 305.548〜308.707 | 各 feed.conversation の時間を合算 | 5 |
| 長い会話の全応答 | 28,657,967 bytes / 83 要求 | — | JSON stringify の UTF-8 bytes | 5 |
| 長い会話の初回 HTTP 本文 | 348,665 bytes | — | feed.conversation の先頭ページ | 5 |
| 短い会話の取得処理 | 0.905 ms | 0.853〜1.041 | 実際の loadConversationWindow / 通信と描画を除外 | 5 |
| 短い会話の API 処理合計 | 0.297 ms | 0.289〜0.338 | 各 feed.conversation の時間を合算 | 5 |
| 短い会話の全応答 | 160,117 bytes / 1 要求 | — | JSON stringify の UTF-8 bytes | 5 |
| 短い会話の初回 HTTP 本文 | 160,117 bytes | — | feed.conversation の先頭ページ | 5 |
| 初回 snapshot 本文 | 2,407,203 bytes | — | 実際の feed.snapshot の JSON | 5 |
| snapshot の取得 | 23.611 ms | 21.768〜27.723 | feed.snapshot | 5 |
| snapshot の直列化 | 3.110 ms | 3.003〜4.079 | JSON.stringify | 5 |

### 本番で残った計測

本番の接続とプロセス情報の読み取りが拒否され、以下の体感時間と常駐時の負荷は未測定である。

| 項目 | 今回の値 | 台本の測り方 | 予定回数 |
| --- | --- | --- | ---: |
| 初回の画面表示 | 未測定 / EPERM | 遷移から Projects 表示と二描画待ち | 5 |
| 本番 JS と CSS 転送量 | 未測定 / EPERM | キャッシュ無効の Resource Timing | 5 |
| 長い会話の最後の発言 | 未測定 / EPERM | 遷移から読み込み完了と最後の吹き出しの可視判定 | 5 |
| 短い会話の最後の発言 | 未測定 / EPERM | 同じ判定で短い会話を測定 | 5 |
| 会話切替 | 未測定 / EPERM | 根のリンクを操作して URL と最後の発言を確認 | 5 |
| サイドバーと根の一覧 | 未測定 / EPERM | 根の選択リンクが表示されるまで | 5 |
| 巻き戻しの描画 | 未測定 / EPERM | 120 描画で 150 px ずつ巻き戻して描画間隔と長いタスクを記録 | 5 |
| React の再描画 | 未測定 / EPERM | DevTools hook のルート commit 数と作業フラグ数 | 5 |
| 送信から吹き出し | 未測定 / EPERM | smoke の送信操作から DOM 追加まで | 1 |
| jsonl の返事から画面 | 未測定 / EPERM | 返事の jsonl 検出と DOM 追加の時刻差 | 1 |
| WebSocket の量と頻度 | 未測定 / EPERM | CDP の受信フレームを十秒間集計 | 1 |
| 会話を開いた初回フレーム | 未測定 / EPERM | CDP の先頭受信フレームの本文量 | 5 |
| 常駐 API の CPU と記憶 | 未測定 / EPERM | ps の CPU 累積時刻差と RSS を十秒間取得 | 10 |

ブラウザ計測は既存の確認台本と同じ道具を使い、保存済みの確認用会話だけに送信を許可する。

画面の再描画はルートの更新確定数として数え、個々の部品の関数が実行された回数とは区別する。

返事の記録は百ミリ秒ごとに検出して時刻を取り、画面に先行して表示された場合は負の値で示す。

## 観測周期の内訳

観測は本番の履歴を読む別プロセスで測定し、本番の常駐プロセスの実測とは区別して記載する。

観測の最初の一周は準備として別に示し、以降の五周期から発言の追記がない周期だけを選別して示す。

区間の境界は測定プロセスのメモリにだけ追加し、製品のソースファイルを一時変更せずに測定した。

各区間の中央値は別々の周期から選ばれるため、内訳の中央値を足しても総時間とは一致しない。

| 項目 | 中央値 ms | 最小〜最大 ms | 測り方 | 回数 |
| --- | ---: | ---: | --- | ---: |
| 観測サービス初期化 | 799.522 | — | 写しの writerOnly 起動 | 1 |
| 準備の最初の周期 | 1832.050 | — | 実際の ingestOnce | 1 |
| 準備後の全周期 | 33.655 | 33.459〜44.732 | 一秒待ちを挟む ingestOnce | 5 |
| 読み込みも追記もない周期 | 33.642 | 33.459〜33.981 | 追記ゼロかつ open ゼロの周期を選別 | 4 |
| 台帳の文脈と準備 | 0.150 | 0.148〜0.160 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 履歴の探索と更新判定 | 9.246 | 8.448〜9.386 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 履歴と題名の取り込み | 0.111 | 0.095〜0.139 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 場所の補完と文脈更新 | 0.001 | 0.001〜0.002 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 直接 Codex の対応付け | 23.739 | 23.424〜24.408 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 隔離した hook の送信待ち | 0.027 | 0.020〜0.032 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 旧キットの取り込みと文脈更新 | 0.169 | 0.138〜0.180 | ingestOnce の連続区間 / 無更新のみ | 4 |
| リモート状態の観測 | 0.035 | 0.029〜0.037 | ingestOnce の連続区間 / 無更新のみ | 4 |
| Claude の生存観測と文脈更新 | 0.106 | 0.102〜0.119 | ingestOnce の連続区間 / 無更新のみ | 4 |
| Codex の生存観測開始 | 0.024 | 0.019〜0.025 | ingestOnce の連続区間 / 無更新のみ | 4 |
| チェックポイントの保存 | 0.117 | 0.103〜0.219 | ingestOnce の連続区間 / 無更新のみ | 4 |
| 別プロセスの CPU 使用時間 | 34.657 | 34.031〜35.233 | process.cpuUsage の周期差 | 4 |
| 別プロセスの RSS | 450,166,784 bytes | — | process.memoryUsage の周期末 | 5 |

生存観測の非同期処理は開始だけが区間に含まれ、完了までの時間は周期の内訳に含めていない。

## 台帳の主な問い合わせ

| 問い合わせ | 中央値 ms | 最小〜最大 ms | EXPLAIN QUERY PLAN | 回数 |
| --- | ---: | ---: | --- | ---: |
| last_seq | 0.003 | 0.002〜0.017 | SEARCH facts | 5 |
| tail_1024 | 3.846 | 2.720〜4.420 | SEARCH facts USING INTEGER PRIMARY KEY (rowid>?) | 5 |
| observation_context | 5.843 | 5.220〜6.416 | SEARCH facts USING INTEGER PRIMARY KEY (rowid>? AND rowid<?) | 5 |
| subject_history | 0.008 | 0.006〜0.030 | SEARCH facts USING INDEX facts_subject_seq (subject=?) | 5 |
| conversation_long_200 | 7.551 | 7.266〜8.321 | SEARCH mm USING INDEX membership_conversation (conversation_id=? AND active=? AND message_id>?) / SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?) / USE TEMP B-TREE FOR ORDER BY | 5 |
| conversation_short_200 | 0.274 | 0.264〜0.439 | SEARCH mm USING INDEX membership_conversation (conversation_id=? AND active=? AND message_id>?) / SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?) / USE TEMP B-TREE FOR ORDER BY | 5 |
| message_summary_long | 19.461 | 19.409〜21.040 | SEARCH mm USING COVERING INDEX membership_conversation (conversation_id=? AND active=?) / SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?) / SCALAR SUBQUERY 1 / SEARCH mm2 USING COVERING INDEX membership_conversation (conversation_id=? AND active=?) / SEARCH m2 USING INDEX sqlite_autoindex_messages_1 (id=?) | 5 |
| identity_startup | 299.845 | 295.898〜304.193 | SCAN facts USING INDEX facts_subject_seq | 5 |
| active_observed_runs | 1.113 | 1.103〜1.262 | SEARCH c USING INDEX conversations_native (provider=?) / SEARCH r USING INDEX runs_state (state=? AND conversation_id=?) / CORRELATED SCALAR SUBQUERY 1 / SEARCH newer USING COVERING INDEX runs_conversation (conversation_id=? AND generation>?) | 5 |

## 主スレッドの遅れの試験

主スレッドの試験は五回とも許容値以内で通り、この規模では秒単位の操作停止が再現しなかった。

試験の最大遅延と投影配信の最大時間は別の値であり、両者の一致だけで原因を確定することはできない。

| 回 | 最大遅延 ms | 最大投影配信更新 ms | 終了コード |
| ---: | ---: | ---: | ---: |
| 1 | 43.1 | 37.0 | 0 |
| 2 | 45.0 | 36.1 | 0 |
| 3 | 48.8 | 40.7 | 0 |
| 4 | 41.9 | 35.2 | 0 |
| 5 | 77.1 | 71.7 | 0 |
| 中央値 | 45.0 | 37.0 | — |

| 条件 | 値 |
| --- | --- |
| 試験ファイル | packages/api/test/observe-perf.test.ts |
| 対象試験 | worker の大量取り込み中も主スレッドの遅れは 100 ms 以下 |
| 合成履歴 | Claude 2,000 ファイル / Codex 500 ファイル |
| 時間の測り方 | 10 ms 間隔のタイマーの超過 / feed.refresh の最大時間 |
| 許容値 | 最大主スレッド遅延 100 ms |

## 再実行

台本は未測定の項目に失敗理由を出力するため、未測定を成功やゼロとして扱わずに比較できる。

```sh
node scripts/perf/baseline.mjs
```

| 台本 | 役割 |
| --- | --- |
| baseline.mjs | build → 試験五回 → 写しと SQL → 観測 → 本番の順で実行 |
| ledger.mjs | sqlite3 の backup と実際の取得関数と SQL の測定 |
| observation.mjs | 写しへの取り込みと区間計測 |
| browser.mjs | 本番の読み取りと確認用会話への送信 |
| .perf/baseline.json | 全測定値と個々の標本と実行環境 |
| .perf/observe-test-1.tap〜5.tap | 五回の元の試験結果 |
| .perf/build.log / build-fallback.log | pnpm と既存 Vite の実行記録 |

送信測定は確認用会話に一回だけ実行するため、送信を無効にするときは環境変数で明示して指定する。

```sh
AGENT_GRAPH_PERF_SEND=0 node scripts/perf/baseline.mjs
node scripts/perf/baseline.mjs --only=build
node scripts/perf/baseline.mjs --only=tests
PERF_REUSE_DB=1 node scripts/perf/ledger.mjs
node scripts/perf/browser.mjs
```

| 注意点 | 内容 |
| --- | --- |
| 比較時の台帳 | 同じ写しと同じ会話 ID を使用 |
| 部分実行 | baseline.json は対象項目だけで更新 |
| 終了コード 1 | 未測定または試験失敗 / 数値は JSON に保存 |
| 実行前提 | Node 24 / sqlite3 / 既存の node_modules / smoke の Playwright |
| API と runner | 再起動なし / 製品コード変更なし / コミットなし |
| ブラウザの残作業 | 本番へ接続できる環境で台本の実機検証と値の記入 |
