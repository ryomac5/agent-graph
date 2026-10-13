import { useMemo, useRef, type ReactNode } from 'react';
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
  return createDelegationResolver(conversationId, state, index, root)(tool);
}
export function createDelegationResolver(conversationId: string, state: ScreenState, index: RootIndex, root?: Root) {
  const tree = buildRootTree(root ?? { id: '', name: '', project: null, state: '', last_activity_ts: null, conversation_ids: [conversationId], running_children: 0, total_children: 0 }, index);
  const parentIds = root?.conversation_ids.includes(conversationId) ? root.conversation_ids : [conversationId];
  const relations = (state.projection.relations ?? []).filter(row => row.type === 'delegated' && row.active !== false && row.active !== 0 && parentIds.includes(readText(row.from_id)));
  return (tool: Row): TreeNode | undefined => {
    const input = readObject(tool.input);
    const ids = [tool.id, input.request_id, input.requestId, input.task_id].map(readText).filter(Boolean);
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
  };
}

export type DelegationNodes = ReadonlyMap<number, Pick<TreeNode, 'conversationId' | 'provider' | 'state'>>;
export function sameDelegationNodes(a?: DelegationNodes, b?: DelegationNodes): boolean {
  if (a === b) return true;
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
  return [...b ?? []].every(([id, right]) => {
    const left = a?.get(id);
    return left?.conversationId === right.conversationId && left?.provider === right.provider && left?.state === right.state;
  });
}
/** 木は依存する投影ごと、発言の道具はその木ごとに一度だけ解決する。 */
export function useDelegationNodes(conversationId: string, state: ScreenState, index: RootIndex, root?: Root) {
  const previous = useRef(new WeakMap<Row, DelegationNodes | undefined>());
  return useMemo(() => {
    let resolve: ReturnType<typeof createDelegationResolver> | undefined;
    const cache = new WeakMap<Row, DelegationNodes | undefined>();
    return (row: Row): DelegationNodes | undefined => {
      if (cache.has(row)) return cache.get(row);
      const tools = Array.isArray(row.body) ? row.body.map(readObject).filter(block => block.type === 'tool_use') : [];
      const nodes = tools.some(isDelegationTool) ? new Map<number, Pick<TreeNode, 'conversationId' | 'provider' | 'state'>>() : undefined;
      for (const [position, tool] of tools.entries()) {
        if (!isDelegationTool(tool)) continue;
        resolve ??= createDelegationResolver(conversationId, state, index, root);
        const node = resolve(tool);
        if (node) nodes!.set(position, { conversationId: node.conversationId, provider: node.provider, state: node.state });
      }
      const stable = sameDelegationNodes(previous.current.get(row), nodes) ? previous.current.get(row) : nodes;
      previous.current.set(row, stable);
      cache.set(row, stable);
      return stable;
    };
  }, [conversationId, state.projection.relations, index, root]);
}

export function DelegationCard({ tool, node, language, onSelect }: { tool: Row; node?: Pick<TreeNode, 'conversationId' | 'provider' | 'state'>; language: Language; onSelect?: (id: string) => void }) {
  const input = readObject(tool.input);
  const provider = node?.provider || readText(input.provider ?? input.executor) || (['Agent', 'Task'].includes(readText(tool.name)) ? 'claude' : 'codex');
  const content: ReactNode = <><ProviderMark provider={provider}/><span className="delegation-title">{readText(input.description) || readText(input.title) || (language === 'ja' ? 'エージェントへの依頼' : 'Agent request')}</span>
    {node?.conversationId && <StatusDot state={node.state} language={language}/>}</>;
  return <button type="button" className="delegation-card" disabled={!node?.conversationId || !onSelect} onClick={() => { if (node?.conversationId) onSelect?.(node.conversationId); }}>{content}</button>;
}
