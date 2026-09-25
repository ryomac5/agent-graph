import assert from "node:assert/strict";
import test from "node:test";
import * as typed from "../src/model.ts";
import * as browser from "../public/model.js";

const root = { id: "root", kind: "session" as const, title: "root", family: "anthropic" };
const child = { id: "child", kind: "delegation" as const, title: "child", family: "openai" };
const edge = { from: "root", to: "child", fromFamily: "anthropic", toFamily: "openai", title: "実装" };
const empty: typed.Graph = { nodes: [], edges: [] };

test("snapshot と delegation の差分を id で重ねる", () => {
  const snapshot = typed.applySnapshot(empty, { nodes: [root, child], edges: [edge] });
  const updated = typed.applyDelegation(snapshot, {
    node: { ...child, status: "done" },
    edge: { ...edge, title: "完了" },
  });
  assert.equal(updated.nodes.length, 2);
  assert.equal(updated.edges.length, 1);
  assert.equal(updated.nodes.find((node) => node.id === "child")?.status, "done");
  assert.equal(updated.edges[0].title, "完了");
  assert.equal(snapshot.nodes.find((node) => node.id === "child")?.status, undefined);
});

test("layout は入力順によらず決定的で、根から深さごとに列を分ける", () => {
  const grandchild = { id: "grandchild", kind: "delegation" as const, title: "grandchild" };
  const graph: typed.Graph = {
    nodes: [grandchild, child, root],
    edges: [{ from: "child", to: "grandchild" }, edge],
  };
  const first = typed.layout(graph);
  const reversed = typed.layout({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });
  assert.deepEqual(first, reversed);
  const points = new Map(first.nodes.map((point) => [point.id, point]));
  assert.ok(points.get("root")!.x < points.get("child")!.x);
  assert.ok(points.get("child")!.x < points.get("grandchild")!.x);
});

test("edgeDirection は双方向、同系統、不明を区別する", () => {
  assert.equal(typed.edgeDirection(edge), "anthropic→openai");
  assert.equal(typed.edgeDirection({ from: "a", to: "b", fromFamily: "openai", toFamily: "anthropic" }), "openai→anthropic");
  assert.equal(typed.edgeDirection({ from: "a", to: "b", fromFamily: "openai", toFamily: "openai" }), "same");
  assert.equal(typed.edgeDirection({ from: "a", to: "b" }), "unknown");
});

test("public/model.js と src/model.ts は同じ入力で一致する", () => {
  const graph = { nodes: [root, child], edges: [edge] };
  const change = { node: { ...child, status: "running" }, edge: { ...edge, title: "進行中" } };
  const typedState = typed.applyDelegation(typed.applySnapshot(empty, graph), change);
  const browserState = browser.applyDelegation(browser.applySnapshot(empty, graph), change);
  assert.deepEqual(typedState, browserState);
  assert.deepEqual(typed.layout(typedState), browser.layout(browserState));
  assert.equal(typed.edgeDirection(edge), browser.edgeDirection(edge));
});
