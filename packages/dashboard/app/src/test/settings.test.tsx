import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultConfig, defaultProject } from '../../../../core/src/settings/index.ts';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { loadAppearance, type SettingsSnapshot, type SettingsStatus } from '../lib/settings.ts';
import { PREFERENCES_KEY } from '../components/notifications/model.ts';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function createFixture() {
  const value: SettingsSnapshot = { config: defaultConfig(), policy: defaultPolicy(), project: defaultProject(), errors: {}, apiKeyConfigured: false };
  const status: SettingsStatus = { hosts: { claude: { state: 'ready', version: 'sdk-test', authentication: 'subscription', degraded: ['fork'] }, codex: { state: 'unknown', version: null, authentication: null, degraded: [] } },
    connection: { runner: true, protocolVersion: 1, apiVersion: '2', updatePending: true }, observation: { formats: ['jsonl', 'legacy'], unsupportedCount: 2 },
    rebuild: { state: 'idle', completed: 0, total: 0 }, logs: { runner: '/state/runner.log', api: '/state/api.log' } };
  const command = vi.fn(async (name: string, payload?: unknown) => {
    let result: unknown;
    if (name === 'settings.read') result = structuredClone(value);
    else if (name === 'settings.status') result = structuredClone(status);
    else if (name === 'settings.models') result = { state: 'unknown', models: [] };
    else if (name === 'settings.previewPolicy') result = { token: 'preview-token', rows: [{ id: 'past-delegation', before: { ok: true, assignment: { executor: 'codex', model: 'before-model' } }, after: { ok: true, assignment: { executor: 'claude', model: 'after-model' } } }] };
    else if (name === 'settings.apiKey') result = { configured: !(payload as { remove?: boolean }).remove };
    else if (name === 'settings.write') result = { saved: true };
    else if (name === 'settings.rebuild') { result = { started: true }; status.rebuild = { state: 'running', completed: 2, total: 5 }; }
    return { type: 'ack' as const, cmd_id: name, ok: true, result };
  });
  return { value, status, command, client: { command } };
}

it('renders all eight sections, file settings and live diagnostics with English defaults', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  await screen.findByRole('region', { name: 'Agents and models' });
  for (const name of ['Assignment policy', 'Projects', 'Notifications', 'Storage and redaction', 'Runner and API status', 'Keyboard shortcuts', 'Appearance']) expect(screen.getByRole('region', { name })).toBeTruthy();
  for (const name of ['agents · claude · Default model', 'agents · codex · Default effort', 'quota · Quota soft limit (%)', 'performance · Minimum performance samples', 'acceptance · Acceptance commands', 'scope · Scope exclusions', 'storage · redaction · Additional redaction patterns', 'keys · command']) expect(screen.getByLabelText(name)).toBeTruthy();
  expect(screen.getByText(/sdk-test/)).toBeTruthy(); expect(screen.getByText(/jsonl, legacy/)).toBeTruthy(); expect(screen.getByText('/state/api.log')).toBeTruthy();
  expect(screen.getByLabelText('theme')).toHaveProperty('value', 'system'); expect(screen.getByLabelText('language')).toHaveProperty('value', 'en');
});
it('saves personal and project settings through cmd without browser preferences', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByLabelText('dashboard · API port');
  fireEvent.change(screen.getByLabelText('dashboard · API port'), { target: { value: '7501' } });
  fireEvent.change(screen.getByLabelText('notifications · Quiet hours start'), { target: { value: '21:00' } });
  fireEvent.change(screen.getByLabelText('keys · command'), { target: { value: 'Cmd+P' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save personal settings' })); await screen.findByText('Saved');
  expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({ store: 'config', patch: expect.objectContaining({ dashboard: { port: 7501 }, keys: expect.objectContaining({ command: 'Cmd+P' }) }) }));
  fireEvent.change(screen.getByLabelText('acceptance · Acceptance commands'), { target: { value: 'node --run test\nnode --run build' } });
  fireEvent.change(screen.getByLabelText('scope · Scope exclusions'), { target: { value: 'private\n.env' } });
  fireEvent.change(within(screen.getByRole('region', { name: 'Projects' })).getByLabelText('isolation · Isolation policy'), { target: { value: 'read-only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({ store: 'project', patch: { isolation: { policy: 'read-only' }, acceptance: { commands: ['node --run test', 'node --run build'] }, scope: { exclude: ['private', '.env'] } } })));
  expect(JSON.stringify(f.command.mock.calls.filter(([name]) => name === 'settings.write'))).not.toContain('density');
});
it('requires policy preview, shows historical outcomes and invalidates preview after edits', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByRole('button', { name: 'Save policy' });
  expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('quota · Quota hard limit (%)'), { target: { value: '95' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' })); await screen.findByText('claude · after-model');
  expect(screen.getByText('codex · before-model')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('performance · Minimum performance samples'), { target: { value: '30' } });
  expect(screen.queryByRole('region', { name: 'Policy preview' })).toBeNull(); expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' })); await screen.findByText('claude · after-model');
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' })); await screen.findByText('Saved');
  expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({ store: 'policy', previewToken: 'preview-token', patch: expect.objectContaining({ quota: { softLimitPercent: 70, hardLimitPercent: 95 } }) }));
});
it('shows API validation and manual edit errors while retaining edited values', async () => {
  const f = createFixture(); f.value.errors.config = 'Invalid redaction pattern';
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (name, payload) => name === 'settings.write' ? { type: 'ack', cmd_id: name, ok: false, error: 'Duplicate key binding', result: undefined } : original(name, payload));
  render(<SettingsPage client={f.client}/>); await screen.findByText(/Previous valid settings remain active/);
  fireEvent.change(screen.getByLabelText('keys · command'), { target: { value: 'j' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save personal settings' })); await screen.findByText('Duplicate key binding');
  expect(screen.getByLabelText('keys · command')).toHaveProperty('value', 'j'); expect(screen.queryByText('Saved')).toBeNull();
});
it('writes keys through the secret cmd, clears the input and never retrieves them', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByLabelText('Claude API key');
  fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'private-test-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Store API key' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.apiKey', { value: 'private-test-key' }));
  expect(screen.getByLabelText('Claude API key')).toHaveProperty('value', ''); expect(document.body.textContent).not.toContain('private-test-key');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove API key' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'Remove API key' })); await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.apiKey', { remove: true }));
});
it('saves all appearance preferences locally and switches to Japanese immediately', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByLabelText('dashboard · API port');
  const calls = f.command.mock.calls.length;
  for (const [key, value] of [['theme', 'dark'], ['density', 'compact'], ['diff', 'unified'], ['time', 'absolute'], ['language', 'ja']]) fireEvent.change(screen.getByLabelText(key), { target: { value } });
  expect(screen.getByRole('heading', { name: '設定' })).toBeTruthy(); expect(screen.getByRole('region', { name: '保存と秘匿' })).toBeTruthy();
  expect(loadAppearance()).toEqual({ theme: 'dark', density: 'compact', diff: 'unified', time: 'absolute', language: 'ja' });
  expect(document.documentElement.dataset.theme).toBe('dark'); expect(document.documentElement.lang).toBe('ja'); expect(f.command.mock.calls.length).toBe(calls);
});
it('saves notification routes locally and falls back when browser permission is denied', async () => {
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'denied') });
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByRole('region', { name: 'Notifications' });
  const section = screen.getByRole('region', { name: 'Notifications' });
  fireEvent.change(within(section).getByLabelText('Run completed'), { target: { value: 'browser' } });
  expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toHaveProperty('completed', 'browser');
  fireEvent.click(screen.getByRole('button', { name: 'Request browser permission' })); await screen.findByText('Browser permission denied; using in-app notifications.');
  expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toHaveProperty('completed', 'in_app');
});
it('refreshes models and starts a rebuild with visible progress', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByRole('button', { name: 'Refresh codex models' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh codex models' })); await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.models', { provider: 'codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild ledger projection' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild ledger projection' })).toHaveProperty('disabled', true));
  await waitFor(() => expect(screen.getByLabelText('Rebuild progress')).toHaveProperty('value', 2), { timeout: 3000 });
});
it('reflects watched changes without replacing unsaved edits', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByLabelText('dashboard · API port');
  f.value.config.dashboard.port = 7550;
  await waitFor(() => expect(screen.getByLabelText('dashboard · API port')).toHaveProperty('value', '7550'), { timeout: 3000 });
  fireEvent.change(screen.getByLabelText('dashboard · API port'), { target: { value: '7551' } });
  f.value.config.dashboard.port = 7552; f.value.errors.config = 'Invalid manual edit';
  await screen.findByText(/Invalid manual edit/, {}, { timeout: 3000 });
  expect(screen.getByLabelText('dashboard · API port')).toHaveProperty('value', '7551');
});

it('retains edits made while a save is pending through the next refresh', async () => {
  const f = createFixture();
  const original = f.command.getMockImplementation()!;
  let finish!: () => void;
  f.command.mockImplementation(async (name, payload) => {
    if (name === 'settings.write') {
      await new Promise<void>(resolve => { finish = resolve; });
      f.value.config.dashboard.port = 7551;
    }
    return original(name, payload);
  });
  render(<SettingsPage client={f.client}/>);
  await screen.findByLabelText('dashboard · API port');
  fireEvent.change(screen.getByLabelText('dashboard · API port'), { target: { value: '7551' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save personal settings' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('dashboard · API port'), { target: { value: '7552' } });
  finish();
  await screen.findByText('Saved');
  f.value.errors.config = 'Refresh after pending save';
  await screen.findByText(/Refresh after pending save/, {}, { timeout: 3000 });
  expect(screen.getByLabelText('dashboard · API port')).toHaveProperty('value', '7552');
});

it('discards a policy preview if the policy changes before its response', async () => {
  const f = createFixture();
  const original = f.command.getMockImplementation()!;
  let finish!: () => void;
  f.command.mockImplementation(async (name, payload) => {
    if (name === 'settings.previewPolicy') await new Promise<void>(resolve => { finish = resolve; });
    return original(name, payload);
  });
  render(<SettingsPage client={f.client}/>);
  await screen.findByRole('button', { name: 'Preview policy' });
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('quota · Quota hard limit (%)'), { target: { value: '95' } });
  finish();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview policy' })).toHaveProperty('disabled', false));
  expect(screen.queryByRole('region', { name: 'Policy preview' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);
});
