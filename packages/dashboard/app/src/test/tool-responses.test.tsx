import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { groupToolRuns } from '../components/conversation/timeline.ts';
import { ToolRun } from '../components/conversation/Message.tsx';
import { collectToolResults } from '../components/conversation/ToolCall.tsx';
import type { TimelineEntry } from '../components/conversation/model.ts';
import type { Row } from '../lib/store.ts';
afterEach(cleanup);
const message = (id: string, body: unknown, extra: Row = {}): TimelineEntry => ({ kind: 'message', key: id, time: id, row: { id, role: 'assistant', body, ...extra } });
const tool = (id: string, name = 'Read') => ({ type: 'tool_use', id, name, input: { path: id } });
it('groups interleaved and mixed tool calls once per user response while retaining text order and results', () => {
  const entries = [message('a', [tool('read'), { type: 'text', text: 'Checking' }]), message('b', 'Progress'),
    message('c', [{ type: 'tool_result', tool_use_id: 'read', content: 'data' }], { role: 'user' }),
    message('d', [tool('bash', 'Bash')]), message('e', 'Answer'),
    message('f', 'Next request', { role: 'user' }), message('g', [tool('next')])];
  const original = JSON.stringify(entries);
  const output = groupToolRuns(entries);
  const groups = output.filter(entry => entry.kind === 'tools');
  expect(groups).toHaveLength(2);
  expect(groups[0].rows.flatMap(entry => entry.row.body as Row[]).map(block => block.id)).toEqual(['read', 'bash']);
  expect(output.filter(entry => entry.kind === 'message').map(entry => entry.key)).toEqual(['a', 'b', 'e', 'f']);
  expect(collectToolResults(entries.map(entry => entry.row)).get('read')).toEqual({ type: 'tool_result', tool_use_id: 'read', content: 'data' });
  expect(JSON.stringify(entries)).toBe(original);
});
it('respects explicit turns, final answers and history boundaries and keeps delegation cards outside tool groups', () => {
  const output = groupToolRuns([message('a', [tool('one')], { turn_id: '1' }), message('b', [tool('two')], { turn_id: '2' }),
    message('c', 'Done', { phase: 'final_answer' }), message('d', [tool('three')]),
    { kind: 'boundary', key: 'boundary', time: '', row: { type: 'compacted' } }, message('e', [tool('four')]),
    message('delegate', [{ type: 'tool_use', id: 'child', name: 'Agent', input: { description: 'Build' } }])]);
  expect(output.filter(entry => entry.kind === 'tools')).toHaveLength(4);
  expect(output.find(entry => entry.key === 'delegate')?.kind).toBe('message');
});
it.each(['en', 'ja'] as const)('shows one closed summary, three unique names and the failure count in %s', language => {
  const rows = [message('a', [tool('a'), tool('b', 'Bash'), tool('c', 'Edit'), tool('d', 'Search'), tool('e')]).row];
  render(<ToolRun rows={rows} language={language} toolResults={new Map([['b', { is_error: true, content: 'Denied' }]])}/>);
  const group = document.querySelector<HTMLDetailsElement>('.tool-run')!;
  expect(group.open).toBe(false);
  expect(group.querySelector('summary')!.textContent).toBe(language === 'ja' ? 'ツール 5 件失敗 1· Read · Bash · Edit' : '5 toolsFailed 1· Read · Bash · Edit');
  fireEvent.click(group.querySelector('summary')!);
  expect(group.open).toBe(true);
  const failed = document.querySelector<HTMLDetailsElement>('.tool-call.failed')!;
  fireEvent.click(failed.querySelector('summary')!);
  expect(failed.open).toBe(true);
  expect(screen.getByText('Denied')).toBeTruthy();
});
