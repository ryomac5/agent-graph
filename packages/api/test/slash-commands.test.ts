import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { listSlashCommands } from '../src/terminal/slash-commands.ts';

test('candidates merge builtins, project commands, personal skills and enabled scoped plugins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slash-candidates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'claude'), cwd = join(root, 'repo'), plugin = join(root, 'plugin');
  async function put(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
  await mkdir(join(cwd, '.git'), { recursive: true });
  await put(join(cwd, '.claude/commands/team/check.md'), '---\ndescription: Project check\n---\nbody');
  await put(join(cwd, '.claude/skills/shared/SKILL.md'), '---\ndescription: Project shared\n---');
  await put(join(config, 'commands/shared.md'), '---\ndescription: Legacy shared\n---');
  await put(join(config, 'skills/shared/SKILL.md'), '---\nname: display-name\ndescription: >\n  Personal shared\n  command\nargument-hint: "[target]"\n---');
  await put(join(config, 'skills/hidden/SKILL.md'), '---\nuser-invocable: false\n---');
  await put(join(config, 'skills/off/SKILL.md'), '---\ndescription: Disabled\n---');
  await put(join(root, 'linked/SKILL.md'), '---\ndescription: Symlink skill\n---');
  await symlink(join(root, 'linked'), join(config, 'skills/linked'));
  await put(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'sample' }));
  await put(join(plugin, 'skills/check/SKILL.md'), '---\ndescription: Plugin check\n---');
  await put(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'sample@market': [{ scope: 'project', projectPath: cwd, installPath: plugin }],
    'disabled@market': [{ scope: 'user', installPath: plugin }],
    'other@market': [{ scope: 'project', projectPath: join(root, 'elsewhere'), installPath: plugin }],
  } }));
  await put(join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'sample@market': true, 'disabled@market': true, 'other@market': true }, skillOverrides: { off: 'off' } }));
  await put(join(cwd, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'disabled@market': false } }));
  const commands = await listSlashCommands('claude', cwd, { configDirectory: config });
  assert.ok(commands.some(command => command.name === 'help' && command.source === 'builtin'));
  assert.deepEqual(commands.find(command => command.name === 'shared'), { name: 'shared', description: 'Personal shared command', source: 'skill', argumentHint: '[target]' });
  assert.equal(commands.find(command => command.name === 'check')?.source, 'command');
  assert.equal(commands.find(command => command.name === 'sample:check')?.source, 'plugin');
  assert.equal(commands.find(command => command.name === 'linked')?.source, 'skill');
  assert.ok(!commands.some(command => ['hidden', 'off', 'display-name', 'disabled:check', 'other:check'].includes(command.name)));
  const remote = await listSlashCommands('claude', cwd, { configDirectory: config, remote: true });
  assert.ok(remote.every(command => command.source === 'builtin'));
  const codex = await listSlashCommands('codex', cwd, { configDirectory: config });
  assert.ok(codex.some(command => command.name === 'model'));
  assert.ok(codex.every(command => command.source === 'builtin'));
});

test('plugin manifest paths and inline commands are used instead of an overridden commands folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slash-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'), config = join(root, 'claude'), plugin = join(root, 'plugin');
  async function put(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
  await mkdir(join(cwd, '.git'), { recursive: true });
  await put(join(plugin, 'commands/ignored.md'), '---\ndescription: Ignored default\n---');
  await put(join(plugin, 'extra-skills/additional/SKILL.md'), '---\ndescription: Extra skill\n---');
  await put(join(plugin, 'extra-command.md'), '---\ndescription: File command\n---');
  await put(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'custom', skills: ['./extra-skills'], commands: {
    about: { content: 'Describe the plugin', description: 'About this plugin' },
    file: { source: './extra-command.md', argumentHint: '[target]' },
  } }));
  await put(join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'custom@market': true } }));
  await put(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'custom@market': [{ scope: 'user', installPath: plugin }] } }));
  const commands = await listSlashCommands('claude', cwd, { configDirectory: config });
  assert.deepEqual(commands.filter(command => command.source === 'plugin').map(command => command.name), ['custom:about', 'custom:additional', 'custom:file']);
  assert.equal(commands.find(command => command.name === 'custom:file')?.argumentHint, '[target]');
});

test('linked worktrees fall back to main-checkout skills only when the worktree has no skills directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slash-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main'), cwd = join(root, 'worktree'), config = join(root, 'claude');
  async function put(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
  await put(join(cwd, '.git'), `gitdir: ${join(main, '.git/worktrees/linked')}\n`);
  await put(join(main, '.git/worktrees/linked/commondir'), '../..\n');
  await put(join(main, '.claude/skills/project-check/SKILL.md'), '---\ndescription: Shared project skill\n---');
  assert.ok((await listSlashCommands('claude', cwd, { configDirectory: config })).some(command => command.name === 'project-check'));
  await mkdir(join(cwd, '.claude/skills'), { recursive: true });
  assert.ok(!(await listSlashCommands('claude', cwd, { configDirectory: config })).some(command => command.name === 'project-check'));
});
