import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type Snapshot } from '../lib/store.ts';
import { buildRootTree, selectRoots, useRootIndex } from '../lib/roots.ts';
import { GraphPage } from '../pages/graph/GraphPage.tsx';

// 本番の Kaggriculture-001 と agent-graph-027 の構造。本文とパスと native ID だけを置換する。
// kit の仮 run_id に対応する会話・run はなく、割当情報は委譲にだけ存在する。
function snapshot(compact: boolean): Snapshot {
  const root = '["claude","parent"]';
  const cases = [
    { position: 1212443, model: null, state: 'failed' },
    { position: 2535281, model: 'gpt-6-astra', state: 'interrupted' },
    { position: 2375754, model: 'gpt-6.1-sol', state: 'done' },
  ];
  return { seq: 1, generation: 1, identities: { conversations: { 'claude:parent': root }, runs: compact ? {} : { 'claude:parent:1': `${root}:1` } }, projection: {
    roots: [{ id: root, name: 'Fixture-001', project: 'repo', state: 'idle', conversation_ids: [root] }],
    projects: [{ id: 'repo', display_name: 'Fixture', state: 'registered' }],
    conversations: [{ id: root, provider: 'claude', origin: 'observed', type: 'interactive' }],
    runs: [{ id: 'claude:parent:1', conversation_id: 'claude:parent', generation: 1, state: 'idle', model: 'claude-opus-5-5' }],
    delegations: cases.map(({ position, model, state }, i) => {
      const request = `kit:["/fixture/.agents/state/events.jsonl",${position}]`;
      return { id: request, request_id: request, root_id: root, role: 'implement', title: `Request ${i}`, parent_run_id: null,
        provider: model ? 'codex' : null, model, state, attempt: 1, parent: '{"confidence":"unknown"}', origin: null,
        kit: { file: '/fixture/.agents/state/events.jsonl', position, session: 'Fixture-001', node_id: `codex-0${i + 1}`,
          parent: 'root', parent_native_id: null, parent_provider: null, child_native_id: null, model: model ?? '' },
        attempts: JSON.stringify([{ attempt: 1, run_id: `kit:${request}`, state,
          assignment: { model: null, effort: null, executor: null, provider: null } }]) };
    }),
    relations: cases.map(({ position }) => {
      const request = `kit:["/fixture/.agents/state/events.jsonl",${position}]`;
      const parts = ['delegated', root, `kit:${request}`, JSON.stringify({ request_id: request, session: 'Fixture-001',
        child_native_id: null, parent_native_id: null, parent_provider: null })];
      return { id: JSON.stringify(parts), confidence: 'inferred', active: 1,
        ...(compact ? {} : { type: parts[0], from_id: parts[1], to_id: parts[2], evidence: parts[3] }) };
    }),
  } };
}
afterEach(cleanup);
it.each([false, true])('joins runless kit relations to their delegation once and uses recorded labels (compact: %s)', compact => {
  const target = createStore();
  target.setSnapshot(snapshot(compact));
  const state = target.getSnapshot();
  const root = selectRoots(state)[0];
  const tree = buildRootTree(root, useRootIndex(state));
  expect(tree.nodes).toHaveLength(4);
  expect(tree.nodes.filter(node => node.provider === 'codex')).toHaveLength(2);
  for (const delegation of state.projection.delegations) {
    const node = tree.nodes.find(node => node.delegation?.id === delegation.id)!;
    expect(node).toBeDefined();
    expect(node.provider).toBe(delegation.provider ?? '');
    expect(node.model).toBe(delegation.model ?? '');
    expect(node.state).toBe(delegation.state);
    expect(node.run).toBeUndefined();
    expect(node.conversationId).toBeUndefined();
    expect(tree.edges.filter(edge => edge.target === node.id)).toHaveLength(1);
    expect(tree.edges.find(edge => edge.target === node.id)?.confidence).toBe('inferred');
  }
  render(<MemoryRouter><GraphPage project="repo" rootId={root.id} target={target} client={{ command: vi.fn() }} embedded/></MemoryRouter>);
  const earlier = screen.queryByRole('treeitem', { name: /Earlier/ });
  if (earlier) fireEvent.click(earlier);
  const labels = [...document.querySelectorAll('[role="treeitem"]')].map(row => row.getAttribute('aria-label'));
  expect(labels.some(label => label?.includes('GPT-6 Astra'))).toBe(true);
  expect(labels.some(label => label?.includes('GPT-6.1 Sol'))).toBe(true);
  expect(labels.some(label => label?.includes('Agent · Unknown'))).toBe(false);
});
