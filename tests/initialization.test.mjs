import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspace } from '../workspace.mjs';
import { createApp } from '../server.mjs';
import { seedState } from '../domain.mjs';

function temporaryDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cobuild-initialization-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('正式工作区默认零项目，无project.json；重启及随后显式示例选项均不向已保存空工作区注入数据', t => {
  const dataDir = temporaryDirectory(t), workspace = createWorkspace(dataDir);
  assert.deepEqual(workspace.view(), { revision: 1, defaultProjectId: null, projects: [] });
  assert.deepEqual(workspace.allStates(), []);
  assert.equal(existsSync(join(dataDir, 'project.json')), false);
  assert.deepEqual(readdirSync(join(dataDir, 'projects')), []);
  assert.throws(() => workspace.state(), error => error.status === 404 && /先创建项目/.test(error.message));
  assert.throws(() => workspace.state('p1'), error => error.status === 404);
  const bytes = readFileSync(join(dataDir, 'workspace.json'));
  assert.deepEqual(createWorkspace(dataDir).view(), workspace.view());
  assert.deepEqual(createWorkspace(dataDir, { seedDemo: true }).view(), workspace.view());
  assert.deepEqual(readFileSync(join(dataDir, 'workspace.json')), bytes);
  assert.equal(existsSync(join(dataDir, 'project.json')), false);
});

test('示例初始化仅供显式新夹具使用，首个真实项目存独立文件并成为默认项目', t => {
  const fixtureDir = temporaryDirectory(t);
  const demo = createWorkspace(fixtureDir, { seedDemo: true });
  assert.deepEqual(demo.state(), seedState());
  assert.equal(demo.view().defaultProjectId, 'p1');
  const dataDir = temporaryDirectory(t), workspace = createWorkspace(dataDir);
  const created = workspace.create({ name: '真实首个项目', ownerName: '实际发起人' });
  const projectId = created.state.project.id;
  assert.notEqual(projectId, 'p1');
  assert.equal(created.workspace.defaultProjectId, projectId);
  assert.equal(workspace.state().project.id, projectId);
  assert.deepEqual(created.state.tasks, []);
  assert.equal(existsSync(join(dataDir, 'project.json')), false);
  assert.ok(existsSync(join(dataDir, 'projects', `${projectId}.json`)));
  assert.deepEqual(createWorkspace(dataDir).state(), created.state);
  const second = workspace.create({ name: '第二个真实项目', ownerName: '实际发起人' });
  assert.equal(second.workspace.defaultProjectId, projectId);
  assert.equal(createWorkspace(dataDir).state().project.id, projectId);
});

test('已有旧project.json及索引逐字节保留，创建新项目及重启不迁移或重排旧数据', t => {
  const dataDir = temporaryDirectory(t), old = seedState();
  old.project.name = '已有团队的真实记录'; old.revision = 31;
  old.tasks[0].artifacts = [{ id: 'preserved', name: '既有成果', note: '保留原始内容', url: 'https://example.test/result' }];
  const original = Buffer.from(JSON.stringify(old, null, '\t') + '\n\n');
  writeFileSync(join(dataDir, 'project.json'), original);
  const workspace = createWorkspace(dataDir);
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), original);
  assert.deepEqual(workspace.state(), old);
  const indexPath = join(dataDir, 'workspace.json');
  const index = Buffer.from(JSON.stringify(JSON.parse(readFileSync(indexPath)), null, 4) + '\n');
  writeFileSync(indexPath, index);
  assert.deepEqual(createWorkspace(dataDir).state(), old);
  assert.deepEqual(readFileSync(indexPath), index);
  const created = workspace.create({ name: '新建的独立项目', ownerName: '实际发起人' });
  assert.equal(created.workspace.defaultProjectId, old.project.id);
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), original);
  const finalIndex = readFileSync(indexPath), reopened = createWorkspace(dataDir);
  assert.deepEqual(reopened.state(), old);
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), original);
  assert.deepEqual(readFileSync(indexPath), finalIndex);
  assert.equal(reopened.allStates().length, 2);
});

test('空工作区首次创建索引失败回滚文件和默认项目，损坏或互相矛盾的旧数据不会被覆盖', t => {
  const dataDir = temporaryDirectory(t), workspace = createWorkspace(dataDir), indexPath = join(dataDir, 'workspace.json');
  const original = readFileSync(indexPath);
  renameSync(indexPath, `${indexPath}.backup`); mkdirSync(indexPath);
  assert.throws(() => workspace.create({ name: '不能部分成功', ownerName: '实际发起人' }));
  assert.deepEqual(workspace.view(), { revision: 1, defaultProjectId: null, projects: [] });
  assert.deepEqual(readdirSync(join(dataDir, 'projects')), []);
  rmSync(indexPath, { recursive: true }); renameSync(`${indexPath}.backup`, indexPath);
  assert.deepEqual(readFileSync(indexPath), original);
  assert.equal(createWorkspace(dataDir).allStates().length, 0);
  const legacy = Buffer.from(JSON.stringify(seedState()));
  writeFileSync(join(dataDir, 'project.json'), legacy);
  assert.throws(() => createWorkspace(dataDir), /workspace\.json/);
  assert.deepEqual(readFileSync(indexPath), original);
  assert.deepEqual(readFileSync(join(dataDir, 'project.json')), legacy);
  const brokenDir = temporaryDirectory(t), broken = Buffer.from('{broken original project');
  writeFileSync(join(brokenDir, 'project.json'), broken);
  assert.throws(() => createWorkspace(brokenDir, { seedDemo: true }), /project\.json/);
  assert.deepEqual(readFileSync(join(brokenDir, 'project.json')), broken);
  assert.equal(existsSync(join(brokenDir, 'workspace.json')), false);
});

test('已有项目目录丢失索引时拒绝空初始化，不隐藏旧项目或因显式示例选项改写现存文件', t => {
  const dataDir = temporaryDirectory(t), workspace = createWorkspace(dataDir);
  const created = workspace.create({ name: '不能被空初始化遮住的已有项目', ownerName: '实际发起人' });
  const projectPath = join(dataDir, 'projects', `${created.state.project.id}.json`), projectBytes = readFileSync(projectPath);
  const indexPath = join(dataDir, 'workspace.json'); renameSync(indexPath, `${indexPath}.backup`);
  for (const options of [undefined, { seedDemo: true }]) assert.throws(() => createWorkspace(dataDir, options), /缺少 workspace\.json 索引/);
  assert.equal(existsSync(indexPath), false);
  assert.equal(existsSync(join(dataDir, 'project.json')), false);
  assert.deepEqual(readFileSync(projectPath), projectBytes);
  renameSync(`${indexPath}.backup`, indexPath);
  assert.deepEqual(createWorkspace(dataDir).state(), created.state);
});

test('默认真实鉴权：新部署零示例人员，设置只创建真实管理员，首项目邀请交付可用并持久重启', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-formal-initialization-'));
  let server, base;
  async function start() {
    // Deliberately omit both authRequired and seedDemo: this is the real CLI path.
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
  function counts() {
    const db = new DatabaseSync(join(dataDir, 'identity.sqlite'));
    const result = Object.fromEntries(['people', 'accounts', 'project_members'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    db.close(); return result;
  }
  const admin = client(), anonymous = client(), guest = client(), password = 'production-initialization-fixture-2026';
  assert.deepEqual(counts(), { people: 0, accounts: 0, project_members: 0 });
  assert.equal((await anonymous('/api/health')).data.authRequired, true);
  assert.equal((await anonymous('/api/auth/session')).data.setupRequired, true);
  for (const path of ['/api/workspace', '/api/state', '/api/people', '/api/dashboard']) assert.equal((await anonymous(path)).status, 401);
  assert.equal((await anonymous('/api/projects', { name: '匿名不能创建' })).status, 401);
  assert.equal((await anonymous('/api/auth/register', { name: '无邀请不能注册', email: 'no-invite@example.test', password })).status, 404);
  const setup = await admin('/api/auth/setup', { name: '真实部署管理员', email: 'owner@example.test', password });
  assert.equal(setup.status, 200); assert.equal(setup.data.user.workspaceRole, 'admin');
  const personId = setup.data.user.personId;
  assert.deepEqual(counts(), { people: 1, accounts: 1, project_members: 0 });
  const empty = await admin('/api/workspace');
  assert.equal(empty.data.defaultProjectId, null); assert.deepEqual(empty.data.projects, []);
  const directory = (await admin('/api/people')).data;
  assert.deepEqual(directory.people.map(person => person.id), [personId]);
  assert.equal(directory.people[0].accountLinked, true); assert.equal(directory.people[0].projectCount, 0);
  assert.deepEqual((await admin('/api/dashboard')).data.summary, { todo: 0, toReview: 0, blocked: 0, dueSoon: 0 });
  assert.equal((await admin('/api/state')).status, 404);
  assert.equal((await admin('/api/export')).status, 404);
  const emptyBytes = readFileSync(join(dataDir, 'workspace.json'));
  await stop(); await start();
  assert.deepEqual(readFileSync(join(dataDir, 'workspace.json')), emptyBytes);
  assert.equal((await admin('/api/auth/session')).data.user.personId, personId);
  assert.deepEqual((await admin('/api/workspace')).data.projects, []);
  const created = await admin('/api/projects', { name: '真实首个项目', goal: '一次可核对交付', color: '#246abc' });
  assert.equal(created.status, 201);
  let state = created.data.state; const projectId = state.project.id;
  assert.equal(created.data.workspace.defaultProjectId, projectId);
  assert.equal(state.members.length, 1); assert.equal(state.members[0].personId, personId);
  assert.equal(state.members[0].name, '真实部署管理员'); assert.deepEqual(state.tasks, []);
  assert.equal(state.currentMemberId, 'm0');
  assert.deepEqual(counts(), { people: 1, accounts: 1, project_members: 1 });
  assert.equal(existsSync(join(dataDir, 'project.json')), false);
  const invited = await admin('/api/invitations', { projectId, email: 'reviewer@example.test', accessRole: 'member' });
  assert.equal(invited.status, 201);
  const token = new URL(invited.data.invitation.url).pathname.split('/').at(-1);
  const registered = await guest('/api/auth/register', { name: '真实受邀人', email: 'reviewer@example.test', password, inviteToken: token });
  assert.equal(registered.status, 200);
  const reviewer = (await guest(`/api/state?projectId=${projectId}`)).data.currentMemberId;
  const task = await admin('/api/action', { projectId, type: 'createTask', title: '核对首轮交付', ownerId: 'm0', reviewerId: reviewer, deliverable: '可检查的交付说明' });
  assert.equal(task.status, 200); const taskId = task.data.state.tasks[0].id;
  assert.equal((await admin('/api/action', { projectId, type: 'submitArtifact', taskId, name: '首轮成果', note: '首份真实输入的成果。' })).status, 200);
  const accepted = await guest('/api/action', { projectId, type: 'accept', taskId });
  assert.equal(accepted.status, 200); state = accepted.data.state;
  assert.equal(state.tasks[0].status, 'done');
  assert.deepEqual(counts(), { people: 2, accounts: 2, project_members: 2 });
  const projectPath = join(dataDir, 'projects', `${projectId}.json`), projectBytes = readFileSync(projectPath), indexBytes = readFileSync(join(dataDir, 'workspace.json'));
  await stop(); await start();
  assert.equal((await guest('/api/state')).data.tasks[0].status, 'done');
  assert.equal((await admin('/api/workspace')).data.defaultProjectId, projectId);
  assert.deepEqual(readFileSync(projectPath), projectBytes);
  assert.deepEqual(readFileSync(join(dataDir, 'workspace.json')), indexBytes);
  assert.equal((await anonymous('/api/action', { type: 'accept', projectId, taskId, actorId: reviewer })).status, 401);
});

test('正式CLI通过current目录软链接启动时仍监听，空白首次设置可用且SIGTERM正常退出', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cobuild-symlink-start-')), dataDir = join(dir, 'isolated-data');
  let child, finished, exit, spawnError, output = '';
  t.after(async () => {
    if (child && !exit && !spawnError) {
      child.kill('SIGTERM');
      await Promise.race([finished, delay(1500)]);
      if (!exit) { child.kill('SIGKILL'); await finished; }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const current = join(dir, 'current');
  symlinkSync(fileURLToPath(new URL('../', import.meta.url)), current, 'dir');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COBUILD_')));
  child = spawn(process.execPath, [join(current, 'server.mjs'), '--host', '127.0.0.1', '--port', String(port)], {
    cwd: dir, env: { ...env, COBUILD_DATA_DIR: dataDir, COBUILD_PUBLIC_URL: '', COBUILD_SETUP_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  finished = new Promise(resolve => {
    child.once('error', error => { spawnError = error; resolve({ error }); });
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
  });
  const capture = bytes => { output = (output + bytes.toString()).slice(-3000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 8000;
  let health;
  while (Date.now() < deadline && !exit && !spawnError) {
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* Wait briefly while the CLI creates only its isolated data directory. */ }
    await delay(50);
  }
  assert.ok(health, `软链接启动未提供健康接口：${spawnError?.message || output}`);
  assert.equal(health.ok, true); assert.equal(health.authRequired, true);
  const session = await (await fetch(base + '/api/auth/session')).json();
  assert.equal(session.setupRequired, true); assert.equal(session.user, null);
  assert.equal((await fetch(base + '/api/workspace')).status, 401);
  const index = JSON.parse(readFileSync(join(dataDir, 'workspace.json'), 'utf8'));
  assert.deepEqual(index, { schemaVersion: 1, revision: 1, defaultProjectId: null, projectIds: [] });
  assert.equal(existsSync(join(dataDir, 'project.json')), false);
  assert.deepEqual(readdirSync(join(dataDir, 'projects')), []);
  const db = new DatabaseSync(join(dataDir, 'identity.sqlite'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  } finally { db.close(); }
  assert.equal(exit, undefined, 'CLI must remain running until explicitly terminated');
  assert.equal(child.kill('SIGTERM'), true);
  const stopped = await Promise.race([finished, delay(3000).then(() => null)]);
  assert.deepEqual(stopped, { code: 0, signal: null }, 'SIGTERM should close the HTTP server and exit normally');
});
