# 会話画面の送信と書きかけの修正

## Sending が長く残る経路

送信は `ConversationPage.send` → `client.command` → WebSocket の cmd → api → ack の順に進む。
端末の `session.send` は `writeMessage` で貼り付けと Enter の書き込みを完了してから成功を返す。
起動直後の入力準備や貼り付けの間隔は ack 前の待ちである。
前回は画面側だけを変更した。今回の端末側の修正は後述する。

旧画面は ack 後も楽観的な発言に `delivery_state: sending` を固定していた。
終了条件は ack ではなく、会話の `pending_inputs` または新しい user 発言との本文一致だった。
照合には会話 ID、送信時点で既知の行 ID の除外、`sameSent` の本文比較を使う。
待ち行列が届かない場合や照合できない場合は、後続の `message.created` まで Sending が残る。

提示された時刻では、Claude の受信から待ち行列の台帳記録まで 687 ms、発言の台帳記録まで 8.177 秒だった。
この差を Sending の表示時間に持ち込んでいたのが画面側の問題である。
当日のブラウザの patch と本文の記録はないため、実際にどの照合条件が外れたかまでは断定していない。

修正後は成功 ack で楽観的な発言を通常の吹き出しにする。
後から待ち行列が届けば Queued に置き換え、発言の記録が届けば通常の記録に置き換える。
Sending の終了は台帳との照合に依存しない。未達の見張りは追加していない。

## 新しい版への切り替えと再読み込み

自動で `window.location.reload()` を呼んでいたのは `lib/preload-recovery.ts` の
`vite:preloadError` ハンドラーである。30 秒の制限だけで、配信中の版を確認せず読み直していた。
`FeatureErrorBoundary` にも Reload ボタンがあるが、こちらは利用者が押す経路である。
WebSocket の再接続と resync は store の更新だけを行い、ページは読み直さない。

Settings、CodeTab、MarkdownEditor は分割ファイルの遅延読み込みを使う。
Vite の build は `emptyOutDir: true` で、分割ファイル名は内容によって変わる。
api は古いファイル名がなくなれば 404 を返す。そのため、配信先を新しい build に置き換えたあと、
古い画面が未読み込みの分割ファイルを要求すると preloadError から自動再読み込みに進む。
当日のブラウザエラー記録はないため、実際の発火は確認できないが、更新による自動再読み込みの経路はこれである。

旧入力欄は React の state だけに本文を持ち、さらに会話 ID が変わる effect で空にしていた。
ページの再読み込み、画面の再マウント、会話の切り替えで書きかけが失われる実装だった。

修正後は入力ごとに会話 ID をキーに sessionStorage に保存し、再マウントと会話切り替えで復元する。
成功 ack で送った本文に一致する書きかけだけを消す。失敗時は残し、別会話の書きかけも消さない。
未作成の会話は project と cwd を含む別キーを使う。
保存できないブラウザでも入力と送信は続けられる。

preloadError では配信中の HTML をキャッシュなしで取得し、module の入口が変わった場合だけ読み直す。
同じ版、通信失敗、HTML の取得失敗、入口がない場合、オフラインでは自動再読み込みしない。

## 残した表示

返事待ちの推定、専用文言、強調色と `lib/reply-status.ts` は削除した。
既存の待ち状態は通常の状態名で表示する。
作業中の一行、最後の道具と説明、裏の待ち、畳んだ道具の説明、Queued、FilesPage の useLayoutEffect は残した。

本番の api と runner の再起動、配信先の更新、状態ディレクトリへの書き込みは行っていない。

## 前回の検証

- dashboard `node --run test:app`: 777 件成功。
- dashboard `node --run build:app`: 成功。出力はこの作業ツリーの dist のみ。
- api `node --run test`: 413 件成功、21 件 skip、失敗 0。
  skip は sandbox のローカルソケット制約など、試験に元からある判定による。
- 直下 `node --run typecheck`: 指定された `packages/daemon/src/http/views.ts:83` の既存 TS2322 のみ。
  このコマンドは daemon で停止するため、後続の dashboard、adapters、planner、scripts と dashboard/app も別途型検査し、成功した。
- `git diff --check`: 成功。

試験は管理下と端末の両送信経路について ack 前後の表示を検証する。
待ち行列と通常の発言への置き換え、会話切り替えと再マウント後の書きかけ復元、
成功時の削除、失敗時の保持、別会話へ移動したあとに届く ack、
英日両方のサイドバーとタブと会話で返事待ちの文言がないこと、
版が変わった場合だけ自動再読み込みすることを確認した。

## 作業中の端末への送信が 15 秒待つ問題

`git log` と `git show dcfdad7` で静穏待ちの導入理由を確認した。
2026-10-11 の同コミットは resume 直後の画像添付の修正である。
画面が入力を受け付ける前に貼ると bracketed paste が効かず、画像パスが素の文字として入るため、
起動後 2500 ms と最終出力後 800 ms の両方を満たすまで待っていた。
ただし、この条件を送信ごとに適用し、15 秒の期限も送信ごとに設定していた。
作業中のスピナーが `lastOutputAt` を更新し続けるため、毎回期限まで貼り付けが始まらなかった。
WebSocket は `sessionHosts.handle` の完了後に ack を返すため、この待ちはすべて ack の前にある。

修正では端末ごとに `inputReady` を記憶する。
既存の 500 ms 周期でも準備を判定するため、チャットからの初回送信以前に端末で作業を始めた場合も、
準備完了を保持できる。完了後は出力が続いても静穏待ちに戻らない。
起動直後は従来と同じ warmup と quiet の条件で待ち、上限は起動から一度だけ 15 秒とする。
準備待ちや添付転送中に端末が終了した場合は、貼り付ける前に失敗を返す。

貼り付けと Enter の分離は `98daa38` からあり、画像の貼り付け順序は `b6e9db5` で加わった。
node-pty の実装も確認した。`UnixTerminal` は読み取り用の `tty.ReadStream` と入力用の
`CustomWriteStream` を分け、入力の部分書き込みと EAGAIN を順序付きキューで処理する。
端末出力の描画データは入力のバイト列へ混入しない。
一方、貼り付けと同時に Enter を送ると入力側で貼り付け本文と解釈される恐れはあるため、
既存の端末ごとの送信直列化、bracketed paste、画像後の 300 ms、本文後の 500 ms、別書き込みの Enter を維持した。

`session-hosts.test.ts` では両 provider の模擬端末に 25 ms 周期の描画を発生させ、
本文のみと画像付きの両方で `session.send` の完了（WebSocket が ack を返す直前）を測定する。
描画が貼り付けから Enter まで続くことと、日本語・改行を含む入力バイト列を検証する。
起動直後は、2400 ms 時点の再描画から 800 ms 待って 3200 ms まで貼り付けないことも確認した。
連続出力時の期限が起動を基準に一度だけ適用されること、既存の連続送信・画像の順序も試験する。
実機の Claude/Codex の受信までは検証していない。

core には usage limit reset の通知を enqueue しても待ち行列に積まない回帰試験を追加した。
explorer の README 表示の特別な 3000 ms timeout は削除した。
前回の ack による Sending 終了、sessionStorage の書きかけ保存、返事待ち表示の削除は保持した。

## 今回の検証

- `builtin cd packages/api && node --run test`: 438 件中 417 件成功、21 件 skip、失敗 0。
  skip はローカルソケット制約など試験の既存条件による。
  主スレッドの最大遅延は **54.3 ms**（基準 100 ms 以下）。
  連続描画中の送信処理は Claude が本文 502.1 ms・画像付き 802.2 ms、
  Codex が本文 501.1 ms・画像付き 801.6 ms。すべて試験の上限 1100 ms 未満。
- `builtin cd packages/core && node --run test`: 401 件成功、失敗 0。
- `builtin cd packages/dashboard && node --run test:app`: 777 件成功、失敗 0。
- explorer 単独を `node --run test:app -- src/test/explorer.test.tsx` で 5 回実行し、
  各回 32 件、5 回とも成功。
- 直下の `node --run typecheck`: `packages/daemon/src/http/views.ts:83` の既存 TS2322 のみ。
  daemon で停止したあとの dashboard、adapters、planner、scripts、dashboard/app は個別に型検査して成功。
- `git diff --check`: 成功。

今回、本番の api/runner の再起動、状態ディレクトリへの書き込み、build、commit は行っていない。
node_modules の symlink は変更していない。
