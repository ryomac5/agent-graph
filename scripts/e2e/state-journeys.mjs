import assert from 'node:assert/strict';
import { waitFor, readActors } from './isolation.mjs';

export const STATE_JOURNEYS = [
  ['state-drop-stop', 'Stop 欠落でも turn_duration があれば Idle'],
  ['state-drop-end', 'SessionEnd 欠落は OS の終了確認で Stopped'],
  ['state-child-tool', '子の tool_use 中の停止は Unknown'],
  ['state-child-notice', '親の子停止通知は子だけ Unknown'],
  ['state-parent-restart', '親再起動後の子は生存を引き継がない'],
  ['state-approval', '許可の待ちは Needs approval'],
  ['state-long-tool', '300 秒を越える tool は同じプロセスの生存中 Working'],
  ['state-same-text', '別端末の同文入力を配達確定にしない'],
  ['state-scan-failure', '走査失敗は期限を延長せず Unknown'],
  ['state-escape', '確かな Esc 中断は Idle、その後も使える'],
];
const SCAN_TIMEOUT_MS = 25_000;
const EXPIRE_PROGRESS_MS = 301_000;
export async function runStateJourneys({ check, seed, script, send, reply, idle, snapshot, watches, open, status, bubble, isolation }) {
  async function decision(id, condition = () => true) {
    return waitFor(async () => {
      const { projection } = await snapshot();
      const conversation = projection.conversations.find(row => row.id === id);
      const run = projection.runs.find(row => row.id === conversation?.current_run_id);
      const value = projection.state_decisions.find(row => row.id === run?.decision_id);
      return value && condition(value) ? value : false;
    }, `current state ${id}`, SCAN_TIMEOUT_MS);
  }
  async function expect(id, label, condition) {
    const d = await decision(id, value => value.display.label === label && (!condition || condition(value)));
    assert.ok(Number.isFinite(d.evaluatedAt)); assert.ok(d.turn.reason);
    await open(id); await status(label).waitFor();
    assert.equal(d.display.label, label); return d;
  }
  async function childOf(session) {
    await decision(session.original, d => d.process.value === 'alive_confirmed');
    const state = await script(session, 'child-tool');
    const id = JSON.stringify(['claude', state.child.id]);
    await expect(id, 'Working'); return id;
  }
  await check('state-drop-stop', async () => {
    const session = await seed(); await script(session, 'drop-stop');
    const text = session.marker + ' no Stop'; await send(text); await reply(text);
    await expect(session.original, 'Idle', d => d.turn.reason === 'turn_finished');
  });
  await check('state-drop-end', async () => {
    const session = await seed(); await decision(session.original, d => d.process.value === 'alive_confirmed');
    await script(session, 'drop-session-end'); await script(session, 'exit');
    await expect(session.original, 'Stopped', d => d.process.reason === 'process_exited' && d.closure.value !== 'closed');
  });
  await check('state-child-tool', async () => {
    const session = await seed(); const child = await childOf(session);
    await script(session, 'child-stop-tool');
    await expect(child, 'Unknown', d => d.turn.reason === 'boundary_unavailable');
  });
  await check('state-child-notice', async () => {
    const session = await seed(); const child = await childOf(session);
    await script(session, 'child-stopped-notification');
    await expect(child, 'Unknown', d => d.turn.reason === 'boundary_unavailable');
    await expect(session.original, 'Idle');
  });
  await check('state-parent-restart', async () => {
    const session = await seed(); const child = await childOf(session);
    await script(session, 'advance-clock', { ms: EXPIRE_PROGRESS_MS });
    await script(session, 'parent-restart');
    await waitFor(async () => (await readActors(isolation.control)).some(actor => actor.id === session.id && actor.pid !== session.pid), 'new parent process', SCAN_TIMEOUT_MS);
    await expect(child, 'Unknown', d => d.process.reason === 'owner_restarted');
  });
  await check('state-approval', async () => {
    const session = await seed(); await script(session, 'approval-wait');
    await expect(session.original, 'Needs approval', d => d.turn.reason === 'approval_requested');
  });
  await check('state-long-tool', async () => {
    const session = await seed(); await script(session, 'long-tool');
    await expect(session.original, 'Working');
    await script(session, 'advance-clock', { ms: EXPIRE_PROGRESS_MS });
    await expect(session.original, 'Working', d => d.turn.reason === 'running_tool' && d.process.value === 'alive_confirmed');
  });
  await check('state-same-text', async () => {
    const session = await seed(); const text = session.marker + ' two terminals';
    await script(session, 'drop-next'); await send(text);
    await script(session, 'external-input', { text });
    await waitFor(async () => (await watches(session.original)).some(row => row.body === text && row.decision.display === 'Likely delivered'), 'uncorrelated receipt remains a candidate');
    await script(session, 'external-input', { text });
    await waitFor(async () => (await watches(session.original)).some(row => row.body === text && row.decision.reason === 'ambiguous_candidates'), 'ambiguous receipts');
    await bubble(text).filter({ hasText: 'Unconfirmed' }).getByRole('status').waitFor();
  });
  await check('state-scan-failure', async () => {
    const session = await seed(); await script(session, 'long-tool');
    await decision(session.original, d => d.turn.reason === 'running_tool');
    try {
      await script(session, 'scan-failure'); await script(session, 'advance-clock', { ms: EXPIRE_PROGRESS_MS });
      await expect(session.original, 'Unknown', d => d.observation.some(scan => scan.state === 'failed'));
    } finally { await script(session, 'restore-scan'); }
    await expect(session.original, 'Working', d => d.turn.reason === 'running_tool');
  });
  await check('state-escape', async () => {
    const session = await seed(); await script(session, 'long-tool'); await expect(session.original, 'Working');
    await script(session, 'interrupt'); await expect(session.original, 'Idle');
    const text = session.marker + ' after Esc'; await send(text); await reply(text); await idle(session);
  });
}
