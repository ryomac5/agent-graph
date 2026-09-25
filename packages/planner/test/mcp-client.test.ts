import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectDelegate } from "../src/mcp-client.ts";

test("initialize、delegate、isError", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const shimPath = join(cwd, "server.mjs");
  writeFileSync(shimPath, `import {createInterface} from 'node:readline';
let ready=false;
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='notifications/initialized') ready=true;
 if(m.id) {
  const result=m.method==='initialize'?{}:m.params.arguments.title==='bad'?{isError:true,content:[{type:'text',text:'failed'}]}:{structuredContent:{ready,cwd:process.cwd(),client:process.env.AGENT_GRAPH_CLIENT,trace:process.env.TRACEPARENT},content:[{type:'text',text:'{}'}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 }
}`);
  const client = await connectDelegate({ shimPath, cwd, env: { TRACEPARENT: "trace" }, signal: t.signal });
  try {
    const request = { role: "implement" as const, title: "good", task: "task", accept: ["true"] };
    assert.deepEqual(await client.delegate(request), { ready: true, cwd: realpathSync(cwd), client: "planner", trace: "trace" });
    await assert.rejects(client.delegate({ ...request, title: "bad" }), /failed/);
  } finally { await client.close(); }
});

test("initialize が応答しない子も中断して回収する", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-stalled-"));
  const shimPath = join(cwd, "stalled.mjs");
  writeFileSync(shimPath, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(connectDelegate({ shimPath, cwd, env: {},
      signal: AbortSignal.any([controller.signal, t.signal]) }), /aborted/);
  } finally { clearTimeout(timer); }
});

test("shim が即座に終了したら接続失敗を返す", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-exit-"));
  const shimPath = join(cwd, "exit.mjs");
  writeFileSync(shimPath, "process.exit(1);\n");
  await assert.rejects(connectDelegate({ shimPath, cwd, env: {}, signal: t.signal }));
});
