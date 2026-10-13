import type { ScreenState } from './store.ts';

/** 不変の表をキーにする。同じ state の再計算と、無関係な patch での再計算を避ける。 */
export function memoizeProjection<T>(tables: readonly string[], calculate: (state: ScreenState) => T): (state: ScreenState) => T {
  const cache = new WeakMap<ScreenState, T>();
  let previous: ScreenState | undefined;
  let value: T;
  return state => {
    if (cache.has(state)) return cache.get(state)!;
    if (!previous || previous.identities !== state.identities
      || tables.some(table => previous!.projection[table] !== state.projection[table])) value = calculate(state);
    previous = state;
    cache.set(state, value);
    return value;
  };
}

/** 選んだ表とメタデータだけを購読する。seq 単独の更新は画面を変えない。 */
export function selectScreenTables(tables: readonly string[], fields: readonly (keyof ScreenState)[] = []) {
  let previous: ScreenState | undefined;
  return (state: ScreenState): ScreenState => {
    if (!previous || previous.identities !== state.identities || previous.generation !== state.generation
      || previous.snapshotReady !== state.snapshotReady || fields.some(field => previous![field] !== state[field])
      || tables.some(table => previous!.projection[table] !== state.projection[table])) previous = state;
    return previous;
  };
}

/** JSON の同じ値は元の参照を保ち、更新された枝だけを置き換える。 */
export function shareValue<T>(before: T, next: T): T {
  if (before === next || !before || !next || typeof before !== 'object' || typeof next !== 'object'
    || Array.isArray(before) !== Array.isArray(next)) return next;
  const left = before as Record<string, unknown>;
  const right = next as Record<string, unknown>;
  const keys = Object.keys(right);
  let same = keys.length === Object.keys(left).length;
  const result = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  for (const key of keys) {
    result[key] = shareValue(left[key], right[key]);
    if (!Object.hasOwn(left, key) || result[key] !== left[key]) same = false;
  }
  return same ? before : result as T;
}
