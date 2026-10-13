import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { defaultConfig, defaultProject } from '../../../../core/src/settings/index.ts';
import type { PolicyPreview } from '../lib/settings.ts';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function createPreview(changed = 7): PolicyPreview {
  const candidate = { executor: 'codex' as const, family: 'openai' as const, tier: 'high' as const };
  return { token: 'preview-token', total: 12, changed,
    roleChanges: [{ role: 'implement', bands: (['light', 'standard', 'heavy'] as const).map(weight => ({ weight,
      before: [{ ...candidate, model: 'gpt-6.1-sol' }], after: [{ ...candidate, model: 'gpt-6-astra' }] })) }],
    rows: Array.from({ length: changed }, (_, index) => ({ id: `kit:["/private/events.jsonl",${index}]`,
      description: index === 1 ? '' : `Fix settings layout ${index}`, timestamp: '2026-10-12T09:30:00Z', role: 'implement',
      before: { ok: true, assignment: { executor: 'codex', model: 'gpt-6.1-sol' } },
      after: { ok: true, assignment: { executor: 'codex', model: 'gpt-6-astra' } },
    })) };
}
async function openPreview(preview: PolicyPreview, policyOnly: boolean, language: 'en' | 'ja') {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: name, ok: true,
    result: name === 'settings.read' ? { policy: defaultPolicy(), config: defaultConfig(), project: defaultProject(), errors: {}, apiKeyConfigured: false }
      : name === 'settings.previewPolicy' ? preview : name === 'settings.models' ? { state: 'unknown', models: [] } : undefined }));
  render(<SettingsPage client={{ command }} policyOnly={policyOnly} language={language}/>);
  const button = policyOnly
    ? within(await screen.findByRole('region', { name: language === 'ja' ? 'モデル' : 'Models' })).getByRole('button', { name: language === 'ja' ? '保存' : 'Save' })
    : await screen.findByRole('button', { name: language === 'ja' ? '割り当てをプレビュー' : 'Preview policy' });
  fireEvent.click(button);
  return await screen.findByRole(policyOnly ? 'dialog' : 'region', { name: language === 'ja'
    ? policyOnly ? '保存する前の確認' : '割り当てのプレビュー'
    : policyOnly ? 'Review before saving' : 'Policy preview' });
}
it.each([true, false])('shows readable role changes, counts and at most five dated examples (policyOnly=%s)', async policyOnly => {
  const region = await openPreview(createPreview(), policyOnly, 'en');
  expect(region.textContent).toContain('Implementation: GPT-6.1 Sol → GPT-6 Astra');
  expect(region.textContent).toContain('7 of 12 recent requests would receive a different assignment');
  expect(region.innerHTML).not.toMatch(/kit:|events\.jsonl|\/private/);
  const rows = within(region).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(5);
  expect(rows[0].textContent).toContain('Fix settings layout 0');
  expect(rows[1].textContent).toContain('Untitled request');
  for (const row of rows) {
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-12T09:30:00Z');
    expect(row.querySelector('time')?.textContent).toMatch(/Oct 12, 2026/);
    expect(row.textContent).toContain('Implementation');
  }
  expect(within(region).queryByText('Fix settings layout 5')).toBeNull();
});
it.each([true, false])('translates the same preview in Japanese (policyOnly=%s)', async policyOnly => {
  const region = await openPreview(createPreview(), policyOnly, 'ja');
  expect(region.textContent).toContain('実装: GPT-6.1 Sol → GPT-6 Astra');
  expect(region.textContent).toContain('最近の依頼 12 件のうち 7 件で、割り当てが変わります');
  expect(region.textContent).toContain('題名のない依頼');
  expect(region.textContent).toContain('2026年10月12日');
  expect(region.textContent).toContain('影響を受ける依頼の例');
});
it.each(['en', 'ja'] as const)('shows no past changes even with history in %s', async language => {
  const region = await openPreview(createPreview(0), true, language);
  expect(region.textContent).toContain(language === 'ja' ? '割り当てが変わる過去の依頼はありません' : 'No past requests would change');
  expect(region.textContent).toContain(language === 'ja' ? '最近の依頼 12 件のうち 0 件' : '0 of 12 recent requests');
  expect(within(region).queryByRole('table')).toBeNull();
  expect(region.textContent).toContain(language === 'ja' ? '実装: GPT-6.1 Sol → GPT-6 Astra' : 'Implementation: GPT-6.1 Sol → GPT-6 Astra');
});
it('summarizes shared model changes once without repeating unchanged backups and effort', async () => {
  const preview = createPreview();
  preview.roleChanges[0].bands.forEach((band, index) => {
    const effort = ['low', 'high', 'xhigh'][index];
    const backup = { executor: 'claude' as const, family: 'anthropic' as const, tier: 'high' as const, model: 'opus' };
    band.before = [{ ...band.before[0], effort }, backup];
    band.after = [{ ...band.after[0], effort }, backup];
  });
  const region = await openPreview(preview, true, 'en');
  const summary = within(region).getByLabelText('Assignment changes');
  expect(summary.textContent).toBe('Implementation: GPT-6.1 Sol → GPT-6 Astra');
  expect(summary.children).toHaveLength(1);
});
it('shows configured changes and no past changes when there is no history', async () => {
  const preview = createPreview(0); preview.total = 0;
  const region = await openPreview(preview, true, 'en');
  expect(region.textContent).toContain('Implementation: GPT-6.1 Sol → GPT-6 Astra');
  expect(region.textContent).toContain('0 of 0 recent requests');
  expect(region.textContent).toContain('No past requests would change');
  expect(within(region).queryByRole('table')).toBeNull();
});
