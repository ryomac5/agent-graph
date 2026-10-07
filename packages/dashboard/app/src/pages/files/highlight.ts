// 依存を足さない簡単な色分け。言語ごとの字句の規則を先頭から順に試し、最初に合った規則の種類を付ける。
export type TokenType = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'function' | 'type' | 'key'
  | 'tag' | 'attr' | 'heading' | 'meta' | 'variable' | 'code' | 'emphasis' | 'link';
export interface Token { text: string; type?: TokenType }
export type Language = 'ts' | 'tsx' | 'js' | 'json' | 'md' | 'py' | 'sh' | 'css' | 'html' | 'toml' | 'yaml';
interface Rule { re: RegExp; type?: TokenType | ((text: string) => TokenType | undefined); inner?: Rule[] }

const words = (list: string) => new Set(list.split(' '));
const rule = (source: string, type?: Rule['type'], flags = '', inner?: Rule[]): Rule =>
  ({ re: new RegExp(source, `y${flags}`), type, inner });
const END = '(?![\\s\\S])';
const SPACE = rule('\\s+');

const JS_KEYWORDS = words('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield');
const JS_LITERALS = words('true false null undefined NaN Infinity');
const jsWord = (text: string): TokenType | undefined =>
  JS_KEYWORDS.has(text) ? 'keyword' : JS_LITERALS.has(text) ? 'literal' : /^[A-Z]/.test(text) ? 'type' : undefined;
const JS: Rule[] = [
  SPACE,
  rule('\\/\\/.*', 'comment'),
  rule(`\\/\\*[\\s\\S]*?(?:\\*\\/|${END})`, 'comment'),
  rule('`(?:\\\\[\\s\\S]|[^\\\\`])*`?', 'string'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?', 'string'),
  rule("'(?:\\\\.|[^'\\\\\\n])*'?", 'string'),
  rule('(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?|\\.\\d[\\d_]*)n?', 'number'),
  rule('[A-Za-z_$][\\w$]*(?=\\s*\\()', text => JS_KEYWORDS.has(text) ? 'keyword' : 'function'),
  rule('[A-Za-z_$][\\w$]*', jsWord),
  rule('@[A-Za-z_$][\\w$.]*', 'meta'),
];
const TSX: Rule[] = [...JS.slice(0, 6), rule('<\\/?[A-Za-z][\\w.:-]*', 'tag'), rule('\\/?>', 'tag'),
  rule('[A-Za-z_][\\w-]*(?==["\'{])', 'attr'), ...JS.slice(6)];

const JSON_RULES: Rule[] = [
  SPACE,
  rule('"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)', 'key'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?', 'string'),
  rule('-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'number'),
  rule('[A-Za-z_]\\w*', text => ['true', 'false', 'null'].includes(text) ? 'literal' : undefined),
  rule('\\/\\/.*', 'comment'),
];

const PY_KEYWORDS = words('and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield');
const PY: Rule[] = [
  SPACE,
  rule('#.*', 'comment'),
  rule(`[rRbBuUfF]{0,2}(?:"""[\\s\\S]*?(?:"""|${END})|'''[\\s\\S]*?(?:'''|${END}))`, 'string'),
  rule('[rRbBuUfF]{0,2}(?:"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?)', 'string'),
  rule('@[A-Za-z_][\\w.]*', 'meta'),
  rule('(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?|\\.\\d+)[jJ]?', 'number'),
  rule('[A-Za-z_]\\w*(?=\\s*\\()', text => PY_KEYWORDS.has(text) ? 'keyword' : 'function'),
  rule('[A-Za-z_]\\w*', text => PY_KEYWORDS.has(text) ? 'keyword' : ['True', 'False', 'None'].includes(text) ? 'literal'
    : text === 'self' || text === 'cls' ? 'variable' : /^[A-Z]/.test(text) ? 'type' : undefined),
];

const SH_KEYWORDS = words('if then else elif fi for while until do done case esac in function return local export declare readonly set unset shift exit break continue source alias trap eval exec select');
const SH: Rule[] = [
  SPACE,
  rule('(?<=^|[\\s;|&(])#.*', 'comment', 'm'),
  rule('"(?:\\\\[\\s\\S]|[^"\\\\])*"?', 'string'),
  rule("'[^']*'?", 'string'),
  rule('\\$\\{[^}\\n]*\\}?|\\$\\(\\(?|\\$[\\w@*#?$!-]', 'variable'),
  rule('[A-Za-z_][\\w-]*(?==)', 'variable'),
  rule('\\d+(?![\\w-])', 'number'),
  rule('[A-Za-z_][\\w.-]*', text => SH_KEYWORDS.has(text) ? 'keyword' : ['true', 'false'].includes(text) ? 'literal' : undefined),
];

const CSS: Rule[] = [
  SPACE,
  rule(`\\/\\*[\\s\\S]*?(?:\\*\\/|${END})`, 'comment'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?', 'string'),
  rule('@[\\w-]+', 'keyword'),
  rule('--[\\w-]+', 'variable'),
  rule('#[\\da-fA-F]{3,8}(?![\\w-])', 'number'),
  rule('-?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|[a-zA-Z]+)?', 'number'),
  rule('!important', 'keyword'),
  rule('[\\w-]+(?=\\()', 'function'),
  rule('[\\w-]+(?=[ \\t]*:[^;{}\\n]*[;}])', 'key'),
  rule('\\.[A-Za-z_-][\\w-]*', 'tag'),
  rule('[\\w-]+'),
];

const HTML_TAG: Rule[] = [
  rule('<\\/?[\\w:-]+', 'tag'),
  SPACE,
  rule('"[^"]*"?|\'[^\']*\'?', 'string'),
  rule('[^\\s"\'=<>/]+', 'attr'),
  rule('\\/?>', 'tag'),
];
const HTML: Rule[] = [
  SPACE,
  rule(`<!--[\\s\\S]*?(?:-->|${END})`, 'comment'),
  rule('<![A-Za-z][^>]*>?', 'meta'),
  rule('<\\/?[A-Za-z][\\w:-]*(?:"[^"]*"|\'[^\']*\'|[^\'">])*>?', undefined, '', HTML_TAG),
  rule('&[#\\w]+;', 'literal'),
  rule('[^<&\\s]+'),
];

const TOML_KEY = '(?:[\\w-]+|"[^"\\n]*"|\'[^\'\\n]*\')';
const TOML: Rule[] = [
  SPACE,
  rule('#.*', 'comment'),
  rule('^[ \\t]*\\[\\[?[^\\]\\n]*\\]\\]?', 'heading', 'm'),
  rule(`(?<=(?:^|[{,])[ \\t]*)${TOML_KEY}(?:[ \\t]*\\.[ \\t]*${TOML_KEY})*(?=[ \\t]*=)`, 'key', 'm'),
  rule(`"""[\\s\\S]*?(?:"""|${END})|'''[\\s\\S]*?(?:'''|${END})`, 'string'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?|\'[^\'\\n]*\'?', 'string'),
  rule('\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?|\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?', 'number'),
  rule('[+-]?(?:0x[\\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?|inf|nan)', 'number'),
  rule('[A-Za-z_]\\w*', text => ['true', 'false'].includes(text) ? 'literal' : undefined),
];

const YAML_LITERALS = words('true false null yes no on off True False Null TRUE FALSE NULL Yes No');
const YAML_PREFIX = '(?<=^[ \\t]*(?:-[ \\t]+)*)';
const YAML: Rule[] = [
  SPACE,
  rule('(?<=^|\\s)#.*', 'comment', 'm'),
  rule('^(?:---|\\.\\.\\.)(?=\\s|$)', 'meta', 'm'),
  rule(`${YAML_PREFIX}(?:"[^"\\n]*"|'[^'\\n]*')(?=[ \\t]*:(?:[ \\t]|$))`, 'key', 'm'),
  rule(`${YAML_PREFIX}[^\\s#'"{}\\[\\],&*!|>-][^:\\n#]*?(?=[ \\t]*:(?:[ \\t]|$))`, 'key', 'm'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?|\'[^\'\\n]*\'?', 'string'),
  rule('[&*][\\w-]+', 'variable'),
  rule('!!?[\\w-]*', 'meta'),
  rule('[+-]?(?:0x[\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?![\\w.-])', 'number'),
  rule('~(?!\\S)', 'literal'),
  rule('[A-Za-z_][\\w-]*', text => YAML_LITERALS.has(text) ? 'literal' : undefined),
];

const MARKDOWN: Rule[] = [
  rule(`^ {0,3}(\`\`\`|~~~)[^\\n]*\\n?[\\s\\S]*?(?:^ {0,3}\\1[ \\t]*$|${END})`, 'code', 'm'),
  rule('^ {0,3}#{1,6}(?=[ \\t]|$).*', 'heading', 'm'),
  rule('^ {0,3}>.*', 'comment', 'm'),
  rule('^[ \\t]*(?:[-*+]|\\d+[.)])(?=[ \\t])', 'keyword', 'm'),
  rule(`<!--[\\s\\S]*?(?:-->|${END})`, 'comment'),
  rule('`[^`\\n]+`', 'code'),
  rule('(\\*\\*|__)(?=\\S)[^\\n]*?\\S\\1', 'emphasis'),
  rule('!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|<https?:[^>\\s]+>', 'link'),
  rule('[^\\n`*_\\[!<]+'),
];

const RULES: Record<Language, Rule[]> = { ts: JS, js: JS, tsx: TSX, json: JSON_RULES, py: PY, sh: SH, css: CSS, html: HTML, toml: TOML, yaml: YAML, md: MARKDOWN };
export const LANGUAGE_NAMES: Record<Language, string> = { ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', json: 'JSON', md: 'Markdown', py: 'Python',
  sh: 'Shell', css: 'CSS', html: 'HTML', toml: 'TOML', yaml: 'YAML' };
const EXTENSIONS: Record<string, Language> = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', jsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', json: 'json', jsonc: 'json', json5: 'json',
  md: 'md', markdown: 'md', mdx: 'md', py: 'py', pyi: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', html: 'html', htm: 'html',
  toml: 'toml', yaml: 'yaml', yml: 'yaml',
};
const FILE_NAMES: Record<string, Language> = { '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh', '.envrc': 'sh', 'Pipfile': 'toml' };

export function detectLanguage(path: string): Language | undefined {
  const name = path.split('/').at(-1) ?? path;
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 || (dot === 0 && name.length > 1) ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined;
}

function scan(text: string, rules: Rule[]): Token[] {
  const tokens: Token[] = [];
  let plain = '';
  let position = 0;
  const flush = () => { if (plain) { tokens.push({ text: plain }); plain = ''; } };
  while (position < text.length) {
    let matched = '';
    for (const { re, type, inner } of rules) {
      re.lastIndex = position;
      const match = re.exec(text)?.[0];
      if (!match) continue;
      matched = match;
      if (inner) { flush(); tokens.push(...scan(match, inner)); break; }
      const kind = typeof type === 'function' ? type(match) : type;
      if (kind) { flush(); tokens.push({ text: match, type: kind }); } else plain += match;
      break;
    }
    if (matched) position += matched.length;
    else plain += text[position++];
  }
  flush();
  return tokens;
}

/** 字句に分けてから行に割る。複数行の注釈と文字列も行をまたいで色が続く。 */
export function highlightLines(content: string, language?: Language): Token[][] {
  const text = content.replace(/\r\n?/g, '\n');
  const tokens = language ? scan(text, RULES[language]) : [{ text }];
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    token.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push(token.type ? { text: part, type: token.type } : { text: part });
    });
  }
  if (lines.length > 1 && text.endsWith('\n')) lines.pop();
  return lines;
}
