import type { Language } from '../../lib/i18n.ts';

const text = {
  en: {
    assignmentChanges: 'Assignment changes', noAssignmentChanges: 'No role model settings would change',
    impact: '{changed} of {total} recent requests would receive a different assignment',
    noPastChanges: 'No past requests would change', examples: 'Examples of affected requests',
    request: 'Request', date: 'Date and time', role: 'Role', untitled: 'Untitled request',
    timeUnknown: 'Time unknown', noCandidates: 'No models',
    light: 'Light', standard: 'Standard', heavy: 'Heavy',
  },
  ja: {
    assignmentChanges: '割り当ての変更', noAssignmentChanges: '役ごとのモデル設定は変わりません',
    impact: '最近の依頼 {total} 件のうち {changed} 件で、割り当てが変わります',
    noPastChanges: '割り当てが変わる過去の依頼はありません', examples: '影響を受ける依頼の例',
    request: '依頼', date: '日時', role: '役', untitled: '題名のない依頼',
    timeUnknown: '日時不明', noCandidates: 'モデルなし',
    light: '軽い', standard: '標準', heavy: '重い',
  },
} as const;
export function translate(language: Language, key: keyof typeof text.en, values: Record<string, number> = {}): string {
  return text[language][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] === undefined ? placeholder : String(values[name]));
}
