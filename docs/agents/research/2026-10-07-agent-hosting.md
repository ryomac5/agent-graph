# エージェント保持の手段の調査

調査日は 2026-10-07 である。
対象は Claude Agent SDK と Codex app-server の 2 つである。
目的は、コンソールが自らエージェントを起動して持つ形の土台を決めることである。

## 要旨

- 2 つの手段とも、自分で起動した会話なら推測なしで状態が取れる。
- 会話の同一性、生死、出力、承認、中断は、どちらも公式の型で得られる。
- 外で動く会話は、どちらの手段でも制御下に置けない。
- 端末の Claude Code と ChatGPT アプリの Codex は、別の経路で見るしかない。
- 推奨は、常駐の中に 2 種のアダプタを置き、ブラウザとは WebSocket で結ぶ構成である。
- Claude の認証は、配布物なら API キーが前提である。
- 本人だけが使う道具で本人の購読を使えるかは、解釈の余地が残る。

## 調査の条件

- Agent SDK は `npm pack @anthropic-ai/claude-agent-sdk` で /tmp に取得した。
- 版は 0.3.291 である。同梱の Claude Code は manifest.json で 2.1.291 と確かめた。
- 型の根拠は、展開した `sdk.d.ts` と `browser-sdk.d.ts` と `bridge.d.ts` である。
- Claude 側は実際の会話を起動していない。~/.claude への書き込みを避けるためである。
- codex は /Users/r/.nodebrew/current/bin/codex で、版は 0.160.1 である。
- 通信の仕様は次の命令で /tmp に出力して読んだ。
  - `codex app-server generate-json-schema --experimental --out <dir>`
  - `codex app-server generate-ts --experimental --out <dir>`
- app-server は /tmp の作業ディレクトリで stdio 接続により 2 回起動した。
- モデルは gpt-5.6-luna を使い、スレッドは ephemeral にした。

## Claude Agent SDK

### 確かめた事実

#### 会話の開始と継続

- 入口は `query({ prompt, options })` で、戻り値の `Query` は SDKMessage の非同期反復子である。
  根拠: `sdk.d.ts` の `query` と `Query` の宣言。
- `prompt` に AsyncIterable を渡すと、1 つの子プロセスで複数の入力を送れる。
  根拠: `sdk.d.ts` の `query` と `streamInput`。
- 制御の命令は、この流し込み入力の形でだけ使える。
  根拠: `Query` の注釈 "only supported when streaming input/output is used"。
- 会話 ID は init の system message と result message の `session_id` で得る。
  根拠: https://code.claude.com/docs/en/agent-sdk/sessions
- `sessionId` を渡せば、起動側が UUID を先に決められる。
  根拠: `Options.sessionId` の注釈。
- 再開は `resume`、直近の再開は `continue`、分岐は `forkSession` で行う。
  根拠: `Options` の各注釈と上記の sessions 文書。
- 途中の発言まで戻した再開は `resumeSessionAt` で行う。
  根拠: `Options.resumeSessionAt` の注釈。
- 一覧と読み出しは `listSessions` と `getSessionMessages` で行う。
- 分岐の複製は `forkSession` 関数でも行える。改名と付箋は `renameSession` と `tagSession` で行う。
  根拠: `sdk.d.ts` の各関数宣言。
- `persistSession: false` にすると記録を残さない。その会話は再開できない。
  根拠: `Options.persistSession` の注釈。

#### 出力の流れ

- 流れの型は SDKMessage の合併型で、39 種がある。
  根拠: `sdk.d.ts` 5336 行の `SDKMessage`。
- 本文と道具の呼び出しは `assistant` の message.content に載る。
- 文字単位の流れは `includePartialMessages: true` で受け取る。
- 実行の状態は `session_state_changed` で、値は idle と running と requires_action である。
  根拠: `SDKSessionStateChangedMessage`。
- 1 回の応答の終わりは `result` で、所要時間と費用を含む。
- サブエージェントの出来事は `task_started` と `task_progress` と `task_notification` で届く。
  根拠: `SDKTaskStartedMessage` などの宣言。
- `task_started` は task_id と tool_use_id と subagent_type と spawn_depth を持つ。
- サブエージェント内の発言は `parent_tool_use_id` で親の呼び出しに結び付く。
- 本文まで欲しいときは `forwardSubagentText: true` を指定する。
  根拠: `Options.forwardSubagentText` の注釈。
- 終わった会話のサブエージェントは `listSubagents` と `getSubagentMessages` で読める。
- 個別の停止は `stopTask`、裏への移動は `backgroundTasks` で行う。

#### 承認

- 承認は `canUseTool` の呼び返しで受け、`PermissionResult` を返す。
  根拠: `CanUseTool` と `PermissionResult` の宣言。
- 返答は allow か deny で、入力の書き換えと規則の追加もできる。
- 呼び返しには中止の信号と提案の規則と理由の文が渡る。
- 方式は `permissionMode` で選び、値は 6 種である。
  default と acceptEdits と bypassPermissions と plan と dontAsk と auto がある。
- 方式は会話の途中でも `setPermissionMode` で変えられる。
- `permissionPrompts: 'none'` にすると、問い合わせは即座に拒否される。
- 質問の対話は `onUserDialog` で、MCP の入力要求は `onElicitation` で受ける。
- 通信が切れた後は `reinitialize` で、保留中の承認が再送される。
  根拠: `Query.reinitialize` の注釈。

#### モデルと effort と中断

- モデルは `model` で指定し、途中で `setModel` で変えられる。
- effort は `effort` で指定し、値は low と medium と high と xhigh と max である。
  根拠: `EffortLevel` の宣言。
- 途中の effort 変更は `applyFlagSettings({ effortLevel })` で行う。
- 使えるモデルの一覧は `supportedModels` で得る。
- 中断は `interrupt` で、子プロセスごとの終了は `close` で行う。
- 外からの中止は `abortController` でも行える。

#### hook

- hook は `Options.hooks` に関数を登録して同じプロセスで受ける。
  根拠: `HookCallback` と `HookCallbackMatcher` の宣言。
- 対象の出来事は 33 種で、SubagentStart と SubagentStop と PermissionRequest を含む。
  根拠: `HOOK_EVENTS` の定数。
- 設定ファイルの hook の実行も `includeHookEvents: true` で流れに載る。
- 子プロセスは ~/.claude と各リポジトリの .claude の設定を既定で読む。
  根拠: https://code.claude.com/docs/en/agent-sdk/overview の機能の表。

#### 端末の会話との関係

- 記録は `~/.claude/projects/<変換した cwd>/<session-id>.jsonl` に書かれる。
  根拠: https://code.claude.com/docs/en/sessions
- SDK は端末の会話も ID で再開できる。逆に SDK の会話も `claude --resume <id>` で開ける。
- ただし SDK の会話は端末の選択画面と `--continue` には出ない。
- 同じ会話を 2 か所で分岐なしに再開すると、発言が 1 つの記録に混ざる。
  根拠: 上記 sessions 文書の Branch a session 節。
- SDK は動いている端末のプロセスに接続する手段を持たない。
- 記録の書式は内部仕様で、版ごとに変わりうると明記されている。

#### 認証と料金

- 公式の手順は API キーで、Bedrock と Vertex と Foundry も選べる。
  根拠: https://code.claude.com/docs/en/agent-sdk/quickstart
- 第三者が自分の製品で claude.ai のログインを提供することは認められていない。
  根拠: https://code.claude.com/docs/en/agent-sdk/overview の注記。
- 製品を作る開発者は API キーを使うべきだと明記されている。
  根拠: https://code.claude.com/docs/en/legal-and-compliance
- 同じ文書は、Pro と Max の上限が個人の通常利用を前提とすると述べる。
- その前提には Claude Code と Agent SDK の両方が含まれている。
- 本人が改変なしの本体に自分の購読でログインすることは妨げないとも書かれている。
- API キーの料金は従量で、result message が `total_cost_usd` を返す。
- `accountInfo` で認証の種別が分かる。init message の `apiKeySource` でも分かる。

### 推測

- 本人だけが手元で使うコンソールなら、本人の購読ログインで動く見込みが高い。
- 本体が ~/.claude の認証情報を読むためである。ただし実行での確認はしていない。
- 他人に配る段階では API キーへの切り替えが必要になる。
- `browser-sdk` はクラウドの会話向けで、手元のコンソールの土台には向かない。
- `bridge` も同じくクラウドの会話向けの部品と読める。

## Codex app-server

### 確かめた事実

#### 起動と通信

- `codex app-server` は [experimental] と表示される。
  根拠: `codex app-server --help`。
- 通信は stdio と unix と ws から選び、既定は stdio である。
- 形式は 1 行 1 件の JSON-RPC で、`jsonrpc` の欄は省ける。
- 接続後に `initialize` を送り、次に `initialized` を通知する。
  根拠: https://learn.chatgpt.com/docs/app-server と実機の観測。
- 要求は 167 種、サーバからの要求は 11 種、通知は 83 種ある。
  根拠: 生成した ClientRequest.json などの数え上げ。
- 常駐の管理は `codex app-server daemon` と `proxy` で行える。
  根拠: 各 `--help`。

#### スレッドの開始と継続

- 開始は `thread/start`、入力は `turn/start` で行う。
- 再開は `thread/resume`、分岐は `thread/fork` で行う。
- 動いているスレッドへの `thread/resume` は、その会話への再参加になる。
  根拠: `ThreadResumeParams` の注釈。
- 分岐は `lastTurnId` か `beforeTurnId` で区切りを選べる。
- 実行中の応答への追記は `turn/steer` で行う。
- スレッド ID は UUIDv7 で、`thread/start` の応答に入る。
- `Thread` は parentThreadId と forkedFromId と source と status を持つ。
- 一覧は `thread/list`、読み込み中の一覧は `thread/loaded/list` で得る。
- 購読の解除は `thread/unsubscribe` で行う。購読は接続ごとに持つ。

#### 出来事の流れ

- 状態は `thread/status/changed` で届く。
- 値は notLoaded と idle と systemError と active である。
- active は waitingOnApproval と waitingOnUserInput の印を持つ。
- 応答の区切りは `turn/started` と `turn/completed` である。
- 中身は `item/started` と `item/completed` と各種の delta で届く。
- item の種類は 19 種である。agentMessage と commandExecution と fileChange を含む。
- hook の実行は `hook/started` と `hook/completed` で届く。
- 使用量は `thread/tokenUsage/updated` と `account/rateLimits/updated` で届く。

#### 承認

- 承認はサーバからの JSON-RPC 要求で届き、応答で返す。
- コマンドは `item/commandExecution/requestApproval` で届く。
- 変更は `item/fileChange/requestApproval` で届く。
- 返答の値は accept と acceptForSession と decline と cancel などである。
  根拠: `CommandExecutionApprovalDecision`。
- 方式は `approvalPolicy` で選び、値は untrusted と on-request と never と granular である。
- 隔離は `sandbox` で選び、値は read-only と workspace-write と danger-full-access である。

#### モデルと effort と中断

- モデルと effort は `turn/start` ごとに上書きでき、以後の応答にも効く。
- 使えるモデルと effort は `model/list` で得る。
- 実行中の応答の設定変更は `turn/settings/update` で行う。
- ただし手元では step_model_switching の機能が必要という誤りで拒否された。
- 中断は `turn/interrupt` で行う。

#### サブエージェント

- 子のスレッドは `parentThreadId` を持つ。
- 子の source は subagent で、thread_spawn は親 ID と深さと役割を持つ。
  根拠: `SessionSource` と `SubAgentSource` の型。
- 親の流れには collabAgentToolCall の item が載る。
- その道具は spawnAgent と sendInput と wait と closeAgent などである。
- 子の動きは subAgentActivity の item で、agentThreadId を持つ。
- `thread/list` は親 ID で子を絞り込める。これは実験的な欄である。
- サブエージェントは実機では起動していない。根拠は型と文書だけである。

#### 認証

- ChatGPT のログインで動く。実機では authMode が chatgpt と通知された。
- 利用は購読の上限で数えられ、`account/rateLimits/updated` で残りが届いた。
- API キーでのログインも `account/login/start` で選べる。
  根拠: `LoginAccountParams` の apiKey の型。

#### ChatGPT アプリとの関係

- ChatGPT.app の子として `codex app-server` が動いていた。
  根拠: `ps -axo pid,ppid,etime,command` の出力。
- その実体は ChatGPT.app 同梱の codex で、版は 0.160.1 である。
- 引数は `app-server --analytics-default-enabled` で、--listen はない。
- 標準入出力は unix の対で、ネットワークの待ち受けはない。
  根拠: `lsof -p <pid>` の出力。
- 別に `codex app-server --listen unix:// --managed-daemon` の常駐もあった。
- その常駐の制御ソケットは ~/.codex/app-server-control/ にある。
  根拠: `codex app-server daemon version` の出力。
- 公式の文書は、VS Code 拡張と Codex デスクトップが app-server を使うと述べる。
  根拠: https://learn.chatgpt.com/docs/app-server

#### 実機の観測

1 回目の起動では次の順で出来事が届いた。

1. `initialize` の応答で codexHome と userAgent が返った。
2. `thread/start` の応答と `thread/started` で ID が確定した。
3. `turn/start` の後に `thread/status/changed` が active になった。
4. hook の SessionStart と UserPromptSubmit が通知された。
5. 道具の前に `thread/status/changed` が waitingOnApproval になった。
6. `item/commandExecution/requestApproval` の要求が届き、accept を返した。
7. `serverRequest/resolved` が届き、印が消えた。
8. commandExecution の item が完了し、agentMessage の delta が続いた。
9. `turn/completed` と `thread/status/changed` の idle で終わった。

- 2 回目の応答は `turn/interrupt` で止まり、status は interrupted になった。
- `thread/loaded/list` は自分が起動したスレッドだけを返した。
- ephemeral のスレッドは `thread/resume` と `thread/fork` が拒否された。
- 誤りの文は "no rollout found for thread id" である。
- `thread/list` は他の起動元の保存済みスレッドを返した。
- それらの status はすべて notLoaded だった。

### 推測

- 別プロセスの app-server が動かすスレッドの生死は、`thread/list` からは分からない。
- ChatGPT アプリの app-server は stdio の専用接続で、外から相乗りできない。
- 管理常駐の unix ソケットに複数のクライアントが繋げば、同じスレッドを共有できる見込みがある。
- この共有は今回は試していない。常駐の状態を乱さないためである。

## 比較

| 項目 | Claude Agent SDK | Codex app-server |
| --- | --- | --- |
| 会話の同一性 | init の session_id で確定する。起動側が UUID を先に決めることもできる。 | thread/start の応答で確定する。子は parentThreadId を持つ。 |
| 生死 | session_state_changed と子プロセスの終了で分かる。 | thread/status/changed と thread/closed で分かる。 |
| 出力の流れ | 39 種の SDKMessage で届く。文字単位は設定で有効にする。 | item と delta の通知で届く。種類は 19 種である。 |
| 承認 | canUseTool の呼び返しで受けて返す。 | サーバからの JSON-RPC 要求で受けて返す。 |
| モデル切替 | setModel で途中に変えられる。effort は applyFlagSettings で変える。 | turn/start ごとに上書きできる。実行中の変更は機能の有効化が要る。 |
| 中断 | interrupt と close で行う。 | turn/interrupt で行う。 |
| サブエージェント | task 系の message と parent_tool_use_id で追える。 | 子スレッドと collabAgentToolCall で追える。 |
| hook | 同じプロセスの関数で受けられる。 | 実行の通知だけを受けられる。 |
| 外の会話の制御 | できない。記録の読み出しと再開だけができる。 | できない。保存済みの一覧と再開だけができる。 |
| 認証 | 公式は API キーである。購読の利用は個人の通常利用に限られる。 | ChatGPT のログインで動く。API キーも選べる。 |
| 安定性 | 一部の命令に alpha や実験の印がある。 | app-server 自体が experimental と表示される。 |

## 得られないものと代替

| 得られないもの | 代わりの手段 |
| --- | --- |
| 端末の Claude Code の実行中の会話 | 今の hook による記録を読み取り専用の経路として残す。 |
| ChatGPT アプリの Codex の実行中のスレッド | 保存済みの記録を thread/list と thread/read で読む。 |
| 外の会話の承認の代行 | コンソールで再開し直し、以後をコンソールで持つ。 |
| Codex の実行中の effort 変更 | 次の turn/start で上書きする。 |
| Codex の hook の差し込み | 承認の要求と item の通知で判断する。 |
| ephemeral の Codex スレッドの再開 | 再開したいスレッドは ephemeral にしない。 |

- 外の会話をコンソールへ移すときは、元の端末を止めてから再開する。
- 両方で動かすと記録が混ざるためである。

## 推奨の構成

1. 常駐を、エージェントを起動して持つ主体に変える。
2. 常駐の中に Claude 用と Codex 用のアダプタを置く。
3. Claude 用は会話ごとに `query` を 1 つ持つ。
4. 入力は AsyncIterable で流し込み、会話を閉じずに保つ。
5. 会話 ID は `sessionId` で常駐が先に決める。
6. 承認は `canUseTool` で受け、ブラウザへ回して答えを待つ。
7. サブエージェントは task 系の message で木に組む。
8. Codex 用は app-server を 1 つ子として起動し、stdio で繋ぐ。
9. 1 つの app-server に複数のスレッドを載せる。
10. 承認の要求はブラウザへ回し、答えを JSON-RPC の応答で返す。
11. 子スレッドは parentThreadId で木に組む。
12. 両方の出来事を共通の形に直し、常駐の記録に追記する。
13. ブラウザとは WebSocket で結ぶ。再接続時は記録の続きから送る。
14. pid と herdr の画面からの推測は、外の会話の表示だけに残す。
15. 外の会話は読み取り専用の扱いにし、引き継ぎの操作を別に用意する。

- この構成では、自前の会話の状態は推測なしで得られる。
- 推測が残るのは、外の会話の表示だけになる。

## 未確認の事項

- Claude の会話を SDK から実際に起動する試験は行っていない。
- 購読ログインで SDK が動くかは実行で確かめていない。
- Codex の永続スレッドの再開と分岐は、実行で確かめていない。
- Codex のサブエージェントの出来事は、実行で確かめていない。
- 管理常駐の unix ソケットへの相乗りは試していない。
- `turn/settings/update` を有効にする設定の名前は確かめていない。

## 調査の副作用

- 試験のスレッドでは、利用者の ~/.codex/hooks.json の hook が実行された。
- SessionStart と UserPromptSubmit と PreToolUse と Stop などが走った。
- これらの hook が agent-graph や herdr に記録を残した可能性がある。
- 起動した app-server は 2 回とも終了を確かめた。
- 一時ファイルは /tmp の下だけに置き、リポジトリには入れていない。
