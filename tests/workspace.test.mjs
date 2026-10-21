import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { seedState } from '../domain.mjs';
import { createWorkspace } from '../workspace.mjs';

async function fixture(t, { legacy } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-workspace-'));
  if (legacy) writeFileSync(join(dataDir, 'project.json'), legacy);
  let server;
  let base;
  async function start() {
    server = createApp({ dataDir, authRequired:false });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const get = path => fetch(`${base}${path}`);
  const post = (path, value) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const json = async path => (await get(path)).json();
  const create = async (name, extra = {}) => {
    const response = await post('/api/projects', { name, ownerName: '发起人', ...extra });
    assert.equal(response.status, 201);
    return response.json();
  };
  const restart = async () => { await new Promise(resolve => server.close(resolve)); await start(); };
  return { dataDir, get, post, json, create, restart };
}

const taskInput = (projectId, title = '本项目的任务') => ({ projectId, type: 'createTask', actorId: 'm0', title, ownerId: 'm0', reviewerId: 'm0', deliverable: '可检查的交付成果' });

test('索引写入失败时项目原字节和内存均恢复，重启不会读到失败的修改', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-save-failure-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const workspace = createWorkspace(dataDir), before = structuredClone(workspace.state());
  const projectPath = join(dataDir, 'project.json'), indexPath = join(dataDir, 'workspace.json');
  const bytes = readFileSync(projectPath), index = workspace.view();
  renameSync(indexPath, `${indexPath}.backup`); mkdirSync(indexPath);
  const next = structuredClone(before); next.project.description = '这次失败的写入不能残留'; next.revision += 1;
  assert.throws(() => workspace.save(before.project.id, next));
  assert.deepEqual(readFileSync(projectPath), bytes);
  assert.deepEqual(workspace.state(), before);
  assert.deepEqual(workspace.view(), index);
  rmSync(indexPath, { recursive: true }); renameSync(`${indexPath}.backup`, indexPath);
  assert.deepEqual(createWorkspace(dataDir).state(), before);
  assert.ok(!readdirSync(dataDir).some(name => name.endsWith('.tmp')));
});

test('注册旧项目不改原文件，真实成果和旧下载保留；创建项目没有示例任务', async t => {
  const original = seedState();
  original.revision = 17;
  original.project.name = '已有真实项目';
  original.tasks[1].artifacts = [{ id: 'old-artifact', name: '保留的成果', url: 'https://example.com/result', note: '真实已有记录' }];
  const legacy = JSON.stringify(original);
  const { dataDir, json, create, get, post, restart } = await fixture(t, { legacy });
  assert.equal(readFileSync(join(dataDir, 'project.json'), 'utf8'), legacy);
  assert.deepEqual(await json('/api/state'), original);
  const workspace = await json('/api/workspace');
  assert.equal(workspace.defaultProjectId, 'p1');
  assert.equal(workspace.projects[0].name, '已有真实项目');
  assert.equal(workspace.projects[0].taskCount, original.tasks.length);
  const created = await create('空白新项目', { members: [{ name: '同事', role: '设计' }], color: '#123abc' });
  const p = created.state;
  assert.notEqual(p.project.id, 'p1');
  assert.equal(p.revision, 1);
  assert.equal(p.project.goal, '');
  assert.equal(p.project.deadline, '');
  assert.deepEqual(p.tasks, []);
  assert.deepEqual(p.decisions, []);
  assert.equal(p.members[0].id, 'm0');
  assert.equal(p.members[0].name, '发起人');
  assert.equal(p.members.length, 2);
  assert.equal(p.activities.length, 1);
  assert.equal(p.activities[0].kind, 'create');
  assert.equal(created.workspace.revision, workspace.revision + 1);
  assert.equal(created.workspace.projects[1].memberCount, 2);
  assert.equal(created.workspace.projects[1].taskCount, 0);
  assert.equal(created.workspace.projects[1].color, '#123abc');
  assert.equal(readFileSync(join(dataDir, 'project.json'), 'utf8'), legacy);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'projects', `${p.project.id}.json`), 'utf8')), p);
  assert.equal((await get('/api/export')).status, 200);
  const content = Buffer.from('原项目文件，切换后仍可下载');
  const uploaded = await post('/api/action', { type: 'submitArtifact', actorId: 'm2', taskId: 't2', name: '原项目上传成果', file: { name: 'old.txt', base64: content.toString('base64') } });
  assert.equal(uploaded.status, 200);
  const oldURL = (await uploaded.json()).state.tasks[1].artifacts[0].url;
  await json(`/api/state?projectId=${p.project.id}`);
  await restart();
  assert.deepEqual(Buffer.from(await (await get(oldURL)).arrayBuffer()), content);
  assert.equal((await json('/api/state')).project.id, 'p1');
});

test('多客户端交错操作隔离项目，项目版本独立、索引版本递增，所有项目API选择一致', async t => {
  const { post, json, create, get, restart } = await fixture(t);
  const original = await json('/api/state');
  const a = (await create('项目 A')).state;
  const b = (await create('项目 B', { ownerName: '另一发起人' })).state;
  const before = await json('/api/workspace');
  // Two tabs may issue requests concurrently; neither request changes a global active project.
  const results = await Promise.all([
    post('/api/action', taskInput(a.project.id, 'A 的任务')),
    post('/api/action', taskInput(b.project.id, 'B 的任务'))
  ]);
  assert.deepEqual(results.map(response => response.status), [200, 200]);
  const updatedA = (await results[0].json()).state;
  const updatedB = (await results[1].json()).state;
  assert.equal(updatedA.tasks[0].title, 'A 的任务');
  assert.equal(updatedB.tasks[0].title, 'B 的任务');
  assert.equal(updatedA.revision, 2);
  assert.equal(updatedB.revision, 2);
  assert.equal((await json('/api/workspace')).revision, before.revision + 2);
  assert.deepEqual(await json('/api/state'), original);
  const analysis = await post('/api/analyze', { projectId: a.project.id, actorId: 'm0', taskId: updatedA.tasks[0].id, text: '等待客户确认。' });
  assert.equal(analysis.status, 200);
  assert.equal((await analysis.json()).analysis.status, 'blocked');
  assert.equal((await json('/api/workspace')).revision, before.revision + 2);
  const crossTask = await post('/api/action', { projectId: b.project.id, type: 'addUpdate', actorId: 'm0', taskId: updatedA.tasks[0].id, text: '不可串到其他项目' });
  assert.equal(crossTask.status, 404);
  const crossAnalysis = await post('/api/analyze', { projectId: b.project.id, actorId: 'm0', taskId: updatedA.tasks[0].id, text: '不可串到其他项目' });
  assert.equal(crossAnalysis.status, 404);
  assert.deepEqual(await json(`/api/export?projectId=${a.project.id}`), updatedA);
  const report = await (await get(`/api/report?projectId=${b.project.id}`)).text();
  assert.match(report, /项目 B/);
  assert.match(report, /B 的任务/);
  assert.doesNotMatch(report, /A 的任务/);
  await restart();
  assert.deepEqual(await json(`/api/state?projectId=${a.project.id}`), updatedA);
  assert.deepEqual(await json(`/api/state?projectId=${b.project.id}`), updatedB);
  assert.deepEqual(await json('/api/state'), original);
  assert.equal((await json('/api/workspace')).revision, before.revision + 2);
});

test('新项目文件跨项目查找并持久化，重置只清本项目工作并保留元信息和成员', async t => {
  const { post, json, create, get, restart } = await fixture(t);
  const a = (await create('项目 A', { description: '保留简介', goal: '保留目标', deadline: '2026-10-27', members: [{ name: '设计同事' }] })).state;
  const b = (await create('项目 B')).state;
  const createdTask = (await (await post('/api/action', taskInput(a.project.id))).json()).state.tasks[0];
  const content = Buffer.from('新项目的真实文件');
  const submitted = await post('/api/action', { projectId: a.project.id, type: 'submitArtifact', actorId: 'm0', taskId: createdTask.id, name: 'A 的成果', file: { name: 'A-成果.txt', base64: content.toString('base64') } });
  assert.equal(submitted.status, 200);
  const submittedState = (await submitted.json()).state;
  const artifactURL = submittedState.tasks[0].artifacts[0].url;
  await json(`/api/state?projectId=${b.project.id}`);
  await restart();
  const downloaded = await get(artifactURL);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
  const workspace = await json('/api/workspace');
  assert.equal(workspace.projects.find(project => project.id === a.project.id).reviewCount, 1);
  const original = await json('/api/state');
  const reset = await post('/api/reset', { projectId: a.project.id });
  assert.equal(reset.status, 200);
  const cleared = (await reset.json()).state;
  assert.deepEqual(cleared.project, submittedState.project);
  assert.deepEqual(cleared.members, submittedState.members);
  assert.deepEqual(cleared.tasks, []);
  assert.deepEqual(cleared.decisions, []);
  assert.equal(cleared.activities.length, 1);
  assert.equal(cleared.activities[0].kind, 'reset');
  assert.equal(cleared.revision, submittedState.revision + 1);
  assert.equal((await json('/api/workspace')).revision, workspace.revision + 1);
  assert.deepEqual(await json(`/api/state?projectId=${b.project.id}`), b);
  assert.deepEqual(await json('/api/state'), original);
  await restart();
  assert.deepEqual(await json(`/api/state?projectId=${a.project.id}`), cleared);
});

test('创建输入校验及不存在项目不会写入其他项目或产生上传孤儿', async t => {
  const { post, json, get, dataDir } = await fixture(t);
  const original = await json('/api/state');
  const workspace = await json('/api/workspace');
  const invalid = [
    null, [], {}, { name: ' ', ownerName: '人' }, { name: '项目', ownerName: ' ' },
    { name: '项目', ownerName: 12 }, { name: '项目', ownerName: '人', deadline: '2026-02-30' },
    { name: '项目', ownerName: '人', deadline: false }, { name: '项目', ownerName: '人', color: 'red' },
    { name: '项目', ownerName: '人', color: '#12' }, { name: '项目', ownerName: '人', members: null },
    { name: '项目', ownerName: '人', members: [{}] },
    { name: '项目', ownerName: '人', members: [{ name: '  ' }] },
    { name: '项目', ownerName: '人', members: [{ name: ' 人 ' }] },
    { name: '项目', ownerName: '人', members: [{ name: '甲' }, { name: ' 甲 ' }] },
    { name: '项目', ownerName: '人', members: [{ name: '甲', role: {} }] },
    { name: '项目', ownerName: '人', members: Array.from({ length: 32 }, (_, i) => ({ name: `${i}` })) },
    { name: '项目', ownerName: '人', id: 'p1' }, { name: 'x'.repeat(101), ownerName: '人' }
  ];
  for (const input of invalid) assert.equal((await post('/api/projects', input)).status, 400, JSON.stringify(input));
  for (const path of ['/api/state', '/api/export', '/api/report', '/api/health']) assert.equal((await get(`${path}?projectId=missing`)).status, 404, path);
  for (const [path, input] of [
    ['/api/action', { type: 'addMember', actorId: 'm0', name: '不应添加' }],
    ['/api/analyze', { actorId: 'm2', taskId: 't2', text: '不应分析默认项目' }],
    ['/api/reset', {}],
    ['/api/action', { type: 'submitArtifact', actorId: 'm2', taskId: 't2', name: '不应上传', file: { name: 'no.txt', base64: 'YQ==' } }]
  ]) assert.equal((await post(path, { ...input, projectId: 'missing' })).status, 404, path);
  for (const projectId of [null, '', '../p1', [], {}]) assert.equal((await post('/api/reset', { projectId })).status, 400);
  assert.equal((await get('/api/state?projectId=p1&projectId=missing')).status, 400);
  assert.deepEqual(await json('/api/state'), original);
  assert.deepEqual(await json('/api/workspace'), workspace);
  assert.deepEqual(readdirSync(join(dataDir, 'projects')), []);
  assert.deepEqual(readdirSync(join(dataDir, 'files')), []);
});

test('新项目可保留空目标、更新简介并再次清空目标，版本和概览同步', async t => {
  const { create, post, json } = await fixture(t);
  const project = (await create('尚未填写目标的项目')).state;
  assert.equal(project.project.goal, '');
  let response = await post('/api/action', { projectId: project.project.id, type: 'updateProject', actorId: 'm0', patch: { description: '已经明确项目简介', goal: '临时目标' } });
  assert.equal(response.status, 200);
  response = await post('/api/action', { projectId: project.project.id, type: 'updateProject', actorId: 'm0', patch: { goal: '' } });
  assert.equal(response.status, 200);
  const state = (await response.json()).state;
  assert.equal(state.project.goal, '');
  assert.equal(state.project.description, '已经明确项目简介');
  assert.equal(state.revision, project.revision + 2);
  const summary = (await json('/api/workspace')).projects.find(candidate => candidate.id === project.project.id);
  assert.equal(summary.goal, '');
  assert.equal(summary.description, state.project.description);
});
