// Codex のモデルと effort を、会話の中の /model の選択画面を herdr で操作して切り替える。
// Codex の /model は引数を受け取らず、番号つきの選択画面を開くだけなので、画面を読みながら進める。
// 矢印は端で反対側に回り込むので、押す回数を決め打ちせず「›」の位置を読んで確かめる。
// 確定は s で、その会話だけに効かせる。Enter は既定にして config.toml に書くので使わない。

export interface PaneControl {
  read(pane: string): Promise<string>;
  keys(pane: string, ...keys: string[]): Promise<void>;
  prompt(pane: string, text: string): Promise<void>;
}

export interface CodexModelTarget { slug: string; label: string; effort?: string }

const POLL_MS = 200;
const POLL_ATTEMPTS = 15;
// effort の行の表示名。max と ultra は「More reasoning…」の中にある
const EFFORT_ROWS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };
const ADVANCED_ROWS: Record<string, string> = { max: "Max", ultra: "Ultra" };
const MORE_ROW = "More reasoning";

interface Row { number: number; label: string; selected: boolean }

// 選択画面の行を読む。「› 2. Medium (default)  説明」のような行から番号と表示名を取り出す
export function parseRows(screen: string): Row[] {
  const rows: Row[] = [];
  for (const line of screen.split("\n")) {
    const match = /^\s*(›)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/.exec(line);
    if (!match) continue;
    rows.push({ number: Number(match[2]), label: match[3].replace(/\s*\((current|default)\)\s*$/, "").replace(/…$/, "").trim(), selected: !!match[1] });
  }
  return rows;
}

async function waitFor(control: PaneControl, pane: string, test: (screen: string) => boolean, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const screen = await control.read(pane);
    if (test(screen)) return screen;
    await sleep(POLL_MS);
  }
  return undefined;
}

// 「›」が目的の行に来るまで下の矢印を送り、着いたことを読んで確かめる
async function moveTo(control: PaneControl, pane: string, label: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const screen = await control.read(pane);
  const rows = parseRows(screen);
  const target = rows.findIndex((row) => row.label === label);
  const current = rows.findIndex((row) => row.selected);
  if (target < 0 || current < 0) return false;
  const steps = (target - current + rows.length) % rows.length;
  for (let step = 0; step < steps; step++) await control.keys(pane, "down");
  return !!await waitFor(control, pane, (next) => parseRows(next).find((row) => row.selected)?.label === label, sleep);
}

export async function switchCodexModel(control: PaneControl, pane: string, target: CodexModelTarget,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<{ ok: boolean; message: string }> {
  const fail = async (message: string) => {
    // 途中の選択画面を閉じて元に戻す
    await control.keys(pane, "escape");
    await control.keys(pane, "escape");
    return { ok: false, message };
  };
  await control.prompt(pane, "/model");
  const models = await waitFor(control, pane, (screen) => screen.includes("Select Model"), sleep);
  if (!models) return fail("Codex のモデルの選択画面が開きませんでした");
  const row = parseRows(models).find((item) => item.label === target.label);
  if (!row || row.number > 9) return fail(`選択画面に ${target.label} が見つかりませんでした`);
  await control.keys(pane, String(row.number));
  const levels = await waitFor(control, pane, (screen) => screen.includes(`Reasoning Level for ${target.label}`), sleep);
  if (!levels) return fail("effort の選択画面が開きませんでした");
  const effort = target.effort || parseRows(levels).find((item) => item.selected)?.label.toLowerCase() || "";
  if (target.effort && ADVANCED_ROWS[target.effort]) {
    if (!await moveTo(control, pane, MORE_ROW, sleep)) return fail("effort の追加の選択肢に移れませんでした");
    await control.keys(pane, "enter");
    if (!await waitFor(control, pane, (screen) => screen.includes("Advanced Reasoning"), sleep)) return fail("effort の追加の選択画面が開きませんでした");
    if (!await moveTo(control, pane, ADVANCED_ROWS[target.effort], sleep)) return fail(`${target.label} は ${target.effort} を選べません`);
  } else if (target.effort) {
    if (!EFFORT_ROWS[target.effort] || !await moveTo(control, pane, EFFORT_ROWS[target.effort], sleep)) {
      return fail(`${target.label} は ${target.effort} を選べません`);
    }
  }
  await control.keys(pane, "s");
  const applied = await waitFor(control, pane, (screen) => screen.includes("Model changed to") || screen.includes(target.label), sleep);
  if (!applied) return { ok: false, message: "切り替えの確認が表示されませんでした。適用後のモデルは観測で更新されます" };
  return { ok: true, message: `${target.label}${target.effort ? ` ${target.effort}` : effort ? ` ${effort}` : ""} に切り替えました。この会話だけに効きます` };
}
