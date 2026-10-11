import { expect, it } from 'vitest';
import { buildRootTree, resolveChildRole, shownRole, type RootIndex, type Root } from '../lib/roots.ts';

it('maps every observed and requested child role to one vocabulary', () => {
  const cases = {
    Explore: 'research', 'claude-code-guide': 'research', Plan: 'plan', 'general-purpose': 'work', implement: 'work',
    'codex-exec': 'work', reviewer: 'review', review: 'review', 'doc-light': 'write', 'doc-heavy': 'write', unknown: 'other',
    research: 'research', document: 'write', orchestrate: 'other',
  };
  for (const [agentType, role] of Object.entries(cases)) expect(resolveChildRole({ agentType })).toBe(role);
  expect(resolveChildRole()).toBe('other');
  expect(resolveChildRole({ agentType: 'Explore' }, { request: { role: 'review' } })).toBe('review');
  expect(resolveChildRole({}, { role: 'implement' })).toBe('work');
});
it('names all six roles in English and Japanese', () => {
  const names = { research: ['Research', '調査'], plan: ['Plan', '計画'], work: ['Work', '作業'], review: ['Review', 'レビュー'], write: ['Write', '文書'], other: ['Other', 'その他'] };
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
  expect(tree.nodes.find(node => node.id === 'direct')?.role).toBe('work');
  expect(tree.nodes.find(node => node.id === 'direct')?.label).toContain('Work');
  expect(tree.nodes.find(node => node.id === 'delegation:task')?.role).toBe('review');
  expect(tree.edges.find(edge => edge.target === 'direct')?.title).toBe('Build');
});
