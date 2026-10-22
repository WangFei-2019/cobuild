import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { createIdentity } from '../identity.mjs';

const password = 'onboarding-isolated-fixture-2026';
const pending = { version: 1, status: 'pending' }, dismissed = { version: 1, status: 'dismissed' }, completed = { version: 1, status: 'completed' };
async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-onboarding-'));
  let server, base;
  async function start() {
    server = createApp({ dataDir, publicUrl: '', setupToken: '' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start(); t.after(async () => { await stop(); rmSync(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '';
    return async (path, input, headers = {}) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    };
  }
  const database = fn => { const db = new DatabaseSync(join(dataDir, 'identity.sqlite')); try { return fn(db); } finally { db.close(); } };
  const snapshot = () => database(db => Object.fromEntries(['accounts','people','project_members','sessions','invitations','metadata','login_attempts'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const preferences = () => database(db => db.prepare('SELECT * FROM account_onboarding ORDER BY accountId,version').all());
  const projectBytes = () => [readFileSync(join(dataDir, 'workspace.json'), 'utf8'), ...readdirSync(join(dataDir, 'projects')).sort().map(name => [name, readFileSync(join(dataDir, 'projects', name), 'utf8')])];
  const admin = client(), anonymous = client();
  const firstSession = await anonymous('/api/auth/session');
  const setup = await admin('/api/auth/setup', { name: '指引管理员', email: 'admin@onboarding.test', password });
  assert.equal(setup.status, 200);
  const register = async (name, email) => {
    const request = client(), response = await request('/api/auth/register', { name, email, password });
    assert.equal(response.status, 200); return { request, user: response.data.user, session: response.data };
  };
  return { dataDir, admin, anonymous, firstSession, setup, client, register, database, snapshot, preferences, projectBytes, restart: async () => { await stop(); await start(); } };
}

test('未登录指引为null，设置/独立注册/邀请注册均默认pending，指引不是用户属性或项目授权', async t => {
  const { admin, anonymous, firstSession, setup, register, client, preferences, database } = await fixture(t);
  assert.equal(firstSession.data.onboarding, null);
  assert.deepEqual(setup.data.onboarding, pending);
  assert.equal(Object.hasOwn(setup.data.user, 'onboarding'), false);
  assert.equal((await anonymous('/api/auth/onboarding', { status: 'completed' })).status, 401);
  const registered = await register('普通新用户', 'new@onboarding.test');
  assert.deepEqual(registered.session.onboarding, pending);
  assert.deepEqual((await registered.request('/api/workspace')).data.projects, []);
  const project = (await admin('/api/projects', { name: '邀请入口指引验证' })).data.state;
  const offer = await admin('/api/invitations', { projectId: project.project.id, email: 'invited@onboarding.test' });
  const token = new URL(offer.data.invitation.url).pathname.split('/').at(-1), invited = client();
  const accepted = await invited('/api/auth/register', { name: '受邀新用户', email: 'invited@onboarding.test', password, inviteToken: token });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.projectId, project.project.id);
  assert.deepEqual(accepted.data.onboarding, pending);
  assert.deepEqual(preferences(), [], 'reading pending state must not eagerly write rows');
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n), 3);
  const loggedOut = await registered.request('/api/auth/logout', {});
  assert.equal(loggedOut.data.onboarding, null);
  assert.equal((await registered.request('/api/auth/session')).data.onboarding, null);
});

test('指引按账号隔离、dismissed可完成、重复幂等且completed不被旧tab关闭覆盖，不改任何项目或身份版本', async t => {
  const { admin, register, snapshot, preferences, projectBytes } = await fixture(t);
  const a = await register('账号A', 'a@onboarding.test'), b = await register('账号B', 'b@onboarding.test');
  assert.equal((await a.request('/api/projects', { name: '只有A参与的真实项目' })).status, 201);
  const before = snapshot(), bytes = projectBytes(), workspace = (await a.request('/api/workspace')).data;
  const first = await a.request('/api/auth/onboarding', { status: 'dismissed' });
  assert.deepEqual(first, { status: 200, data: { onboarding: dismissed } });
  assert.deepEqual((await b.request('/api/auth/session')).data.onboarding, pending);
  const stored = preferences();
  assert.deepEqual((await a.request('/api/auth/onboarding', { status: 'dismissed' })).data.onboarding, dismissed);
  assert.deepEqual(preferences(), stored, 'repeated status must not rewrite updatedAt');
  const [finish, close] = await Promise.all([a.request('/api/auth/onboarding', { status: 'completed' }), a.request('/api/auth/onboarding', { status: 'dismissed' })]);
  assert.equal(finish.status, 200); assert.equal(close.status, 200);
  assert.deepEqual((await a.request('/api/auth/session')).data.onboarding, completed);
  const finished = preferences();
  assert.deepEqual((await a.request('/api/auth/onboarding', { status: 'dismissed' })).data.onboarding, completed);
  assert.deepEqual((await a.request('/api/auth/onboarding', { status: 'completed' })).data.onboarding, completed);
  assert.deepEqual(preferences(), finished);
  // This auth endpoint must not run the administrator project-membership sync.
  assert.equal((await admin('/api/auth/onboarding', { status: 'completed' })).status, 200);
  assert.deepEqual(snapshot(), before); assert.deepEqual(projectBytes(), bytes);
  assert.deepEqual((await a.request('/api/workspace')).data, workspace);
  assert.deepEqual((await b.request('/api/workspace')).data.projects, []);
});

test('关闭和完成状态跨退出、不同登录会话及服务重启持久化，不重新弹出待引导状态', async t => {
  const { register, client, preferences, restart } = await fixture(t);
  const dismissedUser = await register('关闭用户', 'dismissed@onboarding.test'), completedUser = await register('完成用户', 'completed@onboarding.test');
  assert.equal((await dismissedUser.request('/api/auth/onboarding', { status: 'dismissed' })).status, 200);
  assert.equal((await completedUser.request('/api/auth/onboarding', { status: 'completed' })).status, 200);
  const rows = preferences();
  await dismissedUser.request('/api/auth/logout', {});
  const newSession = client(), loggedIn = await newSession('/api/auth/login', { email: 'dismissed@onboarding.test', password });
  assert.equal(loggedIn.status, 200); assert.deepEqual(loggedIn.data.onboarding, dismissed);
  await restart();
  assert.deepEqual((await newSession('/api/auth/session')).data.onboarding, dismissed);
  assert.deepEqual((await completedUser.request('/api/auth/session')).data.onboarding, completed);
  assert.deepEqual(preferences(), rows);
});

test('指引设置严格白名单、无会话不可写、跨站和超大输入拒绝，不接受客户端指定其他账号', async t => {
  const { admin, anonymous, register, snapshot, preferences, projectBytes } = await fixture(t);
  const other = await register('其他账号', 'other@onboarding.test'), before = snapshot(), bytes = projectBytes();
  for (const input of [{}, { status: 'pending' }, { status: 'skipped' }, { status: null }, { status: 1 }, { status: {} }, { status: 'completed', accountId: other.user.id }, { status: 'completed', version: 1 }, { status: 'completed', actorId: 'm0' }, null, []]) {
    assert.equal((await admin('/api/auth/onboarding', input)).status, 400);
  }
  assert.equal((await anonymous('/api/auth/onboarding', { status: 'dismissed' })).status, 401);
  assert.equal((await admin('/api/auth/onboarding', { status: 'completed' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await admin('/api/auth/onboarding', { status: 'completed' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await admin('/api/auth/onboarding', { status: 'completed', padding: 'x'.repeat(17000) })).status, 413);
  assert.deepEqual(snapshot(), before); assert.deepEqual(preferences(), []); assert.deepEqual(projectBytes(), bytes);
  assert.deepEqual((await other.request('/api/auth/session')).data.onboarding, pending);
});

test('账号认领旧人员档案后personId变化，原accountId的完成状态仍保留且其他账号不受影响', async t => {
  const { admin, register, preferences } = await fixture(t);
  const account = await register('认领前昵称', 'claimant@onboarding.test');
  await account.request('/api/auth/onboarding', { status: 'completed' });
  const stored = preferences();
  const project = (await admin('/api/projects', { name: '旧档案认领', members: [{ name: '认领后的历史昵称' }] })).data.state;
  const member = project.members.find(item => item.name === '认领后的历史昵称');
  const offer = await admin('/api/invitations', { projectId: project.project.id, memberId: member.id });
  const token = new URL(offer.data.invitation.url).pathname.split('/').at(-1);
  const accepted = await account.request('/api/invitations/accept', { token });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.session.user.id, account.user.id);
  assert.notEqual(accepted.data.session.user.personId, account.user.personId);
  assert.deepEqual(accepted.data.session.onboarding, completed);
  assert.deepEqual((await account.request('/api/auth/session')).data.onboarding, completed);
  assert.deepEqual((await admin('/api/auth/session')).data.onboarding, pending);
  assert.deepEqual(preferences(), stored);
});

test('旧库账号无需修改或回填用户记录即默认pending，偏好独立持久化且不递增identity revision', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-old-onboarding-'));
  let identity = createIdentity(dataDir), db;
  t.after(() => { db?.close(); identity.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const account = await identity.setup({ name: '升级前旧账号', email: 'legacy@onboarding.test', password });
  db = new DatabaseSync(join(dataDir, 'identity.sqlite'));
  const rows = () => Object.fromEntries(['accounts','people','sessions','metadata'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = rows(), revision = identity.revision();
  identity.close(); db.exec('DROP TABLE account_onboarding'); identity = createIdentity(dataDir);
  assert.deepEqual(rows(), before); assert.equal(identity.revision(), revision);
  assert.deepEqual(identity.onboarding(account.user.id), pending);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_onboarding').get().n, 0);
  assert.deepEqual(identity.updateOnboarding(account.user.id, 'completed'), completed);
  assert.deepEqual(rows(), before); assert.equal(identity.revision(), revision);
  identity.close(); identity = createIdentity(dataDir);
  assert.equal(identity.sessionUser(account.token).id, account.user.id);
  assert.deepEqual(identity.onboarding(account.user.id), completed);
  assert.deepEqual(rows(), before);
});
