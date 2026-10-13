import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export interface SlashCommand { name: string; description: string; source: 'builtin' | 'skill' | 'command' | 'plugin'; argumentHint?: string }
const CLAUDE_COMMANDS: [string, string][] = [
  ['help', 'Show help and commands'], ['cost', 'Show session cost and usage'], ['usage', 'Show usage'],
  ['model', 'Choose a model'], ['clear', 'Start a new conversation'], ['compact', 'Compact conversation context'],
  ['context', 'Show context usage'], ['config', 'Open settings'], ['status', 'Show session status'],
  ['permissions', 'Manage permissions'], ['memory', 'Manage project memory'], ['mcp', 'Manage MCP servers'],
  ['skills', 'Manage skills'], ['plugin', 'Manage plugins'], ['resume', 'Resume a conversation'],
  ['rename', 'Rename this conversation'], ['copy', 'Copy the last response'], ['diff', 'View changes'],
  ['effort', 'Choose reasoning effort'], ['plan', 'Enter plan mode'], ['rewind', 'Rewind the conversation'],
  ['export', 'Export this conversation'], ['theme', 'Choose a theme'], ['vim', 'Toggle Vim input'],
  ['add-dir', 'Add a working directory'], ['doctor', 'Check the installation'], ['hooks', 'Manage hooks'],
  ['tasks', 'View background tasks'], ['exit', 'Exit the session'], ['feedback', 'Send feedback'],
];
const CODEX_COMMANDS: [string, string][] = [
  ['help', 'Show help'], ['model', 'Choose a model and reasoning effort'], ['permissions', 'Choose permissions'],
  ['status', 'Show session status'], ['compact', 'Compact conversation context'], ['new', 'Start a new conversation'],
  ['resume', 'Resume a conversation'], ['fork', 'Fork this conversation'], ['diff', 'View changes'],
  ['review', 'Review changes'], ['mcp', 'Show MCP tools'], ['skills', 'Show skills'], ['quit', 'Exit the session'],
];
const MAX_METADATA_BYTES = 64 * 1024;
async function readOptional(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > MAX_METADATA_BYTES) return;
    return await readFile(path, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}
async function readJson(path: string): Promise<Record<string, any>> {
  const text = await readOptional(path);
  if (!text) return {};
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function readMetadata(text: string): Record<string, string> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1] ?? '';
  const result: Record<string, string> = {};
  let folded = '';
  for (const line of frontmatter.split(/\r?\n/u)) {
    if (folded && /^\s+\S/u.test(line)) { result[folded] += (result[folded] ? ' ' : '') + line.trim(); continue; }
    folded = '';
    const match = /^([\w-]+):\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const value = match[2].replace(/\s+#.*$/u, '');
    result[match[1]] = /^[>|][-+]?$/u.test(value) ? '' : value.replace(/^(['"])(.*)\1$/u, '$2');
    if (/^[>|][-+]?$/u.test(value)) folded = match[1];
  }
  return result;
}
async function listFiles(root: string, kind: 'skill' | 'command', visited = new Set<string>()): Promise<string[]> {
  let entries;
  try {
    const actual = await realpath(root);
    if (visited.has(actual)) return [];
    visited.add(actual);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink() && (await stat(path).catch(() => undefined))?.isDirectory()) {
      if (kind === 'skill') {
        if (await readOptional(join(path, 'SKILL.md')) !== undefined) files.push(join(path, 'SKILL.md'));
      } else files.push(...await listFiles(path, kind, visited));
    } else if (kind === 'command' && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}
export async function listSlashCommands(provider: 'claude' | 'codex', cwd: string, options: { home?: string; configDirectory?: string; remote?: boolean } = {}): Promise<SlashCommand[]> {
  const commands = new Map<string, SlashCommand>((provider === 'claude' ? CLAUDE_COMMANDS : CODEX_COMMANDS)
    .map(([name, description]) => [name, { name, description, source: 'builtin' }]));
  // リモートの会話にローカルの skill を混ぜない。Codex の skill 呼び出しは $name。
  if (provider !== 'claude' || options.remote) return [...commands.values()];
  const config = options.configDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? join(options.home ?? homedir(), '.claude');
  const roots: string[] = [];
  for (let path = resolve(cwd); ; path = dirname(path)) {
    roots.unshift(join(path, '.claude'));
    if (await stat(join(path, '.git')).catch(() => undefined) || dirname(path) === path) break;
  }
  const settings = [await readJson(join(config, 'settings.json')), ...await Promise.all(roots.flatMap(root =>
    ['settings.json', 'settings.local.json'].map(name => readJson(join(root, name)))))];
  const plugins = Object.assign({}, ...settings.map(value => value.enabledPlugins));
  const overrides = Object.assign({}, ...settings.map(value => value.skillOverrides));
  async function addPath(path: string, kind: 'skill' | 'command', namespace?: string) {
    const metadata = await stat(path).catch(() => undefined);
    const files = metadata?.isFile() ? [path] : kind === 'skill' && await readOptional(join(path, 'SKILL.md')) !== undefined
      ? [join(path, 'SKILL.md')] : await listFiles(path, kind);
    for (const file of files) {
      const body = await readOptional(file);
      if (body === undefined) continue;
      const metadata = readMetadata(body);
      // 現行の Claude Code はディレクトリ名／ファイル名を呼び出し名に使う。
      const local = kind === 'skill' ? basename(dirname(file)) : basename(file, '.md');
      const name = namespace ? `${namespace}:${local}` : local;
      if (!/^[\w.:-]+$/u.test(name)) continue;
      if (metadata['user-invocable'] === 'false' || !namespace && overrides[name] === 'off') { commands.delete(name); continue; }
      commands.set(name, { name, description: metadata.description || `${kind === 'skill' ? 'Skill' : 'Command'}: ${local}`,
        source: namespace ? 'plugin' : kind, ...(metadata['argument-hint'] ? { argumentHint: metadata['argument-hint'] } : {}) });
    }
  }
  async function addDirectory(root: string, namespace?: string) {
    for (const kind of ['command', 'skill'] as const) await addPath(join(root, kind === 'skill' ? 'skills' : 'commands'), kind, namespace);
  }
  const installed = await readJson(join(config, 'plugins', 'installed_plugins.json'));
  for (const [key, enabled] of Object.entries(plugins)) {
    if (enabled !== true) continue;
    const rows = installed.plugins?.[key];
    if (!Array.isArray(rows)) continue;
    const scoped = rows.filter(row => row && typeof row.installPath === 'string'
      && (row.scope === 'user' || !row.projectPath || resolve(cwd) === resolve(row.projectPath) || resolve(cwd).startsWith(resolve(row.projectPath) + sep)));
    const row = scoped.find(row => row.scope === 'local') ?? scoped.find(row => row.scope === 'project') ?? scoped[0];
    if (!row) continue;
    const manifest = await readJson(join(row.installPath, '.claude-plugin', 'plugin.json'));
    const namespace = typeof manifest.name === 'string' ? manifest.name : key.split('@')[0];
    const commandPaths = manifest.commands === undefined ? ['commands'] : typeof manifest.commands === 'string' ? [manifest.commands] : Array.isArray(manifest.commands) ? manifest.commands : [];
    for (const path of commandPaths) if (typeof path === 'string') await addPath(resolve(row.installPath, path), 'command', namespace);
    if (manifest.commands && !Array.isArray(manifest.commands) && typeof manifest.commands === 'object') {
      for (const [name, entry] of Object.entries(manifest.commands) as [string, Record<string, unknown>][]) {
        if (!/^[\w.-]+$/u.test(name) || !entry || typeof entry !== 'object') continue;
        const body = typeof entry.source === 'string' ? await readOptional(resolve(row.installPath, entry.source)) : typeof entry.content === 'string' ? entry.content : undefined;
        if (body === undefined || readMetadata(body)['user-invocable'] === 'false') continue;
        commands.set(`${namespace}:${name}`, { name: `${namespace}:${name}`, description: typeof entry.description === 'string' ? entry.description : readMetadata(body).description || name, source: 'plugin',
          ...(typeof entry.argumentHint === 'string' ? { argumentHint: entry.argumentHint } : {}) });
      }
    }
    await addPath(join(row.installPath, 'skills'), 'skill', namespace);
    const skillPaths = typeof manifest.skills === 'string' ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills : [];
    for (const path of skillPaths) if (typeof path === 'string') await addPath(resolve(row.installPath, path), 'skill', namespace);
    if (!manifest.skills && !await stat(join(row.installPath, 'skills')).catch(() => undefined)) await addPath(row.installPath, 'skill', namespace);
  }
  const projectRoot = dirname(roots[0]);
  const gitEntry = await stat(join(projectRoot, '.git')).catch(() => undefined);
  if (gitEntry?.isFile() && !await stat(join(projectRoot, '.claude', 'skills')).catch(() => undefined)) {
    const gitdir = /^gitdir:\s*(.+)/u.exec(await readOptional(join(projectRoot, '.git')) ?? '')?.[1];
    if (gitdir) {
      const location = resolve(projectRoot, gitdir);
      const common = await readOptional(join(location, 'commondir'));
      if (common) await addPath(join(dirname(resolve(location, common.trim())), '.claude', 'skills'), 'skill');
    }
  }
  for (const root of [...roots, config]) await addDirectory(root);
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}
