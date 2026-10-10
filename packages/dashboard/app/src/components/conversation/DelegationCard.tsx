import type { ReactNode } from 'react';
import type { Row, ScreenState } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import type { RootIndex, Root } from '../../lib/roots.ts';
import { buildRootTree } from '../../lib/roots.ts';
import type { TreeNode } from '../../pages/tree/model.ts';
import { ProviderMark } from '../RootViews.tsx';
import { StatusDot } from '../StateBadge.tsx';
import { readObject, readText } from './model.ts';

export function isDelegationTool(block: Row): boolean {
  const name = readText(block.name).split('.').at(-1) ?? '';
  return ['Agent', 'Task', 'spawn_agent', 'spawnAgent', 'delegate', 'intake.delegate'].includes(name)
    || /(?:^|__)delegate$/.test(name) || /(?:runner|planner).*?(?:delegate|spawn|run)/i.test(name);
}

/** 木と同じ節を使う。題だけの対応は、親の中で一意な場合に限る。 */
export function resolveDelegationNode(tool: Row, conversationId: string, state: ScreenState, index: RootIndex, root?: Root): TreeNode | undefined {
  const tree = buildRootTree(root ?? { id: '', name: '', project: null, state: '', last_activity_ts: null, conversation_ids: [conversationId], running_children: 0, total_children: 0 }, index);
  const input = readObject(tool.input);
  const ids = [tool.id, input.request_id, input.requestId, input.task_id].map(readText).filter(Boolean);
  const parentIds = root?.conversation_ids.includes(conversationId) ? root.conversation_ids : [conversationId];
  const relations = (state.projection.relations ?? []).filter(row => row.type === 'delegated' && row.active !== false && row.active !== 0 && parentIds.includes(readText(row.from_id)));
  const relation = relations.find(row => {
    const evidence = readObject(row.evidence);
    return [evidence.toolUseId, evidence.tool_use_id, evidence.request_id, evidence.task_id, evidence.item_id].some(id => typeof id === 'string' && ids.includes(id));
  });
  if (relation) return tree.nodes.find(node => node.conversationId === relation.to_id);
  const byRequest = tree.nodes.filter(node => [node.delegation?.request_id, node.delegation?.id].some(id => typeof id === 'string' && ids.includes(id)));
  if (byRequest.length === 1) return byRequest[0];
  const description = readText(input.description) || readText(input.title);
  if (!description) return;
  const matches = tree.nodes.filter(node => relations.some(row => row.to_id === node.conversationId && readObject(row.evidence).description === description)
    || node.delegation && readText(node.delegation.parent_run_id) === readText(index.runs.get(conversationId)?.id)
      && [node.delegation.description, node.delegation.title].includes(description));
  return matches.length === 1 ? matches[0] : undefined;
}

export function DelegationCard({ tool, node, language, onSelect }: { tool: Row; node?: TreeNode; language: Language; onSelect?: (id: string) => void }) {
  const input = readObject(tool.input);
  const provider = node?.provider || readText(input.provider ?? input.executor) || (['Agent', 'Task'].includes(readText(tool.name)) ? 'claude' : 'codex');
  const content: ReactNode = <><ProviderMark provider={provider}/><span className="delegation-title">{readText(input.description) || readText(input.title) || (language === 'ja' ? 'エージェントへの依頼' : 'Agent request')}</span>
    {node?.conversationId && <StatusDot state={node.state} language={language}/>}</>;
  return <button type="button" className="delegation-card" disabled={!node?.conversationId || !onSelect} onClick={() => { if (node?.conversationId) onSelect?.(node.conversationId); }}>{content}</button>;
}
