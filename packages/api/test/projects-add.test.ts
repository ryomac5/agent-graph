import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openLedger, project } from '../../core/src/ledger/index.ts';
import { addProject, listDirectories } from '../src/ws/projects.ts';

test('project.add registers the Git body, expands home and refuses missing, non-Git and temporary locations', async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'project-add-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const main = join(home, 'main'), tree = join(home, 'tree');
  mkdirSync(main); mkdirSync(join(home, 'plain'));
  execFileSync('git', ['init', '--quiet', main]);
  execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'test']);
  execFileSync('git', ['-C', main, 'worktree', 'add', '--quiet', '--detach', tree]);
  const ledger = openLedger(':memory:'); t.after(() => ledger.close());
  const message = (path: string, id = path) => ({ type: 'cmd' as const, cmd_id: id, command: 'project.add', payload: { path } });
  const append = (input: Parameters<typeof ledger.append>[0]) => ledger.append(input);
  const result = await addProject(append, message('~/tree'), { home, temporaryRoots: [] });
  const rows = project(ledger.readSince(0, 100)).projects;
  assert.equal(rows[0].id, result.projectId); assert.equal(rows[0].root_path, main); assert.equal(rows[0].state, 'registered');
  await assert.rejects(addProject(append, message(join(home, 'missing'))), /missing/);
  await assert.rejects(addProject(append, message(join(home, 'plain'))), /not_git/);
  await assert.rejects(addProject(append, message(main)), /temporary/);
  assert.equal(ledger.readSince(0, 100).length, 1);
});
test('directory candidates stay below home and exclude hidden directories and escaped symlinks', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'project-candidates-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home'), visible = join(home, 'visible'), hidden = join(home, '.hidden'), outside = join(directory, 'outside');
  for (const path of [home, visible, hidden, outside]) mkdirSync(path);
  mkdirSync(join(hidden, 'child')); symlinkSync(outside, join(home, 'escape'));
  assert.deepEqual(listDirectories({ path: '~/' }, home).paths, [visible]);
  assert.deepEqual(listDirectories({ path: '' }, home).paths, [visible]);
  assert.deepEqual(listDirectories({ path: '~/vi' }, home).paths, [visible]);
  assert.deepEqual(listDirectories({ path: outside + '/' }, home).paths, []);
  assert.deepEqual(listDirectories({ path: '~/../' }, home).paths, []);
  assert.deepEqual(listDirectories({ path: '~/.hidden/' }, home).paths, []);
  assert.deepEqual(listDirectories({ path: '~/escape/' }, home).paths, []);
});

test('a local launch without a worktree resolves the registered body', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'project-local-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const main = join(directory, 'main'); mkdirSync(main); execFileSync('git', ['init', '--quiet', main]);
  const { openObservationService } = await import('../src/service/index.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const { createFilesApi } = await import('../src/files/index.ts');
  const { createTargetService } = await import('../src/remote/index.ts');
  const service = openObservationService({ dbPath: join(directory, 'ledger.db') });
  t.after(() => service.close());
  const { projectId } = await addProject(service.appendUi, { type: 'cmd', command: 'project.add', cmd_id: 'add', payload: { path: main } }, { temporaryRoots: [] });
  const db = new DatabaseSync(service.dbPath); t.after(() => db.close());
  const target = createTargetService(createFilesApi(db).selectRoot, { settingsPath: join(directory, 'ssh.toml') });
  assert.equal((await target.launchLocation(projectId, { kind: 'local' })).path, main);
});
