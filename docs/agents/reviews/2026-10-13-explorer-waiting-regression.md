# 返事待ち差分で観測されたファイル表示試験の調査

## 確認した原因と修正

`FileViewerPanel` は、ディレクトリの取得によって選択ファイルの
`changed` が false から true になると、File / Diff のボタンを表示する。
同じ更新で予約された `useEffect` は `setView('diff')` を実行する。
ボタンの出現直後に File を押すと、この初期化が File の選択を上書きし、
画面が Diff に戻る場合がある。本文の取得が遅いだけではなく、
本文を表示するモードから外れるので、待ちを延ばしても region は出ない。

表示モードの初期化だけを `useLayoutEffect` に移した。
ボタンを操作できる前に初期化を完了させ、File の選択を保持する。
差分の取得とその状態更新は従来の `useEffect` に残した。
初期化の依存条件と、ファイルや作業ツリーを切り替えたときの既定モードは保った。

回帰試験では MutationObserver でボタンの出現直後に File を押し、
本文の region と File の選択状態を検証する。
修正前にはこの試験が失敗し、Diff が選択されたままになった。
修正後には成功した。修正前の連続実行では、既存の
`switches worktrees and lists the selected tree` も3秒の region 待ちで失敗した。
試験の待ち時間は変更していない。

## 元差分との関係と調査の限界

当初の未変更状態では、指定された explorer 試験の実行は16回とも成功した。
全体試験では `shows other text files as code without the Markdown switch` が
同じ本文 region の待ちで失敗した。

該当試験の投影には会話も実行もなく、Workbench はマウントされない。
historyState の useMemo と reportConversation の比較はこの経路では動かない。
RootList にも根がないため、resolveActivity と resolveReplyStatus の判定は呼ばれない。
返事待ち差分による、これらの処理の無限更新を失敗原因とする根拠は得られなかった。

上記の表示モード初期化は main の f4e15a8 にもある既存処理である。
今回確認・修正したのは操作と初期化の競合であり、元差分のどの変更が
その競合を起こしやすくしたかまでは特定できていない。
main で元試験が3回通った事実だけでは、この競合の不在は保証できない。

## 修正後の検証

- `builtin cd packages/dashboard && for i in 1 2 3 4 5; do node --run test:app -- src/test/explorer.test.tsx; done`: 5回すべて成功、各32件。
- `builtin cd packages/dashboard && node --run test:app`: 61ファイル、771件すべて成功。
- `builtin cd packages/dashboard && node --run build:app`: 成功。出力先はこの作業ツリーの `packages/dashboard/dist`。
- 直下の `node --run typecheck`: `packages/daemon/src/http/views.ts:83` の既存の TS2322 だけ。
- 上記コマンドが daemon で停止するため、dashboard、adapters、planner、scripts、dashboard/app の型検査も個別に実行し、すべて成功。
- `git diff --check`: 成功。

以前からの未コミット差分を保持し、返事待ち・送信中・Queued の処理は変更していない。
本番 api / runner の再起動、配信先へのビルド、コミットは行っていない。
