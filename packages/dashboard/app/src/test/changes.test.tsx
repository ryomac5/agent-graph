import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ChangesPage } from '../pages/changes/ChangesPage.tsx';
import { DiffView } from '../components/diff/DiffView.tsx';
import { comparePatches, LARGE_FILE_LINES, parseDiff } from '../components/diff/model.ts';
import { createStore, type Row } from '../lib/store.ts';

afterEach(cleanup);
const PATCH = 'diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n';
const NEXT = PATCH.replace('+new', '+fixed');
const artifact = { id: 'a1', run_id: 'implementation', version: 1, repository_id: 'repo', worktree_id: 'tree',
  base_sha: 'base', head_sha: 'head', patch_hash: 'hash1', attribution: 'confirmed', diff: PATCH,
  verification: JSON.stringify({ passed: true, results: [{ command: 'test -f code.txt', exitCode: 0, output: 'OK' }] }) };
function setup(extra: Record<string, Row[]> = {}, artifactId?: string) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { artifacts: [artifact], runs: [{ id: 'implementation', conversation_id: 'conversation' }], ...extra } });
  target.setConnection('connected');
  const client = { command: vi.fn(async (_name: string, _payload?: unknown) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })) };
  render(<MemoryRouter><ChangesPage target={target} client={client} project="repo" artifactId={artifactId}/></MemoryRouter>);
  return { target, client };
}
const finding = (id: string, state = 'open'): Row => ({ id, artifact_id: 'a1', version: 1, file: 'code.txt', side: 'new', start_line: 2, end_line: 2, context_hash: 'context', body: `Fix ${id}`, severity: 'high', state });

it('renders the file list, numbered additions and removals, attribution and acceptance results', () => {
  setup();
  const files = screen.getByRole('complementary', { name: 'Files' });
  expect(within(files).getByRole('button', { name: /code.txt/ })).toBeTruthy();
  const diff = screen.getByRole('table', { name: 'code.txt unified diff' });
  expect(within(diff).getByRole('button', { name: 'Comment on code.txt new line 2' }).textContent).toBe('new');
  expect(within(diff).getByRole('button', { name: 'Comment on code.txt old line 2' }).textContent).toBe('old');
  expect(diff.querySelector('.diff-add')?.textContent).toContain('2+new');
  expect(diff.querySelector('.diff-remove')?.textContent).toContain('2−old');
  const verification = screen.getByRole('region', { name: 'Acceptance verification' });
  expect(within(verification).getByText('Passed', { exact: true })).toBeTruthy();
  fireEvent.click(within(verification).getByText('test -f code.txt · Passed'));
  expect(within(verification).getByText('OK')).toBeTruthy();
});

it.each(['confirmed', 'inferred', 'joint', 'unknown'])('shows %s attribution on files and lines with an evidence link', attribution => {
  setup({ artifacts: [{ ...artifact, attribution }] });
  const label = attribution[0].toUpperCase() + attribution.slice(1);
  const fileBadge = within(screen.getByRole('complementary', { name: 'Files' })).getByRole('link', { name: label });
  expect(fileBadge.getAttribute('href')).toBe('#artifact-evidence-a1');
  expect(within(screen.getByRole('table')).getAllByRole('link', { name: label }).length).toBe(4);
  if (['unknown', 'inferred'].includes(attribution)) expect(fileBadge.className).toContain('chip-dashed');
  if (attribution === 'unknown') {
    expect(fileBadge.getAttribute('title')).toBe('Changes whose author could not be identified');
    expect(screen.getByText('Changes whose author could not be identified')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/human change/i);
  }
});

it('switches unified and side by side layouts and keeps line comments on their side', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
  expect(screen.queryByRole('table', { name: 'code.txt unified diff' })).toBeNull();
  const split = screen.getByRole('table', { name: 'code.txt split diff' });
  expect(within(split).getByText('Before')).toBeTruthy();
  expect(within(split).getByText('After')).toBeTruthy();
  fireEvent.click(within(split).getByRole('button', { name: 'Comment on code.txt old line 2' }));
  expect(screen.getByText('code.txt · old · 2–2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
  expect(screen.getByRole('table', { name: 'code.txt unified diff' })).toBeTruthy();
});

it('collapses large files initially and lets the user expand and collapse them', () => {
  const patch = `diff --git a/large.txt b/large.txt\n@@ -0,0 +1,${LARGE_FILE_LINES + 1} @@\n` + '+line\n'.repeat(LARGE_FILE_LINES + 1);
  render(<DiffView files={parseDiff(patch)} layout="unified" attribution="unknown" evidenceUrl="#evidence"/>);
  const toggle = screen.getByRole('button', { name: 'large.txt' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('table')).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole('table')).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByRole('table')).toBeNull();
});

it('sends a finding cmd pinned to the artifact and selected range', async () => {
  const { client } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Comment on code.txt new line 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Comment on code.txt new line 3' }), { shiftKey: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Finding' }), { target: { value: 'Fix the range' } });
  fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add finding' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('review.add_finding', { artifactId: 'a1', file: 'code.txt', side: 'new', startLine: 2, endLine: 3, body: 'Fix the range', severity: 'high' }));
  expect(await screen.findByRole('status')).toBeTruthy();
});

it('returns selected open findings together and exposes reverify, approve, reviewer and revoke cmds', async () => {
  const { client } = setup({ findings: [finding('one'), finding('two', 'needs_check'), finding('sent', 'sent')] });
  expect((screen.getByLabelText('Select finding sent') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Select finding one')); fireEvent.click(screen.getByLabelText('Select finding two'));
  fireEvent.click(screen.getByRole('button', { name: 'Return selected to agent' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('review.send', { artifactId: 'a1', findingIds: ['one', 'two'] }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Reverify' }) as HTMLButtonElement).disabled).toBe(false));
  for (const [label, command] of [['Reverify', 'review.reverify'], ['Approve', 'review.approve'], ['Start reviewer', 'review.start']]) {
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(command, { artifactId: 'a1' }));
    await waitFor(() => expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false));
  }
});

it('shows stale approval reason, both hashes and patch differences, then revokes by approval ID', async () => {
  const { client } = setup({ artifacts: [artifact, { ...artifact, id: 'a2', version: 2, previous_artifact_id: 'a1', patch_hash: 'hash2', diff: NEXT }],
    approvals: [{ id: 'approval', artifact_id: 'a1', patch_hash: 'hash1', state: 'stale', reason: 'artifact patch_hash changed',
      request: JSON.stringify({ result: { verdict: 'approve', comment: 'Reviewer approved original version' }, reviewer: { provider: 'claude', model: 'sonnet' } }) }] });
  const approval = screen.getByRole('article', { name: 'Approval approval' });
  expect(within(approval).getByText('Stale · Invalid approval')).toBeTruthy();
  expect(within(approval).getAllByText('artifact patch_hash changed').length).toBeGreaterThan(0);
  expect(within(approval).getByText('Approved: hash1')).toBeTruthy();
  expect(within(approval).getByText('Changed: hash2')).toBeTruthy();
  expect(within(approval).getByRole('table', { name: 'Patch comparison split diff' })).toBeTruthy();
  expect(within(approval).getByText('Reviewer: claude sonnet · approve')).toBeTruthy();
  expect(within(approval).getByText('Reviewer approved original version')).toBeTruthy();
  fireEvent.click(within(approval).getByRole('button', { name: 'Revoke approval' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('review.revoke', { approvalId: 'approval' }));
});

it('switches versions, clears draft anchors and compares saved patches without attaching synthetic lines', () => {
  setup({ artifacts: [artifact, { ...artifact, id: 'a2', version: 2, previous_artifact_id: 'a1', patch_hash: 'hash2', diff: NEXT }] });
  fireEvent.click(screen.getByRole('button', { name: 'Comment on code.txt new line 2' }));
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'a1' } });
  expect(screen.queryByRole('textbox', { name: 'Finding' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'a2' } });
  fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: 'a1' } });
  const diff = screen.getByRole('table', { name: 'Patch comparison unified diff' });
  expect(diff.textContent).toContain('+new'); expect(diff.textContent).toContain('+fixed');
  expect(within(diff).queryByRole('button', { name: /Comment on/ })).toBeNull();
});

it('surfaces command failures and prevents commands while disconnected', async () => {
  const { client, target } = setup();
  client.command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'cmd', ok: false, error: 'Worktree differs from fixed artifact' } as Awaited<ReturnType<typeof client.command>>);
  fireEvent.click(screen.getByRole('button', { name: 'Reverify' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Worktree differs from fixed artifact');
  act(() => target.setConnection('runner_unavailable'));
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
});

it('renders missing diff explicitly and filters other projects and unrelated approvals', () => {
  setup({ artifacts: [{ ...artifact, diff: undefined }, { ...artifact, id: 'foreign', repository_id: 'other', version: 9 }],
    approvals: [{ id: 'foreign-approval', artifact_id: 'foreign', state: 'stale' }] });
  expect(screen.getByText('Saved diff unavailable. Content may not have been retained.')).toBeTruthy();
  expect(screen.queryByRole('article', { name: 'Approval foreign-approval' })).toBeNull();
  expect(screen.getByLabelText('Version').querySelectorAll('option')).toHaveLength(1);
});

it('parses header-like content, multiple hunks, deleted and binary files, and compares patches accurately', () => {
  const patch = PATCH.replace('+new', '+++ literal') + 'diff --git a/deleted.txt b/deleted.txt\n--- a/deleted.txt\n+++ /dev/null\n@@ -8 +0,0 @@\n-gone\n'
    + 'diff --git a/picture.png b/picture.png\nBinary files a/picture.png and b/picture.png differ\n';
  const files = parseDiff(patch);
  expect(files.map(file => file.path)).toEqual(['code.txt', 'deleted.txt', 'picture.png']);
  expect(files[0].lines.find(line => line.kind === 'add')).toMatchObject({ text: '++ literal', newLine: 2 });
  expect(files[1].lines.at(-1)).toMatchObject({ oldLine: 8, text: 'gone' });
  const comparison = comparePatches(PATCH, NEXT)[0];
  expect(comparison.lines.filter(line => line.kind === 'remove').map(line => line.text)).toEqual(['+new']);
  expect(comparison.lines.filter(line => line.kind === 'add').map(line => line.text)).toEqual(['+fixed']);
  expect(comparePatches(PATCH, PATCH)).toEqual([]);
});

it('blocks duplicate return before projection updates, but allows a finding remapped to the next version', async () => {
  const { client, target } = setup({ findings: [finding('one')] });
  fireEvent.click(screen.getByLabelText('Select finding one'));
  fireEvent.click(screen.getByRole('button', { name: 'Return selected to agent' }));
  await waitFor(() => expect((screen.getByLabelText('Select finding one') as HTMLInputElement).disabled).toBe(true));
  expect(client.command).toHaveBeenCalledTimes(1);
  act(() => target.setSnapshot({ seq: 2, generation: 1, projection: {
    ...target.getSnapshot().projection,
    artifacts: [artifact, { ...artifact, id: 'a2', previous_artifact_id: 'a1', version: 2, patch_hash: 'hash2', diff: NEXT }],
    findings: [{ ...finding('one', 'needs_check'), artifact_id: 'a2', version: 2 }],
  } }));
  expect((screen.getByLabelText('Select finding one') as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByLabelText('Select finding one'));
  fireEvent.click(screen.getByRole('button', { name: 'Return selected to agent' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('review.send', { artifactId: 'a2', findingIds: ['one'] }));
});

it('follows resumed execution successors even when version numbering restarts', () => {
  setup({ artifacts: [{ ...artifact, version: 4 }, { ...artifact, id: 'resumed', run_id: 'resumed-run', version: 1, previous_artifact_id: 'a1', patch_hash: 'hash2', diff: NEXT }] });
  expect((screen.getByLabelText('Version') as HTMLSelectElement).value).toBe('resumed');
  expect(screen.getByRole('button', { name: 'Comment on code.txt new line 2' }).textContent).toBe('fixed');
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'a1' } });
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows failed acceptance output, scope violations, real reviewer assignment and finding verification cmds', async () => {
  const { client } = setup({ artifacts: [{ ...artifact, verification: { passed: false, results: [{ command: 'exit 1', exitCode: 1, output: 'Acceptance failed' }], scopeViolations: ['outside.ts'] } }],
    findings: [finding('fixed', 'fixed')], approvals: [{ id: 'rejected', artifact_id: 'a1', patch_hash: 'hash1', state: 'rejected',
      request: { result: { verdict: 'reject', comment: 'Fix acceptance first' }, reviewer: { executor: 'claude', model: 'sonnet', family: 'anthropic' } } }] });
  expect(screen.getByText('Scope violations: outside.ts')).toBeTruthy();
  expect(screen.getByText('Reviewer: claude sonnet (anthropic) · reject')).toBeTruthy();
  fireEvent.click(screen.getByText('exit 1 · Failed'));
  expect(screen.getByText('Acceptance failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Verify finding' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('review.finding_state', { findingId: 'fixed', state: 'verified' }));
});
