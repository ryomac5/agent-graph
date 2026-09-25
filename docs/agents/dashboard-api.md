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
| `POST /api/sessions` | `{ id, cwd, client }` | `{ ok: true }` | Host, JSON, Origin, loopback | hook の SessionStart |
| `POST /api/sessions/<id>/end` | `{}` | `{ ok: true }` | Host, JSON, Origin, loopback | hook の SessionEnd |
| `POST /api/observe` | 観測の種類ごとの body | `{ ok: true }` | Host, JSON, Origin, loopback | hook の turn と待ちの観測 |
| `GET /api/repos` | なし | `Repo[]` | Host | 互換のため残す |
| `GET /api/graph?repo=<key>&session=<id>` | query | `Graph` | Host | 互換のため残す |

失敗は `ErrorResult` `{ error: string }` を JSON で返す。状態は 400 が不正な body、403 が守りの拒否、404 が未知の repo、501 が未実装。
経路に合わない POST は 405、`/api/` 配下の未知の GET は 404。

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

現状の `routes/events.ts` は従来どおり `event: snapshot` と `event: delegation` を送る。`project` と `overview` への切り替えは読み取り API のタスクが `views.ts` と合わせて行う。

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
