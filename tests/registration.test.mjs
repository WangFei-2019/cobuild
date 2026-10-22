import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { createIdentity } from '../identity.mjs';

const password = 'independent-registration-fixture-2026';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { setup = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-registration-'));
  let server, base;
  async function start() {
    server = createApp({ dataDir, publicUrl: '', setupToken: 'fixture-admin-bootstrap' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start();
  t.after(async () => { await stop(); rmSync(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '';
    return async (path, input, headers = {}) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, data, headers: response.headers };
    };
  }
  const admin = client();
  const initialize = () => admin('/api/auth/setup', { name: '既有工作区管理员', email: 'admin@registration.test', password, setupToken: 'fixture-admin-bootstrap' });
  if (setup) assert.equal((await initialize()).status, 200);
  async function register(email, name = `用户-${email.split('@')[0]}`) {
    const request = client(), response = await request('/api/auth/register', { name, email, password });
    assert.equal(response.status, 200, response.data.error);
    return { request, user: response.data.user, response };
  }
  function database(fn) { const db = new DatabaseSync(join(dataDir, 'identity.sqlite')); try { return fn(db); } finally { db.close(); } }
  const snapshot = () => database(db => Object.fromEntries(['people','accounts','project_members','sessions','invitations'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const files = () => [readFileSync(join(dataDir, 'workspace.json'), 'utf8'), ...readdirSync(join(dataDir, 'projects')).sort().map(name => [name, readFileSync(join(dataDir, 'projects', name), 'utf8')])];
  return { dataDir, admin, client, initialize, register, database, snapshot, files, restart: async () => { await stop(); await start(); } };
}

test('首次管理员初始化之前关闭自助注册，完成后开放普通注册，初始化口令和既有管理员不能被重设', async t => {
  const { admin, client, initialize, snapshot } = await fixture(t, { setup: false });
  const visitor = client(), initial = (await visitor('/api/auth/session')).data;
  assert.equal(initial.setupRequired, true); assert.equal(initial.registrationEnabled, false);
  const before = snapshot();
  const blocked = await visitor('/api/auth/register', { name: '不能抢占首账号', email: 'first@registration.test', password });
  assert.equal(blocked.status, 409); assert.match(blocked.data.error, /部署者.*初始化/);
  assert.deepEqual(snapshot(), before);
  assert.equal((await admin('/api/auth/setup', { name: '不能绕过口令', email: 'bad@registration.test', password })).status, 403);
  const setup = await initialize(); assert.equal(setup.status, 200);
  assert.equal(setup.data.registrationEnabled, true); assert.equal(setup.data.user.workspaceRole, 'admin');
  assert.equal((await visitor('/register')).status, 200);
  const registered = await visitor('/api/auth/register', { name: '普通自助账号', email: 'first@registration.test', password });
  assert.equal(registered.status, 200); assert.equal(registered.data.user.workspaceRole, 'member');
  assert.equal(registered.data.setupRequired, false); assert.equal(registered.data.registrationEnabled, true);
  assert.equal('projectId' in registered.data, false);
  assert.equal((await visitor('/api/workspace')).data.projects.length, 0);
  assert.equal((await initialize()).status, 409);
  const accounts = snapshot().accounts;
  assert.equal(accounts.filter(account => account.workspaceRole === 'admin').length, 1);
  assert.equal(accounts.find(account => account.workspaceRole === 'admin').personId, setup.data.user.personId);
});

test('A/B独立注册各建私有项目，账号和项目权限隔离，接受精确邀请前无法加入，重启持久有效', async t => {
  const { admin, register, snapshot, files, restart } = await fixture(t);
  const a = await register('a@registration.test', 'A用户'), b = await register('b@registration.test', 'B用户');
  assert.notEqual(a.user.personId, b.user.personId);
  assert.equal(a.user.workspaceRole, 'member'); assert.equal(b.user.workspaceRole, 'member');
  assert.deepEqual((await a.request('/api/people')).data.people.map(person => person.id), [a.user.personId]);
  assert.deepEqual((await b.request('/api/people')).data.people.map(person => person.id), [b.user.personId]);
  const directory = (await admin('/api/people')).data;
  assert.equal((await admin(`/api/people/${b.user.personId}`, { expectedRevision: directory.revision, patch: { bio: '不得向无共同项目的人公开的简介' } })).status, 200);
  const pa = (await a.request('/api/projects', { name: 'A私有项目' })).data.state;
  const pb = (await b.request('/api/projects', { name: 'B私有项目' })).data.state;
  for (const state of [pa, pb]) { assert.equal(state.currentMemberId, 'm0'); assert.equal(state.permissions.manageProject, true); assert.equal(state.members.length, 1); }
  assert.deepEqual((await a.request('/api/workspace')).data.projects.map(project => project.id), [pa.project.id]);
  assert.deepEqual((await b.request('/api/workspace')).data.projects.map(project => project.id), [pb.project.id]);
  for (const route of ['/api/state','/api/export','/api/report','/api/invitations']) assert.equal((await a.request(`${route}?projectId=${pb.project.id}`)).status, 403, route);
  assert.equal((await a.request(`/api/people/${b.user.personId}`)).status, 404);
  for (const route of ['/api/ai/plan','/api/plans/apply','/api/milestones/action','/api/action']) assert.equal((await a.request(route, { projectId: pb.project.id, type: 'createTask' })).status, 403, route);
  const privateTask = (await b.request('/api/action', { projectId: pb.project.id, type: 'createTask', title: 'B私有成果', ownerId: 'm0', reviewerId: 'm0', deliverable: '私有文件' })).data.state.tasks[0];
  const upload = await b.request('/api/action', { projectId: pb.project.id, type: 'submitArtifact', taskId: privateTask.id, name: '私有附件', file: { name: 'private.txt', base64: Buffer.from('B private').toString('base64') } });
  assert.equal(upload.status, 200);
  assert.equal((await a.request(upload.data.state.tasks[0].artifacts[0].url)).status, 404);
  const selected = (await a.request(`/api/people?selectableForProject=${pa.project.id}`)).data.people.find(person => person.id === b.user.personId);
  assert.ok(selected); assert.equal('bio' in selected, false); assert.equal('email' in selected, false); assert.equal('projects' in selected, false);
  const before = snapshot(), disk = files();
  assert.equal((await a.request('/api/project-members', { projectId: pa.project.id, personId: b.user.personId, accessRole: 'admin' })).status, 403);
  assert.notEqual((await a.request('/api/projects', { name: '初始成员不能代授权', members: [{ personId: b.user.personId }] })).status, 201);
  assert.equal((await a.request('/api/projects', { name: '不能冒充发起人', ownerPersonId: b.user.personId })).status, 403);
  assert.equal((await a.request('/api/action', { projectId: pa.project.id, type: 'addMember', name: '不能冒充身份', actorId: 'm0' })).status, 403);
  assert.deepEqual(snapshot(), before); assert.deepEqual(files(), disk);
  const invitation = await a.request('/api/invitations', { projectId: pa.project.id, personId: b.user.personId, accessRole: 'viewer' });
  assert.equal(invitation.status, 201);
  const token = new URL(invitation.data.invitation.url).pathname.split('/').at(-1);
  assert.equal((await b.request(`/api/state?projectId=${pa.project.id}`)).status, 403);
  assert.equal((await a.request('/api/invitations/accept', { token })).status, 409);
  const accepted = await b.request('/api/invitations/accept', { token });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.session.user.personId, b.user.personId);
  assert.deepEqual(accepted.data.state.permissions, { manageProject: false, createTask: false, readOnly: true });
  assert.equal((await b.request('/api/action', { projectId: pa.project.id, type: 'addMember', name: '只读不可新增' })).status, 403);
  assert.equal((await b.request(`/api/state?projectId=${pb.project.id}`)).data.permissions.manageProject, true);
  assert.equal((await a.request(`/api/state?projectId=${pb.project.id}`)).status, 403);
  assert.equal((await b.request('/api/invitations/accept', { token })).status, 410);
  assert.ok((await a.request('/api/people')).data.people.find(person => person.id === b.user.personId).bio);
  await restart();
  assert.equal((await a.request('/api/auth/session')).data.user.workspaceRole, 'member');
  assert.equal((await b.request(`/api/state?projectId=${pa.project.id}`)).data.permissions.readOnly, true);
  assert.equal((await a.request(`/api/state?projectId=${pb.project.id}`)).status, 403);
});

test('注册严格拒绝越权字段/超大输入/无效邀请，邮箱大小写并发重复仅一份新档案且不认领同名旧人', async t => {
  const { admin, client, snapshot } = await fixture(t), visitor = client();
  const created = await admin('/api/people', { name: '重复名候选' });
  assert.equal(created.status, 201); const before = snapshot();
  for (const extra of [{ workspaceRole: 'admin' }, { personId: created.data.person.id }, { accessRole: 'admin' }, { actorId: 'm0' }]) {
    assert.equal((await visitor('/api/auth/register', { name: '重复名候选', email: 'new@registration.test', password, ...extra })).status, 400);
  }
  for (const inviteToken of ['', null, ' ', 'x'.repeat(43)]) assert.equal((await visitor('/api/auth/register', { name: '重复名候选', email: 'new@registration.test', password, inviteToken })).status, 404);
  assert.equal((await visitor('/api/auth/register', { name: 'x', email: 'new@registration.test', password: 'short' })).status, 400);
  assert.equal((await visitor('/api/auth/register', { name: 'x', email: 'new@registration.test', password, padding: 'x'.repeat(17000) })).status, 413);
  assert.deepEqual(snapshot(), before);
  const first = client(), second = client();
  const results = await Promise.all([first('/api/auth/register', { name: '重复名候选', email: 'CASE@registration.test', password }), second('/api/auth/register', { name: '重复名候选', email: 'case@registration.test', password })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const success = results.find(result => result.status === 200);
  assert.notEqual(success.data.user.personId, created.data.person.id);
  const after = snapshot(); assert.equal(after.accounts.length, before.accounts.length + 1); assert.equal(after.people.length, before.people.length + 1); assert.equal(after.sessions.length, before.sessions.length + 1);
  assert.equal(after.project_members.length, 0);
  assert.equal(after.accounts.filter(account => account.email === 'case@registration.test').length, 1);
  assert.equal((await admin(`/api/people/${created.data.person.id}`)).data.person.accountLinked, false);
});

test('跨项目未绑定档案认领在发出邀请和接受/注册时重查权限，拒绝不改账号或旧项目，工作区管理员例外保留', async t => {
  const { admin, register, client, snapshot, files, database } = await fixture(t);
  const owner = await register('owner@registration.test'), other = await register('other@registration.test'), claimant = await register('claimant@registration.test');
  const a = (await owner.request('/api/projects', { name: 'A旧分工', members: [{ name: '待认领旧成员' }, { name: '权限变化测试成员' }] })).data.state;
  const b = (await other.request('/api/projects', { name: 'B私有旧分工' })).data.state;
  const target = a.members.find(member => member.name === '待认领旧成员'), changed = a.members.find(member => member.name === '权限变化测试成员');
  const issued = await owner.request('/api/invitations', { projectId: a.project.id, memberId: target.id });
  assert.equal(issued.status, 201); const token = new URL(issued.data.invitation.url).pathname.split('/').at(-1);
  assert.equal((await admin('/api/project-members', { projectId: b.project.id, personId: target.personId, role: '既有跨项目分工' })).status, 200);
  const before = snapshot(), disk = files();
  assert.equal((await owner.request('/api/invitations', { projectId: a.project.id, memberId: target.id })).status, 403);
  assert.equal((await claimant.request('/api/invitations/accept', { token })).status, 403);
  assert.equal((await client()('/api/auth/register', { name: '不能继承B', email: 'claim-new@registration.test', password, inviteToken: token })).status, 403);
  assert.deepEqual(snapshot(), before); assert.deepEqual(files(), disk);
  assert.equal((await claimant.request('/api/auth/session')).data.user.personId, claimant.user.personId);
  const permissionInvite = await owner.request('/api/invitations', { projectId: a.project.id, memberId: changed.id });
  assert.equal(permissionInvite.status, 201); const permissionToken = new URL(permissionInvite.data.invitation.url).pathname.split('/').at(-1);
  database(db => db.prepare('UPDATE project_members SET accessRole=? WHERE projectId=? AND personId=?').run('member', a.project.id, owner.user.personId));
  const afterRoleChange = snapshot();
  assert.equal((await claimant.request('/api/invitations/accept', { token: permissionToken })).status, 403);
  assert.equal((await client()('/api/auth/register', { name: '不能使用过时授权', email: 'lost-permission@registration.test', password, inviteToken: permissionToken })).status, 403);
  assert.deepEqual(snapshot(), afterRoleChange);
  const trusted = await admin('/api/invitations', { projectId: a.project.id, memberId: target.id });
  assert.equal(trusted.status, 201);
  const trustedToken = new URL(trusted.data.invitation.url).pathname.split('/').at(-1), account = client();
  const accepted = await account('/api/auth/register', { name: '经管理员核对', email: 'trusted@registration.test', password, inviteToken: trustedToken });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.user.personId, target.personId);
  assert.deepEqual(new Set((await account('/api/workspace')).data.projects.map(project => project.id)), new Set([a.project.id, b.project.id]));
  const final = snapshot();
  assert.equal((await client()('/api/auth/register', { name: '已用不能降级', email: 'used@registration.test', password, inviteToken: trustedToken })).status, 410);
  assert.deepEqual(snapshot(), final);
});

test('注册短窗口计数持久化且不信任XFF，账号失败不留下人员或会话；共享代理成功登录不消耗失败额度', async t => {
  const { admin, client, database, snapshot, restart } = await fixture(t), visitor = client();
  const before = snapshot();
  for (let index = 0; index < 5; index++) assert.equal((await visitor('/api/auth/register', { name: '不能重复注册', email: 'ADMIN@registration.test', password })).status, 409);
  const limited = await visitor('/api/auth/register', { name: '仍受限', email: 'admin@registration.test', password });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.deepEqual(snapshot(), before);
  await restart();
  assert.equal((await visitor('/api/auth/register', { name: '重启不能绕过', email: 'admin@registration.test', password }, { 'X-Forwarded-For': '192.0.2.1' })).status, 429);
  database(db => db.prepare('UPDATE login_attempts SET count=30 WHERE key=?').run(hash('signup:ip:127.0.0.1')));
  assert.equal((await visitor('/api/auth/register', { name: '换XFF也无效', email: 'different@registration.test', password }, { 'X-Forwarded-For': '198.51.100.2' })).status, 429);
  assert.deepEqual(snapshot(), before);
  for (let index = 0; index < 35; index++) assert.equal((await admin('/api/auth/login', { email: 'admin@registration.test', password })).status, 200, `successful login ${index}`);
  assert.equal(database(db => db.prepare('SELECT count FROM login_attempts WHERE key=?').get(hash('ip:127.0.0.1')).count), 0);
});

test('注册全局四并发限制和失败后释放，登录只释放本次预占、不清并发历史失败或新时间窗', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-auth-concurrency-')), identity = createIdentity(dataDir);
  let db;
  t.after(() => { db?.close(); identity.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await identity.setup({ name: '管理员', email: 'admin@concurrency.test', password });
  const attempts = Array.from({ length: 5 }, (_, index) => identity.register({ name: `用户${index}`, email: `user${index}@concurrency.test`, password }, undefined, 'shared-proxy'));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 429);
  const failures = await Promise.allSettled(Array.from({ length: 4 }, () => identity.register({ name: '重复账号', email: 'admin@concurrency.test', password }, undefined, 'shared-proxy')));
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.status === 409));
  assert.equal((await identity.register({ name: '失败后仍能注册', email: 'after-failures@concurrency.test', password }, undefined, 'shared-proxy')).user.workspaceRole, 'member');
  const mixed = await Promise.allSettled([identity.login({ email: 'admin@concurrency.test', password }, 'login-proxy'), ...Array.from({ length: 2 }, () => identity.login({ email: 'admin@concurrency.test', password: 'wrong' }, 'login-proxy'))]);
  assert.equal(mixed.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(mixed.filter(result => result.status === 'rejected' && result.reason.status === 401).length, 2);
  db = new DatabaseSync(join(dataDir, 'identity.sqlite'));
  for (const key of [hash('ip:login-proxy'), hash('account:login-proxy:admin@concurrency.test')]) assert.equal(db.prepare('SELECT count FROM login_attempts WHERE key=?').get(key).count, 2);
  await identity.login({ email: 'admin@concurrency.test', password }, 'login-proxy');
  assert.equal(db.prepare('SELECT count FROM login_attempts WHERE key=?').get(hash('ip:login-proxy')).count, 2);
  await Promise.allSettled(Array.from({ length: 3 }, () => identity.login({ email: 'admin@concurrency.test', password: 'wrong' }, 'login-proxy')));
  await assert.rejects(identity.login({ email: 'admin@concurrency.test', password }, 'login-proxy'), error => error.status === 429);
  const originalNow = Date.now(), clock = t.mock.method(Date, 'now', () => originalNow);
  const previousWindow = identity.login({ email: 'admin@concurrency.test', password }, 'new-window-proxy');
  clock.mock.mockImplementation(() => originalNow + 15 * 60000 + 1);
  const newWindowFailure = assert.rejects(identity.login({ email: 'admin@concurrency.test', password: 'wrong' }, 'new-window-proxy'), error => error.status === 401);
  await Promise.all([previousWindow, newWindowFailure]);
  assert.equal(db.prepare('SELECT count FROM login_attempts WHERE key=?').get(hash('ip:new-window-proxy')).count, 1);
});
