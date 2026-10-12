import type { Candidate, Role, Weight } from '../../../../../core/src/delegate/types.ts';
import type { Policy } from '../../lib/settings.ts';

export const ROLES: Role[] = ['orchestrate', 'advisor', 'research', 'implement', 'document', 'review', 'verify', 'proofread'];
export const WEIGHTS: Weight[] = ['light', 'standard', 'heavy'];
export type Preset = 'performance' | 'balanced' | 'economy';
export function readBands(policy: Policy, role: Role) {
  const value = policy.roles[role];
  return Array.isArray(value) ? { standard: value } : value;
}
export function readCandidates(policy: Policy, role: Role, weight: Weight): Candidate[] {
  const bands = readBands(policy, role);
  return bands[weight] ?? bands.standard ?? [];
}
const claude = (model: string): Candidate => ({ executor: 'claude', model, family: 'anthropic', tier: model === 'sonnet' ? 'mid' : 'high' });
const codex = (model: string, effort: string): Candidate => ({ executor: 'codex', model, effort, family: 'openai', tier: model === 'gpt-6-astra' ? 'high' : 'mid' });
// ブラウザから Node に依存する policy.ts を読み込まないため、既定の割り当てだけを持つ。
export function createBalancedRoles(): Policy['roles'] {
  return {
    orchestrate: { standard: [claude('opus')] }, advisor: { standard: [claude('fable')] },
    research: { standard: [claude('sonnet')] },
    implement: { light: [codex('gpt-6.1-sol', 'low'), claude('opus')], standard: [codex('gpt-6-astra', 'high'), claude('opus')], heavy: [codex('gpt-6-astra', 'xhigh'), claude('opus')] },
    document: { light: [claude('sonnet')], standard: [claude('opus')], heavy: [claude('opus')] },
    review: { light: [claude('opus'), codex('gpt-6-astra', 'high')], standard: [claude('opus'), codex('gpt-6-astra', 'high')], heavy: [claude('fable'), codex('gpt-6-astra', 'xhigh')] },
    verify: { standard: [claude('sonnet')] },
    proofread: { standard: [{ executor: 'antigravity', model: 'gemini-3.8-flash-high', family: 'google', tier: 'high' }] },
  };
}
const TIER_RANK = { high: 3, mid: 2, low: 1 };
export function createPreset(policy: Policy, preset: Preset): Policy {
  if (preset === 'balanced') return { ...policy, roles: createBalancedRoles() };
  const roles = { ...policy.roles };
  for (const role of ROLES) {
    const bands = readBands(policy, role);
    if (preset === 'economy') {
      roles[role] = { ...bands, standard: structuredClone(readCandidates(policy, role, 'light')) };
    } else {
      const pool = WEIGHTS.flatMap(weight => readCandidates(policy, role, weight));
      const best = [...pool].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
      roles[role] = Object.fromEntries(WEIGHTS.map(weight => {
        const current = readCandidates(policy, role, weight);
        const primary = best ? current.find(entry => entry.executor === best.executor && entry.model === best.model) ?? best : undefined;
        return [weight, primary ? [primary, ...current.filter(entry => entry.executor !== primary.executor || entry.model !== primary.model)] : current];
      }));
    }
  }
  return { ...policy, roles };
}
export function listPresetChanges(before: Policy, after: Policy) {
  return ROLES.flatMap(role => WEIGHTS.flatMap(weight => {
    const previous = readCandidates(before, role, weight);
    const next = readCandidates(after, role, weight);
    const inheritedBefore = weight !== 'standard' && readBands(before, role)[weight] === undefined;
    const inheritedAfter = weight !== 'standard' && readBands(after, role)[weight] === undefined;
    return JSON.stringify(previous) === JSON.stringify(next) && inheritedBefore === inheritedAfter ? [] : [{ role, weight, before: previous, after: next, inheritedBefore, inheritedAfter }];
  }));
}
