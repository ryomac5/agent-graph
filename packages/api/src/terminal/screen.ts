import xterm from '@xterm/headless';

const { Terminal } = xterm;
const BORDER = /^\s*[─━▔]{4,}\s*$/u;
export interface ScreenSnapshot {
  lines: string[];
  cursorY: number;
  cursorX: number;
  revision: number;
}
export interface Prompt { start: number; end: number; text: string }

/** コマンド結果の切り出しと Esc 後の復帰確認用。送信を許可する条件にはしない。 */
export function readPrompt(screen: ScreenSnapshot, provider: 'claude' | 'codex'): Prompt | undefined {
  const { lines, cursorY } = screen;
  if (provider === 'claude') {
    for (let start = cursorY; start >= 1; start--) {
      if (!/^❯[\s\u00a0]/u.test(lines[start]) || !BORDER.test(lines[start - 1])) continue;
      const end = lines.findIndex((line, index) => index > start && BORDER.test(line));
      if (end < cursorY || end < 0) return;
      return { start, end, text: lines.slice(start, end).join('\n').replace(/^❯[\s\u00a0]/u, '').trim() };
    }
    return;
  }
  // Codex は下のショートカット行が読める場合だけ、結果と入力欄を分ける。
  for (let start = cursorY; start >= 0; start--) {
    if (!/^\s*[›>]\s/u.test(lines[start])) continue;
    const end = lines.findIndex((line, index) => index > cursorY && /\? for shortcuts|context left|context remaining/u.test(line));
    if (end < 0 || lines.slice(start + 1, end).some(line => /enter to (?:confirm|select)|esc to (?:cancel|go back)/iu.test(line))) return;
    return { start, end, text: lines.slice(start, end).join('\n').replace(/^\s*[›>]\s/u, '').trim() };
  }
}

export function readPanel(screen: ScreenSnapshot): string {
  let start = screen.cursorY;
  while (start > 0 && !BORDER.test(screen.lines[start - 1])) start--;
  return screen.lines.slice(start).join('\n').trim();
}

/** 実機で確認した Claude のパネルと選択欄だけを止め、未知の描画は従来どおり送る。 */
export function isInputBlocked(screen: ScreenSnapshot, provider: 'claude' | 'codex'): boolean {
  // Codex の実機記録は起動エラーのみで、拒否の根拠にできるパネルはまだない。
  if (provider === 'codex' || readPrompt(screen, provider)) return false;
  const panel = readPanel(screen);
  const dismiss = /^\s*Esc to cancel\s*$/mu.test(panel);
  if (dismiss && (/^\s*Help\s+General\s+Commands\b/mu.test(panel)
    || /^\s*Settings\s+Status\s+Config\s+Usage\s+Stats\s*$/mu.test(panel) && /^\s*Total cost:/mu.test(panel))) return true;
  // 入力欄のない番号付き選択欄は、案内の文言に依らず止める。
  return /^\s*❯\s+\d+\.\s+/mu.test(panel);
}

export function readCommandOutput(before: ScreenSnapshot, after: ScreenSnapshot, command: string, provider: 'claude' | 'codex'): string {
  const prompt = readPrompt(after, provider);
  const lines = after.lines.slice(0, prompt ? prompt.start - (provider === 'claude' ? 1 : 0) : undefined);
  const echo = lines.findLastIndex(line => line.trim().replace(/^[❯›>]\s*/u, '') === command.trim());
  if (echo >= 0) return lines.slice(echo + 1).join('\n').trim();
  let common = 0;
  while (common < lines.length && lines[common] === before.lines[common]) common++;
  return lines.slice(common).join('\n').trim();
}

export class TerminalScreen {
  private terminal = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  private parsed: Promise<void> = Promise.resolve();
  private revision = 0;
  private disposed = false;
  private pending = new Set<() => void>();
  write(data: string) {
    if (this.disposed) return;
    this.parsed = new Promise(resolve => {
      this.pending.add(resolve);
      this.terminal.write(data, () => { this.revision++; this.pending.delete(resolve); resolve(); });
    });
  }
  async read(): Promise<ScreenSnapshot> {
    await this.parsed;
    if (this.disposed) throw new Error('no_host');
    const buffer = this.terminal.buffer.active;
    return { lines: Array.from({ length: this.terminal.rows }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? ''),
      cursorY: buffer.cursorY, cursorX: buffer.cursorX, revision: this.revision };
  }
  resize(cols: number, rows: number) { this.terminal.resize(cols, rows); }
  close() { if (this.disposed) return; this.disposed = true; for (const resolve of this.pending) resolve(); this.pending.clear(); this.terminal.dispose(); }
}
