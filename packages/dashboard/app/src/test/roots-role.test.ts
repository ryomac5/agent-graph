import { expect, it } from 'vitest';
import { buildRootTree, resolveChildRole, shownRole, type RootIndex, type Root } from '../lib/roots.ts';

it('maps every observed and requested child role to one vocabulary', () => {
  const cases = {
    Explore: 'research', 'claude-code-guide': 'research', Plan: 'advisor', plan: 'advisor', advisor: 'advisor', verify: 'verify', proofread: 'proofread', 'general-purpose': 'implement', implement: 'implement',
    'codex-exec': 'implement', reviewer: 'review', review: 'review', 'doc-light': 'document', 'doc-heavy': 'document', unknown: 'implement',
    research: 'research', document: 'document', orchestrate: 'orchestrate',
  };
  for (const [agentType, role] of Object.entries(cases)) expect(resolveChildRole({ agentType })).toBe(role);
  expect(resolveChildRole()).toBe('implement');
  expect(resolveChildRole({ agentType: 'Explore' }, { request: { role: 'review' } })).toBe('review');
  expect(resolveChildRole({}, { role: 'implement' })).toBe('implement');
});
it('names all eight roles in English and Japanese', () => {
  const names = { orchestrate: ['Orchestrate', '根'], advisor: ['Advisor', '助言'], research: ['Research', '調査'], implement: ['Implement', '実装'], document: ['Document', '文書'], review: ['Review', 'レビュー'], verify: ['Verify', '検証'], proofread: ['Proofread', '校正'] };
  for (const [role, [en, ja]] of Object.entries(names)) {
    expect(shownRole(role, 'en')).toBe(en); expect(shownRole(role, 'ja')).toBe(ja);
  }
});
it('passes roles and request headings into existing tree cards', () => {
  const root: Root = { id: 'root', name: 'Root', project: null, state: 'idle', last_activity_ts: null, conversation_ids: ['parent'], running_children: 0, total_children: 2 };
  const index: RootIndex = {
    conversations: new Map([['direct', { id: 'direct', provider: 'codex' }]]), runs: new Map(), runsById: new Map(),
    children: new Map([['parent', [{ id: 'edge', to_id: 'direct', evidence: { agentType: 'codex-exec', description: '# Build' }, confidence: 'inferred' }]]]),
    requests: new Map(), delegations: new Map([['root', [{ id: 'task', request: { role: 'review' }, title: 'Review task', provider: 'codex' }]]]),
  };
  const tree = buildRootTree(root, index);
  expect(tree.nodes.find(node => node.id === 'direct')?.role).toBe('implement');
  expect(tree.nodes.find(node => node.id === 'direct')?.label).toContain('Implement');
  expect(tree.nodes.find(node => node.id === 'delegation:task')?.role).toBe('review');
  expect(tree.edges.find(edge => edge.target === 'direct')?.title).toBe('Build');
});

it('detects verification requests for general-purpose agents and keeps explicit roles', () => {
  for (const description of ['Run e2e tests', 'Verify the production screen', '本番の画面を確認', '実機で検証', 'テストを回す']) {
    expect(resolveChildRole({ agentType: 'general-purpose', description })).toBe('verify');
  }
  expect(resolveChildRole({ agentType: 'general-purpose', description: 'Implement settings' })).toBe('implement');
  expect(resolveChildRole({ agentType: 'general-purpose' }, { request: { title: 'Smoke test' } })).toBe('verify');
  expect(resolveChildRole({ agentType: 'general-purpose', description: 'Run tests' }, { request: { role: 'document' } })).toBe('document');
});
