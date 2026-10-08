import { expect, it } from 'vitest';
import { collectConversationChanges } from './conversation-changes.ts';

function message(name: string, input: unknown, source_ts = '2026-10-08T00:00:00Z') {
  return { id: source_ts, source_ts, body: [{ type: 'tool_use', name, input }] };
}
it('collects Edit replacements including replace_all without guessing occurrence counts', () => {
  const [file] = collectConversationChanges([message('Edit', { file_path: '/repo/a.ts', old_string: 'old\nline\n', new_string: 'new\n', replace_all: true })], { cwd: '/repo/' });
  expect(file).toMatchObject({ path: 'a.ts', additions: 1, deletions: 2 });
  expect(file.changes[0].lines).toEqual([{ kind: 'remove', text: 'old' }, { kind: 'remove', text: 'line' }, { kind: 'add', text: 'new' }]);
});
it('collects Write contents and strips the project root at a path boundary', () => {
  const files = collectConversationChanges([message('Write', { file_path: '/repo/a.ts', content: 'one\ntwo\n' }),
    message('Write', { file_path: '/repository/a.ts', content: '' })], { projectRoot: '/repo' });
  expect(files.map(({ path, additions, deletions }) => ({ path, additions, deletions }))).toEqual([
    { path: 'a.ts', additions: 2, deletions: 0 }, { path: '/repository/a.ts', additions: 0, deletions: 0 },
  ]);
});
it('collects each MultiEdit replacement in input order', () => {
  const [file] = collectConversationChanges([message('MultiEdit', { file_path: './a.ts', edits: [
    { old_string: 'old', new_string: 'new' }, { old_string: 'last', new_string: 'next\nextra' },
  ] })]);
  expect(file).toMatchObject({ path: 'a.ts', additions: 3, deletions: 2 });
  expect(file.changes[0].lines.map(line => line.text)).toEqual(['old', 'new', 'last', 'next', 'extra']);
});
it('collects apply_patch update, add and delete sections and nested patch inputs', () => {
  const patch = '*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n context\n-old\n+new\n*** Add File: b.ts\n+created\n*** Delete File: c.ts\n*** End Patch';
  for (const [name, input] of [['apply_patch', patch], ['functions.apply_patch', { patch }], ['custom', { nested: { patch } }]]) {
    const files = collectConversationChanges([message(name as string, input)], { cwd: '/repo' });
    expect(files.map(({ path, additions, deletions }) => ({ path, additions, deletions }))).toEqual([
      { path: 'a.ts', additions: 1, deletions: 1 }, { path: 'b.ts', additions: 1, deletions: 0 }, { path: 'c.ts', additions: 0, deletions: 0 },
    ]);
    expect(files[0].changes[0].lines).toContainEqual({ kind: 'context', text: 'context' });
  }
});
it('groups repeated changes chronologically without mutating messages', () => {
  const messages = [message('Edit', { file_path: 'a.ts', old_string: 'second', new_string: 'third' }, '2026-10-08T00:00:02Z'),
    message('Edit', { file_path: '/repo/a.ts', old_string: 'first', new_string: 'second' }, '2026-10-08T00:00:01Z')];
  const before = structuredClone(messages);
  const [file] = collectConversationChanges(messages, { cwd: '/repo' });
  expect(file).toMatchObject({ path: 'a.ts', additions: 2, deletions: 2 });
  expect(file.changes.map(change => change.lines[0].text)).toEqual(['first', 'second']);
  expect(messages).toEqual(before);
});
it('returns no files for text, malformed inputs, notebooks and shell calls containing patches', () => {
  expect(collectConversationChanges([{ body: 'text' }, { body: [null, { type: 'text', text: '*** Begin Patch' }] },
    message('Edit', {}), message('NotebookEdit', { file_path: 'a.ipynb' }),
    message('exec_command', { cmd: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' }),
    message('functions.exec_command', { cmd: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' }),
    message('Bash', { command: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' })])).toEqual([]);
});
it('reads stored JSON bodies and inputs', () => {
  const row = message('Write', JSON.stringify({ file_path: 'a.ts', content: 'hello' }));
  expect(collectConversationChanges([{ ...row, body: JSON.stringify(row.body) }])[0]).toMatchObject({ path: 'a.ts', additions: 1 });
});
it('別の作業ツリーのファイルはプロジェクト名のディレクトリより後ろで出し、外のファイルを後に並べる', () => {
  const files = collectConversationChanges([
    message('Write', { file_path: '/tmp/scratch/a.mjs', content: 'x\n' }, '2026-10-08T00:00:00Z'),
    message('Write', { file_path: '/home/me/agent-graph-design/packages/b.ts', content: 'y\n' }, '2026-10-08T00:00:01Z'),
  ], { projectRoot: '/home/me/agent-graph' });
  expect(files.map(file => file.path)).toEqual(['packages/b.ts', '/tmp/scratch/a.mjs']);
});
