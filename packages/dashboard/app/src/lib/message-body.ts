// hook やハーネスが利用者の行に差し込む札。人が書いた本文ではないので画面に出さない。
const INJECTED_BLOCKS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|user-prompt-submit-hook|task-notification)>[\s\S]*?<\/\1>/g;
/** 保存済みの旧いコマンド本文も、投影を再構築せず読むときに整える。 */
function readSlashCommand(text: string): string | undefined {
  const command = /^\s*<command-name>(\/[^<\s]+)<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>\s*)?$/u.exec(text);
  return command ? [command[1], command[2]?.trim()].filter(Boolean).join(' ') : undefined;
}
/** 本文から差し込まれた札を外し、人が読む文だけを残す。コマンドの札は中の語だけを残す。 */
export function visibleText(text: string, normalized = false): string {
  const command = readSlashCommand(text);
  if (command !== undefined) return command;
  if (normalized) return text.trim();
  return text.replace(INJECTED_BLOCKS, '').replace(/<\/?(command-name|command-args)>/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}
/**
 * 利用者の行として届くが、人が書いていないもの。子のエージェントの報告と、裏の作業の通知である。
 * 端末に途中で打った発言は、包みを外して利用者の発言として扱う。
 */
export type HarnessKind = 'agent_report' | 'notification' | 'user';
const AGENT_REPORT = /^(?:Another Claude session sent a message|<agent-message\b|\[Subagent hand-back\])/;
// Claude Code は画像を貼ると、元のパスを「[Image: source: パス]」の行として別に記録する。画像は発言の中に描くので、この行は出さない。
const NOTIFICATION = /^(?:\[SYSTEM NOTIFICATION|<task-notification>|\[Image: source: [^\]\n]+\]\s*$)/;
export function harnessKind(text: string): HarnessKind {
  const head = text.trimStart();
  return AGENT_REPORT.test(head) ? 'agent_report' : NOTIFICATION.test(head) ? 'notification' : 'user';
}
/** 子の報告から包みと注意書きを外し、報告の本文だけを返す。 */
export function agentReportText(text: string): string {
  const body = text.replace(/^Another Claude session sent a message:\s*/, '').replace(/<\/?agent-message[^>]*>/g, '');
  const start = body.indexOf('The report follows:');
  const report = start >= 0 ? body.slice(start + 'The report follows:'.length) : body;
  // 報告の後ろに続く、ハーネスの注意書きを落とす。
  const end = report.search(/\n\s*That "other Claude session" is an agent/);
  return (end >= 0 ? report.slice(0, end) : report).replace(/^ {2}/gm, '').trim();
}
const bodies = new WeakMap<object, string>();
const messages = new WeakMap<object, string>();
/** 投影行は版ごとに置き換わる。古い発言を保持せず、同じ版の本文だけを再利用する。 */
export function readMessageBody(row: { body?: unknown }): string {
  if (messages.has(row)) return messages.get(row)!;
  const text = readBody(row.body);
  messages.set(row, text);
  return text;
}
/** 保存済み本文と構造化レビュー結果を、一覧と会話で同じ表示にする。 */
export function readBody(value: unknown): string {
  if (value === null || typeof value !== 'object') return decodeBody(value);
  if (bodies.has(value)) return bodies.get(value)!;
  const text = decodeBody(value);
  bodies.set(value, text);
  return text;
}
function decodeBody(value: unknown): string {
  if (typeof value === 'string') {
    // 通常の文章と数値は JSON を展開しても本文形式にならない。
    if (!/^[\s]*["{\[]/.test(value)) return readSlashCommand(value) ?? value;
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch { return value; }
    // 本文形式でない JSON（コードや道具の出力）は元の文字列を保つ。
    if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      && !('verdict' in decoded && ['approve', 'request_changes', 'reject'].includes(String(decoded.verdict)))
      && !('text' in decoded) && !('content' in decoded)) return value;
    return typeof decoded === 'string' || decoded !== null && typeof decoded === 'object'
      ? readBody(decoded) : value;
  }
  if (Array.isArray(value)) return value.map(readBody).filter(Boolean).join('\n');
  if (value === null || typeof value !== 'object') return '';
  const body = value as Record<string, unknown>;
  if (body.verdict === 'approve' || body.verdict === 'request_changes' || body.verdict === 'reject') {
    const label = body.verdict === 'approve' ? 'Approved' : 'Changes requested';
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    return comment ? `${label} · ${comment}` : label;
  }
  return readBody(body.text ?? body.content ?? '');
}
