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

## 改善 1: 初回の読み込み

前後とも同じ作業ツリー内へビルドを出力し、本番の配信ファイルに対する書き込みを避けた。

```sh
node scripts/perf/baseline.mjs --only=build
```

初回の対象は一覧画面から静的に参照する全チャンクとし、遅延読み込みの分は集計から除いた。

| 対象 | 変更前 bytes | 変更後 bytes |
| --- | ---: | ---: |
| 初回 JS の圧縮前合計 | 1,994,001 | 763,923 |
| 初回 JS の gzip 合計 | 643,525 | 240,524 |
| 初回 JS の Brotli 合計 | 未測定 | 203,302 |
| JS 全チャンクの圧縮前合計 | 2,326,384 | 2,327,366 |
| CSS 全チャンクの圧縮前合計 | 134,288 | 134,290 |

初回に読む JS の gzip 合計は、変更前の同じ圧縮条件と比べて 62.6% 減った。

初回の転送量は本番の未圧縮値と比べて減るが、今回の値には通信路の見出しを含めていない。

| 初回 JS の内訳 | 圧縮前 bytes | gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: |
| index | 650,829 | 200,935 | 168,348 |
| settings 共有部 | 58,454 | 20,349 | 17,851 |
| Icon 共有部 | 44,364 | 15,263 | 13,562 |
| preload-helper 共有部 | 10,276 | 3,977 | 3,541 |
| 合計 | 763,923 | 240,524 | 203,302 |

モジュールの内訳はビルドの集計を使い、最小化前の大きさとして配信ファイルと区別した。

| 変更前の index に含む主なモジュール | 集計 bytes | 読み込みの変更 |
| --- | ---: | --- |
| CodeMirror と Lezer の言語解析器 | 1,052,215 | コードタブを開く時に読む |
| Tiptap と ProseMirror と marked と linkifyjs | 890,669 | Markdown ファイルを表示する時に読む |
| react-dom | 537,035 | 初回に読む |
| @codemirror/view | 326,955 | CodeMirror 集計の内数 |
| prosemirror-view | 171,569 | Tiptap 集計の内数 |
| @tiptap/core | 171,143 | Tiptap 集計の内数 |

解析結果はビルド出力の専用ファイルへ保存し、各チャンクに含むモジュールと依存を記録した。

| ビルド出力 | 用途 |
| --- | --- |
| .vite/bundle-analysis.json | モジュールの renderedLength とチャンクの依存 |
| .vite/manifest.json | 初回 JS の静的な依存を重複なく集計 |
| assets/*.br と assets/*.gz | 最終出力と一致する配信用の圧縮版 |
| .perf/baseline.json の build.initialJs | 初回 JS の対象と各圧縮形式の合計 |

設定画面とコード編集と Markdown 編集を分割し、使う部分にだけ軽い待機表示を出す。

会話の描画は従来の同期読み込みを保ち、初回の一覧と共通の枠は追加の待機なしで表示する。

端末本体は既存の遅延読み込みを保ち、会話が使う Markdown の拡張は今回は変更しない。

圧縮ファイルは最終出力からビルド時に生成し、配信の要求ごとに圧縮する処理を追加しない。

圧縮の選択は利用者の許容値に従い、同じ優先度では Brotli を gzip より先に使う。

HTML は毎回トークンと nonce を埋め込むため、圧縮済みのファイルによる配信から除いた。

HTML は毎回の確認を要求する設定とし、ハッシュ付きの資産だけを一年間のキャッシュで返す。

| 配信対象 | 見出し |
| --- | --- |
| 圧縮版 | Content-Encoding: br または gzip |
| HTML 以外の静的ファイル | Vary: Accept-Encoding |
| ハッシュ付きの /assets/ | Cache-Control: public, max-age=31536000, immutable |
| index.html と画面の経路 | Cache-Control: no-store |

配信時には毎回ファイルを読み直し、古い圧縮版は避けてビルド後の内容を再起動なしで返す。

圧縮形式とキャッシュの見出しはソケットなしの試験を通し、更新時の再読み込みも確かめた。

生成した全 JS と CSS の圧縮版を展開し、最終出力と内容が一致することを確認した。

| 受け入れのコマンド | 結果 |
| --- | --- |
| builtin cd packages/dashboard && node --run test:app | 56 ファイルと 724 試験が成功 |
| builtin cd packages/dashboard && node --run build:app | 成功 |
| builtin cd packages/api && node --run test | 380 成功 / 1 失敗 / 21 省略 |
| node --run typecheck | 既存の packages/daemon/src/http/views.ts:83 の TS2322 のみ |
| 後続パッケージと scripts と app の個別型検査 | すべて成功 |

直下の型検査は既存の daemon の誤りで止まり、後続の対象は個別の型検査で確認した。

主スレッドの遅れの試験は基準を超えたため、全試験の実行で得た最大遅延を下の表に示した。

| 主スレッドの試験 | 値 |
| --- | ---: |
| 最大主スレッド遅延 | 185.6 ms |
| 許容値 | 100 ms |
| 最大投影配信更新 | 67.7 ms |
| 全試験の実行時間 | 225,377 ms |

API の全試験とビルドの実行時間は一部重なり、単独実行による主スレッドの遅延は未測定である。

ソケットを使う二十一件は環境の制限で省略され、圧縮配信はソケットなしの実装経路で確認した。

本番の API と runner の再起動は行わず、ブラウザでの表示時間は今回計測していない。

### 初回読み込みのレビュー修正

- `main.tsx` で `vite:preloadError` の回復処理を登録した。自動再読み込みは sessionStorage に時刻を保存し、ページを読み直しても30秒に1回までに制限する。保存できない場合や制限中は import の失敗を境界へ渡す。
- SettingsLayout、SettingsPage、CodeTab、MarkdownEditor を囲む各 Suspense の外側に ErrorBoundary を置いた。失敗した領域に英語の “A new version is available.” と Reload ボタンを表示する。遅延 import の拒否を注入する試験で、ナビゲーション、設定の見出し、別の会話ペイン、Markdown の周囲が残ることを確認した。
- `immediatelyRender: false` の削除は試したが、`document-preview.test.tsx` の “preserves every source character when preview is opened, selected and saved with Cmd+S” が失敗した。Suspense の待機中に Tiptap のエディターが破棄され、MarkdownBlocks の初期化で `Cannot read properties of null (reading 'nodeFromJSON')` が発生するため指定を残した。editor が null の間は Markdown 本文を表示し、空の surface を防ぐ。待機中の本文表示も試験に追加した。
- 静的配信で `/.vite` とその配下を404にした。解析資料の生成先は維持し、manifest と絶対パスを含む bundle-analysis の配信を防ぐ。URL エンコードされた指定も試験した。

修正後の検証:

| コマンド | 結果 |
| --- | --- |
| builtin cd packages/dashboard && node --run test:app | 60 ファイル、731 試験が成功 |
| builtin cd packages/dashboard && node --run build:app | 成功（この作業ツリー内の dist に出力） |
| builtin cd packages/api && node --test --import ./test/setup.ts test/static.test.ts | 1 成功、3 件はソケット制限で省略、失敗なし |
| node --run typecheck | 既存の packages/daemon/src/http/views.ts:83 の TS2322 のみ |
| daemon より後の dashboard、adapters、planner、scripts、app の個別型検査 | すべて成功 |

本番の API と runner は再起動していない。本番の配信先には出力していない。

## 改善 2: 観測と配信

今回は統合済みの変更へレビューの五点を反映し、観測と配信の最終値を隔離した環境で測定した。

台帳の既存の識別子と本文には変更を加えず、追記だけの規則と投影の第十版をそのまま維持した。

### レビューの修正

投影の完了を待つ整理に三十秒の期限を設け、連続した追記でもＷＡＬの整理を定期的に試行する。

投影の状態と変更一覧は短い読み取り取引で取得し、要約と同一性の書き込みは取引の外で行う。

変更のカーソルは更新が成功した後に削除し、中断した処理は次の配信更新でも再び処理できる。

監視周期は変わった履歴の取り込みと読了位置の保存に絞り、一覧を読む後処理は見回りに残した。

監視周期は主スレッドへ開始と進捗と完了を送らず、観測状態と直前の見回りの結果を保持する。

監視対象は履歴と投影と期限の変化で作り直し、無更新の見回りでは全履歴の選別と整列を省く。

配信履歴の保持量は送出に使った文字列の長さで数え、上限判定のためだけの再直列化を省いた。

一覧だけの接続は同じ文字列を再利用して配り、会話を開いた接続は各送出で一度だけ直列化する。

接続のない期間も送出用の文字列から保持量を数え、再接続用の履歴へ同じ大きさの上限を適用する。

| 指摘 | 修正 | 回帰試験 |
| --- | --- | --- |
| WAL の整理が停止 | 100 ms の安定待ちに 30 秒の期限を追加 | 25 ms ごとの連続追記と投影の遅れ |
| 書き込み鍵の長時間保持 | 読み取り取引の後で会話を更新し、成功した cursor だけ削除 | 要約中の別接続の書き込み、中断後の refresh と再起動、busy 後のプロジェクト差分 |
| 監視周期の後処理 | outbox、kit、remote status、セッション、題名、直接 Codex の対応付けを見回りへ限定 | 監視中の outbox と題名の延期 |
| 監視対象の毎秒選別 | 履歴一覧、読了位置、投影 seq、活動期限でキャッシュを失効 | 不変時の再利用、期限切れ、新規履歴、古い実行中の履歴 |
| 観測状態の揺れ | watched の通知で読取量だけ更新 | 送出後も観測状態と見回り結果が同じ |
| 二重の直列化 | 送出文字列の長さで保持量を更新 | scoped patch の直列化数と送出数の一致 |

### 待機ＣＰＵの最終測定

待機ＣＰＵは固定した履歴の写しを隔離先へ置き、最終コードで六十秒の測定を三回連続して行った。

前回の比較に使った台帳から実行用の写しを作り、初回の観測後に無更新の周期を五回確認した。

ＣＰＵ時間は主スレッドと観測ワーカーを含め、一コアを基準に六十秒の経過時間から割合を求めた。

測定用の履歴から外部を参照するリンクを取り除き、他のエージェントの履歴の書き込みを隔離した。

本番のサービスは再起動せず、本番の状態ディレクトリと指定された台帳の写しは変更していない。

三回とも事実の追記と履歴の読み取りは零件となり、監視通知を起点とする取り込みも発生しなかった。

比較先の変更前も同じ固定条件で六十秒を三回測り、前回の統合結果は保存済みの中央値を示した。

| 条件 | 値 |
| --- | --- |
| Node | v24.6.0 |
| 変更前 | main / 5147ab5180ad3e575b663cd1b25b0e761b0064b2 |
| 前回の統合結果 | b24d0dd7adf9c0107349b8420417621806ad53b6 / 既存の 60 秒三回 |
| 最終コード | b24d0dd と今回の修正 / .perf/idle-merge/review-final |
| 準備台帳 | .perf/idle-merge/settled.db / 290,469 件 |
| 最終コードの準備後 | 290,492 件 |
| 隔離した home | .perf/idle-review/frozen / シンボリックリンクなし |
| 参照する Claude と Codex | 隔離 home の .claude と .codex |
| 書き込み先 | 各実行専用の runtime DB、state、cache |
| 構成 | 観測ワーカーと投影配信 / hook とソケットは無効 |
| 配信の見回りと集約 | 500 ms / 25 ms |
| 測定順 | main の三回 → 最終コードの三回 |
| 各窓の事実の追記 | 六回とも 0 件 |
| 各窓の履歴の読み取り | 六回とも opened 0 / prefixBytes 0 / contentBytes 0 |
| 各窓の監視周期 | 六回とも 0 回 |
| 試験との同時実行 | なし |

| 実行 | 経過 ms | CPU ms | 一コアの CPU | 見回り | checkpoint | 配信更新 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| main 1 | 60002.3 | 4577.990 | 7.63% | 56 | 56 | 120 |
| main 2 | 60002.0 | 4009.244 | 6.68% | 56 | 56 | 119 |
| main 3 | 60001.7 | 4061.814 | 6.77% | 56 | 56 | 120 |
| 最終 1 | 59999.7 | 2593.359 | 4.32% | 57 | 57 | 120 |
| 最終 2 | 60002.3 | 2596.100 | 4.33% | 58 | 58 | 119 |
| 最終 3 | 60001.8 | 2467.495 | 4.11% | 57 | 57 | 120 |

| 比較 | 待機 CPU の中央値 | 最終値の低下率 |
| --- | ---: | ---: |
| main の今回の再測定 | 6.77% | 36.2% |
| main の前回の測定 | 7.67% | 43.6% |
| b24d0dd の前回の測定 | 4.59% | 5.8% |
| 最終コード | 4.32% | — |

### 変更から送出までの最終測定

変更から送出までの時間は隔離した合成履歴を使い、各製品で五回ずつ実際の送出関数まで測定した。

通信とブラウザの描画は測定に含めておらず、送出関数へ渡した時刻までを配信遅延として集計した。

| 製品 | 中央値 ms | 最小〜最大 ms | 五回の測定 ms |
| --- | ---: | ---: | --- |
| Claude | 60.8 | 55.3〜68.1 | 57.8 / 62.7 / 55.3 / 60.8 / 68.1 |
| Codex | 55.8 | 55.4〜57.8 | 57.8 / 55.4 / 55.9 / 55.7 / 55.8 |

### 最終の受け入れ

待受が環境に拒否された試験は省略したため、通信なしの試験で実際の配信処理を通して検証した。

| 検証 | 結果 |
| --- | --- |
| builtin cd packages/api && node --run test | 426 件 / 405 成功 / 21 省略 / 失敗 0 |
| 主スレッドの最大遅延 | 52.4 ms / 許容値 100 ms |
| 配信更新の最大時間 | 45.9 ms |
| 静的配信ハンドラの最大応答 | 0.7 ms / 許容値 200 ms |
| builtin cd packages/core && node --run test | 399 件 / 全件成功 |
| builtin cd packages/dashboard && node --run test:app | 61 ファイル / 741 件 / 全件成功 |
| 直下の node --run typecheck | packages/daemon/src/http/views.ts:83 の既存の TS2322 だけ |
| 配信と再試行の追加検査 | 18 件 / 12 成功 / 6 省略 / 失敗 0 |
| 台帳 | 追記だけ / 既存の source_event_id と payload の変更なし |
| 投影の版 | 10 を維持 |
| Git | git add と commit は未実行 |

| 元の記録 | 保存先 |
| --- | --- |
| main の 60 秒三回 | .perf/idle-merge/base-idle-review.json / base-idle-review.log |
| 最終コードの 60 秒三回 | .perf/idle-merge/review-final-idle-review.json / review-final-idle.log |
| CPU の計測台本 | .perf/idle-merge/measure-review.mjs |
| 配信遅延と直列化 | .perf/review-feed-final.log |
| API の全試験 | .perf/review-api-final.log |
| core の全試験 | .perf/review-core-tests.log |
| dashboard の全試験 | .perf/review-dashboard-tests.log |
| 型検査 | .perf/review-typecheck-final.log |

```sh
node .perf/idle-merge/measure-review.mjs base
node .perf/idle-merge/measure-review.mjs review-final
builtin cd packages/api && node --run test
builtin cd ../core && node --run test
builtin cd ../dashboard && node --run test:app
builtin cd ../.. && node --run typecheck
```

## 改善 3: 会話の画面

会話の初回取得を最新の二百件に限り、上へ巻き戻した時だけ前の窓を一つずつ取得する。

検索で指定した発言も窓の末尾として取得し、同じ時刻の発言は出所の数値順で整列する。

変更ファイルの候補は本文の窓と別に取得し、古い変更を数える処理で会話の表示を待たせない。

発言と道具の部品を memo で保護し、本文や関係する結果が変わらない更新では描き直さない。

投影の参照と発言の解析結果を保持することで、毎秒の時計や別の会話の更新から描画を切り離す。

畳まれた道具の詳細は開いた時だけ描画し、短い会話でも初回に不要な本文を組み立てない。

巻き戻し中は表示窓の先頭を保持することで、新しい発言の到着で読んでいる発言を押し出さない。

上に読み足す時は見えている発言の位置を基準に補正し、同時に末尾が伸びても位置を維持する。

追加の依存は使わずに取得と描画を分離しており、画面外の発言を除く仮想化は今回は導入していない。

### 会話を開く時間の調査

会話の初回表示には固定の待機がなく、端末の一覧やモデルの取得は本文と並行して進む。

端末の起動を待つ処理は送信の経路にあり、既存の会話の本文を表示する条件には含まれない。

短い会話の取得は一ミリ秒未満で終わり、ブラウザの一二二二ミリ秒を取得時間では説明できない。

短い会話には五件の道具の呼び出しがあり、閉じた詳細の本文も初回の描画対象になっていた。

長い会話の窓には道具の呼び出しがなく、件数だけで初回の描画負荷を比べることはできない。

本番の表示時間の内訳は未測定のため、畳んだ道具の描画だけで遅さの原因を確定したとは扱わない。

| 調査した経路 | ソース |
| --- | --- |
| 本文の取得と一秒時計 | packages/dashboard/app/src/pages/conversation/ConversationPage.tsx |
| 畳んだ道具の先行描画 | packages/dashboard/app/src/components/conversation/Message.tsx |
| 端末の起動を待つ経路 | ConversationPage.tsx の送信処理 |
| 全ページの直列取得 | packages/dashboard/app/src/lib/projection-client.ts の変更前 |

### 同じ台帳の写しによる比較

変更前の取得関数を同じ写しで再実行し、通信とブラウザの描画を除いた五回の中央値を比べた。

| 対象 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 長い会話の発言数 | 16,429 | 16,429 |
| 長い会話の取得処理 | 692.180 ms | 103.956 ms |
| 長い会話の API 処理合計 | 314.200 ms | 101.826 ms |
| 長い会話の要求数 | 83 | 1 |
| 長い会話の応答合計 | 28,661,038 bytes | 332,842 bytes |
| 前の窓の取得処理 | 未測定 | 104.328 ms |
| 前の窓の要求数 | 83 | 1 |
| 前の窓の応答合計 | 未測定 | 316,401 bytes |
| 変更ファイルの別要求 | 全履歴に含む | 30.418 ms / 1 要求 / 933 bytes |
| 初回と変更ファイルの応答合計 | 28,661,038 bytes | 333,775 bytes |
| 最初に保持する発言数 | 200 | 200 |
| 短い会話の取得処理 | 0.933 ms | 0.712 ms |
| 短い会話の要求数 | 1 | 1 |

本文は選んだ窓だけを取得する一方、時刻順の決定には会話全体の識別子と時刻を読み込む。

変更ファイルの別要求はこの比較に含めず、窓の表示後に古い変更の候補だけを取得する。

比較の台帳は作業ツリー内の写しだけを更新し、本番の状態ディレクトリには書き込みを行っていない。

| 計測資料 | 保存先 |
| --- | --- |
| 同じ写しの変更前 | .perf/ledger-before.json |
| 変更後の五回の標本 | .perf/ledger.json |
| 元の報告の取得処理 | 673.145 ms |
| 元の報告の応答合計 | 28,657,967 bytes |
| 変更前との差 | API に追加した hasOlder の本文量 |

```sh
PERF_REUSE_DB=1 node scripts/perf/baseline.mjs --only=ledger
node --test scripts/perf/browser-metrics.test.mjs
AGENT_GRAPH_PERF_SEND=0 node scripts/perf/browser.mjs
```

### 試験と本番の残作業

毎秒の更新で本文を描き直さない試験に加え、実際の本文が変わる場合は再描画することも確認した。

最新の窓だけを取る試験と前の窓を取る試験を足し、新着と上への読み足しが重なる位置も確認した。

送信中と Queued の表示は既存の試験を維持し、送信から待ち行列と記録への切り替えも確認した。

| 受け入れのコマンド | 結果 |
| --- | --- |
| builtin cd packages/dashboard && node --run test:app | 61 ファイル / 736 成功 |
| builtin cd packages/dashboard && node --run build:app | 成功 |
| builtin cd packages/api && node --run test | 385 成功 / 主スレッド試験だけ失敗 / 21 省略 |
| builtin cd packages/core && node --run test | 399 成功 |
| node --run typecheck | 既存の daemon/src/http/views.ts:83 の TS2322 のみ |
| 後続パッケージと scripts と app の個別型検査 | 成功 |
| node --test scripts/perf/browser-metrics.test.mjs | 2 成功 |

主スレッドの遅れは同時実行中に基準を超えたため、失敗した値も成功した値と並べて記録する。

| 実行 | 最大主スレッド遅延 ms | 最大投影配信更新 ms | 結果 |
| --- | ---: | ---: | --- |
| API 全試験の初回 | 738.4 | 731.9 | 失敗 |
| 主スレッド試験の再実行 | 1048.7 | 1040.5 | 失敗 |
| API 全試験の再実行 | 77.3 | 55.9 | 成功 |
| API 全試験の最終回 | 675.8 | 667.2 | 失敗 |

最初の試験は core の全試験と重なり、再実行した主スレッド試験は変更前の計測と重なった。

変更前のブラウザ値は利用者の本番計測を記載し、写しによる取得処理の測定値とは区別する。

| 本番ブラウザの項目 | 変更前 | 変更後 |
| --- | --- | --- |
| 巻き戻し百二十回 | 7.5〜8.6 秒 | 未測定 |
| 長いタスクの時間と回数 | 60〜140 ms / 12〜14 回 | 未測定 |
| React の commit | 15〜20 回 | 未測定 |
| 作業した fiber | 22,617〜53,435 | 未測定 |
| 描画された発言 | 119〜250 件 | 未測定 |
| 短い会話を開く中央値 | 1,222 ms | 未測定 |
| 長い会話を開く中央値 | 467 ms | 未測定 |
| 切り替え時のサイドバー | 35〜60 ms | 未測定 |
| 切り替えから最後の発言 | 217〜292 ms | 未測定 |
| 大きな Claude の最後の発言 | 975〜1,029 ms | 未測定 |

本番のブラウザ値は利用者が再測定するため、開く時間と切り替えと巻き戻しの改善値は未測定である。

ブラウザ台本の可視判定と巻き戻し処理を試験し、百二十回の描画と長いタスクの値を確認した。

本番の API と runner は再起動しておらず、ビルドの出力先も作業ツリーだけに限っている。
