// hook やハーネスが利用者の行に差し込む札。人が書いた本文ではないので画面に出さない。
const INJECTED_BLOCKS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|user-prompt-submit-hook|task-notification)>[\s\S]*?<\/\1>/g;
/** 本文から差し込まれた札を外し、人が読む文だけを残す。コマンドの札は中の語だけを残す。 */
export function visibleText(text: string): string {
  return text.replace(INJECTED_BLOCKS, '').replace(/<\/?(command-name|command-args)>/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}
/** 保存済み本文と構造化レビュー結果を、一覧と会話で同じ表示にする。 */
export function readBody(value: unknown): string {
  if (typeof value === 'string') {
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
