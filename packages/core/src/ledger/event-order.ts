// 同じ時刻の事実は出所の識別子で並べる。識別子に含まれる行の位置などの数は、桁数ではなく値で比べる。
// 数の並びの前に桁数を 2 桁で置き、文字列の比較が数の比較と一致するようにする。画面からも使うため Node の機能に依存しない。
export function encodeEventOrder(value: string): string {
  return value.replace(/\d+/gu, (digits) => `${String(digits.length).padStart(2, "0")}${digits}`);
}
export function compareEventOrder(left: string, right: string): number {
  const [a, b] = [encodeEventOrder(left), encodeEventOrder(right)];
  return a < b ? -1 : a > b ? 1 : 0;
}
