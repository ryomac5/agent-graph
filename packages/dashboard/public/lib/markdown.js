// 吹き出し用の最小の Markdown。見出し、箇条書き、太字、行内のコードだけを見分ける。
// HTML は組まず、行と区間の列を返す。描画側は textContent で入れるので外からの文字列で XSS にならない。

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
// **太字** と `コード` を左から順に拾う。閉じない記号は地の文として残す
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`/g;

// 1 行の中を地の文、太字、コードの区間に分ける
export function inlineSpans(line) {
  const spans = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    if (match.index > last) spans.push({ type: "text", text: line.slice(last, match.index) });
    spans.push(match[1] !== undefined ? { type: "strong", text: match[1] } : { type: "code", text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < line.length) spans.push({ type: "text", text: line.slice(last) });
  return spans;
}

// 文字列を行の列にする。見出しは記号を外して heading に、箇条書きは記号を「・」に置き換える
export function parseMarkdown(text) {
  return String(text ?? "").split(/\r?\n/).map((raw) => {
    const heading = HEADING.exec(raw);
    if (heading) return { type: "heading", level: heading[1].length, spans: inlineSpans(heading[2].trim()) };
    const bullet = BULLET.exec(raw);
    if (bullet) return { type: "bullet", indent: bullet[1].length, spans: inlineSpans(bullet[2]) };
    return { type: "line", spans: inlineSpans(raw) };
  });
}
