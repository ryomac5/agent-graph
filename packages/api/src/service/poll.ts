// 破損・API の誤用・DB 形式の不一致は、次の走査では回復できない。
const FATAL_SQLITE_CODES = new Set([11, 21, 26]);

export function pollObservation<T>(action: () => T): T | undefined {
  try { return action(); }
  catch (error) {
    console.error(`Observation failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && "errcode" in error
      && typeof error.errcode === "number" && FATAL_SQLITE_CODES.has(error.errcode & 0xff)) throw error;
    return undefined;
  }
}
