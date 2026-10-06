# Claude Agent SDK の常駐試作

## 手順

事前調査と既存の設計書に基づく独立した試作を使って一時領域から会話の実機検証を行った。
今回の修正では前回の実測記録を保存したまま同じ試作を無人実行の隔離環境で再実行した。

| 項目 | 指定値 |
| --- | --- |
| 実施日 | 2026-10-07 JST |
| Node | v24.6.0 |
| SDK | @anthropic-ai/claude-agent-sdk 0.3.291 |
| 配置 | `spikes/claude-sdk/` |
| 初期モデル | `haiku` |
| 切替先 | `sonnet` |
| 設定の入力 | `settingSources: []` |
| hook | `settings: { disableAllHooks: true }` |
| 道具 | `Write` のみ |
| 承認方式 | `permissionMode: 'default'` |
| 応答の制限時間 | 90 秒 |
| 中断の条件 | テキスト差分が 120 文字に達した時点 |
| 終了待機 | 5 秒後に残存する自分の子だけを強制終了 |
| 今回の sandbox | `workspace-write`、通信制限あり |
| 今回の権限昇格 | `approval_policy: never` |

```sh
npx --yes pnpm@10 --dir spikes/claude-sdk --ignore-workspace install --frozen-lockfile
node spikes/claude-sdk/run.mjs > /tmp/claude-sdk-spike-results.jsonl
```

再開後に会話の記憶を確認する質問には初期入力で毎回生成して渡す識別文字列を含めない。
ファイル承認では一時領域にある指定パスと指定本文の両方に一致した書き込みだけを許可する。

| 段 | 実装した操作 | 確認方法 |
| --- | --- | --- |
| 1 | `query` に非同期入力を渡す | `init.session_id` と READY の応答 |
| 2 | 出力を非同期に反復する | テキスト差分と道具と状態の JSON 行 |
| 3 | 次の入力でファイル作成を頼む | `canUseTool` の実行回数と実ファイルの本文 |
| 4 | 出力中に `interrupt` を呼ぶ | 制御応答と result と 1 秒間の出力停止 |
| 5 | `close` 後に `resume` を指定する | 同一 session_id と識別文字列の一致 |
| 6 | 次の入力前に `setModel('sonnet')` を呼ぶ | assistant の実モデル名 |

今回の実行権限では隔離制限を変更できないため許可のある環境での再実行は実施できなかった。
人の対話セッションで再検証するときも既存の購読ログインを使って上記の命令を実行する。

## 結果

今回の再実行でも通常の応答が始まる前に既存の認証情報を取得できない状態で処理が終了した。
前回の報告にあった利用者自身が未ログインだという判断はレビューの観測に基づき撤回する。

| 記録 | 保存先 |
| --- | --- |
| 前回の最終実行 | [results.jsonl](../../../spikes/claude-sdk/results.jsonl) |
| 今回の再実行と例外全文 | [results-recheck.jsonl](../../../spikes/claude-sdk/results-recheck.jsonl) |
| 今回の認証状態の選択項目 | [auth-recheck.json](../../../spikes/claude-sdk/auth-recheck.json) |

### 認証と通信の切り分け

| 観測元 | 操作 | 確認された値または現象 |
| --- | --- | --- |
| ユーザー提供のレビュー | `claude auth status` | ログイン済み。claude.ai の購読を使用 |
| ユーザー提供のレビュー | 通常 CLI の単発起動 | sandbox が `api.anthropic.com` への通信を拒否 |
| 今回の隔離環境 | `claude auth status` | 終了コード `1`、`loggedIn: false`、`authMethod: none`、`apiProvider: firstParty` |
| 今回の隔離環境 | SDK の `accountInfo` | `tokenSource: none`、`apiProvider: firstParty` |
| 今回の隔離環境 | 認証情報を付けない HTTPS 接続 | curl の終了コード `6`。接続先の名前解決に失敗 |

レビューの認証状態と通信拒否はユーザー提供の観測であり今回の再実行で取得した値ではない。
レビューには生の出力全文が含まれていないため未提供の項目や拒否文を実測値として補わない。

今回の通信確認で実行した命令と得られたエラーの全文は次の二つのブロックにそれぞれ示す。

```sh
curl --head --connect-timeout 5 --max-time 10 https://api.anthropic.com
```

```text
curl: (6) Could not resolve host: api.anthropic.com
```

認証情報を参照できない隔離環境で得た認証状態だけを使って利用者のログイン状態は判定できない。
原因は隔離による通信拒否と認証情報の参照不可であり利用者の購読ログインの欠如ではない。
認証情報を参照できない原因としてキーチェーンの制限が疑われるが拒否の直接記録は未取得である。
今回の通信確認だけでは名前解決の失敗と接続後の通信拒否を同一の事象として断定できない。

### 各段の実測

| 項目 | 今回の再実行の実測値 |
| --- | --- |
| 開始時刻 | `2026-10-06T17:09:19.820Z` |
| cwd | `/var/folders/07/wtfd17vj0pbfk26xvgyv73r00000gn/T/claude-sdk-spike-QbtUNI` |
| 子 PID | `31311` |
| session_id | `c6ec51e1-dc05-482d-ac69-9002aaa77d2e` |
| init.model | `claude-haiku-4-5-20251001` |
| init.apiKeySource | `none` |
| accountInfo.tokenSource | `none` |
| accountInfo.apiProvider | `firstParty` |
| system.status | `requesting` |
| assistant.model | `<synthetic>` |
| assistant.text | `Not logged in · Please run /login` |
| result.subtype | `success` |
| result.is_error | `true` |
| result.stop_reason | `stop_sequence` |
| result.num_turns | `1` |
| result.total_cost_usd | `0` |
| 子の終了コード | `1` |
| 試作の終了コード | `1` |
| all_processes_exited | `true` |

SDK から受け取った本文と結果の双方に現れた認証エラーの全文は次に示す一行と一致した。

```text
Not logged in · Please run /login
```

| 段 | 実際の結果 | 原因と限界 |
| --- | --- | --- |
| 1 | session_id を取得したが READY は未取得 | 隔離内で既存の認証情報を取得できず上記エラー |
| 2 | エラー本文と `status: requesting` を受信 | 専用チェックは `skipped_stage: 2`。文字差分と道具と `session_state_changed` は未観測 |
| 3 | `skipped_stage: 3` | 段 1 の失敗で未実行。固有エラーなし |
| 4 | `skipped_stage: 4` | 段 1 の失敗で未実行。固有エラーなし |
| 5 | `skipped_stage: 5` | 段 1 の失敗で未実行。固有エラーなし |
| 6 | `skipped_stage: 6` | 段 1 の失敗で未実行。固有エラーなし |

段二の専用チェックに進めなかった今回の実行でも起動失敗までの出力監視は実際に動作した。
今回の試行も段一で終了したため段二から段六の正常な動作を裏付ける実測値は得られていない。

### 終了と変更範囲

| 項目 | 記録 |
| --- | --- |
| 前回の三試行 | PID `14561`、`16267`、`17179` が code `1` で終了 |
| 今回の試行 | PID `31311` が code `1` で終了。`all_processes_exited: true` |
| 前回の最終試行の設定比較 | `~/.claude/settings.json` と `~/.claude.json` が前後一致 |
| 前回の二回目の補助比較 | 上記二ファイルの組に不一致。変更主体は未特定 |
| 設定の手動編集 | なし |
| 新規 API キー | 作成なし |
| 秘密情報 | トークン値の取得や出力なし |
| SDK の依存 | 試作内の package.json と pnpm-lock.yaml のみ |
| node_modules の除外 | 既存のリポジトリ直下の `.gitignore` を使用 |
| 今回の修正 | 報告書の訂正と再実行の記録追加 |
| 試作コード | 六段の実装を維持。今回のコード変更なし |

前回の補助比較で設定群に不一致が出たことから全試行で設定が不変だったとは断定できない。

| 受け入れ検査 | 結果 |
| --- | --- |
| `test -s spikes/claude-sdk/run.mjs` | 合格 |
| `test -s docs/agents/research/2026-10-07-claude-sdk-spike.md` | 合格 |
| `grep -qxF '## 結果' docs/agents/research/2026-10-07-claude-sdk-spike.md` | 合格 |
| `grep -qxF '## 結論' docs/agents/research/2026-10-07-claude-sdk-spike.md` | 合格 |
| `node --check spikes/claude-sdk/run.mjs` | 合格 |
| `git diff --check` | 合格 |

## 結論

正常な会話が始まらなかった今回の試験では常駐の土台として採用できるという実証は未完了である。
今回の失敗は隔離環境の制約によるため購読ログインでは動作しないという結論は導けない。
常駐の実行主体には既存の購読認証を参照できる権限と認証先への通信を許可する設定が必要である。

| 再検証に必要な条件 | 具体的な対応 |
| --- | --- |
| API への通信 | sandbox で `api.anthropic.com` の名前解決と HTTPS 通信を許可 |
| 既存認証の参照 | 同じ利用者の keychain を Claude の子プロセスから参照可能にする |
| 会話の保存と再開 | `~/.claude/projects` への会話記録の書き込みと読み取りを許可 |
| 制限を変更できない場合 | 利用者の対話セッションで同じ `run.mjs` を実行 |
| 成功の判定 | 六段のチェック成功と最後の `all_processes_exited: true` を確認 |

通信許可の変更は実行主体の管理者が行い代替の対話実行でも利用者の既存設定は書き換えない。
新しい鍵を作成して認証方式を変える必要性は既存の購読認証を参照できる環境で判断する。

| 採用時の API | 常駐側の使い方 | 今回の検証 |
| --- | --- | --- |
| `query` と非同期入力 | 会話ごとに一つ保持して追加入力 | 起動と失敗出力のみ確認 |
| `session_id` | 常駐内の会話 ID に対応付け | 取得を確認 |
| `includePartialMessages` | 文字差分をブラウザへ転送 | 未検証 |
| `canUseTool` | 承認要求をブラウザへ渡して回答を待つ | 未検証 |
| `interrupt` | 出力中のターンを中断 | 未検証 |
| `close` | 所有する子の終了を待つ | 終了を確認 |
| `resume` | 保存した同じ ID で会話を再開 | 未検証 |
| `setModel` | 保持中の会話の次ターンからモデルを変更 | 未検証 |

今回のような起動失敗の見逃しを防ぐ結果判定には is_error の値の確認が必須である。
