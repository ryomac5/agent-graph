import { assignmentSettingText } from '../../lib/i18n.ts';

const TOTAL_PERCENT = 100;
const FRACTION_TOLERANCE = 1e-9;
const WEIGHT_KEYS = ['acceptRate', 'reviewApprove', 'roundTrips', 'tokens'] as const;
type WeightKey = typeof WEIGHT_KEYS[number];

// 切り捨てた端数の大きい順に残りを配り、表示の合計を必ず100にする。
function allocatePercent(values: number[], total: number): number[] {
  const sum = values.reduce((sum, value) => sum + value, 0);
  const exact = values.map(value => sum > 0 ? value / sum * total : total / values.length);
  const result = exact.map(Math.floor);
  const remainder = total - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - result[index] })).sort((a, b) => Math.abs(b.fraction - a.fraction) < FRACTION_TOLERANCE ? a.index - b.index : b.fraction - a.fraction);
  for (const { index } of order.slice(0, remainder)) result[index] += 1;
  return result;
}
export function PerformanceWeights({ value, language, onChange }: {
  value: Record<string, unknown>; language: 'en' | 'ja'; onChange(value: Record<string, unknown>): void;
}) {
  const text = assignmentSettingText[language];
  const percentages = allocatePercent(WEIGHT_KEYS.map(key => Number(value[key])), TOTAL_PERCENT);
  function update(key: WeightKey, percent: number) {
    if (!Number.isFinite(percent)) return;
    const selected = Math.max(0, Math.min(TOTAL_PERCENT, Math.round(percent)));
    const others = WEIGHT_KEYS.filter(other => other !== key);
    const shares = allocatePercent(others.map(other => Number(value[other])), TOTAL_PERCENT - selected);
    onChange({ ...value, [key]: selected / TOTAL_PERCENT, ...Object.fromEntries(others.map((other, index) => [other, shares[index] / TOTAL_PERCENT])) });
  }
  return <div className="settings-weights" title={text.weightsTitle}>
    <div className="settings-weight-controls">{WEIGHT_KEYS.map((key, index) => {
      const name = text[key];
      return <div className="settings-weight-row" key={key}>
        <label><span><i className={`settings-weight-color weight-${key}`} aria-hidden="true"/><strong>{name}</strong></span>
          <input type="range" aria-label={name} aria-valuetext={`${percentages[index]}%`} title={key === 'acceptRate' ? text.passTitle : undefined}
            className={`weight-${key}`} min={0} max={TOTAL_PERCENT} step={1} value={percentages[index]} onChange={event => update(key, Number(event.target.value))}/></label>
        <div className="settings-number-unit"><input type="number" aria-label={`${name} (%)`} min={0} max={TOTAL_PERCENT} step={1} value={percentages[index]} onChange={event => update(key, Number(event.target.value))}/><span>%</span></div>
      </div>;
    })}</div>
    <div className="settings-weight-bar" role="img" aria-label={`${text.distribution}: ${WEIGHT_KEYS.map((key, index) => `${text[key]} ${percentages[index]}%`).join(', ')}`}>
      {WEIGHT_KEYS.map((key, index) => <span key={key} className={`settings-weight-color weight-${key}`} style={{ width: `${percentages[index]}%` }} title={`${text[key]} ${percentages[index]}%`}/>)}
    </div>
  </div>;
}
