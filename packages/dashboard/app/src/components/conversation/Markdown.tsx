import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { detectLanguage, highlightLines, LANGUAGE_NAMES, type Language } from '../../pages/files/highlight.ts';
import '../../pages/files/highlight.css';
import { AppLink } from '../AppLink.tsx';
import { Icon } from '../Icon.tsx';
import './markdown.css';

/** 囲いのコードの情報文字列で、拡張子と違う呼び名を色分けの言語へ寄せる。 */
const LANGUAGE_ALIASES: Record<string, Language> = {
  typescript: 'ts', javascript: 'js', python: 'py', shell: 'sh', console: 'sh', shellsession: 'sh', markdown: 'md', jsx: 'tsx',
};
export function fenceLanguage(info: string): Language | undefined {
  const name = info.trim().toLowerCase();
  return name ? LANGUAGE_ALIASES[name] ?? detectLanguage(`code.${name}`) : undefined;
}

/** リンクと画像の行き先は http と https とアプリ内の経路だけを通す。他は捨てて文字だけ残す。 */
export function safeUrl(url: string): string | undefined {
  const value = url.trim();
  return /^https?:\/\//i.test(value) || /^\/(?![/\\])/.test(value) ? value : undefined;
}

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
interface MdastNode { type: string; value?: string; children?: MdastNode[] }
/** 会話では段落の中の 1 つの改行も改行として見せる。コードと HTML の値は子を持たないので触らない。 */
function remarkSoftBreaks() {
  const visit = (node: MdastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text' || !child.value?.includes('\n')) { visit(child); return [child]; }
      return child.value.split(/\r?\n/).flatMap((part, index): MdastNode[] => [
        ...(index > 0 ? [{ type: 'break' }] : []),
        ...(part ? [{ type: 'text', value: part }] : []),
      ]);
    });
  };
  return (tree: MdastNode) => visit(tree);
}

function textOf(node: HastNode | undefined): string {
  if (!node) return '';
  return node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('');
}

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_LABELS: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };
const COPY_RESET_MS = 1600;

/** 囲いのコード。Files と同じ色分けを使い、言語名と複写のボタンを上の帯に置く。 */
export function CodeBlock({ code, info }: { code: string; info: string }) {
  const language = fenceLanguage(info);
  const label = language ? LANGUAGE_NAMES[language] : info.trim() || 'Plain text';
  const lines = useMemo(() => highlightLines(code, language), [code, language]);
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copyCode() {
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setCopy('copied');
    } catch { setCopy('failed'); }
    timer.current = setTimeout(() => setCopy('idle'), COPY_RESET_MS);
  }
  return <div className="md-code" data-language={language ?? 'plain'}>
    <div className="md-code-bar"><span className="md-code-language">{label}</span>
      <button type="button" className="md-code-copy" aria-label={copy === 'idle' ? 'Copy code' : COPY_LABELS[copy]} onClick={() => void copyCode()}>
        <Icon name={copy === 'copied' ? 'check' : 'copy'} size={13}/><span aria-hidden="true">{COPY_LABELS[copy]}</span></button></div>
    <pre><code>{lines.map((tokens, index) => <span className="md-code-line" key={index}>
      {tokens.map((token, part) => token.type ? <span key={part} className={`tok tok-${token.type}`}>{token.text}</span> : token.text)}
      {index < lines.length - 1 ? '\n' : ''}</span>)}</code></pre>
  </div>;
}

type HeadingProps = ComponentProps<'h1'> & { node?: unknown };
/** 本文の見出しは画面の見出しより 2 段下げる。見た目の段は md-h の印で付ける。 */
function heading(level: number) {
  const Tag = `h${Math.min(level + 2, 6)}` as 'h3';
  return function MarkdownHeading({ node: _node, className, ...props }: HeadingProps) {
    return <Tag className={[`md-h md-h${level}`, className].filter(Boolean).join(' ')} {...props}/>;
  };
}

const COMPONENTS: Components = {
  h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
  a({ node: _node, href, children, target: _target, rel: _rel, ...props }) {
    if (!href) return <span className="md-link-inert">{children}</span>;
    if (href.startsWith('/')) return <AppLink to={href} rel="noreferrer" {...props}>{children}</AppLink>;
    return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
  },
  img({ src, alt }) {
    const text: ReactNode = <><Icon name="image" size={14}/><span>{alt || 'Image'}</span></>;
    const href = typeof src === 'string' && src ? src : undefined;
    return href ? <a className="md-image" href={href} target="_blank" rel="noreferrer" title={href}>{text}</a>
      : <span className="md-image" role="img" aria-label={alt || 'Image'}>{text}</span>;
  },
  pre({ node }) {
    const code = (node as HastNode | undefined)?.children?.find(child => child.tagName === 'code');
    const classes = code?.properties?.className;
    const info = (Array.isArray(classes) ? classes.map(String) : []).find(name => name.startsWith('language-'))?.slice('language-'.length) ?? '';
    return <CodeBlock code={textOf(code).replace(/\n$/, '')} info={info}/>;
  },
  code({ node: _node, className, ...props }) { return <code className={['md-inline-code', className].filter(Boolean).join(' ')} {...props}/>; },
  table({ node: _node, ...props }) { return <div className="md-table-wrap"><table {...props}/></div>; },
  input({ node: _node, ...props }) { return <input {...props} readOnly className="md-task-box"/>; },
};
const PLUGINS = { document: [remarkGfm], conversation: [remarkGfm, remarkSoftBreaks], rehype: [rehypeSanitize] };

/**
 * Markdown を GFM で解釈し、rehype-sanitize の既定の方針で HTML を落としてから描く。
 * breaks は会話のように 1 つの改行を改行として見せる。ファイルの表示では切る。
 */
export function Markdown({ text, breaks = true, className }: { text: string; breaks?: boolean; className?: string }) {
  return <div className={['conversation-markdown markdown-body', className].filter(Boolean).join(' ')}>
    <ReactMarkdown remarkPlugins={breaks ? PLUGINS.conversation : PLUGINS.document} rehypePlugins={PLUGINS.rehype}
      urlTransform={safeUrl} components={COMPONENTS}>{text}</ReactMarkdown>
  </div>;
}
