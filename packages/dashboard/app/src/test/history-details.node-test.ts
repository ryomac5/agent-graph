import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL as FileURL } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeId, openLedger, project } from '../../../../core/src/ledger/index.ts';
import { observeCodexFile } from '../../../../api/src/observe/codex/index.ts';
import { observeClaudeHistories } from '../../../../api/src/service/claude-reader.ts';
import { openObservationService } from '../../../../api/src/service/index.ts';
import { ProjectionFeed } from '../../../../api/src/service/projection-feed.ts';
import type { ScreenState } from '../lib/store.ts';
import { buildDelegationTree } from '../pages/tree/model.ts';
import { conversationTitle } from '../lib/format.ts';
import { buildRootTree, selectRoots, useRootIndex } from '../lib/roots.ts';
import { readMessageBody } from '../lib/message-body.ts';
import { selectTimeline } from '../components/conversation/model.ts';

test('uses imported native history in the existing root graph, conversation title, model and final answer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-details-screen-'));
  const path = join(directory, 'ledger.db');
  const ledger = openLedger(path);
  let service: ReturnType<typeof openObservationService> | undefined;
  let feed: ProjectionFeed | undefined;
  try {
    const codexPath = join(directory, 'rollout-parent.jsonl');
    const claudePath = join(directory, 'session.jsonl');
    writeFileSync(codexPath, readFileSync(new FileURL('../../../../api/test/samples/history-details/codex.jsonl', import.meta.url)));
    writeFileSync(claudePath, readFileSync(new FileURL('../../../../api/test/samples/history-details/claude.jsonl', import.meta.url)));
    observeCodexFile(ledger, codexPath, { codexHome: directory });
    observeClaudeHistories(ledger, directory, ledger.readSince(0, Number.MAX_SAFE_INTEGER), undefined, [claudePath]);
    const projection = project(ledger.readSince(0, Number.MAX_SAFE_INTEGER));
    service = openObservationService({ dbPath: path, home: directory, env: {} });
    feed = new ProjectionFeed(path, service.catchUp);
    const current = feed.snapshot().projection;
    const state: ScreenState = { seq: 1, generation: 1, connection: 'connected', deltas: {}, projection: {
      conversations: current.conversations, runs: current.runs, state_decisions: current.state_decisions,
      relations: projection.relations.map(row => ({ ...row })), roots: projection.roots.map(row => ({ ...row })),
      messages: projection.messages.map(row => ({ ...row })), message_memberships: projection.message_memberships.map(row => ({ ...row })),
    } };
    const parent = createNativeId('codex', 'parent');
    const child = createNativeId('codex', 'child');
    const root = selectRoots(state).find(root => root.conversation_ids.includes(parent))!;
    const tree = buildRootTree(root, useRootIndex(state));
    const childNode = tree.nodes.find(node => node.conversationId === child)!;
    assert.ok(childNode);
    assert.equal(childNode.state, 'idle');
    const edges = tree.edges.filter(edge => edge.target === childNode.id);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].title, 'review');
    const call = selectTimeline(state, parent).find(entry => entry.row.native_id === 'function-item')!;
    const tool = (call.row.body as Record<string, unknown>[])[0];
    assert.equal((state.projection.relations![0].evidence as Record<string, unknown>).toolUseId, tool.id);
    assert.equal(buildDelegationTree(state).nodes.find(node => node.conversationId === parent)?.model, 'gpt-6-sol');
    const conversation = state.projection.conversations!.find(row => row.provider === 'claude')!;
    assert.equal(conversationTitle(conversation), 'Review the importer');
    assert.equal(state.projection.runs!.find(row => row.conversation_id === conversation.id)?.model, 'claude-opus-5');
    const output = selectTimeline(state, String(conversation.id)).find(entry => entry.row.native_id === 'output')!;
    assert.equal(readMessageBody(output.row), 'Approved · The importer preserves native identifiers.');
  } finally { feed?.close(); service?.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
