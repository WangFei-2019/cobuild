import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { applyAction, seedState } from '../domain.mjs';
import { createApp } from '../server.mjs';

const taskById = state => state.tasks.find(task => task.id === 't2');
function awaitingResubmission() {
  let state = applyAction(seedState(), { type: 'submitArtifact', actorId: 'm2', taskId: 't2', name: '原成果', note: '最初的接口字段。' });
  return applyAction(state, { type: 'updateTask', actorId: 'm0', taskId: 't2', patch: { deliverable: '接口字段与错误响应说明' } });
}

test('交付表单旧快照在交付物、负责人或接收人变更后均冲突，核对最新约定后才能重新提交', async t => {
  for (const [field, value] of [['deliverable', '接口字段、错误响应与可执行验证'], ['ownerId', 'm1'], ['reviewerId', 'm0']]) {
    await t.test(field, () => {
      const initial = awaitingResubmission(), displayed = structuredClone(taskById(initial));
      assert.equal(displayed.needsResubmission, true);
      const changed = applyAction(initial, { type: 'updateTask', actorId: 'm0', taskId: 't2', patch: { [field]: value } });
      const before = structuredClone(changed), latest = taskById(changed);
      assert.notEqual(latest.updatedAt, displayed.updatedAt);
      const submission = { type: 'submitArtifact', actorId: 'm2', taskId: 't2', name: '仍依据旧表单准备的成果', note: '不能当成核对新约定后的重交。', taskUpdatedAt: displayed.updatedAt };
      assert.throws(() => applyAction(changed, submission), error => error.status === 409 && /任务已有更新/.test(error.message));
      assert.deepEqual(changed, before);
      assert.equal(taskById(changed).artifacts.length, displayed.artifacts.length);
      assert.equal(taskById(changed).needsResubmission, true);
      // A changed owner must submit as the newly authorized owner, not as the old one.
      const confirmed = applyAction(changed, { ...submission, actorId: latest.ownerId, name: '按最新约定核对后的成果', taskUpdatedAt: latest.updatedAt });
      const acceptedDraft = taskById(confirmed);
      assert.equal(acceptedDraft.artifacts.length, latest.artifacts.length + 1);
      assert.equal(acceptedDraft.artifacts[0].submittedBy, latest.ownerId);
      assert.equal(acceptedDraft.reviewerId, latest.reviewerId);
      assert.equal(acceptedDraft.needsResubmission, false);
      assert.equal(acceptedDraft.status, 'review');
      assert.equal(confirmed.revision, changed.revision + 1);
    });
  }
});

test('默认鉴权文件交付的旧版本返回409且不写文件，核对最新版本后可上传下载', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-handoff-conflict-'));
  const server = createApp({ dataDir, publicUrl: '', setupToken: '', seedDemo:true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '';
    return async (path, input) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    };
  }
  const admin = client(), author = client(), password = 'handoff-fixture-password-2026';
  assert.equal((await admin('/api/auth/setup', { name: '交付测试管理员', email: 'handoff-admin@example.test', password })).status, 200);
  const invitationResponse = await admin('/api/invitations', { projectId: 'p1', memberId: 'm2', email: 'handoff-author@example.test', accessRole: 'member' });
  assert.equal(invitationResponse.status, 201);
  const invitation = (await invitationResponse.json()).invitation;
  assert.equal((await author('/api/auth/register', { name: '交付负责人', email: 'handoff-author@example.test', password, inviteToken: new URL(invitation.url).pathname.split('/').at(-1) })).status, 200);
  const original = await author('/api/action', { type: 'submitArtifact', taskId: 't2', name: '旧成果', note: '已有成果应完整保留。' });
  assert.equal(original.status, 200);
  const displayed = taskById((await original.json()).state);
  const change = await admin('/api/action', { type: 'updateTask', taskId: 't2', patch: { deliverable: '按新约定补充接口字段、错误响应和验证步骤' } });
  assert.equal(change.status, 200);
  const latestState = (await (await author('/api/state')).json()), latest = taskById(latestState);
  assert.equal(latest.needsResubmission, true);
  const diskBefore = readFileSync(join(dataDir, 'project.json')), filesBefore = readdirSync(join(dataDir, 'files'));
  const bytes = Buffer.from('只有核对最新交付约定后才能保存此文件。');
  const input = { type: 'submitArtifact', taskId: 't2', taskUpdatedAt: displayed.updatedAt, name: '新附件', file: { name: '核对后的接口.md', base64: bytes.toString('base64') } };
  const stale = await author('/api/action', input);
  assert.equal(stale.status, 409);
  assert.deepEqual(await (await author('/api/state')).json(), latestState);
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), diskBefore);
  assert.deepEqual(readdirSync(join(dataDir, 'files')), filesBefore);
  assert.equal(taskById(latestState).artifacts.length, displayed.artifacts.length);
  assert.equal(taskById(latestState).needsResubmission, true);
  const current = await author('/api/action', { ...input, taskUpdatedAt: latest.updatedAt });
  assert.equal(current.status, 200);
  const saved = taskById((await current.json()).state);
  assert.equal(saved.needsResubmission, false); assert.equal(saved.status, 'review');
  assert.equal(saved.artifacts.length, latest.artifacts.length + 1);
  assert.equal(readdirSync(join(dataDir, 'files')).length, filesBefore.length + 1);
  const downloaded = await author(saved.artifacts[0].url);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
});
