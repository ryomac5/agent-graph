import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { defaultConfig, defaultProject } from '../../../../core/src/settings/index.ts';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { SshSettings } from '../components/SshSettings.tsx';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { trackReloadInputs } from '../lib/reload-inputs.ts';
import { isDashboardAutoReloadBlocked } from '../lib/reload-guard.ts';
import { getFileDocument } from '../lib/file-documents.ts';
import { holdDashboardReload } from '../lib/reload-safety.ts';
import { MemoryRouter, useLocation } from 'react-router';
import { FileTreePanel, useFileExplorer } from '../pages/files/FilesPage.tsx';
import { createStore } from "./current-fixture.ts";
import { installPreloadRecovery } from '../lib/preload-recovery.ts';

let dispose = () => {};
afterEach(() => { dispose(); cleanup(); sessionStorage.clear(); });
function track() { const inputs = trackReloadInputs(document); dispose = inputs.dispose; return inputs; }
it.each(['text', 'email', 'url', 'number', 'tel', 'password', 'textarea'])('protects changed %s until reverted or unmounted', kind => {
  const inputs = track();
  const element = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
  if (element instanceof HTMLInputElement) element.type = kind;
  element.value = kind === 'number' ? '1' : 'original';
  const original = element.value;
  document.body.append(element);
  fireEvent.focusIn(element);
  expect(inputs.isBlocked()).toBe(false);
  fireEvent.input(element, { target: { value: kind === 'number' ? '2' : 'edited' } });
  expect(inputs.isBlocked()).toBe(true);
  fireEvent.input(element, { target: { value: original } });
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
it.each(['search', 'checkbox', 'radio', 'editable', 'select'])('ignores changed %s controls', kind => {
  const inputs = track();
  const element = document.createElement(kind === 'editable' ? 'div' : kind === 'select' ? 'select' : 'input');
  if (element instanceof HTMLInputElement) element.type = kind;
  if (element instanceof HTMLSelectElement) element.innerHTML = '<option value="original">Original</option><option value="edited">Edited</option>';
  if (kind === 'editable') { element.setAttribute('contenteditable', 'true'); element.className = 'ProseMirror'; element.textContent = 'original'; }
  document.body.append(element);
  fireEvent.focusIn(element);
  if (kind === 'editable') { element.textContent = 'edited'; fireEvent.input(element); }
  else if (kind === 'checkbox' || kind === 'radio') fireEvent.click(element);
  else fireEvent.change(element, { target: { value: 'edited' } });
  expect(inputs.isBlocked()).toBe(false);
  element.remove();
});
it.each(['self', 'parent', 'after editing'])('excludes persisted inputs marked on %s', placement => {
  const inputs = track();
  const view = render(<div><input defaultValue="original"/></div>);
  const input = view.getByRole('textbox');
  const marked = placement === 'parent' ? input.parentElement! : input;
  if (placement !== 'after editing') marked.setAttribute('data-reload-ignore', '');
  fireEvent.focusIn(input); fireEvent.change(input, { target: { value: 'persisted' } });
  if (placement === 'after editing') {
    expect(inputs.isBlocked()).toBe(true);
    marked.setAttribute('data-reload-ignore', '');
  }
  expect(inputs.isBlocked()).toBe(false);
});
it('reloads a hidden tab with a changed worktree select and search filter', async () => {
  const inputs = track();
  const target = createStore();
  const client = { canReload: () => true, command: vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'files', ok: true,
    result: name === 'files.worktrees' ? { worktree: '/repo', worktrees: [{ path: '/repo', branch: 'main', detached: false }, { path: '/feature', branch: 'feature', detached: false }] } : { entries: [] } })) };
  function Files() {
    const explorer = useFileExplorer({ client, project: 'p', target, embedded: true });
    const location = useLocation();
    return <><FileTreePanel explorer={explorer}/><output data-testid="location">{location.search}</output></>;
  }
  const view = render(<MemoryRouter><Files/></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Other worktrees · 1' }));
  const select = view.getByRole('combobox', { name: 'Worktree' });
  fireEvent.focusIn(select);
  await act(async () => fireEvent.change(select, { target: { value: '/feature' } }));
  expect(select).toHaveProperty('value', '/feature');
  expect(view.getByTestId('location').textContent).toContain('worktree=%2Ffeature');
  fireEvent.change(view.getByRole('searchbox'), { target: { value: 'temporary filter' } });
  expect(isDashboardAutoReloadBlocked(client, inputs.isBlocked)).toBe(false);
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.head.innerHTML = '<script type="module" src="/assets/old.js"></script>';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<script type="module" src="/assets/new.js"></script>' })));
  const reload = vi.fn();
  const stop = installPreloadRecovery(reload, { isBlocked: () => isDashboardAutoReloadBlocked(client, inputs.isBlocked) });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(select).toHaveProperty('value', '/feature');
  } finally {
    stop(); document.head.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
it('blocks visible dialogs even when empty and ignores hidden dialogs', () => {
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

it.each(['save', 'reload settings', 'leave page'])('protects unsaved settings checkbox in a hidden tab and releases on %s', async action => {
  const inputs = track();
  const snapshot = { config: defaultConfig(), policy: defaultPolicy(), project: defaultProject(), errors: {}, apiKeyConfigured: false };
  const client = { canReload: () => true, command: vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: name, ok: true,
    result: name === 'settings.status' ? undefined : name === 'settings.read' ? structuredClone(snapshot) : name === 'settings.models' ? { state: 'unknown', models: [] } : { saved: true } })) };
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.head.innerHTML = '<script type="module" src="/assets/old.js"></script>';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<script type="module" src="/assets/new.js"></script>' })));
  const reload = vi.fn();
  let stop = () => {};
  try {
    const view = render(<SettingsPage client={client} language="en"/>);
    await act(async () => {});
    const checkbox = view.getByRole('checkbox', { name: 'observation · Observe Claude' });
    const original = (checkbox as HTMLInputElement).checked;
    fireEvent.click(checkbox);
    expect(checkbox).toHaveProperty('checked', !original);
    expect(inputs.isBlocked()).toBe(false);
    stop = installPreloadRecovery(reload, { isBlocked: () => isDashboardAutoReloadBlocked(client, inputs.isBlocked) });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).not.toHaveBeenCalled();
    expect(checkbox).toHaveProperty('checked', !original);
    await act(async () => {
      if (action === 'leave page') view.unmount();
      else fireEvent.click(view.getByRole('button', { name: action === 'save' ? 'Save personal settings' : 'Reload settings' }));
    });
    if (action === 'save') expect(client.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({ store: 'config', patch: expect.objectContaining({ observation: expect.objectContaining({ claude: !original }) }) }));
    if (action === 'reload settings') expect(checkbox).toHaveProperty('checked', original);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    stop(); cleanup(); document.head.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
