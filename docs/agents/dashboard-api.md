# ダッシュボード HTTP API

型の正本は `packages/daemon/src/http/contract.ts`。この文書は経路と守りと SSE の約束を書く。
ルータは `packages/daemon/src/http/routes/` に経路ごとのファイルを置き、`routes/index.ts` の配列で登録する。
経路を足すときは、ファイルを 1 つ置いて `index.ts` に 1 行足す。
実装が無い経路は 501 を返す。

## 経路

| 経路 | 入力 | 出力 | 守り | 用途 |
| --- | --- | --- | --- | --- |
| `GET /` | なし | index.html | Host | トークンを `<meta name="agent-graph-token">` で埋め込む |
| `GET /api/overview` | なし | `Overview` | Host | 全リポジトリの一覧 |
| `GET /api/project?repo=<key>` | query `repo` | `ProjectView` | Host | 1 リポジトリの全体 |
| `GET /api/events?repo=<key>` | query `repo` は省略可 | SSE | Host | 変化の配信 |
| `POST /api/action` | `ActionRequest` | `ActionResult` | Host, JSON, Origin, token | 承認、再試行、却下、終了、turn の非表示 |
| `POST /api/sessions` | `{ id, cwd, client, model? }` | 201 `{ ok: true }` | Host, JSON, Origin, loopback | hook の SessionStart |
| `POST /api/sessions/<id>/end` | `{}` | 200 `{ ok: true }` | Host, JSON, Origin, loopback | hook の SessionEnd |
| `POST /api/observe` | `{ kind, sessionId, ... }` | 200 `{ ok: true }` | Host, JSON, Origin, loopback | hook の turn と待ちとサブエージェントの観測 |
| `GET /api/repos` | なし | `Repo[]` | Host | 互換のため残す |
| `GET /api/graph?repo=<key>&session=<id>` | query | `Graph` | Host | 互換のため残す |

失敗は `ErrorResult` `{ error: string }` を JSON で返す。状態は 400 が不正な body、403 が守りの拒否、404 が未知の repo やセッション、501 が未実装。
経路に合わない POST は 405、`/api/` 配下の未知の GET は 404。

## hook の経路

`POST /api/sessions` の body。

| 項目 | 内容 |
| --- | --- |
| `id` | Claude Code の `session_id` |
| `cwd` | 絶対パス。git のルートを解決して repo を決める |
| `client` | `claude` `codex` `planner` |
| `model?` | 根のモデル名 |

pid は hook から送らない。hook の親は shell のことがあり、根のプロセスとは限らない。
根の pid は shim の hello だけで記録し、デーモンは `ps` の起動時刻と組で保存して生死判定に使う。起動時刻が取れずに空のまま残った pid は、生きていれば 30 秒ごとの見回りで起動時刻を補う。
初回の登録で `<repo名>-NNN` の名前を振る。同じ `id` の再登録では名前を変えず、`session.started` も再記録しない。
終了済みのセッションが同じ `id` で再登録されたら `status` を `running` に戻し、`endedAt` を消す。`lost` にした委譲は戻さない。MCP の根の hello も同じ扱い。

`POST /api/sessions/<id>/end` は body `{}` で受け、`status` を `ended` にして `endedAt` を入れる。すでに終わっていれば何もせず 200 を返す。
そのセッションで走っていた委譲は `lost` にし、委譲ごとに `delegation.lost` を events に追記する。`lost` はあくまで推定で、その委譲があとで実際に完了したときは事実を優先し、`done` か `failed` で上書きする。
デーモンは起動時に状態置き場の全リポジトリの store を開く。再起動のあとも、まだ接続の無いリポジトリのセッションを見回りの対象にする。

`POST /api/observe` の body は `kind` で分ける。`sessionId` は必須。未知の `kind` は 400、未知のセッションは 404。

| `kind` | 項目 | 効果 |
| --- | --- | --- |
| `turn_start` | `prompt` | `turns` に行を作る。最初の `prompt` を `goal` にする。待ちを解除する |
| `turn_done` | `summary?`, `reply` | 直近の未完の turn に `summary` を付ける。`summary` が無ければ `reply` の先頭 3 行。`reply` は 6000 字まで。待ちを解除する |
| `waiting` | `reason` | `status` を `waiting` にし、`waitingReason` に `permission` か `question` を入れる |
| `resumed` | なし | 待ちを解除する。PostToolUse の AskUserQuestion |
| `subagent_request` | `toolUseId`, `title`, `task`, `subagentType?`, `name?`, `model?`, `parentAgentId?` | PreToolUse の Agent。`delegations` に `kind: subagent` の行を作る。同じ `toolUseId` は無視する |
| `subagent_done` | `toolUseId`, `failed`, `agentId?` | PostToolUse と PostToolUseFailure の Agent。失敗なら `failed` で閉じる。未束縛の行は `agentId` で結ぶか `failed` で閉じる |
| `subagent_start` | `agentId`, `agentType`, `toolUseId?` | SubagentStart。`agentId` を同じ `agentType` の未束縛の行に古い順で結ぶ。既知の `agentId` なら `running` に戻す |
| `subagent_message` | `toolUseId`, `to`, `text` | PreToolUse の SendMessage。宛先の子の往復に再指示を足し、`roundTrips` を増やす。同じ `toolUseId` は無視する |
| `subagent_stop` | `agentId?`, `agentType`, `report`, `summary?`, `task?` | SubagentStop。報告を積んで `status` を `done` にする。`task` の合う行に結び直す。同じ報告の二重送信は無視する |

turn の 3 種は `packages/daemon/src/sessions.ts`、サブエージェントの種類は `packages/daemon/src/observe.ts` にある。

## サブエージェントの記録

Claude Code の Agent ツールで起こした子は `delegations` の `kind: subagent` の行になる。`title` は Agent の `description`、`role` は `subagent_type` と `description` から推定する。`assignments` には `executor: claude`、`model` は Agent の `model` か根の `model`、`family: anthropic` を入れる。
入れ子の委譲は `parentAgentId` から親の行を引き、`parent_id` に入れる。`SendMessage` の宛先は `agentId` か Agent の `name` で引く。

往復は `events` に積む。`payload.delegationId` で行に結ぶ。`NodeDetail.rounds` はここから組む。

| `kind` | `payload` | 往復 |
| --- | --- | --- |
| `delegation.requested` | `{ delegationId, task }` | `request` |
| `subagent.dispatched` | `{ delegationId, toolUseId, agentType, name?, parentAgentId? }` | なし |
| `subagent.started` | `{ delegationId, agentId, agentType }` | なし。最後の値が束縛。`agentId` が空なら未束縛に戻す |
| `subagent.reinstructed` | `{ delegationId, agentId, toolUseId, text }` | `reinstruct` |
| `subagent.reported` | `{ delegationId, agentId?, output, summary, task? }` | `report` |
| `delegation.finished` | `{ delegationId, status }` | なし。`done` か `failed` |

`execution.started` と `execution.finished` も MCP の委譲と同じ形で積む。
`subagent_start` と `subagent_stop` に記録も `agentType` も無い子は Claude Code 内部のものとみなし、行を作らず既存の行にも結ばない。
サブエージェント由来の観測は根の `waitingReason` を消さない。待ちを解くのは `turn_start` と `turn_done` と `resumed` だけ。
`subagent_stop` の `task` は子の transcript の最初の user 本文。前後の空白を除いた完全一致か先頭 200 字の一致で `delegation.requested` の `task` と突き合わせ、並列の同じ種別の取り違えを直す。
hook はデーモンに届かなくても 0 で終わる。

## セッションの状態

`SessionView.status` は `running` `waiting` `ended` の 3 つを取る。

| 遷移 | 契機 |
| --- | --- |
| 登録 → `running` | `POST /api/sessions` か MCP の根の hello |
| `running` → `waiting` | `observe` の `waiting`。`waitingReason` を入れる |
| `waiting` → `running` | 次の `turn_start` か `turn_done`。後続の tool の観測も解除する |
| `running` / `waiting` → `ended` | `POST /api/sessions/<id>/end`。または 30 秒ごとの見回りで pid のプロセスが死んでいたとき。pid が無ければ 30 分記録が無いとき |
| `ended` → `running` | 同じ `id` の再登録か根の hello。`claude --resume` で戻る |

`ended` のセッションは `turn` や `waiting` の観測では戻らない。

## 型

主な型を示す。省略可能な項目は `?` を付ける。全文は `contract.ts` を読む。

| 型 | 内容 |
| --- | --- |
| `Status` | `planned` `running` `waiting` `waiting_human` `conflict` `done` `failed` `rejected` `lost` `timeout` `denied` `ended` |
| `Usage` | `{ ts?, windows: UsageWindow[] }`。`UsageWindow` は `{ key, label, provider, percent, resetsAt? }` |
| `ProjectSummary` | `{ key, name, rootPath, counts: { running, waiting, failed, done }, liveSessions, lastActivityAt?, status }` |
| `Overview` | `{ projects: ProjectSummary[], usage, updatedAt }` |
| `NodeDetail` | `kind` は `root` `delegation` `subagent` `task`。`status` は `Status`。詳細の項目はすべて省略可 |
| `EdgeDetail` | `{ id, from, to, kind: delegate / return / depends, label?, fromFamily?, toFamily? }` |
| `Turn` | `{ id, at, prompt, summary?, hidden? }` |
| `SessionView` | `{ id, name, client?, status, waitingReason?, startedAt, endedAt?, goal?, model?, turns, nodes, edges }` |
| `GraphView` | planner のグラフ。`{ id, sessionId?, goal, nodes, edges }`。タスクは `kind: task` の node、依存は `kind: depends` の edge |
| `ProjectView` | `{ project: { key, name, rootPath }, sessions, graphs, usage, updatedAt }` |
| `ActionRequest` | `{ action, repo, graphId?, taskId?, sessionId?, turnId? }`。`action` は `approve` `retry` `reject` `end_session` `hide_turn` |
| `ActionResult` | `{ ok, message }` |

`ProjectView` の例。

```json
{
  "project": { "key": "abc123", "name": "agent-graph", "rootPath": "/Users/r/00_project/agent-graph" },
  "sessions": [{
    "id": "s1", "name": "agent-graph-001", "client": "claude", "status": "running",
    "startedAt": "2026-09-25T00:00:00.000Z",
    "turns": [{ "id": "t1", "at": "2026-09-25T00:00:01.000Z", "prompt": "契約を固定する" }],
    "nodes": [
      { "id": "s1", "kind": "root", "title": "agent-graph-001", "status": "running", "family": "anthropic" },
      { "id": "d1", "kind": "delegation", "title": "契約を書く", "status": "done", "executor": "codex",
        "model": "gpt-6-sol", "family": "openai", "parentId": "s1" }
    ],
    "edges": [{ "id": "s1->d1", "from": "s1", "to": "d1", "kind": "delegate", "fromFamily": "anthropic", "toFamily": "openai" }]
  }],
  "graphs": [{
    "id": "agent-graph-001-s10", "sessionId": "s1", "goal": "ダッシュボードを作り直す",
    "nodes": [{ "id": "C0", "kind": "task", "title": "契約", "status": "done" },
              { "id": "V1b", "kind": "task", "title": "セッション", "status": "running" }],
    "edges": [{ "id": "C0->V1b", "from": "C0", "to": "V1b", "kind": "depends" }]
  }],
  "usage": { "ts": "2026-09-25T00:00:00.000Z",
    "windows": [{ "key": "anthropic:5h", "label": "5 時間", "provider": "anthropic", "percent": 42 }] },
  "updatedAt": "2026-09-25T00:00:02.000Z"
}
```

`POST /api/action` の例。

```http
POST /api/action HTTP/1.1
Host: 127.0.0.1:4310
Origin: http://127.0.0.1:4310
Content-Type: application/json
X-Agent-Graph-Token: <index.html の meta の値>

{ "action": "approve", "repo": "abc123", "graphId": "agent-graph-001-s10", "taskId": "C0" }
```

応答は `{ "ok": true, "message": "C0 を承認した" }`。
`graphId` は `GraphView.id` の値で、`graphs.id` の ULID を入れる。planner のセッション識別子でも引ける。

`POST /api/action` の応答の状態。

| 状態 | 本文 | 契機 |
| --- | --- | --- |
| 200 | `ActionResult` の `ok: true` | 記録した。approve、retry、reject は task_decisions に書き、planner が反映する |
| 409 | `ActionResult` の `ok: false` | 対象の状態が合わない。失敗したタスクの approve、終了済みのセッションの end_session、走っている委譲があるセッションの end_session など |
| 400 | `{ error }` | 不正な body。未知の `action`、識別子の欠落や文字種違い |
| 404 | `{ error }` | 未知の repo、graph、task、session、turn |
| 403 | `{ error }` | 守りの拒否 |

`end_session` は `status` を `ended` にするだけで、プロセスには触らない。
そのセッションに `requested` `planned` `running` `waiting` の委譲が 1 つでもあれば 409 で断り、`message` に件数を書く。
終えると子が `lost` と記録されるので、生きている子がいる間は画面から終えられない。

## SSE

`GET /api/events` は `text/event-stream` を返す。

| 約束 | 内容 |
| --- | --- |
| `repo` あり | 変化があるたびに `event: project` で `ProjectView` の全体を送る。差分は送らない |
| `repo` なし | 変化があるたびに `event: overview` で `Overview` の全体を送る |
| 間引き | 250ms に 1 回まで。連続した変化は最後の状態だけ送る |
| keep-alive | 15 秒ごとに `: keep-alive` のコメント行を送る |
| 接続直後 | 現在の全体を 1 回送る |

```
event: project
data: {"project":{...},"sessions":[...],"graphs":[...],"usage":{...},"updatedAt":"..."}

: keep-alive
```

## 守り

実装は `packages/daemon/src/http/security.ts`。デーモンは `127.0.0.1` にだけ bind する。

| 守り | 対象 | 規則 |
| --- | --- | --- |
| Host | すべて | `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>` だけ受ける。DNS リバインディング対策 |
| Content-Type | POST | `application/json` で始まること |
| Origin | POST | 付いていれば `http://<Host>` と一致すること |
| token | `POST /api/action` | `X-Agent-Graph-Token` がデーモンのトークンと一致すること |
| loopback | hook 用の 3 経路 | 接続元が `127.0.0.1` であること。トークンは要らない |

拒否はどれも 403 で `{ error }` を返す。
トークンはデーモン起動ごとに作り直し、`runDir()/dashboard.token` に 0600 で保存する。
`GET /` の応答は index.html の `<head>` 直後に `<meta name="agent-graph-token" content="...">` を差し込む。ダッシュボードはこの値を読んで POST に付ける。
テストでは `startHttpServer` の `tokenPath` で保存先を差し替える。
