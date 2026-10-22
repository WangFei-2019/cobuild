import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { createIdentity } from '../identity.mjs';

const password = 'nickname-regression-fixture-2026';
async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-nicknames-'));
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
    return async (path, input) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    };
  }
  const admin = client();
  assert.equal((await admin('/api/auth/setup', { name: '唯一管理员', email: 'admin@nicknames.test', password })).status, 200);
  const database = fn => { const db = new DatabaseSync(join(dataDir, 'identity.sqlite')); try { return fn(db); } finally { db.close(); } };
  const snapshot = () => database(db => Object.fromEntries(['people','accounts','sessions','project_members','invitations','metadata'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const projectBytes = () => [readFileSync(join(dataDir, 'workspace.json'), 'utf8'), ...readdirSync(join(dataDir, 'projects')).sort().map(name => [name, readFileSync(join(dataDir, 'projects', name), 'utf8')])];
  const register = async (name, email) => { const request = client(), result = await request('/api/auth/register', { name, email, password }); assert.equal(result.status, 200, result.data.error); return { request, user: result.data.user }; };
  const invite = async (projectId, memberId) => { const result = await admin('/api/invitations', { projectId, ...(memberId ? { memberId } : {}) }); assert.equal(result.status, 201); return new URL(result.data.invitation.url).pathname.split('/').at(-1); };
  return { admin, client, register, invite, database, snapshot, projectBytes, restart: async () => { await stop(); await start(); } };
}
function conflict(result, field, code, message) {
  assert.equal(result.status, 409);
  assert.deepEqual(result.data, { error: message, code, field });
}

test('注册邮箱原有trim/lowercase唯一约束保留，昵称NFKC大小写归一化，字段反馈明确且重启仍占用', async t => {
  const { client, register, snapshot, restart } = await fixture(t);
  const original = await register(' Alice ', ' Alice@Nicknames.test ');
  assert.equal(original.user.name, 'Alice'); assert.equal(original.user.email, 'alice@nicknames.test');
  const visitor = client(), before = snapshot();
  conflict(await visitor('/api/auth/register', { name: '不同昵称', email: ' ALICE@NICKNAMES.TEST ', password }), 'email', 'EMAIL_TAKEN', '该邮箱已注册');
  conflict(await visitor('/api/auth/register', { name: '\u00a0ＡＬＩＣＥ\u00a0', email: 'different@nicknames.test', password }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  assert.equal((await visitor('/api/auth/register', { name: 'x'.repeat(41), email: 'long@nicknames.test', password })).status, 400);
  assert.deepEqual(snapshot(), before);
  await restart();
  assert.equal((await original.request('/api/auth/session')).data.user.personId, original.user.personId);
  conflict(await visitor('/api/auth/register', { name: 'aLiCe', email: 'after-restart@nicknames.test', password }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  assert.deepEqual(snapshot(), before);
});

test('不同邮箱并发占用同一归一化昵称仅成功一次，不留孤儿档案或会话；邀请注册同样拒绝已占用昵称', async t => {
  const { client, admin, invite, snapshot } = await fixture(t), first = client(), second = client();
  const before = snapshot();
  const results = await Promise.all([first('/api/auth/register', { name: ' Concurrent ', email: 'one@nicknames.test', password }), second('/api/auth/register', { name: 'ＣＯＮＣＵＲＲＥＮＴ', email: 'two@nicknames.test', password })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  conflict(results.find(result => result.status === 409), 'name', 'NAME_TAKEN', '该昵称已被占用');
  const after = snapshot();
  for (const key of ['accounts','people','sessions']) assert.equal(after[key].length, before[key].length + 1);
  assert.equal(after.project_members.length, 0);
  const project = (await admin('/api/projects', { name: '邀请昵称核验' })).data.state;
  const token = await invite(project.project.id), newcomer = client(), beforeInviteRegistration = snapshot();
  conflict(await newcomer('/api/auth/register', { name: 'concurrent', email: 'invited@nicknames.test', password, inviteToken: token }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  assert.deepEqual(snapshot(), beforeInviteRegistration);
  assert.equal((await newcomer('/api/auth/register', { name: '邀请者新昵称', email: 'invited@nicknames.test', password, inviteToken: token })).status, 200);
});

test('账号档案改名及历史认领不能绕过昵称占用；邀请只校验最终有效昵称，成功认领后占用随实际账号变化', async t => {
  const { admin, client, register, invite, snapshot, projectBytes } = await fixture(t);
  const alice = await register('Alice', 'alice@nicknames.test'), bob = await register('Bob', 'bob@nicknames.test');
  const directory = (await admin('/api/people')).data, beforeEdit = snapshot();
  conflict(await admin(`/api/people/${bob.user.personId}`, { expectedRevision: directory.revision, patch: { name: 'ＡＬＩＣＥ' }, allowDuplicateName: true }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  assert.deepEqual(snapshot(), beforeEdit);
  const project = (await admin('/api/projects', { name: '历史人员认领', members: [{ name: 'aLiCe' }, { name: '可认领的唯一昵称' }] })).data.state;
  const target = project.members.find(member => member.name === 'aLiCe'), free = project.members.find(member => member.name === '可认领的唯一昵称');
  const token = await invite(project.project.id, target.id), beforeClaim = snapshot(), bytes = projectBytes();
  conflict(await client()('/api/auth/register', { name: '表单名不能掩盖实际重名', email: 'claim-new@nicknames.test', password, inviteToken: token }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  conflict(await bob.request('/api/invitations/accept', { token }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  assert.deepEqual(snapshot(), beforeClaim); assert.deepEqual(projectBytes(), bytes);
  assert.equal((await bob.request('/api/auth/session')).data.user.personId, bob.user.personId);
  const latest = (await admin(`/api/people/${target.personId}`)).data;
  assert.equal((await admin(`/api/people/${target.personId}`, { expectedRevision: latest.revision, patch: { name: '认领后的独立昵称' } })).status, 200);
  const accepted = await bob.request('/api/invitations/accept', { token });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.session.user.name, '认领后的独立昵称');
  assert.equal(accepted.data.session.user.personId, target.personId);
  const reused = await register('Bob', 'bob-reused@nicknames.test');
  assert.notEqual(reused.user.personId, bob.user.personId);
  conflict(await client()('/api/auth/register', { name: '认领后的独立昵称', email: 'claimed-taken@nicknames.test', password }), 'name', 'NAME_TAKEN', '该昵称已被占用');
  const freeToken = await invite(project.project.id, free.id);
  // Existing clients may send a name that is ignored when claiming a profile.
  // Only the profile's actual effective nickname may decide this result.
  const effective = await client()('/api/auth/register', { name: alice.user.name, email: 'effective-only@nicknames.test', password, inviteToken: freeToken });
  assert.equal(effective.status, 200); assert.equal(effective.data.user.name, free.name);
});

test('旧库同名账号无迁移不删不改，简介编辑与同canonical认领保留，新占用仍拒绝直到原账号都改名', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-legacy-nickname-'));
  let identity = createIdentity(dataDir), db;
  t.after(() => { db?.close(); identity.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const admin = await identity.setup({ name: '管理员', email: 'admin@legacy.test', password });
  const alpha = await identity.register({ name: 'Alpha', email: 'alpha@legacy.test', password });
  const beta = await identity.register({ name: 'Beta', email: 'beta@legacy.test', password });
  db = new DatabaseSync(join(dataDir, 'identity.sqlite'));
  db.prepare('UPDATE people SET name=? WHERE id=?').run('ＡＬＰＨＡ', beta.user.personId);
  const beforeNames = db.prepare('SELECT id,name FROM people ORDER BY id').all(), revision = identity.revision();
  identity.close(); identity = createIdentity(dataDir);
  assert.deepEqual(db.prepare('SELECT id,name FROM people ORDER BY id').all(), beforeNames);
  assert.equal(identity.revision(), revision);
  assert.equal(identity.sessionUser(alpha.token).personId, alpha.user.personId);
  assert.equal(identity.sessionUser(beta.token).personId, beta.user.personId);
  const unchanged = identity.updatePerson(beta.user.personId, { bio: '保留历史同名，仅改简介' });
  assert.equal(unchanged.name, 'ＡＬＰＨＡ');
  await assert.rejects(identity.register({ name: 'alpha', email: 'new@legacy.test', password }), error => error.status === 409 && error.code === 'NAME_TAKEN');
  identity.syncProject({ project: { id: 'legacy-project' }, members: [{ id: 'm1', name: ' alpha ', color: '#123abc', initial: 'a' }] });
  const invitation = identity.invite({ projectId: 'legacy-project', memberId: 'm1' }, admin.user);
  const accepted = identity.accept(invitation.token, beta.user, () => { throw new Error('Existing profile membership must be retained'); });
  assert.equal(accepted.user.name, ' alpha '); assert.notEqual(accepted.user.personId, beta.user.personId);
  identity.updatePerson(alpha.user.personId, { name: '原Alpha的新昵称' });
  await assert.rejects(identity.register({ name: 'ＡＬＰＨＡ', email: 'still-taken@legacy.test', password }), error => error.code === 'NAME_TAKEN');
  identity.updatePerson(accepted.user.personId, { name: '旧重名成员的新昵称' });
  assert.equal((await identity.register({ name: 'Alpha', email: 'finally-free@legacy.test', password })).user.name, 'Alpha');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 4);
});
