import { SshSettings } from '../components/SshSettings.tsx';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { trackReloadInputs } from '../lib/reload-inputs.ts';
import { isDashboardAutoReloadBlocked } from '../lib/reload-guard.ts';
import { getFileDocument } from '../lib/file-documents.ts';
import { holdDashboardReload } from '../lib/reload-safety.ts';

let dispose = () => {};
afterEach(() => { dispose(); cleanup(); sessionStorage.clear(); });
function track() { const inputs = trackReloadInputs(document); dispose = inputs.dispose; return inputs; }
it.each(['input', 'textarea', 'checkbox', 'editable'])('protects changed %s until reverted or unmounted', kind => {
  const inputs = track();
  const element = document.createElement(kind === 'editable' ? 'div' : kind === 'checkbox' ? 'input' : kind);
  if (kind === 'editable') { element.contentEditable = 'true'; element.setAttribute('contenteditable', 'true'); element.textContent = 'original'; }
  else if (element instanceof HTMLInputElement) { element.type = kind === 'checkbox' ? 'checkbox' : 'text'; element.value = 'original'; }
  else if (element instanceof HTMLTextAreaElement) element.value = 'original';
  document.body.append(element);
  fireEvent.focusIn(element);
  expect(inputs.isBlocked()).toBe(false);
  if (kind === 'editable') { element.textContent = 'edited'; fireEvent.input(element); }
  else if (kind === 'checkbox') fireEvent.click(element);
  else fireEvent.input(element, { target: { value: 'edited' } });
  expect(inputs.isBlocked()).toBe(true);
  if (kind === 'editable') { element.textContent = 'original'; fireEvent.input(element); }
  else if (kind === 'checkbox') fireEvent.click(element);
  else fireEvent.input(element, { target: { value: 'original' } });
  expect(inputs.isBlocked()).toBe(false);
  element.remove(); expect(inputs.isBlocked()).toBe(false);
});
it('remembers controlled values before React updates defaultValue and ignores removed editors', () => {
  const inputs = track();
  function Editor() { const [value, setValue] = useState('original'); return <input value={value} onChange={event => setValue(event.target.value)}/>; }
  const view = render(<Editor/>);
  const input = view.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'edited' } });
  expect(input).toHaveProperty('defaultValue', 'edited');
  expect(inputs.isBlocked()).toBe(true);
  view.unmount(); expect(inputs.isBlocked()).toBe(false);
});
it('blocks open dialogs, including empty SessionCreate and ProjectAdd forms', () => {
  const inputs = track();
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
  expect(inputs.isBlocked()).toBe(true);
  dialog.hidden = true; expect(inputs.isBlocked()).toBe(false);
  dialog.hidden = false; dialog.style.display = 'none'; expect(inputs.isBlocked()).toBe(false);
  dialog.remove(); expect(inputs.isBlocked()).toBe(false);
});
it('excludes a conversation draft only when its current value is actually saved', () => {
  const inputs = track();
  const input = document.createElement('textarea'); input.dataset.conversationDraft = 'test'; document.body.append(input);
  fireEvent.focusIn(input); fireEvent.input(input, { target: { value: 'saved draft' } });
  expect(inputs.isBlocked()).toBe(true);
  sessionStorage.setItem('agent-graph-conversation-draft:test', 'saved draft'); expect(inputs.isBlocked()).toBe(false);
  fireEvent.input(input, { target: { value: 'unsaved change' } }); expect(inputs.isBlocked()).toBe(true);
  input.remove();
});
it('composes the unsaved file guard even when every other condition allows reload', async () => {
  const client = { canReload: () => true, command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'read', ok: true,
    result: { state: 'text', content: 'original', hash: 'hash', editable: true } })) };
  const inputs = track();
  const document = getFileDocument(client, { projectId: 'p', path: 'file.ts' }); await document.refresh();
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
  document.edit('unsaved file'); expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(true);
  document.discard(); expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
});
it('composes operation holds and generic inputs independently', () => {
  const client = { canReload: () => true, command: vi.fn() };
  const inputs = track();
  const release = holdDashboardReload();
  try { expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(true); } finally { release(); }
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
  const input = document.createElement('input'); document.body.append(input);
  fireEvent.change(input, { target: { value: 'Keep this setting' } });
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(true);
  input.remove(); expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
});

it('protects SSH additions without typed input and releases after saving', async () => {
  const inputs = track();
  const client = { canReload: () => true, command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'ssh', ok: true, result: { connections: [] } })) };
  const view = render(<SshSettings client={client} projects={[]}/>);
  await act(async () => {});
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
  fireEvent.click(view.getByRole('button', { name: 'Add connection' }));
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(true);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save' })); });
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
  fireEvent.click(view.getByRole('button', { name: 'Remove connection' }));
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(true);
  view.unmount(); expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
});
