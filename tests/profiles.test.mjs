import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { applyAction, seedState } from '../domain.mjs';
import { createDemoAPI, DEMO_STORAGE_KEY } from '../src/demo-api.js';

const password = 'profile-fixture-password-2026';
async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-profiles-'));
  let server, base;
  async function start() {
    server = createApp({ dataDir, publicUrl: '', setupToken: '' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start();
  t.after(async () => { await stop(); rmSync(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '';
    return async (path, input) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    };
  }
  const admin = client();
  const setup = await admin('/api/auth/setup', { name: '档案管理员', email: 'admin@profile.test', password });
  assert.equal(setup.status, 200);
  async function register(projectId, email, name, accessRole = 'member') {
    const created = await admin('/api/invitations', { projectId, email, accessRole });
    assert.equal(created.status, 201);
    const request = client(), token = new URL(created.data.invitation.url).pathname.split('/').at(-1);
    const registered = await request('/api/auth/register', { name, email, password, inviteToken: token });
    assert.equal(registered.status, 200);
    return { request, user: registered.data.user };
  }
  return { dataDir, admin, user: setup.data.user, client, register, restart: async () => { await stop(); await start(); } };
}

test('统一档案创建不建账号或授权，同名需明确区分，字段和旧版本校验保持数据不变', async t => {
  const { dataDir, admin, user, restart } = await fixture(t);
  const stateBefore = (await admin('/api/state')).data;
  const bytes = readFileSync(join(dataDir, 'project.json'));
  const created = await admin('/api/people', { name: ' Alice ', bio: '负责交互设计', color: '#123456' });
  assert.equal(created.status, 201);
  const person = created.data.person;
  assert.equal(person.name, 'Alice'); assert.equal(person.bio, '负责交互设计'); assert.equal(person.accountLinked, false);
  assert.equal(person.permissions.editProfile, true);
  assert.equal((await admin('/api/people')).data.people.find(value => value.id === person.id).projectCount, 0);
  const db = new DatabaseSync(join(dataDir, 'identity.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE personId=?').get(person.id).n, 0); db.close();
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), bytes);
  assert.deepEqual((await admin('/api/state')).data, stateBefore);
  const duplicate = await admin('/api/people', { name: 'ＡＬＩＣＥ' });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.data.code, 'DUPLICATE_PERSON_NAME');
  const distinct = await admin('/api/people', { name: 'ALICE', allowDuplicateName: true });
  assert.equal(distinct.status, 201); assert.notEqual(distinct.data.person.id, person.id);
  let directory = (await admin('/api/people')).data;
  const stale = await admin(`/api/people/${person.id}`, { expectedRevision: created.data.revision, patch: { bio: '旧窗口不应覆盖' } });
  assert.equal(stale.status, 409);
  for (const patch of [{ accountLinked: true }, { personId: user.personId }, { name: '' }, { bio: 'x'.repeat(1001) }, { color: 'red' }, {}]) {
    assert.equal((await admin(`/api/people/${person.id}`, { expectedRevision: directory.revision, patch })).status, 400);
  }
  assert.deepEqual((await admin('/api/people')).data, directory);
  const changed = await admin(`/api/people/${person.id}`, { expectedRevision: directory.revision, patch: { bio: '新的负责方向' } });
  assert.equal(changed.status, 200, 'an existing explicit namesake must not prevent an unrelated bio edit');
  directory = (await admin('/api/people')).data;
  assert.equal((await admin(`/api/people/${person.id}`, { expectedRevision: directory.revision, patch: { name: '档案管理员' } })).status, 409);
  const renamedAdmin = await admin(`/api/people/${user.personId}`, { expectedRevision: directory.revision, patch: { name: '管理员新名字' } });
  assert.equal(renamedAdmin.status, 200); assert.equal(renamedAdmin.data.session.user.name, '管理员新名字');
  assert.equal(renamedAdmin.data.session.user.personId, user.personId);
  await restart();
  assert.equal((await admin(`/api/people/${person.id}`)).data.person.bio, '新的负责方向');
  assert.equal((await admin('/api/auth/session')).data.user.name, '管理员新名字');
});

test('档案改名在两个项目和汇总一致显示，历史JSON及任务交付版本保持原样，项目角色单独编辑', async t => {
  const { dataDir, admin } = await fixture(t);
  const original = (await admin('/api/state')).data, target = original.members.find(member => member.id === 'm2');
  const created = await admin('/api/projects', { name: '第二项目', color: '#123abc' });
  const projectId = created.data.state.project.id;
  assert.equal((await admin('/api/project-members', { projectId, personId: target.personId, role: '设计负责人' })).status, 200);
  const beforeA = (await admin('/api/state')).data, beforeB = (await admin(`/api/state?projectId=${projectId}`)).data;
  const diskBefore = readFileSync(join(dataDir, 'project.json'));
  const directory = (await admin('/api/people')).data;
  const renamed = await admin(`/api/people/${target.personId}`, { expectedRevision: directory.revision, patch: { name: '统一新姓名', color: '#abc', bio: '统一负责方向' } });
  assert.equal(renamed.status, 200);
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), diskBefore);
  for (const before of [beforeA, beforeB]) {
    const after = (await admin(`/api/state?projectId=${before.project.id}`)).data;
    const member = after.members.find(value => value.personId === target.personId);
    assert.equal(member.name, '统一新姓名'); assert.equal(member.color, '#abc');
    assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.activities, before.activities); assert.equal(after.revision, before.revision);
  }
  assert.equal((await admin('/api/workspace')).data.projects.find(project => project.id === projectId).members.find(member => member.personId === target.personId).name, '统一新姓名');
  const member = beforeB.members.find(value => value.personId === target.personId);
  const role = await admin('/api/action', { type: 'updateMember', projectId, memberId: member.id, role: '接口协调', expectedRevision: beforeB.revision });
  assert.equal(role.status, 200); assert.equal(role.data.state.members.find(value => value.id === member.id).role, '接口协调');
  assert.deepEqual(role.data.state.tasks, beforeB.tasks);
  assert.equal((await admin('/api/action', { type: 'updateMember', projectId, memberId: member.id, role: '旧修改', expectedRevision: beforeB.revision })).status, 409);
  const latest = role.data.state;
  assert.equal((await admin('/api/action', { type: 'updateMember', projectId, memberId: member.id, role: '试图升级', accessRole: 'admin', expectedRevision: latest.revision })).status, 400);
  const profile = (await admin(`/api/people/${target.personId}`)).data;
  assert.equal(profile.projects.length, 2);
  assert.equal(profile.projects.find(value => value.project.id === projectId).role, '接口协调');
  assert.equal(profile.projects.find(value => value.project.id === 'p1').role, target.role);
});

test('项目管理者只能选择公开账号的最小档案，精确人员邀请确认前不授权且不能被同名账号接受', async t => {
  const { admin, register } = await fixture(t);
  const owner = await register('p1', 'owner@profile.test', '项目管理者');
  const owned = await owner.request('/api/projects', { name: '个人项目' }), projectId = owned.data.state.project.id;
  const secret = await admin('/api/projects', { name: '不得泄露的私有项目' });
  const target = await register(secret.data.state.project.id, 'target@profile.test', '同名用户');
  const wrong = await register('p1', 'wrong@profile.test', '同名用户');
  const privatePerson = (await admin('/api/people', { name: '未加入的私有档案' })).data.person;
  const regular = (await owner.request('/api/people')).data;
  assert.equal(regular.permissions.managePeople, false);
  assert.ok(!regular.people.some(person => person.id === target.user.personId));
  assert.equal((await owner.request(`/api/people/${target.user.personId}`)).status, 404);
  assert.equal((await owner.request('/api/people', { name: '越权创建' })).status, 403);
  assert.equal((await owner.request(`/api/people/${owner.user.personId}`, { expectedRevision: regular.revision, patch: { name: '越权改名' } })).status, 403);
  assert.equal((await wrong.request(`/api/people?selectableForProject=${projectId}`)).status, 403);
  const selected = await owner.request(`/api/people?selectableForProject=${projectId}`);
  assert.equal(selected.status, 200);
  assert.ok(selected.data.people.some(person => person.id === target.user.personId && person.accountLinked));
  assert.ok(!selected.data.people.some(person => person.id === privatePerson.id));
  assert.ok(!JSON.stringify(selected.data).includes('不得泄露的私有项目'));
  for (const person of selected.data.people) { assert.equal('projects' in person, false); assert.equal('projectCount' in person, false); assert.equal('email' in person, false); }
  const invitation = await owner.request('/api/invitations', { projectId, personId: target.user.personId, accessRole: 'member' });
  assert.equal(invitation.status, 201);
  assert.equal((await target.request(`/api/state?projectId=${projectId}`)).status, 403);
  const token = new URL(invitation.data.invitation.url).pathname.split('/').at(-1);
  assert.equal((await wrong.request('/api/invitations/accept', { token })).status, 409);
  assert.equal((await wrong.request(`/api/state?projectId=${projectId}`)).status, 403);
  const accepted = await target.request('/api/invitations/accept', { token });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.session.user.personId, target.user.personId);
  assert.equal(accepted.data.state.members.filter(member => member.personId === target.user.personId).length, 1);
  assert.equal((await owner.request('/api/invitations', { projectId, personId: target.user.personId })).status, 409);
  const plain = await owner.request('/api/action', { projectId, type: 'addMember', name: '本项目新档案', role: '协助排期' });
  assert.equal(plain.status, 200, 'project admins retain the atomic unbound profile creation path');
  const person = plain.data.state.members.at(-1);
  assert.equal(person.accountLinked, false);
  assert.equal((await target.request('/api/action', { projectId, type: 'updateMember', memberId: person.id, role: '越权', expectedRevision: plain.data.state.revision })).status, 403);
});

test('项目颜色创建更新、持久化和跨项目个人汇总一致，非法颜色不修改历史', async t => {
  const { admin, user, restart } = await fixture(t);
  const created = await admin('/api/projects', { name: '自定义色项目', color: '#123abc' });
  assert.equal(created.status, 201); const projectId = created.data.state.project.id;
  const changed = await admin('/api/action', { projectId, type: 'updateProject', expectedRevision: created.data.state.revision, patch: { color: '#aabbcc' } });
  assert.equal(changed.status, 200); assert.equal(changed.data.state.project.color, '#aabbcc');
  for (const color of ['blue', '#12', 'rgb(1,2,3)', null]) {
    assert.equal((await admin('/api/action', { projectId, type: 'updateProject', expectedRevision: changed.data.state.revision, patch: { color } })).status, 400);
  }
  assert.deepEqual((await admin(`/api/state?projectId=${projectId}`)).data, changed.data.state);
  await restart();
  assert.equal((await admin('/api/workspace')).data.projects.find(project => project.id === projectId).color, '#aabbcc');
  assert.equal((await admin(`/api/people/${user.personId}`)).data.projects.find(row => row.project.id === projectId).project.color, '#aabbcc');
  const old = seedState();
  assert.throws(() => applyAction(old, { type: 'updateMember', actorId: 'm2', memberId: 'm1', role: '不合法管理' }), error => error.status === 403);
});

test('Pages档案CRUD与项目负责方向独立持久化，保留原任务与原始成员快照，不提供真实邀请', async () => {
  const values = new Map([['real-app', 'unchanged']]), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const demo = createDemoAPI({ storage }), original = await demo.request('/api/state');
  const current = (await demo.request('/api/auth/session')).user;
  const created = await demo.request('/api/people', { name: '本地新档案', color: '#bad', bio: '视觉设计' });
  assert.equal(created.person.accountLinked, false);
  assert.equal((await demo.request('/api/people')).people.find(person => person.id === created.person.id).projectCount, 0);
  const before = values.get(DEMO_STORAGE_KEY);
  await assert.rejects(demo.request('/api/people', { name: '本地新档案' }), error => error.status === 409 && error.code === 'DUPLICATE_PERSON_NAME');
  await assert.rejects(demo.request(`/api/people/${created.person.id}`, { expectedRevision: created.revision - 1, patch: { name: '冲突改名' } }), error => error.status === 409);
  assert.equal(values.get(DEMO_STORAGE_KEY), before);
  const directory = await demo.request('/api/people');
  await demo.request(`/api/people/${current.personId}`, { expectedRevision: directory.revision, patch: { name: '统一演示新名', color: '#123abc', bio: '本地体验者简介' } });
  const raw = JSON.parse(values.get(DEMO_STORAGE_KEY));
  assert.equal(raw.projects[0].members.find(member => member.id === original.currentMemberId).name, '演示体验者');
  const reopened = createDemoAPI({ storage }), state = await reopened.request('/api/state');
  assert.equal(state.members.find(member => member.id === state.currentMemberId).name, '统一演示新名');
  assert.deepEqual(state.tasks, original.tasks); assert.deepEqual(state.activities, original.activities); assert.equal(state.revision, original.revision);
  assert.equal((await reopened.request(`/api/people/${current.personId}`)).projects.length, 2);
  const joined = await reopened.request('/api/project-members', { personId: created.person.id, role: '本项目设计' });
  const member = joined.state.members.find(member => member.personId === created.person.id);
  const updated = await reopened.request('/api/action', { type: 'updateMember', memberId: member.id, role: '本项目协调', expectedRevision: joined.state.revision });
  assert.equal(updated.state.members.find(value => value.id === member.id).role, '本项目协调');
  const changed = await reopened.request('/api/action', { type: 'updateProject', expectedRevision: updated.state.revision, patch: { color: '#aabbcc' } });
  assert.equal(changed.state.project.color, '#aabbcc');
  assert.equal((await createDemoAPI({ storage }).request('/api/workspace')).projects.find(project => project.id === state.project.id).color, '#aabbcc');
  await assert.rejects(reopened.request('/api/invitations', { personId: created.person.id }), error => error.status === 501 && error.code === 'DEMO_UNAVAILABLE');
  assert.equal(values.get('real-app'), 'unchanged');
});
