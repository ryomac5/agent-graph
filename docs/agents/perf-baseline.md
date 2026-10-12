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

今回の比較では同じ台帳の写しを二つに分け、変更前と変更後の台本を順番に実行した。

変更前の製品コードは隔離した写しから読み込み、本番のプロセスや台帳には手を加えていない。

監視は実行中の会話と直近十分に動いた履歴へ絞り、対象の上限を百二十八個に固定した。

通知が取れない履歴や新規ファイルは一秒ごとの見回りで補い、取り込みの欠落を防いでいる。

変更通知と投影反映の通知を二十五ミリ秒でまとめ、大量取り込み中の配信回数も抑えている。

画面描画とソケットの通信時間は含めず、変更から送出関数の呼び出しまでを試験で測った。

同一性は対象の事実だけを持つ部分索引で読み、長い会話の最新発言は時刻索引から取得する。

所属と発言の変更は同じ取引で補助表へ反映し、訂正や解除でも最後の発言を取り直している。

同じ時刻の発言は従来の順序で選び、時差表記や所属の先着でも最新の発言が一致する。

最初の導入では補助表と索引を一度作成し、次の起動からは所属の全件走査を繰り返さない。

投影の版は据え置いたため、八十秒から百十五秒を要する全件の作り直しは今回発生しない。

本番のプロセス情報の取得は環境から拒否されたため、記憶領域の正確な内訳は未確認である。

本番の一・一ギガバイトという値の改善率は断定せず、隔離した実行の内訳を参考値として示す。

配信履歴は千件と十六メビバイトの両方で制限し、上限を超えた再接続には再同期を要求する。

場所のキャッシュは四千九十六件に制限し、追い出した場所は必要になった周期で調べ直す。

配信接続の自動チェックポイントを止め、既存の書き手である観測ワーカーへ処理を寄せた。

変更通知の周期は対象の履歴だけを読み、連続した更新の間も一秒ごとの全体の見回りを続ける。

投影の反映は観測ワーカーで小さな単位に分け、主スレッドで台帳の重い書き戻しを行わない。

配信更新は短い取引でまとめて行い、書き手のロックが取れない周期は待たずに再試行する。

補助表の初回作成では既存の発言名の時刻を再利用し、本文を含む発言の全件読み出しを省いた。

最新候補は二ミリ秒の範囲から元の時刻で比較し、小数秒の境界でも従来の最後の発言を保つ。

準備台帳は四千九十六件と十六メビバイトで区切り、大きな事実の連続保持を避けている。

書き込み接続のページキャッシュを十六メビバイトに抑え、台帳の大きなページの保持を減らした。

配信側の文脈接続のページ上限を八メビバイトへ縮め、投影反映を行う接続とは別に管理している。

### 前後の数値

| 条件 | 値 |
| --- | --- |
| 元の製品コード | HEAD の写し / API と core を隔離 |
| 同じ台帳の事実 | 278,467 件 |
| 会話 / 発言 / 所属 / 実行 | 3,026 / 113,890 / 116,828 / 3,299 |
| 長い会話 | 16,429 発言 |
| 取得方法 | 指定された perf 作業ツリーの ledger.db を複製 |
| 起動の測定順 | feed の初期化 → SQL の計測 |
| 観測の測定順 | 準備一周 → 一秒間隔の五周 |
| 無更新の選別 | appended = 0 / jsonl の opened = 0 |
| 初回と二回目 | 各一回 / 別プロセス |

| 項目 | 変更前 | 変更後 | 回数 | 変更後の最小〜最大 |
| --- | ---: | ---: | ---: | ---: |
| 無更新の観測周期 | 79.067 ms | 41.237 ms | 各 5 | 9.357〜143.722 ms |
| 無更新の同期 CPU 時間 | 81.307 ms | 45.726 ms | 各 5 | 11.178〜162.123 ms |
| 直接 Codex の対応付け区間 | 37.818 ms | 0.500 ms | 各 5 | 0.225〜29.452 ms |
| 探索と更新判定の区間 | 39.831 ms | 37.527 ms | 各 5 | 8.539〜41.107 ms |
| 観測プロセスの RSS | 649,543,680 bytes | 578,519,040 bytes | 各 5 | 578,502,656〜579,944,448 bytes |
| 同一性の SQL | 297.610 ms | 28.868 ms | 各 5 | 26.319〜31.109 ms |
| 長い会話の最新候補 SQL | 20.178 ms | 0.071 ms | 各 5 | 0.069〜0.140 ms |
| 配信準備の初回起動 | 38,502.339 ms | 11,268.527 ms | 各 1 | — |
| 配信準備の二回目起動 | 1,554.576 ms | 746.756 ms | 各 1 | — |
| Claude の変更から送出 | 未測定 | 62.4 ms | 5 | 57.2〜66.2 ms |
| Codex の変更から送出 | 未測定 | 68.7 ms | 5 | 60.2〜71.1 ms |

今回の起動計測はＳＱＬ計測より先に行う条件へ揃えたため、既存の千五百ミリ秒とは区別する。

最新候補を引く時刻の索引は範囲探索となり、同一性の部分索引は一万三百四件だけを走査する。

約二十六万件を走査対象から外し、会話の全ての事実と実行の作成の事実だけを索引に残している。

対応付けが残った最初の無更新周期には準備後の差分が含まれ、最後の四周期では処理を省けた。

### 記憶量と負荷

ＲＳＳは全スレッドで共有される値なので、主スレッドとワーカーの記憶量を足し合わせない。

ＣＰＵとＲＳＳは隔離した実行の参考値として示し、本番の八・七パーセントとは直接比較しない。

| 項目 | 変更前 | 変更後 |
| --- | ---: | ---: |
| API 構成の十秒の CPU | 6.84% | 15.01% |
| 同じ構成の RSS | 867,860,480 bytes | 814,333,952 bytes |
| 主スレッド heapTotal | 88,440,832 bytes | 88,473,600 bytes |
| ワーカー heapTotal | 269,451,264 bytes | 284,901,376 bytes |
| 主スレッド heapUsed | 10,794,288 bytes | 34,730,872 bytes |
| ワーカー heapUsed | 162,175,008 bytes | 197,572,128 bytes |
| 外部領域 | 22,026,190 bytes | 22,042,554 bytes |
| 変更後の履歴読み取り | — | 1 ファイル / 9,824 bytes |
| 変更後の監視通知の周期 | — | 1 周期 |
| 変更後の見回りの周期 | — | 8 周期 |

この十秒には発言にならない履歴の読み取りが一回含まれ、待機時のＣＰＵ低下は確認できていない。

記憶量の残りには予約領域とネイティブ領域が含まれ、ＳＱＬｉｔｅだけの使用量には分離していない。

単独の大きな事実は区切りを越えて保持する必要があり、準備台帳の数値はＲＳＳの上限ではない。

### 検証と再実行

| 検証 | 結果 |
| --- | --- |
| API の全試験 | 412 件 / 391 成功 / 21 skip / 失敗 0 |
| 主スレッドの最大遅延 | 36.4 ms / 許容値 100 ms |
| 配信更新の最大時間 | 30.2 ms |
| core の全試験 | 396 件 / 全件成功 |
| 直下の typecheck | daemon の views.ts:83 の既存の誤りだけ |
| ソケットの skip | 実行環境による TCP と Unix socket の listen 拒否 |
| 新しい試験 | 変更から送出 / 連続通知中の新規探索 / 長いターンの監視 / 要約索引 / 大きな準備台帳 |
| 投影の版 | 10 を維持 / 上げていない |

```sh
builtin cd packages/api && node --run test
builtin cd ../core && node --run test
builtin cd ../.. && node --run typecheck
PERF_REUSE_DB=1 AGENT_GRAPH_PERF_DIR="$PWD/.perf/compare-final" node scripts/perf/ledger.mjs
AGENT_GRAPH_PERF_DIR="$PWD/.perf/compare-final" node scripts/perf/observation.mjs
AGENT_GRAPH_PERF_DIR="$PWD/.perf/compare-final" node --expose-gc scripts/perf/runtime.mjs
```

| 元の記録 | 保存先 |
| --- | --- |
| 変更前の起動と SQL | .perf/compare-before/ledger.json / ledger-warm.json |
| 変更後の起動と SQL | .perf/compare-final/ledger.json / ledger-warm.json |
| 変更前の観測 | .perf/compare-before/observation-final.json |
| 変更後の観測 | .perf/compare-final/observation-final.json |
| 記憶量と CPU | 両方の保存先の runtime-final.json |
| 試験の結果 | .perf/api-tests.log / core-tests.log / typecheck.log |

本番の api と runner は再起動せず、台帳の追記先と計測の生成物は作業ツリー内に隔離した。

### merge 後の待機ＣＰＵの再測定

待機ＣＰＵは外部更新のない固定した履歴を使い、変更前後で六十秒の測定を三回ずつ行った。

変更前は main の `5147ab5` を使い、変更後は衝突を解消した統合結果のコードを使った。

初回取り込み後の台帳は投影を末尾まで反映し、両方の実行で同じ準備台帳の写しを使用した。

既存の事実の識別子と本文は台帳に保存した値を維持し、今回の統合作業でも書き換えていない。

準備後に五回連続で履歴の読み取りがない周期を確認し、その後の三つの測定窓を順番に取得した。

主スレッドと観測ワーカーを含むＣＰＵ時間を取得し、六十秒の経過時間と一コアを基準に算出した。

各測定窓で事実の追記と履歴の読み取りがないことを確認し、監視通知による周期も発生しなかった。

| 条件 | 値 |
| --- | --- |
| Node | v24.6.0 |
| 変更前のコード | main / 5147ab5180ad3e575b663cd1b25b0e761b0064b2 |
| 変更後のコード | この merge の結果 / .perf/idle-merge/after |
| 元の台帳の事実 | 278,467 件 |
| 共有の準備台帳の事実 | 290,469 件 |
| 履歴の固定先 | .perf/idle-merge/frozen |
| 準備台帳 | .perf/idle-merge/settled.db |
| 測定の順序 | 変更前の三回 → 変更後の三回 |
| 構成 | 観測ワーカーと投影配信 / hook とソケットは無効 |
| 配信の見回り | 両方とも 500 ms |
| 通知による配信の集約 | 両方とも 25 ms |
| 各窓の事実の追記 | 六回とも 0 件 |
| 各窓の履歴読み取り | 六回とも opened 0 / prefixBytes 0 / contentBytes 0 |
| 各窓の監視通知の周期 | 六回とも 0 回 |
| 試験との同時実行 | なし |

| 実行 | 経過 ms | CPU ms | 一コアの CPU | 見回り | checkpoint | 配信更新 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 変更前 1 | 60002.4 | 4602.491 | 7.67% | 55 | 55 | 120 |
| 変更前 2 | 60002.7 | 4831.333 | 8.05% | 55 | 55 | 119 |
| 変更前 3 | 60002.1 | 4225.372 | 7.04% | 56 | 56 | 120 |
| 変更後 1 | 60002.6 | 2753.694 | 4.59% | 57 | 57 | 120 |
| 変更後 2 | 60001.9 | 2815.381 | 4.69% | 58 | 58 | 119 |
| 変更後 3 | 60001.4 | 2668.723 | 4.45% | 57 | 57 | 120 |
| 中央値 | — | — | 7.67% → 4.59% | — | — | — |
| 中央値の低下率 | — | — | 40.2% | — | — | — |

今回の固定条件では待機ＣＰＵの増加は見られず、前回の十秒測定だけでは回帰を判定できない。

見回りの回数は変更前後でほぼ同じ範囲に収まり、変更通知による観測周期の倍増は見られなかった。

この比較では本番の履歴更新がない状態に限定し、実行中の書き込み負荷でのＣＰＵは測っていない。

| 計測資料 | 保存先 |
| --- | --- |
| 変更前の六十秒三回 | .perf/idle-merge/base-idle.json |
| 変更後の六十秒三回 | .perf/idle-merge/after-idle.json |
| 計測台本 | .perf/idle-merge/measure.mjs |
| 周期と読み取りの計装 | .perf/idle-merge/prepare.mjs |
| 準備台帳の投影反映 | .perf/idle-merge/settle.mjs / settle.log |
| 変更前の実行ログ | .perf/idle-merge/base-idle-final.log |
| 変更後の実行ログ | .perf/idle-merge/after-idle-final.log |

~~~sh
node .perf/idle-merge/measure.mjs base
node .perf/idle-merge/measure.mjs after
~~~

### merge 後の受け入れ

同一性の検索は部分索引の条件を保ったまま、待ち行列の事実だけを同一性の更新から除外した。

待ち行列の初期読み込みは配信準備の取引内に置き、一覧と根の投影が同じ状態を参照するようにした。

投影の版は既存の第十版を今回もそのまま維持し、台帳全体を作り直す版の更新は行っていない。

| 検証 | 統合後の結果 |
| --- | --- |
| builtin cd packages/api && node --run test | 419 件 / 398 成功 / 21 省略 / 失敗 0 |
| 主スレッドの最大遅延 | 38.7 ms / 許容値 100 ms |
| 配信更新の最大時間 | 32.6 ms |
| builtin cd packages/core && node --run test | 399 件 / 全件成功 |
| builtin cd packages/dashboard && node --run test:app | 最終回は 61 ファイル / 741 件 / 全件成功 |
| 画面の初回試験 | 740 成功 / README.md の表示待ちだけ失敗 |
| 画面の対象ファイルの再実行 | explorer.test.tsx / 31 件 / 全件成功 |
| node --run typecheck | packages/daemon/src/http/views.ts:83 の既存の TS2322 のみ |
| daemon より後の対象の個別型検査 | dashboard / adapters / planner / scripts / app が成功 |
| 同一性の問い合わせの実行計画 | api_identity_subject_seq を使用 |
| 窓のカーソルと旧い引数 | conversation-window.test.ts が成功 |
| 待ち行列の反映と再構築 | input-queue.test.ts が成功 |
| ファイル内の衝突の印 | 二つのファイルとも残存なし |
| git add | sandbox が作業ツリー外の index.lock 作成を拒否 |
| git diff --name-only --diff-filter=U | index 更新が拒否されたため二件が残る |

画面の初回試験では一件の表示待ちが期限を超えたが、対象の単独実行と全体の再実行は成功した。

直下の型検査は既存の daemon の誤りで止まるため、後続の対象も個別に検査して成功を確認した。

本番の api と runner は今回の計測中も起動状態を維持し、再起動は一度も行っていない。

| 試験の記録 | 保存先 |
| --- | --- |
| API | .perf/merge-api-tests.log |
| core | .perf/merge-core-tests.log |
| 画面の初回 | .perf/merge-dashboard-tests.log |
| 画面の対象ファイル | .perf/merge-dashboard-explorer.log |
| 画面の最終回 | .perf/merge-dashboard-tests-final.log |
| 直下の型検査 | .perf/merge-typecheck.log |
| 後続の型検査 | .perf/merge-typecheck-following.log |

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
