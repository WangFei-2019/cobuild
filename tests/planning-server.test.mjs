import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const configKeys = ['COBUILD_AI_BASE_URL', 'COBUILD_AI_API_KEY', 'COBUILD_AI_MODEL', 'COBUILD_AI_TIMEOUT_MS', 'COBUILD_AI_MAX_TOKENS', 'COBUILD_AI_RESPONSE_FORMAT', 'COBUILD_AI_TOKEN_PARAMETER'];

async function listen(servers, server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

function responseDraft(context) {
  const [owner, reviewer] = context.members;
  return {
    title: 'HTTP 集成规划', summary: '通过真实登录路由创建可验收的项目计划。',
    assumptions: ['当前已确定接口和界面的负责方向'], risks: ['仍需进行浏览器验证'], questions: [],
    milestones: [{ id: 'phase-release', title: '联调完成', goal: '项目协作流程可体验', due: '2026-12-10', acceptanceCriteria: '接口样例和界面成果都由各自接收人检查通过' }],
    tasks: [
      { id: 'draft-api', title: '完善接口说明', description: '说明正常请求和错误请求', ownerId: owner.id, reviewerId: reviewer.id, due: '2026-12-07', deliverable: '可核对的接口文档与样例', dependsOn: [], milestoneId: 'phase-release' },
      { id: 'draft-ui', title: '核对界面联调', description: '依照文档核对交互', ownerId: reviewer.id, reviewerId: owner.id, due: '2026-12-09', deliverable: '联调录屏与问题清单', dependsOn: ['draft-api'], milestoneId: 'phase-release' }
    ]
  };
}

test('authenticated HTTP planning generates without writes, applies atomically, and rejects stale plans', async t => {
  const previous = new Map(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-planning-server-'));
  const servers = [];
  t.after(async () => {
    try {
      for (const server of [...servers].reverse()) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  // Do not pass authRequired:false: this test exercises production authentication.
  const base = await listen(servers, createApp({ dataDir, publicUrl: '', setupToken: '', seedDemo:true }));
  let cookie = '';
  async function request(path, body, authenticated = true) {
    const headers = {};
    if (authenticated && cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function state(projectId) {
    const result = await request('/api/state?projectId=' + encodeURIComponent(projectId));
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }

  assert.equal((await request('/api/workspace', undefined, false)).status, 401);
  let result = await request('/api/auth/setup', { name: '规划测试管理员', email: 'planning-admin@example.test', password: 'planning-fixture-password-2026' }, false);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.user.workspaceRole, 'admin');
  assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  assert.ok(cookie.startsWith('cobuild_session='));
  const legacy = await request('/api/state');
  assert.equal(legacy.status, 200);
  const legacyProjectId = legacy.data.project.id;

  result = await request('/api/projects', {
    name: '真实路由规划验证', description: '只用于随机端口和临时数据目录的集成测试。',
    goal: '交付完整的任务与里程碑草案', deadline: '2026-12-20', ownerRole: '项目管理',
    members: [{ name: '测试设计成员', role: '界面设计与验收' }]
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const projectId = result.data.state.project.id;
  assert.notEqual(projectId, legacyProjectId);
  const before = await state(projectId);
  assert.equal(before.tasks.length, 0);
  assert.equal(before.milestones?.length || 0, 0);
  assert.equal(before.permissions.manageProject, true);
  const projectFile = join(dataDir, 'projects', projectId + '.json');
  const diskBefore = readFileSync(projectFile, 'utf8');

  const modelRequests = [];
  const model = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const data = JSON.parse(input.messages[1].content);
      modelRequests.push({ path: req.url, authorization: req.headers.authorization, input, context: data.context });
      const draft = responseDraft(data.context);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'integration-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture failure' }));
    }
  });
  const modelBase = await listen(servers, model);
  Object.assign(process.env, {
    COBUILD_AI_BASE_URL: modelBase + '/v1', COBUILD_AI_API_KEY: 'integration-fixture-only-token',
    COBUILD_AI_MODEL: 'integration-fixture', COBUILD_AI_TIMEOUT_MS: '3000', COBUILD_AI_MAX_TOKENS: '2048'
  });
  result = await request('/api/ai/status');
  assert.equal(result.status, 200);
  assert.equal(result.data.configured, true);
  assert.ok(!JSON.stringify(result.data).includes('integration-fixture-only-token'));

  const planningRequest = { projectId, goal: before.project.goal, deadline: before.project.deadline, scope: '接口与界面联调', constraints: '只使用已存在的项目成员' };
  assert.equal((await request('/api/ai/plan', planningRequest, false)).status, 401);
  result = await request('/api/ai/plan', planningRequest);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const generated = result.data;
  assert.equal(generated.baseRevision, before.revision);
  assert.equal(generated.model, 'integration-fixture');
  assert.equal(generated.draft.tasks.length, 2);
  assert.equal(generated.draft.milestones.length, 1);
  assert.deepEqual(await state(projectId), before, 'generating a draft must not modify project state');
  assert.equal(readFileSync(projectFile, 'utf8'), diskBefore, 'generating a draft must not persist tasks or milestones');
  assert.equal(modelRequests[0].path, '/v1/chat/completions');
  assert.equal(modelRequests[0].authorization, 'Bearer integration-fixture-only-token');
  assert.equal(modelRequests[0].context.project.name, before.project.name);
  assert.deepEqual(modelRequests[0].context.members.map(item => item.id), before.members.map(item => item.id));

  result = await request('/api/plans/apply', { projectId, expectedRevision: generated.baseRevision, draft: generated.draft });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const applied = result.data.state;
  assert.equal(applied.revision, before.revision + 1);
  assert.equal(applied.tasks.length, 2);
  assert.equal(applied.milestones.length, 1);
  assert.ok(applied.tasks.every(item => item.status === 'todo' && item.milestoneId === applied.milestones[0].id));
  assert.deepEqual(applied.tasks[1].dependsOn, [applied.tasks[0].id]);
  assert.notEqual(applied.tasks[0].id, 'draft-api');
  const diskApplied = JSON.parse(readFileSync(projectFile, 'utf8'));
  assert.equal(diskApplied.tasks.length, 2);
  assert.equal(diskApplied.milestones.length, 1);
  assert.ok(diskApplied.members.every(member => !('accessRole' in member)), 'derived authorization roles must not leak into project persistence');
  assert.deepEqual(await state(legacyProjectId), legacy.data, 'planning a new project must not change the legacy project');

  result = await request('/api/ai/plan', planningRequest);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const stale = result.data;
  result = await request('/api/action', { projectId, type: 'updateProject', patch: { description: '规划生成后，人类修订了项目范围。' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const afterHumanEdit = await state(projectId);
  assert.ok(afterHumanEdit.revision > stale.baseRevision);
  result = await request('/api/plans/apply', { projectId, expectedRevision: stale.baseRevision, draft: stale.draft });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.deepEqual(await state(projectId), afterHumanEdit, 'a stale plan must not append partial work or overwrite the edit');
  assert.equal(modelRequests.length, 2);
});
