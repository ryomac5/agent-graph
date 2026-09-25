import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectDelegate } from "../src/mcp-client.ts";

test("initialize、delegate、isError", async () => {
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
  const client = await connectDelegate({ shimPath, cwd, env: { TRACEPARENT: "trace" } });
  const request = { role: "implement" as const, title: "good", task: "task", accept: ["true"] };
  assert.deepEqual(await client.delegate(request), { ready: true, cwd: realpathSync(cwd), client: "planner", trace: "trace" });
  await assert.rejects(client.delegate({ ...request, title: "bad" }), /failed/);
  client.close();
});
