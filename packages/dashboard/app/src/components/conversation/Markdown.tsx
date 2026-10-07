import { Fragment, type ReactNode } from 'react';

function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    if (part.startsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link && /^(https?:\/\/|\/(?!\/)|#)/i.test(link[2])) return <a key={index} href={link[2]} rel="noreferrer">{link[1]}</a>;
    return part;
  });
}

// HTML は解釈せず、React の文字列として描画する。
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      const closing = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      index++;
      while (index < lines.length && !closing.test(lines[index]!)) code.push(lines[index++]!);
      index++;
      blocks.push(<pre key={blocks.length}><code data-language={fence[2]!.trim()}>{code.join('\n')}</code></pre>);
    } else if (!line.trim()) index++;
    else if (/^#{1,6} /.test(line)) {
      blocks.push(<p className="markdown-heading" key={blocks.length}><strong>{renderInline(line.replace(/^#+ /, ''))}</strong></p>);
      index++;
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+\. / : /^\s*[-*+] /;
      while (index < lines.length && pattern.test(lines[index]!)) {
        items.push(<li key={items.length}>{renderInline(lines[index++]!.replace(pattern, ''))}</li>);
      }
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    } else if (line.startsWith('> ')) {
      blocks.push(<blockquote key={blocks.length}>{renderInline(line.slice(2))}</blockquote>);
      index++;
    } else {
      blocks.push(<p key={blocks.length}>{renderInline(line)}</p>);
      index++;
    }
  }
  return <div className="conversation-markdown">{blocks.map((block, index) => <Fragment key={index}>{block}</Fragment>)}</div>;
}
