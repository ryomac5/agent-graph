# Claude Agent SDK の常駐試作の再実行

## 手順

最初の実行と同じ試作を外部と通信できる環境で動かし直した。
認証には利用者の claude.ai 購読のログインをそのまま使った。
API キーは作っていない。

| 項目 | 値 |
| --- | --- |
| 実施日 | 2026-10-07 JST |
| 取得元 | `agent-graph/v2-foundation-01M492FQ00QEBFA5E9X2KJTCED/integration` の `spikes/claude-sdk/` |
| 実行場所 | `/tmp/claude-sdk-rerun-Vgin`。リポジトリの外に写した |
| Node | v24.6.0 |
| SDK | `@anthropic-ai/claude-agent-sdk` 0.3.291 |
| 依存の導入 | pnpm 10.34.6 で lockfile どおりに導入 |
| 初期モデル | `haiku` |
| 切替先 | `sonnet` |

```sh
npx --yes pnpm@10 --dir /tmp/claude-sdk-rerun-Vgin --ignore-workspace install --frozen-lockfile
node run.mjs > results.jsonl
```

`run.mjs` は一切直していない。
6 段はすべて 1 回の実行で通った。
補助の確かめとして小さなスクリプトを 2 つ一時ディレクトリに足した。

| 補助 | 目的 |
| --- | --- |
| `auth.mjs` | init と `accountInfo` の項目名と認証の値を確かめる |
| `states.mjs` | `session_state_changed` を出す条件を確かめる |

`claude auth status` も実行し、購読のログインを確かめた。
メールや組織の値は伏せて読み、報告書にも書かない。

## 結果

試作の最後の行は `"passed":true` と `"all_processes_exited":true` だった。
試作の終了コードは 0 だった。
開始から完了までは約 16.5 秒だった。

| 段 | 確認の結果 | 実際に出た値 |
| --- | --- | --- |
| 1 開始 | 合格 | session_id は `8df34a6b-5ea4-4409-999a-90fa342f28bf`。応答は `READY` |
| 2 出力の流れ | 合格 | 文字差分は 41 回で計 5 文字。道具の呼び出しと状態も届いた |
| 3 承認 | 合格 | `canUseTool` は 1 回呼ばれ allow を返した。ファイル本文は指定と一致 |
| 4 中断 | 合格 | 差分 120 文字で中断した。1 秒間は新しい出力がなかった |
| 5 再開 | 合格 | 同じ session_id で再開した。合言葉を正しく答えた |
| 6 切替 | 合格 | `setModel('sonnet')` の後は `claude-sonnet-5-5` が答えた |

### 認証

init の `apiKeySource` は `none` だった。
API キーを使わずに会話が成り立ったことを示す。
`accountInfo` の値は次のとおりだった。

| 項目 | 値 |
| --- | --- |
| `subscriptionType` | `Claude Team` |
| `apiProvider` | `firstParty` |
| `email` と `organization` | 値あり。中身は書かない |
| `tokenSource` と `apiKeySource` | 項目そのものが返らなかった |

`claude auth status` は `loggedIn: true` を返した。
`authMethod` は `claude.ai` だった。
`subscriptionType` は `team` だった。
以上から認証は利用者の購読のログインで通ったと判断する。

### 段 1 開始

| 項目 | 値 |
| --- | --- |
| 子の PID | `44700` |
| init.model | `claude-haiku-4-5-20251001` |
| init から結果まで | 約 1.3 秒 |
| result.subtype | `success` |
| result.is_error | `false` |
| result.stop_reason | `end_turn` |
| total_cost_usd | `0.002958` |

### 段 2 出力の流れ

1 ターンの中で届いた種類は次の順だった。
`init` と `status: requesting` が先に来た。
次に `rate_limit_event` と `thinking_tokens` が来た。
`text_delta` が続き、最後に `assistant` と `result` が来た。
段 3 では `tool_call` が届いた後に `user` の道具結果が届いた。

本体の試作では `session_state_changed` が 1 件も届かなかった。
SDK の中を調べると環境変数で出し分けていると分かった。
`states.mjs` で `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` を渡して確かめた。

| 順 | 届いた値 |
| --- | --- |
| 1 | `state: running` |
| 2 | 道具の呼び出しを含む `assistant` |
| 3 | `state: requires_action` |
| 4 | `canUseTool` の呼び出し |
| 5 | `state: running` |
| 6 | `result` |
| 7 | `state: idle` |

`requires_action` は承認待ちの表示にそのまま使える。
`idle` はターンの終わりの確かな合図に使える。

### 段 3 承認

| 項目 | 値 |
| --- | --- |
| 道具の呼び出し ID | `toolu_01MddnrqqHZaDHunKg3n3tg7` |
| `permission_request` | `Write`。対象は指定パスと指定本文 |
| `permission_response` | `allow` |
| 承認の回数 | 1 |
| ファイル本文 | `claude-sdk-spike-ok\n` |
| result | `success`。応答は `WRITTEN`。`num_turns` は 2 |

`states.mjs` では deny を返す場合も確かめた。
deny の文言はモデルに渡り、モデルは作成を断念したと答えた。

### 段 4 中断

| 時刻 | 出来事 |
| --- | --- |
| 17:17:06.167Z | 差分が 120 文字に達し `interrupt()` を呼んだ |
| 17:17:06.171Z | 制御応答 `{"still_queued":[]}` が返った |
| 17:17:06.181Z | result が届いた |

中断の結果は次の値だった。

| 項目 | 値 |
| --- | --- |
| result.subtype | `error_during_execution` |
| result.is_error | `true` |
| result.stop_reason | `null` |
| result.errors | `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null` |

呼んでから結果まで約 14 ミリ秒だった。
中断の結果は `is_error: true` で届く。
常駐側は中断と本物の失敗を分けて扱う必要がある。

### 段 5 再開

`close()` の後に 1 つ目の子 `44700` は終了コード 1 で終わった。
中断の直後に閉じたためと考えるが、原因は確かめていない。
`resume` を付けた 2 つ目の子 `44896` は同じ session_id で始まった。

| 項目 | 値 |
| --- | --- |
| 渡した合言葉 | `memory-d69311ee-ff18-42f1-b7d8-a34c51f1cccc` |
| 再開後の応答 | `memory-d69311ee-ff18-42f1-b7d8-a34c51f1cccc` |
| 再開の起動から init まで | 約 0.27 秒 |
| result.is_error | `false` |

再開後の質問には合言葉を含めていない。
前の内容は会話の記録から読み戻されたと判断する。

### 段 6 モデルの切り替え

`setModel('sonnet')` は会話を開いたまま即座に返った。
次のターンの init.model は `claude-sonnet-5-5` だった。
assistant の model も 2 件とも `claude-sonnet-5-5` だった。
応答は `SWITCHED` で始まり、result は `success` だった。
2 つ目の子 `44896` は終了コード 0 で終わった。

応答の後ろに claude.ai の MCP 連携の認可を促す文が付いた。
対象は Google Calendar、Notion、Slack の 3 つだった。
`settingSources: []` でも購読に紐づく連携が読み込まれると分かる。

### 費用と後始末

`total_cost_usd` の最後の値は `0.025658` だった。
購読での利用なので、この値は請求額ではなく目安である。
試作の後に `pgrep` で SDK の子が残っていないと確かめた。

## 最初の実行との違い

| 項目 | 最初の実行 | 今回 |
| --- | --- | --- |
| 環境 | 外部と通信できない囲いの中 | 外部と通信できる通常の環境 |
| 認証 | 既存のログインを読めなかった | 購読のログインで通った |
| `accountInfo` | `tokenSource: none` | `subscriptionType: Claude Team` |
| 段 1 の応答 | `Not logged in · Please run /login` | `READY` |
| 段 1 の model | `<synthetic>` | `claude-haiku-4-5-20251001` |
| 段 2 から段 6 | すべて未実行 | すべて合格 |
| 終了コード | 1 | 0 |
| `run.mjs` | 変更なし | 変更なし |

`init.apiKeySource` は両方とも `none` だった。
この値だけでは認証が通ったかを判定できない。
判定には `accountInfo.subscriptionType` と result の `is_error` を使う。

最初の実行で失敗した原因は囲いの制約だったと確定した。
利用者の購読のログインに問題はなかった。

## 結論

Claude Agent SDK は常駐の土台に使える。
会話の開始から再開とモデル切替までが購読の認証で動いた。
API キーは要らない。

| API | 常駐側の使い方 |
| --- | --- |
| `query` と非同期入力 | 会話ごとに 1 つ持ち続け、利用者の入力を順に流す |
| `session_id` | init で受け取り、常駐の会話 ID と対応づけて保存する |
| `includePartialMessages` | `text_delta` を画面へそのまま流す |
| `session_state_changed` | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` を渡して受け取る。`idle` をターンの終わりに使う |
| `canUseTool` | 承認要求を画面へ渡し、利用者の答えを待って返す |
| `interrupt` | 出力中のターンを止める。結果は `is_error: true` で届く |
| `close` と `resume` | 放置した会話は閉じる。再び使うときは保存した ID で開き直す |
| `setModel` | 会話を開いたまま次のターンからモデルを変える |
| `accountInfo` | 起動時に `subscriptionType` を見てログイン切れを見つける |

実装に移る前に次の点を決めておく。

| 課題 | 対応の案 |
| --- | --- |
| 中断と失敗の区別 | 常駐側で中断を呼んだ印を持ち、`error_during_execution` と突き合わせる |
| 中断後の閉じ方 | 終了コード 1 が害になるかを確かめる。害がなければ記録だけ残す |
| 購読の MCP 連携 | 常駐の会話に要らなければ読み込まない設定を探す |
| ログイン切れ | `is_error` と `accountInfo` を見て、利用者に再ログインを促す |
| 費用の表示 | `total_cost_usd` は目安として扱い、請求額としては出さない |
