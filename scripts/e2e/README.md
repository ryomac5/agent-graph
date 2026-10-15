# 隔離した基本操作の E2E

リポジトリの根で実行する。

```sh
node scripts/e2e/run.mjs
```

ブラウザを表示する場合は `--headed` を付ける。Node 24、既存の workspace 依存、既存の Chromium が必要。依存の追加・インストールは行わない。Playwright は次のファイルを絶対パスで読み込む。

```text
/Users/r/.npm/_npx/d71ea5ed3eabc9b3/node_modules/playwright/index.mjs
```

終了コード `0` だけを公開の条件とする。失敗・未実行・証拠の保存失敗・後片付けの失敗は `1`。期待される既知の失敗を合格に読み替える設定はない。公開する環境の既存の手順で、この命令の成功を必須にする。この変更は公開処理自体には手を入れない。

## 実行と隔離

1. 偽 CLI と隔離・判定処理の補助試験を実行する。
2. インストール済み Vite で、この作業ツリーの dashboard を隔離先へ build する。
3. 新しい api と runner、観測ワーカー、実際の Chromium を起動する。
4. ブラウザからプロジェクトを追加し、会話を起動・操作する。
5. 結果と証拠を保存してから、子プロセスと実行用ディレクトリを片付ける。

実行用ディレクトリは `scripts/e2e/.runs/run-*`。その中の別々の場所に HOME、Claude/Codex の設定・履歴、XDG の状態・設定・キャッシュ・データ、TMPDIR、使い捨ての Git リポジトリ、build を置く。使い捨てリポジトリは `git init` だけを行い、commit は作らない。

親の環境変数は引き継がず、許可した項目だけで組み直す。認証情報、既存の hook、CLI の会話 ID、Node の preload 設定、利用者の shell 設定は読み込まない。`AGENT_GRAPH_CLAUDE_BIN` / `AGENT_GRAPH_CODEX_BIN` と PATH の先頭を、専用の偽実行ファイルへ固定する。api の PTY 起動が `AGENT_GRAPH_*` を取り除いても、PATH の偽 CLI を使用する。SDK のモデル一覧取得と使用量の問い合わせも偽物が応答する。

api・dashboard・hook の TCP port はすべて `0` で割り当てる。既存の URL を指定するオプションは設けない。runner と api は隔離した状態ディレクトリを cwd にし、相対パス `runner.sock` で接続する。これは macOS の Unix socket のパス長制限も避ける。`~/.local/state/agent-graph`、本番 port、既存の runner.sock、利用者の `~/.claude` / `~/.codex` は使わない。`.endpoint` は隔離先にも作らず、専用の `hook-destination.json` を使う。

api は製品と同じ静的配信・WebSocket・観測ワーカー・設定サービスを起動する。dashboard の HTTP / WebSocket 応答や投影は差し替えない。ロゴの合成キャッシュを隔離先に置き、外部 CDN へのアクセスを避ける。ブラウザの接続先は起動した dashboard の origin に限定する。

正常終了、例外、SIGINT、SIGTERM で片付ける。実行全体の上限は 15 分。CLI 子は親の死亡も監視する。Playwright 自身が作る一時プロファイルと trace も、親プロセスの一時ディレクトリを切り替えて隔離する。SIGKILL や電源断では `finally` が動かないため、実行用ディレクトリが残る場合がある。共有の node-pty helper の実行権限が足りない場合は止まり、共有依存の権限を変更しない。

## 結果

`scripts/e2e/results/<UTC日時>-<PID>/report.html` を開く。同じ場所に機械判定用の `report.json` がある。実行ごとに別の場所へ保存し、過去の結果は上書きしない。

- 各項目: `pass` / `fail` / `blocked`、所要時間、理由、PNG、DOM、投影と偽 CLI の状態、Playwright trace。
- `commands.json`: 実際に送られた WebSocket command / ack。応答の差し替えはしない。
- `browser-errors.json`: 全ページの `pageerror` とすべての `console.error`。除外リストはない。
- `fixture-evidence/`: 合成した履歴、hook 入力、台本の指示、CLI の監査記録。
- `build.log`、`harness-tests.log`、起動できた場合の `api.log` / `runner.log`。

`blocked` は未実行であり、合格ではない。ブラウザ自体を起動できなかったときは画像を捏造せず、「画像なし」と理由を記録する。実行用の DB・HOME・token の設定ファイルは保存しない。trace と DOM には当該実行だけの dashboard token が含まれ得る。サービス停止後に無効になる。

## 通す操作

| 番号 | 確認 |
| --- | --- |
| 1 | サイドバーの新規起動、入力、送信、返事。Claude と Codex を別々に確認 |
| 2 | 台本で返事を保留し、作業中に追加送信。Queued、再読み込み、吸収後の一件表示、配達確認 |
| 3 | 最新の応答、再読み込み、会話と端末タブの往復、開き直し。compact 後の最新発言と要約の非表示 |
| 4 | 同じ PTY で native ID を fork。continued-in の同じ根への統合、分岐前のタブからの送信と履歴 |
| 5 | 行の rename と端末で入力する `/rename` を別々に実行。サイドバーとタブの両方を確認 |
| 6 | 画面のモデル選択と Apply、実際の端末確認画面。確認中の送信拒否と下書き保持、`s` による確定と表示変更 |
| 7 | 保留中の Working と完了後の Idle/Done。SessionEnd の後、同じプロセス・世代に続く入力でも Working に戻る |
| 8 | 二日前の履歴を持つ会話に今日の発言を追加し、行の datetime を最新発言と比較。fork 後の根とサイドバーの行数も別項目で確認 |
| 9 | 通常文の配達成功と意図的な未着。`!` の配達成功と未着。製品の 60 秒の期限を実時間で待ち、未着表示を確認 |
| 10 | 全操作を通じて pageerror と console.error がゼロ |

各確認は新しいブラウザ context と新しい会話で始め、失敗しても次の独立した項目へ進む。全体の初期化ができない場合は残りを blocked にする。`!` は shell を本当に実行せず、実履歴と同じ `<bash-input>` / `<bash-stdout>` の形を偽 CLI が出す。配達処理の期待値に合わせた本文への書き換えはしない。

## 偽 CLI と形式の根拠

`fixtures.mjs` が記録形式と画面を、`fake-cli.mjs` が入力・状態・台本を持つ。通常の stdin、Ctrl+U、bracketed paste、別送の Enter を扱う。`journeys.mjs` の `scriptActor()` は、当該 CLI 専用のファイル mailbox に台本を送る。HTTP 応答や台帳の行を直接書くものではない。

台本の操作は `hold-next`、`release`、`fork`、`rename`、`compact`、`end`、`resume`、`drop-next`。`next-session.json` の `historyAgeMs` は、古い会話から最新日付への更新を再現する。端末の `/rename`、`/model`、確認キー、通常入力は stdin を通す。hook は製品の `runHookV2` を使い、世代採番・outbox・HTTP 送信を通る。

2026-10-15 に、次を読み取り専用で調べた。利用者の本文・ID・パス・認証情報は標本へコピーしていない。

| 対象 | 根拠と再現範囲 |
| --- | --- |
| Claude 2.1.299 | `~/.claude/projects` の version が一致する実行から user、assistant、queue-operation、attachment.queued_command、custom-title、continued-in、local-command-stdout、bash-input の構造を確認 |
| キュー | 2.1.299 の attachment に `commandMode: prompt`、`origin.kind: human`、`source_uuid`、`delivery_id`、`humanTurn`、独立した timestamp がある。enqueue/remove と、吸収後の attachment を出す |
| 圧縮 | ローカルの実履歴では 2.1.285 / 2.1.296 の標本を確認。2.1.299 の保存済み実行ファイルも読み、compact_boundary と isCompactSummary / isVisibleInTranscriptOnly の保持を確認。2.1.299 の圧縮成功の実履歴はこの環境では見つからなかった |
| TUI | リポジトリの実機画面標本 `packages/api/test/samples/terminal-panels/claude.json` と、保存済み 2.1.299 実行ファイルの ModelPicker の見出し・案内・キー名を照合。入力欄の罫線と ❯、作業中の入力欄、番号付きモデル選択と `s` / Enter / Esc を ANSI で描画する。画面全体のピクセル一致や全キー操作は対象外 |
| hook | 既存の台帳を SQLite の `mode=ro&immutable=1` で開き、保存済み input のキーを確認。SessionStart / UserPromptSubmit / Stop / SessionEnd を再現。hook 自体に CLI version がないため、全標本が 2.1.299 由来とは断定しない |
| Codex | `~/.codex/sessions` の 0.160.1 の paginated rollout を読み取り、session_meta、turn_context、response_item の構造を確認。TUI は送信・返事の最小の合成画面。app-server はモデル一覧と使用量の問い合わせだけに応答する |

実機のモデル応答、認証、全 slash command、エージェントの道具実行は再現しない。CLI の版が変わったら、形式の標本と偽 CLI を更新する。形式の出所の不確かさを、製品側の不具合の根拠と取り違えない。

## 補助試験と初回の実行結果

補助試験だけなら次で実行できる。

```sh
node --test scripts/e2e/harness.test.mjs
```

本物の履歴取り込み、SDK / app-server のモデル問い合わせ、xterm の画面解釈、本物の PTY と `session.send`、偽 CLI の hook と台本、隔離とゲートの失敗判定を確認する。PTY の補助試験だけは、sandbox で拒否される `ps` の代わりに既知の直系 PID を使う。ブラウザ E2E にはこの代替を入れない。

初回の対象は、開始時点の `main` と同じ `0b8b925549bcd0136326ee8e57b779d2675b58f3`。作業中に main は `d9395e7` に進んだが、差分は設計書一つだけで製品コードは同一だった。各レポートに HEAD、main、製品ファイルの差分を記録する。

2026-10-15 に listen できる環境で全項目を 2 回続けて流し、同じ結果を得た。1 回は約 4 分 45 秒かかる。

| 結果 | 項目 |
| --- | --- |
| pass | 1-claude、1-codex、2、3、4、5-ui、5-terminal、7、8-root、9-delivered、9-missing、10 |
| fail | 6、8-date、9-bang。いずれも製品側の挙動による |

調査のときは `--only=6,9-bang` のように項目を絞れる。除いた項目は blocked になり、公開の判定は失敗のままになる。

製品コード、本番サービス、既存の smoke、依存と lockfile は変更していない。
