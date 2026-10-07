import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { DelegationTree, TreeNode } from '../../pages/tree/model.ts';
import { NodeSummary } from '../../pages/tree/NodeSummary.tsx';
import type { Language } from '../../lib/i18n.ts';
import '@xyflow/react/dist/style.css';

type GraphNode = Node<{ node: TreeNode; language: Language; onSelect?: (id: string) => void }, 'execution'>;
function ExecutionNode({ data }: NodeProps<GraphNode>) {
  return <div className={`delegation-graph-node ${data.node.state === 'unknown' ? 'is-unknown' : ''}`}>
    <Handle type="target" position={Position.Left}/>
    <button className="delegation-select nodrag" onClick={() => data.onSelect?.(data.node.id)}>{data.node.label}</button><NodeSummary node={data.node} language={data.language}/>
    <Handle type="source" position={Position.Right}/>
  </div>;
}
const nodeTypes = { execution: ExecutionNode };
const COLUMN_WIDTH = 360;
const ROW_HEIGHT = 190;
export function createGraphElements(tree: DelegationTree, selected?: string, language: Language = 'en') {
  const byId = new Map(tree.nodes.map(n => [n.id, n]));
  const positions = new Map<string, { x: number; y: number }>();
  let row = 0;
  function place(id: string, depth: number) {
    if (positions.has(id)) return;
    positions.set(id, { x: depth * COLUMN_WIDTH, y: row++ * ROW_HEIGHT });
    for (const child of byId.get(id)?.children ?? []) place(child, depth + 1);
  }
  for (const id of [...tree.roots, ...tree.unresolved]) place(id, 0);
  const nodes: GraphNode[] = tree.nodes.map(node => ({ id: node.id, type: 'execution',
    position: positions.get(node.id) ?? { x: 0, y: row++ * ROW_HEIGHT },
    selected: node.id === selected, data: { node, language }, ariaLabel: node.label }));
  const edges: Edge[] = tree.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
    label: `${edge.title} · ${edge.confidence}${edge.kind === 'dependency' ? ' · Dependency' : ''}`,
    style: { stroke: 'var(--text-3)', strokeDasharray: edge.confidence !== 'confirmed' || edge.kind === 'candidate' ? '6 4' : undefined },
    data: { confidence: edge.confidence, kind: edge.kind },
    labelStyle: { fill: 'var(--text)' }, labelBgStyle: { fill: 'var(--surface)' },
    type: edge.kind === 'dependency' ? 'smoothstep' : 'default' }));
  return { nodes, edges };
}
export function DelegationGraph({ tree, selected, onSelect, language = 'en' }: {
  tree: DelegationTree; selected?: string; onSelect: (id: string) => void; language?: Language;
}) {
  const elements = createGraphElements(tree, selected, language);
  elements.nodes = elements.nodes.map(node => ({ ...node, data: { ...node.data, onSelect } }));
  return <div className="delegation-graph" aria-label={language === 'ja' ? '委譲グラフ' : 'Delegation graph'}>
    <ReactFlow {...elements} nodeTypes={nodeTypes} onNodeClick={(_event, node) => onSelect(node.id)}
      nodesDraggable={false} nodesConnectable={false} fitView minZoom={0.15} maxZoom={2}>
      <Background/><Controls showInteractive={false}/>
    </ReactFlow>
  </div>;
}
