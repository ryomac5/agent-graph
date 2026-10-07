# 新しい provider の調査

調査日は 2026-10-07 である。
対象は Google Antigravity と OpenCode の 2 つである。
目的は、2 つを runner のホストと api の観測に載せる道筋を決めることである。
比べる基準は、既存の Claude と Codex のホストと観測である。

## 要旨

- Antigravity には公式の CLI がある。名前は Antigravity CLI で、命令は `agy` である。
- Gemini CLI の個人向けの提供は 2026-06-18 に終わった。後継が `agy` である。
- Antigravity の外からの口は 3 つある。`agy` の headless と、公式の ACP サーバと、Python の SDK である。
- `agy` の headless は承認に外から答えられない。承認の要る道具は黙って拒否される。
- 承認に答えられる口は、公式の ACP サーバと Python の SDK である。
- Antigravity の規約は、第三者の道具からの利用を違反と定める。組み込みの前に解釈を確かめる。
- OpenCode は MIT の OSS で、HTTP のサーバと TypeScript の SDK を公式に持つ。
- OpenCode は契約の全メソッドに公式の手段を当てられる。
- OpenCode の履歴は 1 つの SQLite にまとまる。本文は JSON の列で読める。
- Antigravity の履歴は会話ごとの SQLite で、中身は公開されない protobuf である。
- 推奨の順は、型の拡張、OpenCode のホスト、OpenCode の観測、Antigravity の順である。

## 調査の条件

- 公式の文書とリポジトリを WebSearch と WebFetch で読んだ。
- 第三者の記事は補助に使い、出典に第三者と明記した。
- 手元の `opencode` は `/opt/homebrew/bin/opencode` にあり、版は 1.18.32 である。
- `opencode` は `--help` と `--version` だけを走らせた。
- 手元に `agy` と `gemini` は無かった。Antigravity は文書だけで調べた。
- OpenCode の表の定義は、GitHub の `packages/core/src/session/sql.ts` で読んだ。
- SDK の型は、GitHub の `packages/sdk/js/src/v2/gen` を /tmp に取って読んだ。
- 実際の会話は起動していない。認証と課金を避けるためである。

## Antigravity

### 製品の正体

#### 事実

- Antigravity は 4 つの面を持つ。2.0 のデスクトップ、CLI、IDE、SDK である。
- 4 つの面は同じエージェントの土台で動くと公式に書かれている。
- CLI は Go で書かれた TUI で、命令の名前は `agy` である。
- 導入は `curl -fsSL https://antigravity.google/cli/install.sh | bash` で行う。
- IDE は 2025 年の終わりに出た VS Code の派生である。
- SDK は Python の `google-antigravity` で、最新は 0.1.20 である。
- 2026-05-19 の Google I/O で、開発者向けの道具は Antigravity に統合された。
- Gemini CLI は個人向けに 2026-06-18 で応答を止めた。
- 企業向けの契約と API キーの利用者には、Gemini CLI が残る。
- Gemini CLI は Apache-2.0 のまま公開が続く。
- `agy` のソースは公開されていない。公開の計画も告知に無い。
- `agy` 自身に ACP の起動の旗は無い。ACP は別の実行ファイルが担う。

#### 推測

- 本人の購読で使う新しい会話は、Gemini CLI ではなく `agy` に移ると見てよい。
- Gemini CLI を載せる価値は、企業の契約を持つ利用者に限られる。

#### 出典

- https://cloud.google.com/blog/topics/developers-practitioners/choosing-your-surface-antigravity-20-antigravity-cli-antigravity-ide-or-antigravity-sdk
- https://github.com/google-antigravity/antigravity-cli
- https://antigravity.google/docs/cli/overview/
- https://github.com/google-gemini/gemini-cli/discussions/27274
- https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx は第三者の記事である。

### 外から動かす口

#### 事実

| 口 | 形 | 承認 | 状態 |
| --- | --- | --- | --- |
| `agy -p` | 標準入出力の NDJSON で、1 つの過程が複数のターンを受ける。 | 外から答えられない。要る道具は黙って拒否される。 | 公式の文書がある。 |
| `agy_acp_server` | ACP を stdio の JSON-RPC で話す別の実行ファイルである。 | `session/request_permission` で答えられる。 | 公式で、ACP の登録簿に Google LLC の名で載る。 |
| Python SDK | `Agent` と `LocalAgentConfig` で Go の土台を動かす。 | `ask_user` の handler が真偽を返す。 | 公式で、Apache-2.0 である。 |

- headless は `-p` か `--print` か `--prompt` で起動する。
- 入力は `--input-format stream-json`、出力は `--output-format stream-json` で選ぶ。
- 両方を stream-json にすると、1 つの過程で会話が続く。
- 入力の 1 行は `{"event":"user","message":{"content":"..."}}` の形である。
- 入力に使えるのは text の塊だけである。他の型は誤りで終わる。
- 応答の待ち時間は `--print-timeout` で決まり、既定は 5 分である。
- `agy_acp_server` の版は 1.3.0 で、許諾は proprietary と登録されている。
- `agy_acp_server` は Zed と JetBrains の公式の統合を支えている。
- SDK の Python 部分は Apache-2.0 で、実行には wheel 同梱の土台の実行ファイルが要る。
- SDK の土台との通信は WebSocket で、中身は JSON にした protobuf である。

#### 推測

- `agy` の過程を runner が抱える形は、Claude の `query` を 1 つ持つ形に近い。
- 承認を答えたいなら、ACP か SDK のどちらかを選ぶことになる。
- SDK は Python なので、runner に Python の子過程を足す必要がある。

#### 出典

- https://antigravity.google/docs/cli/headless/
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://zed.dev/acp/agent/antigravity-acp
- https://github.com/google-antigravity/antigravity-sdk-python
- https://pypi.org/project/google-antigravity/
- https://antigravity.google/docs/sdk/overview/
- http://pi-go.sh/blog/antigravity-acp/ は第三者の記事である。

### 実行中の出来事

#### 事実

- stream-json の出来事は `init` と `step_update` と `result` の 3 種である。
- `init` は 1 回だけ出て、`conversation_id` と道具の一覧と承認の方式を持つ。
- `step_update` は `conversation_id` と `step_index` と `state` と `step_type` を持つ。
- `step_type` は `user_input` と `agent_response` と `tool` と `checkpoint` である。
- `state` は `ACTIVE` と `DONE` の 2 値である。
- 発言の差分は `agent_response` の `text_delta` で届く。
- 道具は `tool_name` と、`tool_info` の名前と引数と出力で届く。
- `result` はターンの終わりで、`status` と `response` と使用量を持つ。
- `status` は SUCCESS、ERROR、CANCELED、INTERRUPTED、INVALID、WAITING、RUNNING である。
- 終了コードは 0 が成功で、1 が一般の誤り、2 が未対応の入力である。
- ACP の経路では、出来事は `session/update` の通知で届く。
- ACP の更新は `agent_message_chunk` と `tool_call` と `tool_call_update` などである。
- ACP の `session/prompt` の応答は止まった理由を返す。値は `end_turn` や `cancelled` などである。

#### 推測

- 会話の ID は `init` の `conversation_id` で確定できる。起動側が先に決める旗は見当たらない。
- ターンの終わりは `result` で、Claude の `result` と同じ扱いにできる。
- INTERRUPTED は SIGINT で生じると書かれている。複数ターンの過程が生き残るかは未確認である。

#### 出典

- https://antigravity.google/docs/cli/headless/
- https://agentclientprotocol.com/protocol/overview
- https://agentclientprotocol.com/protocol/schema

### 承認の口

#### 事実

- headless の既定では、作業場所の中の読み書きは自動で許される。
- 命令の実行は承認が要り、headless では黙って拒否される。
- 拒否されても実行は続き、終了コードは成功のままである。
- 許可の規則は `~/.gemini/antigravity-cli/settings.json` の `permissions` に書く。
- `--dangerously-skip-permissions` はすべての道具を許す。
- `--sandbox` は端末の隔離を有効にする。
- hook の `PreToolUse` は `allow` と `deny` と `ask` と `force_ask` を返せる。
- `agy_acp_server` は命令の前に `session/request_permission` を送る。
- ACP の選択肢は `allow_once` と `allow_always` と `reject_once` と `reject_always` である。
- SDK は `deny` と `allow` と `ask_user` の方針を持つ。
- `ask_user` の handler は道具の呼び出しを受け、真偽を返す。

#### 推測

- `PreToolUse` の hook から runner へ問い合わせ、答えを待つ形は作れる見込みがある。
- ただし hook の待ち時間の上限は文書に無く、未確認である。
- 第三者の改修版は、ACP の承認待ちで会話が止まる不具合を直している。公式の版で再現するかは未確認である。

#### 出典

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/hooks/
- https://antigravity.google/docs/sdk/policies/
- https://github.com/littlebearapps/untether/issues/982 は第三者の記録である。
- https://github.com/simonepri/refined-antigravity-acp は第三者の改修版である。

### 再開と分岐

#### 事実

- 再開は `--conversation <ID>` で行い、直近の再開は `-c` で行う。
- 会話の履歴は作業ディレクトリごとに分けられる。
- 分岐は対話の `/fork` で行い、別名は `/branch` である。
- 分岐は会話だけを複製し、手元の Git の状態は複製しない。
- ACP の経路は `session/load` と `session/resume` と `session/list` を持つ。
- SDK は `conversation_id` と `save_dir` を渡すと前の会話を戻す。
- SDK の `conversation_id` は 32 文字以上で、英数字とハイフンに限る。

#### 推測

- headless の旗に分岐は見当たらない。外から分岐するには ACP か SDK の確認が要る。
- ACP の `session/fork` は仕様では不安定の扱いで、`agy_acp_server` の対応は未確認である。

#### 出典

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/conversations/
- https://antigravity.google/docs/sdk/lifecycle/
- https://github.com/littlebearapps/untether/issues/982 は第三者の記録である。

### 子のエージェント

#### 事実

- 親は `invoke_subagent` の道具で子を起こす。
- 子は自分の会話 ID を持ち、親の履歴を引き継がない。
- エージェント同士は会話 ID を宛先にして伝言を送れる。
- 子の作業場所は、親と共有するか、Git の worktree に分けるかを選べる。
- `/teamwork-preview` は複数の役割の子を組にして動かす。
- SDK の子は、親の権限と道具を継ぐ動的な子と、設定で決める静的な子がある。

#### 推測

- stream-json に子の出来事が載るかは文書に無く、未確認である。
- 親の `tool` の段に `invoke_subagent` が現れれば、関係の根拠にできる見込みがある。
- 第三者の観察では、会話の要約の索引に `parent_conversation_id` と `nesting_depth` がある。

#### 出典

- https://antigravity.google/docs/subagents/
- https://antigravity.google/docs/sdk/subagents/
- https://github.com/tenequm/pond/issues/201 は第三者の観察である。

### 履歴の置き場

#### 事実

- `agy` の利用者データの場所は `~/.gemini/antigravity-cli` である。
- hook の設定は `.agents/hooks.json` か `~/.gemini/config/hooks.json` に置く。
- hook は `conversationId` と `transcriptPath` と `modelName` を受け取る。
- hook の出来事は PreToolUse、PostToolUse、PreInvocation、PostInvocation、Stop の 5 種である。

#### 第三者の観察

- 会話ごとに `conversations/<uuid>.db` の SQLite がある。
- `steps` の表の `step_payload` は protobuf で、公開の定義は無い。
- 表示用の写しが `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` にある。
- 写しの行は `step_index` と `type` と `source` と `status` と `created_at` を持つ。
- 入力の記録が `history.jsonl` にあり、`conversationId` を持つ行がある。
- `implicit/<uuid>.pb` は暗号化されたように見え、読めない。
- SQLite の会話は 1.0.9 から、観察の最新は 1.2.1 である。

#### 推測

- 外の端末の会話は、hook と JSONL の写しで観測できる見込みがある。
- 写しは再生成されると書かれており、追記だけの前提が成り立つかは未確認である。
- protobuf の本体を読むのは、形式が変わったときの壊れ方が大きく勧めない。
- デスクトップと IDE の会話の置き場が CLI と同じかは未確認である。

#### 出典

- https://antigravity.google/docs/hooks/
- https://agentgrep.org/backends/antigravity-cli/ は第三者の観察である。
- https://github.com/tenequm/pond/issues/201 は第三者の観察である。
- https://github.com/google-antigravity/antigravity-cli/issues/1045 は内部の SQLite に頼る回避策の記録である。

### モデルと構造化出力

#### 事実

- モデルは `--model` で選び、例は `gemini-3.8-flash-medium` である。
- 推論の強さは `--effort` で選び、値は `low` と `medium` と `high` である。
- 構造化出力は `--json-schema` に文字列かファイルを渡す。
- 結果は `structured_output` の欄に入る。
- ACP の経路では、モデルは `session/set_config_option` で選ぶ。
- SDK は Pydantic の型で構造化出力を検証する。
- SDK の認証は `GEMINI_API_KEY` か Vertex の資格である。

#### 推測

- モデルの一覧を取る headless の命令は見当たらない。ACP の設定の選択肢から取るのが近い。
- SDK は本人の購読ではなく API キーで動く前提と読める。

#### 出典

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/sdk/overview/
- https://github.com/littlebearapps/untether/issues/982 は第三者の記録である。

### ライセンスと制約

#### 事実

- `agy` と `agy_acp_server` は proprietary である。
- SDK の Python 部分は Apache-2.0 である。
- 規約は、第三者の道具で本サービスに触れることを違反と定める。
- 規約の例は、Antigravity の OAuth を OpenClaw で使うことである。
- `agy` のログインは端末の資格の保管庫を使い、無ければ Google のログインに進む。
- `agy_acp_server` は `agy` のログインを継がず、別にログインする。
- `agy_acp_server` の起動は 8 秒から 25 秒かかり、容量は 1GB を超えると報告がある。

#### 推測

- 公式の `agy` を子として起動する形が違反に当たるかは、文言からは決まらない。
- ACP サーバは第三者の編集器のための公式の口であり、最も擁護しやすい経路である。
- SDK に API キーを渡す形は、規約の論点が最も少ない。
- 規約違反で利用を止められたという報告がある。組み込む前に人の判断が要る。

#### 出典

- https://antigravity.google/terms/
- https://github.com/google-antigravity/antigravity-cli
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- http://pi-go.sh/blog/antigravity-acp/ は第三者の記事である。
- https://discuss.ai.google.dev/t/appeal-request-agy-this-service-has-been-disabled-in-this-account-for-violation-of-terms-of-service/172309 は利用者の報告である。

## OpenCode

### 製品の正体

#### 事実

- OpenCode は MIT の OSS の符号化エージェントで、開発元は Anomaly である。
- リポジトリは `anomalyco/opencode` で、既定の枝は `dev` である。
- TUI と headless の実行と HTTP サーバと ACP サーバを 1 つの実行ファイルが持つ。
- 手元の版は 1.18.32 で、ACP の登録簿の版は 1.18.35 である。
- モデルの提供元を選ばず、`provider/model` の形でモデルを指す。

#### 出典

- https://github.com/anomalyco/opencode
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://opencode.ai/docs/models/

### 外から動かす口

#### 事実

| 口 | 形 | 承認 |
| --- | --- | --- |
| `opencode serve` | HTTP の API と SSE の出来事を持つ常駐である。 | `permission.asked` を受け、HTTP で答える。 |
| `@opencode-ai/sdk` | TypeScript の SDK で、サーバの起動と接続を持つ。 | SDK の関数で答える。 |
| `opencode run` | 1 回の実行で、`--format json` で出来事を流す。 | `--auto` で一括で許すだけである。 |
| `opencode acp` | ACP を stdio で話す。 | ACP の `session/request_permission` で答える。 |

- `serve` は `--port` と `--hostname` を取り、既定の待ち受けは 127.0.0.1 である。
- `OPENCODE_SERVER_PASSWORD` を渡すと、Basic 認証で守られる。
- OpenAPI の定義は `/doc` で配られる。
- 1 つのサーバで、要求ごとに `directory` を指して複数の作業場所を扱える。
- SDK の `createOpencode` はサーバを起こし、既定の待ちは 5 秒である。
- `opencode run --attach <url>` は動いているサーバに相乗りできる。

#### 推測

- runner は `opencode serve` を子として起こし、SDK の client で結ぶのが素直である。
- この形は Codex の app-server を 1 つ持つ形に近い。

#### 出典

- https://opencode.ai/docs/server/
- https://opencode.ai/docs/sdk/
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/acp/

### 実行中の出来事

#### 事実

- 出来事は SSE の `/event` と `/global/event` で届く。
- 会話の状態は `session.status` で、値は `idle` と `busy` と `retry` である。
- `session.idle` はターンの終わりを知らせる。
- 文字の差分は `message.part.delta` で、会話と発言と部品の ID を持つ。
- 旧い形では `message.part.updated` が `delta` を持つ。
- 部品の種類は text、reasoning、tool、step-start、step-finish、patch、subtask などである。
- 発言の確定は `message.updated` で、完了の時刻と費用と使用量を持つ。
- 誤りは `session.error` で届く。
- 会話の作成は `session.created` で、会話の情報が `parentID` を持つ。
- 会話の ID は `POST /session` の応答で確定する。

#### 推測

- 発言の事実は、`message.updated` で完了の時刻が付いた時点で追記するのがよい。
- 道具の呼び出しは、tool の部品の状態の変化から取れる見込みがある。

#### 出典

- https://opencode.ai/docs/server/
- https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts

### 承認の口

#### 事実

- 許可は道具ごとに `allow` と `ask` と `deny` で決める。
- 既定はほとんど `allow` で、`doom_loop` と `external_directory` だけが `ask` である。
- `.env` の読み込みは既定で拒否される。
- 問い合わせは `permission.asked` で届き、ID と会話と道具と対象の型を持つ。
- 答えは `POST /permission/{requestID}/reply` で返す。
- 答えの値は `once` と `always` と `reject` で、拒否の文言を添えられる。
- 答えた結果は `permission.replied` で届く。
- 利用者への質問は `question.asked` で届き、`/question/{requestID}/reply` で答える。
- 許可の設定は `OPENCODE_PERMISSION` の環境変数で丸ごと渡せる。

#### 推測

- 既定のままでは承認が起きない。管理する実行では `edit` と `bash` を `ask` にして渡す必要がある。
- `question.asked` は `waiting_input` に写せる。

#### 出典

- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/cli/
- https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/sdk.gen.ts

### 再開と分岐

#### 事実

- 再開は、既存の会話 ID に新しい発言を送るだけで成り立つ。
- CLI の再開は `--session <ID>` か `--continue` で行う。
- 分岐は `POST /session/{id}/fork` で、発言の ID で区切りを選べる。
- CLI でも `--fork` を `--session` と組み合わせて分岐できる。
- 発言の巻き戻しは `revert` と `unrevert` で行う。
- 中断は `POST /session/{id}/abort` で行う。

#### 出典

- https://opencode.ai/docs/server/
- https://opencode.ai/docs/cli/

### 子のエージェント

#### 事実

- 主のエージェントは Task の道具で子のエージェントを起こす。
- 子は子の会話を作り、会話の表の `parent_id` が親を指す。
- `GET /session/{id}/children` で子の一覧を得られる。
- 呼べる子は `permission.task` の型で制限できる。
- 子は、設定が無ければ親のモデルを継ぐ。

#### 推測

- `session.created` の `parentID` を、`delegated` の関係の確かな根拠にできる。
- Codex と違い、子の関係が子の作成の時点で分かる見込みが高い。

#### 出典

- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/server/
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts

### 履歴の置き場

#### 事実

- 1.14 以降の履歴は `~/.local/share/opencode/opencode.db` の SQLite にある。
- 手元にも `opencode.db` と `-wal` と `-shm` があった。
- 版の通り道ごとに別の名のファイルになることがある。例は `opencode-prod.db` である。
- 実際の場所は `opencode db path` で分かる。
- `session` の表は `parent_id` と `directory` と `title` とモデルと使用量を持つ。
- `message` の表と `part` の表は、本文を JSON の `data` の列に持つ。
- 旧い版の履歴は `storage/` の下の JSON で、移行の漏れが報告されている。
- 書き出しは `opencode export` で、秘密を伏せる `--sanitize` がある。
- プラグインは全体の `~/.config/opencode/plugins/` か作業場所の `.opencode/plugins/` に置く。
- プラグインは会話と発言と許可の出来事を受けられる。

#### 推測

- 外の端末の会話は、SQLite を読み取り専用で開けば取り込める。
- `node:sqlite` で読めるため、core の依存の方針に収まる。
- 実行中かどうかは表に残らない見込みが高く、外の会話の生死は不明になりやすい。
- 全体のプラグインを置けば、Claude の hook と同じ即時の観測ができる見込みがある。

#### 出典

- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts
- https://github.com/ccusage/ccusage/issues/966 は第三者の記録である。
- https://github.com/anomalyco/opencode/issues/21790
- https://github.com/anomalyco/opencode/issues/34445
- https://opencode.ai/docs/plugins/

### モデルと構造化出力

#### 事実

- 発言の送信ごとに `model` を `providerID` と `modelID` で指定できる。
- 推論の強さは `variant` で選び、値は提供元ごとに違う。
- Anthropic は `high` と `max`、OpenAI は `none` から `xhigh`、Google は `low` と `high` である。
- 一覧は `opencode models` か、サーバの提供元の一覧で取れる。
- 構造化出力は送信の `format` に `json_schema` と型を渡す。
- 検証に落ちたときの再試行の回数を `retryCount` で決められる。
- 発言の送信は添付の部品を受け付ける。

#### 出典

- https://opencode.ai/docs/models/
- https://opencode.ai/docs/sdk/
- https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/sdk.gen.ts

### ライセンスと制約

#### 事実

- 本体と SDK は MIT である。
- 認証は提供元ごとに持ち、`opencode providers` で管理する。
- 既存の調査の通り、Claude の購読を第三者の製品で使うことは認められていない。

#### 推測

- OpenCode で Claude のモデルを使うときは、API キーが前提になる。
- 組み込みの論点は、許諾よりも提供元ごとの規約の方が大きい。

#### 出典

- https://github.com/anomalyco/opencode
- https://code.claude.com/docs/en/legal-and-compliance

## 契約への対応

### AgentHost の対応表

| メソッド | OpenCode | Antigravity の ACP | Antigravity の `agy -p` |
| --- | --- | --- | --- |
| `start` | `POST /session` の後に `prompt_async` を送る。 | `session/new` の後に `session/prompt` を送る。 | 過程を起こし、stream-json の入力を 1 行送る。 |
| `resume` | 既存の会話 ID へ `prompt_async` を送る。 | `session/load` か `session/resume` を使う。 | `--conversation <ID>` で過程を起こす。 |
| `fork` | `POST /session/{id}/fork` を使う。 | `session/fork` は不安定で、対応は未確認である。 | 当てる手段が無い。 |
| `send` | `prompt_async` を送る。 | `session/prompt` を送る。 | 入力の行を足す。 |
| `interrupt` | `POST /session/{id}/abort` を使う。 | `session/cancel` を送る。 | SIGINT を送る。過程が残るかは未確認である。 |
| `answer` | `/permission/{id}/reply` に `once` などを返す。 | `request_permission` の応答で選択肢を返す。 | 当てる手段が無い。hook の経由は未確認である。 |
| `setModel` | 次の送信の `model` と `variant` で替える。 | `session/set_config_option` で替える。 | 過程を起こし直すしかない。 |
| `close` | 実行を閉じ、残りが無ければサーバを止める。 | 過程を止める。 | 標準入力を閉じる。 |
| `listModels` | 提供元の一覧から作る。 | 設定の選択肢から作る。 | 当てる手段が無い。 |
| `capabilities` | すべて真にできる見込みである。 | fork と delta の扱いを縮退として返す。 | approvals と fork と setModel を偽にする。 |

- 状態の写しは、OpenCode なら `busy` を `running`、`idle` を `idle` とする。
- OpenCode の `permission.asked` は `waiting_approval`、`question.asked` は `waiting_input` とする。
- Antigravity の `result` の `status` は、INTERRUPTED と CANCELED を中断として扱う。
- `outputSchema` は、OpenCode の `format` と `agy` の `--json-schema` に当てられる。
- 添付は OpenCode だけが受けられる。`agy` の入力は text に限られる。

### 観測の対応表

| 項目 | OpenCode | Antigravity |
| --- | --- | --- |
| 読む手段 | `opencode.db` を読み取り専用で開く。 | hook と `transcript_full.jsonl` を読む。 |
| 形式の公開 | 表の定義は OSS で読める。本文は JSON の列である。 | 公式の文書は無い。本体の SQLite は protobuf である。 |
| 会話の同一性 | `session.id` で決まる。 | 会話の UUID で決まる。 |
| 親子 | `session.parent_id` で確かに取れる。 | 要約の索引の `parent_conversation_id` で、第三者の観察である。 |
| 分岐 | 分岐元の欄は未確認である。 | 未確認である。 |
| 生死 | 表に残らない。プラグインの出来事か不明で扱う。 | hook の `Stop` を根拠にできる。 |
| 即時の経路 | 全体のプラグインで出来事を送れる見込みである。 | 全体の `hooks.json` で送れる。 |
| 読みの位置 | 行の ID と更新の時刻で持つ。今の `FileCursor` は使えない。 | JSONL は今の `FileCursor` が使える。書き直しへの備えが要る。 |
| 対応の宣言 | 表の版と `opencode` の版で固定する。 | `agy` の版で固定し、未知の形式は未対応とする。 |

### 型と契約の拡張

今の provider は `claude` と `codex` の 2 つに固定されている。
固定の箇所は次の通りである。

| 箇所 | 今の形 | 広げ方 |
| --- | --- | --- |
| `packages/core/src/ledger/facts.ts` の `Provider` | 2 値の合併型である。 | 定数の配列から型を作り、2 値を足す。 |
| `packages/core/src/ledger/facts.ts` の `SOURCES` | 出所が provider ごとに並ぶ。 | `host-opencode` と `db-opencode` と `host-antigravity` などを足す。 |
| `packages/core/src/delegate/types.ts` の `Executor` | 2 値である。 | `Provider` と同じ定数に揃える。 |
| `packages/core/src/exec/types.ts` と `packages/core/src/events.ts` | 実行者を 2 値で持つ。 | 同じ定数に揃える。 |
| `packages/core/src/assign/policy.ts` | 実行者と系統を 2 値で検査する。 | 系統に `google` を足す。系統は実行者でなくモデルから決める。 |
| `packages/core/src/intake/index.ts` の `readOrigin` | 環境変数の 2 種で起動元を決める。 | provider ごとの読み方の表に替える。 |
| `packages/runner/src/planner.ts` | 起動元の検査と環境変数が 2 値である。 | 同じ表を使う。 |
| `packages/runner/src/runtime.ts` | 95 行で 2 値を検査し、217 行で 2 つのホストを作る。 | 登録されたホストの一覧で検査する。 |
| `packages/runner/src/runtime.ts` の 196 行 | Claude の分岐だけ関係を自分で書く。 | ホストが関係を出すかを能力で示す。 |
| `packages/runner/src/recovery.ts` の 92 行 | Claude だけを再起動後の再開の対象にする。 | 再参加できるかを能力で示す。 |
| `packages/runner/src/cli.ts` | `--claude-integrations` だけを持つ。 | provider ごとの設定の束に替える。 |
| `packages/core/src/store/store.ts` の 261 行 | 旧い表の client を 3 値で持つ。 | 旧い経路のため、触らずに残すか同じ定数に揃える。 |
| 画面の `CreateTaskForm.tsx` | 選択肢と系統の対応が 2 値である。 | 能力と系統を api から受けて並べる。 |

契約そのものに足すものは次の通りである。

- `HostCapabilities` に `outputSchema` と `attachments` と `subagents` を足す。
- `HostCapabilities` に、runner の再起動後に再参加できるかの印を足す。
- `ModelChoice` の `effort` は、provider ごとに許す値を `listModels` で返す。
- OpenCode のモデルは `provider/model` の形の文字列で持つ。`effort` は `variant` に写す。
- `IntegrationMode` は Claude に固有なので、ホストごとの起動の設定へ移す。
- 承認の事実は、ホストが示した選択肢をそのまま持つ。OpenCode と ACP で値が違うためである。
- `Decision` は文字列のままでよい。画面は選択肢の一覧から選ばせる。

### 識別子の受け渡しの注意

- 今の委譲の受付は、環境変数で起動元と実行の識別子を受ける。
- OpenCode のサーバを 1 つで共有すると、実行ごとの環境変数を渡せない。
- 最初は実行ごとにサーバを 1 つ起こす形がよい。起動の遅さは計測で確かめる。
- OpenCode と `agy` が道具や MCP に会話の ID を渡すかは未確認である。
- 渡さない場合は、MCP の中継の接続に実行の識別子を載せる方式が要る。

## 推奨の順番

| 順 | 作業 | 大きさ | 理由 |
| --- | --- | --- | --- |
| 1 | provider の型を定数に揃え、能力の印を足す | 中 | 13 か所ほどに散る。後の 3 つの作業の前提になる。 |
| 2 | OpenCode のホストを作る | 中 | 契約の全メソッドに公式の手段がある。既存の 2 つのホストと同じ程度の量である。 |
| 3 | OpenCode の実機の確認を作る | 小 | 既存の `e2e-hosts.ts` と同じ段で、承認と中断と再開と分岐を通す。 |
| 4 | OpenCode の観測を作る | 中 | SQLite の読みの位置を新しく作る。表の定義は OSS で固定できる。 |
| 5 | Antigravity の規約の判断を人に仰ぐ | 小 | 公式の `agy` を子として起こす形が違反に当たるかが決まらない。 |
| 6 | Antigravity の小さな実機の確認を行う | 小 | ACP サーバの承認と再開と分岐と起動の時間を確かめる。 |
| 7 | 汎用の ACP のホストを作り、Antigravity を載せる | 大 | 出来事の写しと承認の選択肢を ACP の型で一般化する。OpenCode の予備にもなる。 |
| 8 | Antigravity の観測を作る | 中 | hook と JSONL を使う。形式は非公式なので対応の版を狭く宣言する。 |

- 5 で ACP サーバが使えないと決まったら、7 は `agy -p` の縮退のホストに替える。
- 縮退のホストは承認と分岐と途中のモデル変更を持たない。無人実行の向けに限るのがよい。
- Python の SDK は API キーが前提で、Python の子過程も要る。今の方針では最後の選択肢にする。
- 設計書の決定事項 1 は 2 つの土台だけを定めている。載せる前に設計書へ新しい段を足す。

## 未確認の事項

- `agy` の複数ターンの過程が SIGINT の後も生き残るか。
- `agy` の `PreToolUse` の hook が、答えを長く待てるか。
- `agy_acp_server` が `session/fork` と使用量の通知に対応するか。
- `agy` のデスクトップと IDE の会話が CLI と同じ場所に残るか。
- `transcript_full.jsonl` が追記だけで書かれるか。
- OpenCode の分岐で、分岐元が表のどこに残るか。
- OpenCode が道具や MCP の子に会話の ID を渡すか。
- OpenCode のサーバの起動にかかる時間と、実行ごとに起こすときの重さ。

## 調査の副作用

- `opencode` の `--help` と `--version` を走らせた。会話と認証には触れていない。
- OpenCode の SDK の生成の型を /tmp に 1 つ取得し、読んだ後に消した。
- リポジトリに書いたのはこの文書だけである。
