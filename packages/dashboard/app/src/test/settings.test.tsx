import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultConfig, defaultProject } from '../../../../core/src/settings/index.ts';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { loadAppearance, type SettingsSnapshot, type SettingsStatus } from '../lib/settings.ts';
import { PREFERENCES_KEY } from '../components/notifications/model.ts';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';

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

it('edits and saves model assignments from the production settings route', async () => {
  const f = createFixture();
  render(<MemoryRouter initialEntries={['/settings']}><App client={f.client}/></MemoryRouter>);
  await screen.findByRole('region', { name: 'Model assignment settings' });
  expect(screen.getByLabelText('Theme')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Heavy Edit assignment' }));
  fireEvent.change(screen.getByLabelText('Implementation Heavy 1 Model'), { target: { value: 'custom-astra' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' }));
  await screen.findByRole('region', { name: 'Policy preview' });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({
    store: 'policy', previewToken: 'preview-token', patch: expect.objectContaining({
      roles: expect.objectContaining({ implement: expect.objectContaining({ heavy: expect.arrayContaining([expect.objectContaining({ model: 'custom-astra' })]) }) }),
    }),
  })));
});
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
it.each(['en', 'ja'] as const)('warns that existing payload deletion needs separate confirmation in %s', async language => {
  const f = createFixture();
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (name, payload) => name === 'settings.write'
    ? { type: 'ack', cmd_id: name, ok: true, result: { saved: true, existingPayloadDeletion: 'requires_confirmation' } }
    : original(name, payload));
  render(<SettingsPage client={f.client} language={language}/>);
  const ja = language === 'ja';
  const retention = await screen.findByLabelText(ja ? 'storage · 本文の保持日数' : 'storage · Body retention days');
  fireEvent.change(retention, { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: ja ? '個人の設定を保存' : 'Save personal settings' }));
  const warning = await screen.findByText(ja
    ? '保存しました。既存の本文は未削除。別の確認が必要です。'
    : 'Saved. Existing payloads have not been deleted; separate confirmation is required.');
  expect(warning.getAttribute('role')).toBe('status');
  expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({
    store: 'config', patch: expect.objectContaining({ storage: expect.objectContaining({ bodyRetentionDays: 30 }) }),
  }));
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
  render(<SettingsPage client={f.client}/>); await screen.findByText(/Invalid redaction pattern/);
  expect(screen.queryByText(/Previous valid settings remain active/)).toBeNull();
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
  const f = createFixture(); render(<SettingsPage client={f.client}/>); await screen.findByRole('button', { name: 'Implementation Standard Edit assignment' });
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Standard Edit assignment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Standard Refresh codex models' })); await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.models', { provider: 'codex' }));
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

it('edits weighted assignments, candidate order, criteria and model notes then saves the previewed policy', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  const assignments = await screen.findByRole('region', { name: 'Model assignment settings' });
  expect(within(assignments).queryByText(/On limits or errors, switch to/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Heavy Edit assignment' }));
  expect(within(assignments).queryByText('Top performance on SWE-bench.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Edit criteria' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Implementation Heavy 1 Effort' })).getByRole('button', { name: 'max' }));
  fireEvent.change(screen.getByLabelText('Implementation Heavy Weight criteria'), { target: { value: 'Changes across packages' } });
  fireEvent.click(screen.getByLabelText('Implementation Heavy 2 Move up'));
  expect(screen.getByLabelText('Implementation Heavy 1 Model')).toHaveProperty('value', 'opus');
  fireEvent.click(screen.getByLabelText('Implementation Heavy Add fallback model'));
  fireEvent.change(screen.getByLabelText('Implementation Heavy 3 Provider'), { target: { value: 'antigravity' } });
  fireEvent.change(screen.getByLabelText('Implementation Heavy 3 Model'), { target: { value: 'manual-gemini' } });
  fireEvent.click(screen.getByLabelText('Implementation Heavy 2 Remove'));
  fireEvent.change(screen.getByLabelText('Model note 1 strength'), { target: { value: 'Strong implementation' } });
  fireEvent.click(screen.getByLabelText('Model note 1 latest'));
  fireEvent.click(screen.getByRole('button', { name: 'Advisor Light Edit assignment' }));
  fireEvent.change(screen.getByLabelText('Advisor Light 1 Model'), { target: { value: 'sonnet' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' })); await screen.findByText('claude · after-model');
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' })); await screen.findByText('Saved');
  const save = f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] };
  const roles = save.patch.roles;
  expect(roles.implement).toMatchObject({ heavy: [{ executor: 'claude', model: 'opus' }, { executor: 'antigravity', model: 'manual-gemini', family: 'google' }] });
  expect(roles.advisor).toMatchObject({ light: [{ model: 'sonnet' }] });
  expect(save.patch.criteria.implement?.heavy).toBe('Changes across packages');
  expect(save.patch.modelNotes[0]).toMatchObject({ latest: true, strength: 'Strong implementation' });
});
it('supports drag reordering and standard inheritance with Japanese labels and provider catalogs', async () => {
  const f = createFixture(); const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (name, payload) => name === 'settings.models' ? { type: 'ack', cmd_id: name, ok: true, result: { state: 'known', models: [{ model: `${(payload as { provider: string }).provider}-listed`, displayName: 'Listed model' }] } } : original(name, payload));
  render(<SettingsPage client={f.client} language="ja"/>); await screen.findByRole('region', { name: 'モデル割り当て設定' });
  fireEvent.click(screen.getByRole('button', { name: '実装 高負荷 割り当てを編集' }));
  const model = screen.getByLabelText('実装 高負荷 1 モデル') as HTMLInputElement;
  await screen.findByRole('list', { name: '実装 高負荷 1 モデルの一覧' });
  expect(screen.getAllByRole('button', { name: 'Listed model' })).toHaveLength(3);
  const [first, second] = document.querySelectorAll('.assignment-candidates > li');
  fireEvent.dragStart(first); fireEvent.dragOver(second); fireEvent.drop(second);
  expect(screen.getByLabelText('実装 高負荷 1 モデル')).toHaveProperty('value', 'opus');
  fireEvent.click(screen.getByLabelText('実装 高負荷 標準モデルを使用'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: '実装 高負荷 割り当てを編集' }).textContent).toBe('標準モデルを使用');
  fireEvent.click(screen.getByRole('button', { name: '割り当てを試算' })); await screen.findByText('claude · after-model');
  fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' })); await screen.findByText('保存しました');
  const save = f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] };
  expect(save.patch.roles.implement).not.toHaveProperty('heavy');
});

it('shows eight roles, lets the root select every provider, and folds fallback candidates', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  const region = await screen.findByRole('region', { name: 'Model assignment settings' });
  const table = region.querySelector('.assignment-table')!;
  expect(table.querySelectorAll('tbody > tr')).toHaveLength(8);
  expect([...table.querySelectorAll('tbody > tr > th')].map(cell => cell.querySelector('.assignment-role > span')?.textContent)).toEqual(['Main agent', 'Advisor', 'Research', 'Implementation', 'Documentation', 'Code review', 'Verification', 'Proofreading']);
  expect(screen.queryByText('Planning')).toBeNull();
  expect(screen.queryByLabelText('Implementation Standard 2 Model')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Main agent Standard Edit assignment' }));
  const root = screen.getByLabelText('Main agent Standard 1 Provider');
  fireEvent.change(root, { target: { value: 'antigravity' } });
  expect(root).toHaveProperty('value', 'antigravity');
  fireEvent.change(root, { target: { value: 'codex' } });
  expect(root).toHaveProperty('value', 'codex');
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Standard Edit assignment' }));
  expect(screen.queryByText('Available models: Unknown')).toBeNull();
  expect(screen.getByLabelText('Implementation Standard Refresh codex models').textContent).toBe('↻');
});

it('previews provider file diffs and requires confirmation before applying each provider', async () => {
  const f = createFixture(); const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (name, payload) => {
    if (name === 'settings.previewProvider') {
      const provider = (payload as { provider: string }).provider;
      return { type: 'ack', cmd_id: name, ok: true, result: { token: `token-${provider}`, provider, files: [{ path: `/fixture/${provider}/settings`, diff: '-model: old\n+model: new' }], ...(provider === 'antigravity' ? { mcpCommand: 'agy mcp add agent-graph -- node shim.ts' } : {}) } };
    }
    if (name === 'settings.applyProvider') return { type: 'ack', cmd_id: name, ok: true, result: { applied: true } };
    return original(name, payload);
  });
  render(<SettingsPage client={f.client}/>); await screen.findByRole('button', { name: 'Apply to configuration files' });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to configuration files' }));
  for (const provider of ['claude', 'codex', 'antigravity']) await screen.findByText(`/fixture/${provider}/settings`);
  expect(screen.getAllByText(/-model: old/)).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Confirm and apply' })).toHaveProperty('disabled', true);
  expect(f.command.mock.calls.some(([command]) => command === 'settings.applyProvider')).toBe(false);
  expect(screen.getByText('agy mcp add agent-graph -- node shim.ts')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Update the Claude Code, Codex and Antigravity configuration files. Continue?'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
  for (const provider of ['claude', 'codex', 'antigravity']) await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.applyProvider', { token: `token-${provider}`, provider, confirmation: true }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Provider changes' })).toBeNull());
});

it('shows catalog display names and efforts in assignment buttons even before or without a catalog match', async () => {
  const f = createFixture();
  const original = f.command.getMockImplementation()!;
  let deliver!: () => void;
  f.command.mockImplementation(async (name, payload) => {
    if (name !== 'settings.models' || (payload as { provider: string }).provider !== 'codex') return original(name, payload);
    await new Promise<void>(resolve => { deliver = resolve; });
    return { type: 'ack', cmd_id: name, ok: true, result: { state: 'known', models: [{ model: 'gpt-6-astra', displayName: 'GPT-6 Astra' }] } };
  });
  // 遅い一覧でも保存済みの識別子を表示する。
  render(<SettingsPage client={f.client} policyOnly/>);
  const button = await screen.findByRole('button', { name: 'Implementation Standard Edit assignment' });
  expect(button.textContent).toContain('gpt-6-astra');
  expect(button.textContent).toContain('high');
  expect(screen.queryByLabelText('Implementation Standard 1 Model')).toBeNull();
  deliver();
  await waitFor(() => expect(button.textContent).toContain('GPT-6 Astra'));
  expect(screen.getByRole('button', { name: 'Main agent Standard Edit assignment' }).textContent).toContain('opus');
  expect(screen.getByRole('button', { name: 'Main agent Standard Edit assignment' }).textContent).toContain('Default');
  expect(document.querySelector('.assignment-settings.settings-page')).toBeTruthy();
});

it('closes the editor with Escape or outside presses and omits fallback descriptions', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  const assignments = await screen.findByRole('region', { name: 'Model assignment settings' });
  const advisor = screen.getByRole('button', { name: 'Advisor Light Edit assignment' });
  expect(advisor.textContent).toBe('Use standard model');
  expect(advisor.closest('td')?.querySelector('.assignment-count')).toBeNull();
  fireEvent.click(advisor);
  expect(screen.getByRole('dialog', { name: 'Advisor Light Assignment' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Advisor Light 1 Model'), { target: { value: 'custom-model' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(advisor);
  expect(advisor.textContent).toContain('custom-model');
  fireEvent.click(advisor);
  fireEvent.click(screen.getByLabelText('Advisor Light Add fallback model'));
  fireEvent.click(within(screen.getByRole('list', { name: 'Advisor Light 2 Available models' })).getByRole('button', { name: 'opus' }));
  expect(advisor.closest('td')?.querySelector('.assignment-count')).toBeNull();
  fireEvent.click(screen.getByLabelText('Advisor Light 2 Remove'));
  expect(advisor.closest('td')?.querySelector('.assignment-count')).toBeNull();
  fireEvent.pointerDown(within(assignments).getByRole('heading'));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(advisor);
  fireEvent.click(screen.getByLabelText('Advisor Light Use standard model'));
  expect(advisor.textContent).toBe('Use standard model');
  fireEvent.click(screen.getByRole('button', { name: 'Advisor Standard Edit assignment' }));
  expect(screen.queryByRole('button', { name: 'Advisor Standard Use standard model' })).toBeNull();
});

it('omits weight criteria summaries and keeps each band editable', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client} language="ja"/>);
  await screen.findByRole('region', { name: 'モデル割り当て設定' });
  expect(screen.queryByRole('button', { name: 'メインエージェント 基準を編集' })).toBeNull();
  const edit = screen.getByRole('button', { name: '実装 基準を編集' });
  expect(edit.closest('th')!.querySelector('.assignment-criteria-summary')).toBeNull();
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText('実装 軽量 重さの基準'), { target: { value: '小さな変更' } });
  fireEvent.change(screen.getByLabelText('実装 標準 重さの基準'), { target: { value: '機能の追加' } });
  fireEvent.change(screen.getByLabelText('実装 高負荷 重さの基準'), { target: { value: '設計の変更' } });
  expect(edit.closest('th')!.querySelector('.assignment-criteria-summary')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '完了' }));
  expect(screen.queryByLabelText('実装 軽量 重さの基準')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '割り当てを試算' }));
  await screen.findByRole('region', { name: '割り当ての試算' });
  fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' }));
  await screen.findByText('保存しました');
  const save = f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] };
  expect(save.patch.criteria.implement).toEqual({ light: '小さな変更', standard: '機能の追加', heavy: '設計の変更' });
});

it('selects catalog models without latest and strength descriptions', async () => {
  const f = createFixture();
  const original = f.command.getMockImplementation()!;
  f.value.policy.modelNotes[0].latest = true;
  f.command.mockImplementation(async (name, payload) => name === 'settings.models' && (payload as { provider: string }).provider === 'codex' ? { type: 'ack', cmd_id: name, ok: true, result: { state: 'known', models: [{ model: 'gpt-6-astra', displayName: 'GPT-6 Astra' }, { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }] } } : original(name, payload));
  render(<SettingsPage client={f.client}/>);
  await screen.findByRole('button', { name: 'Implementation Standard Edit assignment' });
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Standard Edit assignment' }));
  const choices = await screen.findByRole('list', { name: 'Implementation Standard 1 Available models' });
  const astra = within(choices).getByRole('button', { name: 'GPT-6 Astra' });
  expect(astra.querySelector('small')).toBeNull();
  fireEvent.click(within(choices).getByRole('button', { name: 'GPT-6.1 Sol' }));
  expect(screen.getByLabelText('Implementation Standard 1 Model')).toHaveProperty('value', 'gpt-6.1-sol');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Implementation Standard Edit assignment' }).textContent).toContain('GPT-6.1 Sol');
});

it.each(['Performance', 'Balanced', 'Economy'])('keeps %s preset changes unsaved until the existing preview and save flow', async preset => {
  const f = createFixture();
  f.value.policy.roles.implement = { light: [{ executor: 'codex', model: 'gpt-6.1-sol', effort: 'low', family: 'openai', tier: 'mid' }], standard: [{ executor: 'claude', model: 'custom-opus', family: 'anthropic', tier: 'high' }], heavy: [{ executor: 'codex', model: 'gpt-6-astra', effort: 'xhigh', family: 'openai', tier: 'high' }] };
  render(<SettingsPage client={f.client} policyOnly/>);
  await screen.findByRole('button', { name: preset });
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' }));
  await screen.findByRole('region', { name: 'Policy preview' });
  fireEvent.click(screen.getByRole('button', { name: preset }));
  expect(screen.getByRole('dialog', { name: 'Preset changes' })).toBeTruthy();
  expect(f.command.mock.calls.some(([name]) => name === 'settings.write')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm changes' }));
  expect(screen.queryByRole('region', { name: 'Policy preview' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);
  expect(f.command.mock.calls.some(([name]) => name === 'settings.write')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' }));
  await screen.findByRole('region', { name: 'Policy preview' });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await screen.findByText('Saved');
  const patch = (f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] }).patch;
  const role = patch.roles.implement;
  expect(Array.isArray(role)).toBe(false);
  if (!Array.isArray(role)) expect(role.standard?.[0].model).toBe(preset === 'Economy' ? 'gpt-6.1-sol' : 'gpt-6-astra');
});

it('shows the exact Japanese confirmation after loading all three provider diffs', async () => {
  const f = createFixture(); const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (name, payload) => name === 'settings.previewProvider' ? { type: 'ack', cmd_id: name, ok: true, result: { provider: (payload as { provider: string }).provider, token: 'token', files: [] } } : original(name, payload));
  render(<SettingsPage client={f.client} language="ja"/>);
  fireEvent.click(await screen.findByRole('button', { name: '設定ファイルに反映' }));
  expect(await screen.findByLabelText('Claude Code、Codex、Antigravity の設定ファイルを更新します。よろしいですか？')).toBeTruthy();
  expect(screen.getByRole('button', { name: '確認して反映' })).toHaveProperty('disabled', true);
  for (const provider of ['claude', 'codex', 'antigravity']) expect(f.command).toHaveBeenCalledWith('settings.previewProvider', { provider });
  expect(f.command.mock.calls.some(([name]) => name === 'settings.applyProvider')).toBe(false);
});

it('retains only unfinished provider diffs after an apply failure so retry does not reuse completed tokens', async () => {
  const f = createFixture(); const original = f.command.getMockImplementation()!;
  let failed = false;
  f.command.mockImplementation(async (name, payload) => {
    const provider = (payload as { provider?: string } | undefined)?.provider;
    if (name === 'settings.previewProvider') return { type: 'ack', cmd_id: name, ok: true, result: { provider, token: `token-${provider}`, files: [{ path: `/fixture/${provider}`, diff: '+model: new' }] } };
    if (name === 'settings.applyProvider') {
      if (provider === 'codex' && !failed) { failed = true; return { type: 'ack', cmd_id: name, ok: false, error: 'Codex file is locked', result: undefined }; }
      return { type: 'ack', cmd_id: name, ok: true, result: { applied: true } };
    }
    return original(name, payload);
  });
  render(<SettingsPage client={f.client} policyOnly/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Apply to configuration files' }));
  await screen.findByText('/fixture/claude');
  fireEvent.click(screen.getByLabelText('Update the Claude Code, Codex and Antigravity configuration files. Continue?'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
  await screen.findByText('Codex file is locked');
  expect(screen.queryByText('/fixture/claude')).toBeNull();
  expect(screen.getByText('/fixture/codex')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
  await screen.findByText('Applied');
  const calls = f.command.mock.calls.filter(([name]) => name === 'settings.applyProvider').map(([, payload]) => (payload as { provider: string }).provider);
  expect(calls).toEqual(['claude', 'codex', 'codex', 'antigravity']);
});

it.each(['en', 'ja'] as const)('renders settings without explanatory paragraphs or field hints in %s', async language => {
  const f = createFixture();
  const { container } = render(<SettingsPage client={f.client} language={language}/>);
  await screen.findByRole('region', { name: language === 'ja' ? 'エージェントとモデル' : 'Agents and models' });
  expect(container.querySelector('.page-subtitle')).toBeNull();
  expect(container.querySelector('.settings-section header p, .settings-section header code')).toBeNull();
  expect(container.querySelector('.assignment-note, .assignment-role-description, .assignment-count, .assignment-criteria-summary')).toBeNull();
  expect(container.textContent).not.toContain(language === 'ja' ? '次の実行から反映します。' : 'Applies to the next execution.');
  expect(container.textContent).not.toContain(language === 'ja' ? 'このブラウザで即座に反映します。' : 'Applies immediately to this browser.');
  fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '性能重視' : 'Performance' }));
  expect(screen.getByRole('dialog').querySelector('.assignment-note')).toBeNull();
});
