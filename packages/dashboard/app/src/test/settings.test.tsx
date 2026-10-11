import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultConfig, defaultProject } from '../../../../core/src/settings/index.ts';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { labelSetting, labelConstraint } from '../components/settings/SettingsFields.tsx';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { loadAppearance, type SettingsSnapshot, type SettingsStatus } from '../lib/settings.ts';
import { PREFERENCES_KEY } from '../components/notifications/model.ts';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
import { readFileSync } from 'node:fs';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(['en', 'ja'] as const)('restores key storage and last-valid-value information in %s', async language => {
  const f = createFixture();
  f.value.errors.config = 'Settings application failed';
  render(<SettingsPage client={f.client} language={language}/>);
  const ja = language === 'ja';
  expect(await screen.findByText(ja ? '個人設定: 設定の反映に失敗しました' : 'config: Settings application failed')).toBeTruthy();
  expect(screen.getByText(ja ? '前の有効な値で動き続けます。' : 'Previous valid settings remain active.').tagName).toBe('SMALL');
  expect(screen.getByText(ja ? 'API の再起動で反映します。旧 daemon のポートは使えません。' : 'Applies after API restart. The legacy daemon port is not allowed.').className).toBe('settings-note');
  expect(screen.getByText(ja ? 'Keychain に保存して再表示せず、次の起動から反映します。' : 'Stored in Keychain without redisplay and applied on the next launch.')).toBeTruthy();
});
it.each(['en', 'ja'] as const)('shows translated policy labels and named constraints with full accessible names in %s', async language => {
  const f = createFixture();
  const { container } = render(<SettingsPage client={f.client} language={language}/>);
  const ja = language === 'ja';
  await screen.findByRole('button', { name: ja ? '割り当てを保存' : 'Save policy' });
  for (const heading of ja ? ['利用枠', '実績', '実績の重み', '制約'] : ['Quota', 'Track record', 'Result weights', 'Constraints']) expect(screen.getByText(heading, { selector: 'legend' }).tagName).toBe('LEGEND');
  const hardLimit = screen.getByLabelText(ja ? '利用枠 · 候補から外す使用率' : 'quota · Stop using at usage');
  const acceptance = screen.getByLabelText(ja ? '合格率' : 'Pass rate');
  expect(hardLimit.closest('label')?.textContent).toBe(ja ? '使用率が % を超えたモデルは使わない' : 'Stop using a model above % usage');
  expect(acceptance.closest('label')?.querySelector('strong')?.textContent).toBe(ja ? '合格率' : 'Pass rate');
  expect(screen.getByRole('button', { name: ja ? '制約を追加' : 'Add constraint' })).toBeTruthy();
  const rows = [...container.querySelectorAll('.settings-array-row')];
  expect(rows).toHaveLength(f.value.policy.constraints.length);
  expect(rows.length).toBeGreaterThan(0);
  rows.forEach((row, index) => {
    expect(row.querySelector('legend')).toBeNull();
    expect(screen.getByRole('group', { name: `${ja ? '制約' : 'Constraint'} ${index + 1}` })).toBe(row);
    const constraint = within(row as HTMLElement).getByLabelText(ja ? `制約 · ${index + 1} · 制約` : `constraints · ${index + 1} · Constraint`);
    fireEvent.click(constraint);
    for (const option of within(row as HTMLElement).getAllByRole('option')) {
      expect(option.textContent).toBeTruthy();
      expect(option.textContent).not.toMatch(/reviewerDifferentFamily|implementerNotOrchestrator|minTierForRole/);
    }
    expect(within(row as HTMLElement).getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(constraint, { key: 'Escape' });
  });
});
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
  await screen.findByRole('region', { name: 'Models by role' });
  expect(screen.getByLabelText('Theme')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Heavy Edit assignment' }));
  fireEvent.change(screen.getByLabelText('Implementation Heavy 1 Model'), { target: { value: 'custom-astra' } });
  fireEvent.click(within(screen.getByRole('region', { name: 'Models' })).getByRole('button', { name: 'Save' }));
  await screen.findByRole('dialog', { name: 'Review before saving' });
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Review before saving' })).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({
    store: 'policy', previewToken: 'preview-token', patch: expect.objectContaining({
      roles: expect.objectContaining({ implement: expect.objectContaining({ heavy: expect.arrayContaining([expect.objectContaining({ model: 'custom-astra' })]) }) }),
    }),
  })));
});
it.each(['en', 'ja'] as const)('opens /settings with five ordered sections and sticky navigation in %s', async language => {
  localStorage.setItem('agent-graph-language', language);
  const f = createFixture();
  const { container } = render(<MemoryRouter initialEntries={['/settings']}><App target={createStore()} client={f.client}/></MemoryRouter>);
  await screen.findByRole('region', { name: language === 'ja' ? 'モデル' : 'Models' });
  const page = container.querySelector('main > .settings-page')!;
  const ids = ['models', 'rules', 'appearance', 'ssh', 'keys'];
  const labels = language === 'ja' ? ['モデル', '選び方のルール', '表示', 'SSH の接続先', 'キーボードショートカット'] : ['Models', 'Selection rules', 'Appearance', 'SSH connections', 'Keyboard shortcuts'];
  const sections = [...page.querySelectorAll<HTMLElement>('[id^="settings-"]')];
  expect(sections.map(section => section.id)).toEqual(ids.map(id => 'settings-' + id));
  expect(sections.map(section => section.querySelector('h2')?.textContent)).toEqual(labels);
  for (const id of ['rules', 'ssh', 'keys']) expect(page.querySelector('#settings-' + id)).toHaveProperty('open', false);
  expect(page.querySelectorAll('select')).toHaveLength(0);
  const nav = within(page as HTMLElement).getByRole('navigation', { name: language === 'ja' ? '設定の節' : 'Settings sections' });
  expect(nav.className).toBe('settings-nav');
  expect(nav.previousElementSibling?.querySelector('h1')?.textContent).toBe(language === 'ja' ? '設定' : 'Settings');
  const css = readFileSync('app/src/pages/settings/settings.css', 'utf8');
  const navRule = css.match(/\.settings-nav\s*\{([^}]+)\}/)![1];
  expect(navRule).toMatch(/position:\s*sticky\s*;/);
  expect(navRule).toMatch(/top:\s*0\s*;/);
  const buttons = within(nav).getAllByRole('button');
  expect(buttons.map(button => button.textContent)).toEqual(labels);
  expect(buttons[0].getAttribute('aria-current')).toBe('location');
  for (const [index, section] of sections.entries()) {
    const scroll = vi.fn();
    Object.defineProperty(section, 'scrollIntoView', { configurable: true, value: scroll });
    fireEvent.click(buttons[index]);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'start' });
    if (section instanceof HTMLDetailsElement) expect(section.open).toBe(true);
    expect(buttons[index].getAttribute('aria-current')).toBe('location');
    expect(buttons.filter(button => button.hasAttribute('aria-current'))).toEqual([buttons[index]]);
    expect(buttons[index].className).toBe('btn btn-ghost');
  }
  expect(page.querySelectorAll('h2')).toHaveLength(5);
  expect(within(page as HTMLElement).queryByRole('button', { name: /Save personal settings|個人の設定を保存/ })).toBeNull();
});
it('renders all eight sections, file settings and live diagnostics with English defaults', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  await screen.findByRole('region', { name: 'Agents and models' });
  for (const name of ['Assignment policy', 'Projects', 'Notifications', 'Storage and redaction', 'Runner and API status', 'Keyboard shortcuts', 'Appearance']) expect(screen.getByRole('region', { name })).toBeTruthy();
  for (const name of ['agents · claude · Default model', 'agents · codex · Default effort', 'quota · Deprioritize at usage', 'performance · Results needed to rank', 'acceptance · Acceptance commands', 'scope · Scope exclusions', 'storage · redaction · Additional redaction patterns', 'keys · command']) expect(screen.getByLabelText(name)).toBeTruthy();
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
  fireEvent.click(within(screen.getByRole('region', { name: 'Projects' })).getByLabelText('isolation · Isolation policy')); fireEvent.click(screen.getByRole('option', { name: 'read-only' }));
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
  fireEvent.change(screen.getByLabelText('quota · Stop using at usage'), { target: { value: '95' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview policy' })); await screen.findByText('claude · after-model');
  expect(screen.getByText('codex · before-model')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('performance · Results needed to rank'), { target: { value: '30' } });
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
  expect(screen.getByText('Previous valid settings remain active.')).toBeTruthy();
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
  expect(screen.getByRole('heading', { name: '設定' })).toBeTruthy(); expect(screen.getByRole('region', { name: 'データの保存とマスキング' })).toBeTruthy();
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
  fireEvent.change(screen.getByLabelText('quota · Stop using at usage'), { target: { value: '95' } });
  finish();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview policy' })).toHaveProperty('disabled', false));
  expect(screen.queryByRole('region', { name: 'Policy preview' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);
});

it('edits weighted assignments, candidate order, criteria and model notes then saves the previewed policy', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client} policyOnly/>); await openRules();
  await openRules();
  const assignments = await screen.findByRole('region', { name: 'Models by role' });
  expect(within(assignments).getAllByText(/Backup /)).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Heavy Edit assignment' }));
  expect(within(assignments).getByText('Top performance on SWE-bench.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit workload criteria for Implementation' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Implementation Heavy 1 Effort' })).getByRole('button', { name: 'max' }));
  fireEvent.change(screen.getByLabelText('Implementation Heavy Weight criteria'), { target: { value: 'Changes across packages' } });
  { const rows = document.querySelectorAll('.assignment-candidates > li'); fireEvent.dragStart(rows[1]); fireEvent.dragOver(rows[0]); fireEvent.drop(rows[0]); }
  expect(screen.getByLabelText('Implementation Heavy 1 Model')).toHaveProperty('value', 'opus');
  fireEvent.click(screen.getByLabelText('Implementation Heavy Add backup'));
  fireEvent.click(within(screen.getByRole('group', { name: 'Implementation Heavy 3 Provider' })).getByRole('button', { name: 'Antigravity' }));
  fireEvent.change(screen.getByLabelText('Implementation Heavy 3 Model'), { target: { value: 'manual-gemini' } });
  fireEvent.click(screen.getByLabelText('Implementation Heavy 2 Remove'));
  fireEvent.change(screen.getByLabelText('Model note 1 strength'), { target: { value: 'Strong implementation' } });
  fireEvent.click(screen.getByLabelText('Model note 1 latest'));
  fireEvent.click(screen.getByRole('button', { name: 'Advisor Light Edit assignment' }));
  fireEvent.change(screen.getByLabelText('Advisor Light 1 Model'), { target: { value: 'sonnet' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!); await screen.findByText('claude · after-model');
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!); await screen.findByText('Saved');
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
  render(<SettingsPage client={f.client} language="ja"/>); await screen.findByRole('region', { name: '役割別のモデル' });
  fireEvent.click(screen.getByRole('button', { name: '実装 重い作業 割り当てを編集' }));
  const model = screen.getByLabelText('実装 重い作業 1 モデル') as HTMLInputElement;
  await screen.findByRole('list', { name: '実装 重い作業 1 モデルの一覧' });
  expect(screen.getAllByRole('button', { name: 'Listed model' })).toHaveLength(3);
  const [first, second] = document.querySelectorAll('.assignment-candidates > li');
  fireEvent.dragStart(first); fireEvent.dragOver(second); fireEvent.drop(second);
  expect(screen.getByLabelText('実装 重い作業 1 モデル')).toHaveProperty('value', 'opus');
  fireEvent.click(screen.getByLabelText('実装 重い作業 ふつうと同じにする'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: '実装 重い作業 割り当てを編集' }).textContent).toBe('gpt-6-astra');
  fireEvent.click(screen.getByRole('button', { name: '割り当てをプレビュー' })); await screen.findByText('claude · after-model');
  fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' })); await screen.findByText('保存しました');
  const save = f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] };
  expect(save.patch.roles.implement).not.toHaveProperty('heavy');
});

it('shows eight roles, lets the root select every provider, and folds fallback candidates', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  const region = await screen.findByRole('region', { name: 'Models by role' });
  const table = region.querySelector('.assignment-table')!;
  expect(table.querySelectorAll('tbody > tr')).toHaveLength(8);
  expect([...table.querySelectorAll('tbody > tr > th')].map(cell => cell.querySelector('.assignment-role > span')?.textContent)).toEqual(['Main agent', 'Advisor', 'Research', 'Implementation', 'Documentation', 'Code review', 'Verification', 'Proofreading']);
  expect(screen.queryByText('Planning')).toBeNull();
  expect(screen.queryByLabelText('Implementation Standard 2 Model')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Main agent Standard Edit assignment' }));
  const root = screen.getByLabelText('Main agent Standard 1 Provider');
  fireEvent.click(within(root).getByRole('button', { name: 'Antigravity' }));
  expect(within(root).getByRole('button', { name: 'Antigravity' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(root).getByRole('button', { name: 'Codex' }));
  expect(within(root).getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed')).toBe('true');
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
  render(<SettingsPage client={f.client}/>); await screen.findByRole('button', { name: 'Export' });
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
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
  render(<SettingsPage client={f.client} policyOnly/>); await openRules();
  const button = await screen.findByRole('button', { name: 'Implementation Standard Edit assignment' });
  expect(button.textContent).toContain('gpt-6-astra');
  expect(button.textContent).toContain('high');
  expect(screen.queryByLabelText('Implementation Standard 1 Model')).toBeNull();
  deliver();
  await waitFor(() => expect(button.textContent).toContain('GPT-6 Astra'));
  expect(screen.getByRole('button', { name: 'Main agent Standard Edit assignment' }).textContent).toContain('opus');
  expect(screen.getByRole('button', { name: 'Main agent Standard Edit assignment' }).querySelector('.assignment-effort')).toBeNull();
  expect(document.querySelector('.assignment-settings.settings-page')).toBeTruthy();
});

it('closes the editor with Escape or outside presses and shows fallback chains', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client}/>);
  const assignments = await screen.findByRole('region', { name: 'Models by role' });
  const advisor = screen.getByRole('button', { name: 'Advisor Light Edit assignment' });
  expect(advisor.textContent).toBe('fable');
  expect(advisor.closest('td')?.querySelector('.assignment-count')?.textContent).toBe('Same as standard');
  fireEvent.click(advisor);
  expect(screen.getByRole('dialog', { name: 'Advisor Light Assignment' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Advisor Light 1 Model'), { target: { value: 'custom-model' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(advisor);
  expect(advisor.textContent).toContain('custom-model');
  fireEvent.click(advisor);
  fireEvent.click(screen.getByLabelText('Advisor Light Add backup'));
  fireEvent.click(within(screen.getByRole('list', { name: 'Advisor Light 2 Available models' })).getByRole('button', { name: 'opus' }));
  expect(advisor.closest('td')?.querySelector('.assignment-count')?.textContent).toBe('Backup opus');
  fireEvent.click(screen.getByLabelText('Advisor Light 2 Remove'));
  expect(advisor.closest('td')?.querySelector('.assignment-count')).toBeNull();
  fireEvent.pointerDown(assignments.querySelector('thead')!);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(advisor);
  fireEvent.click(screen.getByLabelText('Advisor Light Use the standard column'));
  expect(advisor.textContent).toBe('fable');
  fireEvent.click(screen.getByRole('button', { name: 'Advisor Standard Edit assignment' }));
  expect(screen.queryByRole('button', { name: 'Advisor Standard Use the standard column' })).toBeNull();
});

it('omits weight criteria summaries and keeps each band editable', async () => {
  const f = createFixture(); render(<SettingsPage client={f.client} language="ja"/>);
  await screen.findByRole('region', { name: '役割別のモデル' });
  expect(screen.queryByRole('button', { name: 'メインエージェントの重さの基準を編集' })).toBeNull();
  const edit = screen.getByRole('button', { name: '実装の重さの基準を編集' });
  expect(edit.closest('th')!.querySelector('.assignment-criteria-summary')).toBeNull();
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText('実装 軽い作業 重さの基準'), { target: { value: '小さな変更' } });
  fireEvent.change(screen.getByLabelText('実装 ふつうの作業 重さの基準'), { target: { value: '機能の追加' } });
  fireEvent.change(screen.getByLabelText('実装 重い作業 重さの基準'), { target: { value: '設計の変更' } });
  expect(edit.closest('th')!.querySelector('.assignment-criteria-summary')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
  expect(screen.queryByLabelText('実装 軽い作業 重さの基準')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '割り当てをプレビュー' }));
  await screen.findByRole('region', { name: '割り当てのプレビュー' });
  fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' }));
  await screen.findByText('保存しました');
  const save = f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] };
  expect(save.patch.criteria.implement).toEqual({ light: '小さな変更', standard: '機能の追加', heavy: '設計の変更' });
});

it('selects catalog models with latest and strength notes', async () => {
  const f = createFixture();
  const original = f.command.getMockImplementation()!;
  f.value.policy.modelNotes[0].latest = true;
  f.command.mockImplementation(async (name, payload) => name === 'settings.models' && (payload as { provider: string }).provider === 'codex' ? { type: 'ack', cmd_id: name, ok: true, result: { state: 'known', models: [{ model: 'gpt-6-astra', displayName: 'GPT-6 Astra' }, { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }] } } : original(name, payload));
  render(<SettingsPage client={f.client}/>);
  await screen.findByRole('button', { name: 'Implementation Standard Edit assignment' });
  fireEvent.click(screen.getByRole('button', { name: 'Implementation Standard Edit assignment' }));
  const choices = await screen.findByRole('list', { name: 'Implementation Standard 1 Available models' });
  const astra = within(choices).getByRole('button', { name: 'GPT-6 Astra' });
  expect(astra.querySelector('small')?.textContent).toBe('Latest · Top performance on SWE-bench.');
  fireEvent.click(within(choices).getByRole('button', { name: 'GPT-6.1 Sol' }));
  expect(screen.getByLabelText('Implementation Standard 1 Model')).toHaveProperty('value', 'gpt-6.1-sol');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Implementation Standard Edit assignment' }).textContent).toContain('GPT-6.1 Sol');
});

it.each(['Performance', 'Balanced', 'Economy'])('keeps %s preset changes unsaved until the existing preview and save flow', async preset => {
  const f = createFixture();
  f.value.policy.roles.implement = { light: [{ executor: 'codex', model: 'gpt-6.1-sol', effort: 'low', family: 'openai', tier: 'mid' }], standard: [{ executor: 'claude', model: 'custom-opus', family: 'anthropic', tier: 'high' }], heavy: [{ executor: 'codex', model: 'gpt-6-astra', effort: 'xhigh', family: 'openai', tier: 'high' }] };
  render(<SettingsPage client={f.client} policyOnly/>); await openRules();
  await screen.findByRole('button', { name: preset });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
  await screen.findByRole('dialog', { name: 'Review before saving' });
  fireEvent.click(screen.getByRole('button', { name: preset }));
  expect(screen.getByRole('dialog', { name: 'Changes' })).toBeTruthy();
  expect(f.command.mock.calls.some(([name]) => name === 'settings.write')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Apply to table' }));
  expect(screen.queryByRole('dialog', { name: 'Review before saving' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Review before saving' })).toBeNull();
  expect(f.command.mock.calls.some(([name]) => name === 'settings.write')).toBe(false);
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
  await screen.findByRole('dialog', { name: 'Review before saving' });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
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
  fireEvent.click(await screen.findByRole('button', { name: '書き出す' }));
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
  render(<SettingsPage client={f.client} policyOnly/>); await openRules();
  fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
  await screen.findByText('/fixture/claude');
  fireEvent.click(screen.getByLabelText('Overwrite the files above'));
  fireEvent.click(screen.getByRole('button', { name: 'Write files' }));
  await screen.findByText('Codex file is locked');
  expect(screen.queryByText('/fixture/claude')).toBeNull();
  expect(screen.getByText('/fixture/codex')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Write files' }));
  await screen.findByText('Applied');
  const calls = f.command.mock.calls.filter(([name]) => name === 'settings.applyProvider').map(([, payload]) => (payload as { provider: string }).provider);
  expect(calls).toEqual(['claude', 'codex', 'codex', 'antigravity']);
});

it.each(['en', 'ja'] as const)('keeps removed descriptions absent while restoring operational information in %s', async language => {
  const f = createFixture();
  const { container } = render(<SettingsPage client={f.client} language={language}/>);
  await screen.findByRole('region', { name: language === 'ja' ? 'エージェントとモデル' : 'Agents and models' });
  expect(container.querySelector('.page-subtitle')).toBeNull();
  expect(container.querySelector('.settings-section header p, .settings-section header code')).toBeNull();
  expect(container.querySelector('.assignment-role-description, .assignment-criteria-summary')).toBeNull();
  expect(container.textContent).not.toContain(language === 'ja' ? '次の実行から反映します。' : 'Applies to the next execution.');
  expect(container.textContent).not.toContain(language === 'ja' ? 'このブラウザで即座に反映します。' : 'Applies immediately to this browser.');
  fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '性能重視' : 'Performance' }));
  expect(screen.getByRole('dialog').querySelectorAll('.assignment-note')).toHaveLength(2);
});

it.each(['en', 'ja'] as const)('never displays internal policy section keys in %s', async language => {
  const f = createFixture();
  const { container } = render(<SettingsPage client={f.client} language={language} policyOnly/>); await openRules();
  await screen.findAllByRole('button', { name: language === 'ja' ? '保存' : 'Save' });
  for (const key of ['quota', 'performance', 'weights', 'constraints']) {
    expect(labelSetting(key, language)).not.toBe(key);
    expect([...container.querySelectorAll('legend')].some(legend => legend.textContent === key)).toBe(false);
  }
  expect(screen.queryByRole('heading', { name: 'Model assignment settings' })).toBeNull();
  expect(screen.getByRole('region', { name: language === 'ja' ? '役割別のモデル' : 'Models by role' })).toBeTruthy();
  const select = screen.getByLabelText(language === 'ja' ? '制約 · 1 · 制約' : 'constraints · 1 · Constraint');
  fireEvent.click(select);
  fireEvent.click(screen.getByRole('option', { name: labelConstraint('minTierForRole', language) }));
  expect(screen.getByLabelText(language === 'ja' ? '制約 · 1 · 制約' : 'constraints · 1 · Constraint').closest('fieldset')?.querySelector('legend')).toBeNull();
  expect(screen.getByRole('group', { name: language === 'ja' ? '制約 1' : 'Constraint 1' })).toBe(screen.getByLabelText(language === 'ja' ? '制約 · 1 · 制約' : 'constraints · 1 · Constraint').closest('fieldset'));
  expect(screen.getByLabelText(language === 'ja' ? '制約 · 1 · モデルランク' : 'constraints · 1 · Model tier')).toBeTruthy();
  expect(screen.getByRole('button', { name: language === 'ja' ? '制約 · 1 · 役割' : 'constraints · 1 · Role' }).textContent).toContain(language === 'ja' ? '実装' : 'Implementation');
});

it.each(['en', 'ja'] as const)('shows usage and result units and four percentage shares in %s', async language => {
  const f = createFixture();
  const { container } = render(<SettingsPage client={f.client} language={language} policyOnly/>); await openRules();
  const ja = language === 'ja';
  const soft = await screen.findByLabelText(ja ? '利用枠 · 後回しにする使用率' : 'quota · Deprioritize at usage');
  const hard = screen.getByLabelText(ja ? '利用枠 · 候補から外す使用率' : 'quota · Stop using at usage');
  const samples = screen.getByLabelText(ja ? '実績 · 実績で選ぶ最低件数' : 'performance · Results needed to rank');
  for (const input of [soft, hard]) expect(input.nextElementSibling?.textContent).toBe('%');
  expect(samples.nextElementSibling?.textContent).toBe(ja ? '件' : 'runs');
  expect(samples.getAttribute('title')).toContain(ja ? 'すべての候補' : 'every candidate');
  const names = ja ? ['合格率', 'レビューの承認率', 'やりとりの少なさ', 'トークンの少なさ'] : ['Pass rate', 'Review approval', 'Fewer round trips', 'Fewer tokens'];
  const shares = names.map(name => {
    const slider = screen.getByRole('slider', { name });
    const number = screen.getByRole('spinbutton', { name: `${name} (%)` });
    expect(number.nextElementSibling?.textContent).toBe('%');
    expect(slider.getAttribute('aria-valuetext')).toBe(`${(number as HTMLInputElement).value}%`);
    return Number((number as HTMLInputElement).value);
  });
  expect(shares).toEqual([40, 30, 20, 10]);
  expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
  expect(container.querySelectorAll('.settings-weight-row')).toHaveLength(4);
  expect(container.querySelectorAll('.settings-weight-row i, .settings-weight-color, .settings-weight-bar')).toHaveLength(0);
  expect(screen.queryByRole('img', { name: new RegExp(ja ? 'モデル選びの割合' : 'Model preference shares') })).toBeNull();
  expect(screen.getAllByRole('slider').map(slider => (slider as HTMLElement).style.getPropertyValue('--slider-value'))).toEqual(['0.4', '0.3', '0.2', '0.1']);
  expect(container.querySelector('.settings-weights p')).toBeNull();
});

it.each(['en', 'ja'] as const)('redistributes slider and number changes and saves decimal weights in %s', async language => {
  const f = createFixture(); render(<SettingsPage client={f.client} language={language} policyOnly/>); await openRules();
  const ja = language === 'ja';
  const names = ja ? ['合格率', 'レビューの承認率', 'やりとりの少なさ', 'トークンの少なさ'] : ['Pass rate', 'Review approval', 'Fewer round trips', 'Fewer tokens'];
  const slider = await screen.findByRole('slider', { name: names[0] });
  const readShares = () => names.map(name => Number((screen.getByRole('spinbutton', { name: `${name} (%)` }) as HTMLInputElement).value));
  fireEvent.change(slider, { target: { value: '55' } });
  expect(readShares()).toEqual([55, 23, 15, 7]);
  expect(readShares().reduce((sum, value) => sum + value, 0)).toBe(100);
  fireEvent.change(screen.getByRole('spinbutton', { name: `${names[0]} (%)` }), { target: { value: '100' } });
  expect(readShares()).toEqual([100, 0, 0, 0]);
  fireEvent.change(slider, { target: { value: '0' } });
  expect(readShares()).toEqual([0, 34, 33, 33]);
  fireEvent.click(screen.getAllByRole('button', { name: ja ? '保存' : 'Save' }).at(-1)!);
  await screen.findByRole('dialog', { name: ja ? '保存する前の確認' : 'Review before saving' });
  fireEvent.click(within(screen.getByRole('dialog', { name: ja ? '保存する前の確認' : 'Review before saving' })).getByRole('button', { name: ja ? 'この内容で保存' : 'Save' }));
  await screen.findByText(ja ? '保存しました' : 'Saved');
  const patch = (f.command.mock.calls.find(([name]) => name === 'settings.write')![1] as { patch: SettingsSnapshot['policy'] }).patch;
  expect(patch.performance.weights).toEqual({ acceptRate: 0, reviewApprove: 0.34, roundTrips: 0.33, tokens: 0.33 });
  expect(Object.values(patch.performance.weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
});

it.each(['en', 'ja'] as const)('blocks reversed quota limits and marks both fields invalid in %s', async language => {
  const f = createFixture(); render(<SettingsPage client={f.client} language={language} policyOnly/>); await openRules();
  const ja = language === 'ja';
  const soft = await screen.findByLabelText(ja ? '利用枠 · 後回しにする使用率' : 'quota · Deprioritize at usage');
  const hard = screen.getByLabelText(ja ? '利用枠 · 候補から外す使用率' : 'quota · Stop using at usage');
  const preview = screen.getAllByRole('button', { name: ja ? '保存' : 'Save' }).at(-1)!;
  const save = preview;
  fireEvent.click(preview);
  await screen.findByRole('dialog', { name: ja ? '保存する前の確認' : 'Review before saving' });
  fireEvent.change(soft, { target: { value: '95' } });
  for (const input of [soft, hard]) expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(preview).toHaveProperty('disabled', true);
  expect(save).toHaveProperty('disabled', true);
  fireEvent.click(preview); fireEvent.click(save);
  expect(f.command.mock.calls.filter(([name]) => name === 'settings.previewPolicy')).toHaveLength(1);
  expect(f.command.mock.calls.some(([name]) => name === 'settings.write')).toBe(false);
  fireEvent.change(hard, { target: { value: '95' } });
  for (const input of [soft, hard]) expect(input.getAttribute('aria-invalid')).toBeNull();
  expect(preview).toHaveProperty('disabled', false);
  fireEvent.click(preview);
  await screen.findByRole('dialog', { name: ja ? '保存する前の確認' : 'Review before saving' });
  fireEvent.click(within(screen.getByRole('dialog', { name: ja ? '保存する前の確認' : 'Review before saving' })).getByRole('button', { name: ja ? 'この内容で保存' : 'Save' }));
  await screen.findByText(ja ? '保存しました' : 'Saved');
  expect(f.command).toHaveBeenCalledWith('settings.write', expect.objectContaining({ patch: expect.objectContaining({ quota: { softLimitPercent: 95, hardLimitPercent: 95 } }) }));
});

it.each([{ acceptRate: 1, reviewApprove: 1, roundTrips: 1, tokens: 0 }, { acceptRate: 0, reviewApprove: 0, roundTrips: 0, tokens: 0 }])('normalizes loaded shares to 100 without rewriting the stored policy', async weights => {
  const f = createFixture(); f.value.policy.performance.weights = weights;
  render(<SettingsPage client={f.client} policyOnly/>); await openRules();
  await screen.findByRole('slider', { name: 'Pass rate' });
  const percentages = screen.getAllByRole('slider').map(input => Number((input as HTMLInputElement).value));
  expect(percentages.reduce((sum, value) => sum + value, 0)).toBe(100);
  expect(percentages).toEqual(weights.acceptRate ? [34, 33, 33, 0] : [25, 25, 25, 25]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
  await screen.findByRole('dialog', { name: 'Review before saving' });
  expect(f.command).toHaveBeenCalledWith('settings.previewPolicy', expect.objectContaining({ patch: expect.objectContaining({ performance: expect.objectContaining({ weights }) }) }));
});

async function openRules() { const section = await screen.findByText(/^(Selection rules|選び方のルール)$/, { selector: 'h2' }); const details = section.closest('details')!; details.open = true; }
