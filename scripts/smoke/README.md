# 核の使い方の確かめ

本番のダッシュボードで、核の使い方を本物のブラウザで通す。
本番に出すたびに、リポジトリの根で `node scripts/smoke/core-journeys.mjs` を走らせる。
通らなければ、本番に出したとは言わない。

- 確かめるのは送信、画像付きの送信、Codex の送信の経路、グラフ、変更、ファイル、名前の変更、設定、画面の誤りと、非表示・直接表示である。
- 手順ごとに合否と秒数を 1 行で出す。
- 1 つでも落ちると、終了コードは 1 になる。
- 落ちた手順のスクリーンショットは `~/.cache/agent-graph/smoke/` に置く。
- 送信する会話の cwd は `~/.cache/agent-graph/smoke` に固定する。予約した起動先 `agent-graph-smoke` を使い、モデルは haiku にする。利用者のリポジトリやその作業ツリーで試験用の会話を起こさない。
- 起動時に `AGENT_GRAPH_HEADLESS=1` を渡す。旧キットの turn hook は採番を行わない。観測した cwd の印は台帳に `hidden: true` として記録され、最初から一覧に出ない。
- id は `~/.cache/agent-graph/smoke/session-v2.json` に覚える。旧 `session.json` は読まない。再利用前に版・起動先・cwd・非表示を詳細 API で確認し、api 側も再開前に JSONL の cwd を確認する。
- 作り直すときは `session-v2.json` を別名に退避してから走らせる。古い会話には戻らない。
- 画面の WebSocket は台本が中継し、隔離した会話の起動と送信のほかの書き込みを止める。
- Codex の会話では送信を押すが、命令は中継で止まり、本物の Codex には届かない。
- グラフ・Changes・Files は既存プロジェクトを読み取るだけにする。新規作成 UI と改名の自動試験も台本内で実行する。改名のブラウザ操作は別コンテキストで、WebSocket の宛先を一時台帳だけに固定して行う。表示の変更・リロード後の永続化・名前の復元を検証し、失敗すれば台本も失敗する。
- 終わると、確認用の端末を閉じ、localStorage を戻す。
- 宛先は `AGENT_GRAPH_SMOKE_URL` で変えられ、既定は `http://127.0.0.1:7420` である。
- Playwright が見つからないときは、台本の頭の `PLAYWRIGHT` の場所を直す。

手動の確認や review でも同じ起動先を使う。子に確認を頼む際は、cwd と採番抑止の印、一覧に出ないことを条件に含める。本物の根・fork・利用者の会話を送信先に使わない。`scripts/perf/browser.mjs` も同じ版の保存ファイルと検証を使う。

## 既存の試験会話の片付け

この変更を稼働側に反映してから、利用者が実行する。本番への追記は次の `apply` だけで行う。サービスの起動・再起動、投影の再構築、履歴ファイルの変更は行わない。

```sh
node scripts/hide-verification-conversations.mjs verify
node scripts/hide-verification-conversations.mjs apply
```

`verify` は DB と JSONL を読み取り専用で確認する。対象と確認時の SHA-256 は `scripts/hide-verification-conversations.json` に固定した。`apply` も全件を再確認してから `conversation.hidden` を冪等に追記する。JSONL が変わっていたら、利用者の発言が増えていないか再確認するまで適用しない。既存の投影の版は上げず、api の通常の追跡で非表示を反映する。直接の会話 URL は引き続き使える。

対象は Claude の `dccfc0e3`、`34db3ddb`、`72c34a27`、`e7c321b5`、`61a2f785`、`ae1f6dc5`、`563d809d`、`580177f6`、`7e05e985` の 9 件。試験依頼以外の利用者の発言がないことを JSONL 全体で確認した。

`8f583846`、`a3b77d2d`、`daaa5263`、`0af4408d` は JSONL が見つからないため除外。`33810f8b` は `/model haiku` のみ、Codex の `01a139c5` は `/model gpt-5.5` のみで、利用者の操作か判別できないため除外した。指定された保護対象 `1c0d055c`、`354000b1`、`fea1ff97` は対象に含めない。
