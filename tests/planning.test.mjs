import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { seedState, applyAction } from '../domain.mjs';
import { aiStatus, generatePlan, validatePlanDraft, applyPlanDraft, applyMilestoneAction, reconcileMilestones } from '../planning.mjs';

function project() {
  const state = seedState();
  state.project.deadline = '2026-11-30';
  return state;
}
function draft() {
  return {
    title: '交付可用的协作版', summary: '先确认接口，再完成前端联调。',
    assumptions: ['成员能够按约定投入时间'], risks: ['联调可能发现接口差异'], questions: ['测试由谁负责？'],
    milestones: [
      { id: 'phase-a', title: '接口就绪', goal: '前端可以依说明调用接口', due: '2026-11-10', acceptanceCriteria: '说明与样例覆盖正常及失败请求，接收人完成核对' },
      { id: 'phase-b', title: '交互联调', goal: '完成一次真实成果交接', due: '2026-11-20', acceptanceCriteria: '两个成员可以完成提交、退回、再次提交和确认流程' }
    ],
    tasks: [
      { id: 'work-a', title: '补充接口样例', description: '加入失败请求示例', ownerId: 'm2', reviewerId: 'm3', due: '2026-11-08', deliverable: '接口说明与可执行样例', dependsOn: [], milestoneId: 'phase-a' },
      { id: 'work-b', title: '完成联调', description: '依照接口说明完成验证', ownerId: 'm3', reviewerId: 'm1', due: '2026-11-18', deliverable: '联调结果与操作录屏', dependsOn: ['work-a'], milestoneId: 'phase-b' }
    ]
  };
}
const status = (code, pattern) => error => error.status === code && (!pattern || pattern.test(error.message));
const apply = (state, value = draft()) => applyPlanDraft(state, { actorId: 'm0', expectedRevision: state.revision, draft: value });
const milestone = (state, type, input = {}) => applyMilestoneAction(state, { type, actorId: 'm0', expectedRevision: state.revision, ...input });
const configKeys = ['COBUILD_AI_BASE_URL', 'COBUILD_AI_API_KEY', 'COBUILD_AI_MODEL', 'COBUILD_AI_TIMEOUT_MS', 'COBUILD_AI_MAX_TOKENS', 'COBUILD_AI_RESPONSE_FORMAT', 'COBUILD_AI_TOKEN_PARAMETER', 'COBUILD_AI_THINKING'];
function configure(t, values = {}) {
  const previous = new Map(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = { method: req.method, path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
      requests.push(request);
      await handler(request, res);
    } catch { if (!res.destroyed) { res.writeHead(500); res.end('fixture failure'); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', requests };
}
function fixtureConfig(baseUrl, extra = {}) {
  return { COBUILD_AI_BASE_URL: baseUrl, COBUILD_AI_API_KEY: 'local-fixture-token', COBUILD_AI_MODEL: 'fixture-model', COBUILD_AI_TIMEOUT_MS: '3000', COBUILD_AI_MAX_TOKENS: '1024', ...extra };
}
function completion(res, value, choice = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...choice }] }));
}

test('draft normalization keeps input immutable and permits edited plans to be validated again', () => {
  const state = project(), raw = draft(), original = structuredClone(raw);
  raw.title = '  调整后的计划  ';
  const checked = validatePlanDraft(state, raw);
  assert.equal(checked.title, '调整后的计划');
  assert.equal(raw.title, '  调整后的计划  ');
  checked.tasks[0].deliverable = '修订后的接口说明';
  assert.equal(validatePlanDraft(state, checked).tasks[0].deliverable, '修订后的接口说明');
  assert.deepEqual(original, draft());
  assert.equal(state.milestones, undefined);
});

test('invalid assignments, references, dates, scopes and dependency cycles are rejected atomically', () => {
  const cases = [
    ['unknown member', value => { value.tasks[0].ownerId = 'invented-member'; }],
    ['unknown milestone', value => { value.tasks[0].milestoneId = 'missing'; }],
    ['unknown dependency', value => { value.tasks[0].dependsOn = ['missing']; }],
    ['duplicate task', value => { value.tasks[1].id = value.tasks[0].id; }],
    ['duplicate milestone', value => { value.milestones[1].id = value.milestones[0].id; }],
    ['invalid date', value => { value.tasks[0].due = '2026-02-30'; }],
    ['after project deadline', value => { value.milestones[1].due = '2026-12-01'; }],
    ['after milestone deadline', value => { value.tasks[0].due = '2026-11-11'; }],
    ['cycle', value => { value.tasks[0].due = value.tasks[1].due = '2026-11-08'; value.tasks[0].dependsOn = ['work-b']; }],
    ['late predecessor', value => { value.tasks[1].due = '2026-11-07'; }],
    ['empty criteria', value => { value.milestones[0].acceptanceCriteria = ' '; }],
    ['fake completion', value => { value.tasks[0].status = 'done'; }],
    ['empty milestone', value => { value.tasks[1].milestoneId = 'phase-a'; value.tasks[1].due = '2026-11-09'; }],
    ['too many tasks', value => { value.tasks = Array.from({ length: 81 }, (_, index) => ({ ...value.tasks[0], id: 'task-' + index })); }],
    ['missing deliverable', value => { delete value.tasks[0].deliverable; }]
  ];
  for (const [label, change] of cases) {
    const state = project(), original = structuredClone(state), value = draft();
    change(value);
    assert.throws(() => apply(state, value), undefined, label);
    assert.deepEqual(state, original, label + ' must not partially apply');
  }
});

test('applying a plan remaps all temporary IDs and appends tasks without altering existing work', () => {
  const state = project(), original = structuredClone(state), value = draft();
  const next = apply(state, value);
  assert.deepEqual(state, original);
  assert.equal(next.revision, state.revision + 1);
  assert.deepEqual(next.tasks.slice(0, state.tasks.length), state.tasks);
  assert.equal(next.milestones.length, 2);
  const [first, second] = next.tasks.slice(state.tasks.length);
  assert.notEqual(first.id, value.tasks[0].id);
  assert.deepEqual(second.dependsOn, [first.id]);
  assert.equal(first.milestoneId, next.milestones[0].id);
  assert.equal(second.milestoneId, next.milestones[1].id);
  assert.ok([first, second].every(item => item.status === 'todo' && !item.artifacts.length && !item.acceptedAt));
  assert.equal(next.activities[0].actorId, 'm0');
  assert.match(next.activities[0].text, /新增 2 个里程碑和 2 项任务/);
});

test('plans require the original project version and enforce total project capacity', () => {
  const state = project();
  assert.throws(() => applyPlanDraft(state, { actorId: 'm0', expectedRevision: state.revision + 1, draft: draft() }), status(409));
  assert.throws(() => applyPlanDraft(state, { actorId: 'm0', draft: draft() }), status(400));
  const full = project();
  full.tasks = Array.from({ length: 499 }, (_, index) => ({ ...structuredClone(full.tasks[0]), id: 'old-' + index }));
  assert.throws(() => apply(full), status(400, /500/));
  assert.equal(full.tasks.length, 499);
});

test('management follows trusted access roles rather than treating the old m0 as the logged-in administrator', () => {
  const state = project();
  state.members = state.members.map(item => ({ ...item, accessRole: item.id === 'm2' ? 'admin' : 'member' }));
  assert.throws(() => apply(state), status(403));
  const next = applyPlanDraft(state, { actorId: 'm2', expectedRevision: state.revision, draft: draft() });
  assert.equal(next.activities[0].actorId, 'm2');
  assert.throws(() => milestone(state, 'createMilestone', { title: '发布', goal: '完成上线', due: '2026-11-25', acceptanceCriteria: '成果全部交接' }), status(403));
});

test('manual milestones accept legacy tasks only after real task handoff, preserving acceptance history on change', () => {
  let state = milestone(project(), 'createMilestone', { title: '原型就绪', goal: '范围已经确认', due: '2026-11-01', acceptanceCriteria: '接收人检查原型与范围', taskIds: ['t1'] });
  const id = state.milestones[0].id;
  state = milestone(state, 'acceptMilestone', { milestoneId: id, note: '已逐项检查原型范围。' });
  assert.equal(state.milestones[0].status, 'accepted');
  assert.equal(state.milestones[0].acceptedBy, 'm0');
  assert.ok(state.milestones[0].acceptedAt);
  assert.throws(() => milestone(state, 'acceptMilestone', { milestoneId: id, note: '重复确认' }), status(409));
  const withProgress = applyAction(state, { type: 'addUpdate', actorId: 'm1', taskId: 't1', text: '补充归档说明，不改变交付。' });
  assert.equal(reconcileMilestones(withProgress).milestones[0].status, 'accepted');
  const changed = applyAction(state, { type: 'updateTask', actorId: 'm1', taskId: 't1', patch: { deliverable: '新增移动端原型与操作说明' } });
  const next = reconcileMilestones(changed);
  assert.equal(next.milestones[0].status, 'open');
  assert.equal(next.milestones[0].acceptedAt, '');
  assert.equal(next.milestones[0].acceptanceHistory.length, 1);
  assert.equal(next.milestones[0].acceptanceHistory[0].note, '已逐项检查原型范围。');
  assert.ok(next.milestones[0].acceptanceHistory[0].invalidatedAt);
  assert.equal(state.milestones[0].status, 'accepted');
});

test('empty milestones, pending handoffs, fake done states and stale milestone forms cannot be accepted', () => {
  const fields = { title: '发布', goal: '完成交付', due: '2026-11-25', acceptanceCriteria: '所有成果检查通过' };
  let state = milestone(project(), 'createMilestone', fields);
  const id = state.milestones[0].id;
  assert.throws(() => milestone(state, 'acceptMilestone', { milestoneId: id, note: '检查通过' }), status(409));
  state = milestone(state, 'updateMilestone', { milestoneId: id, patch: { taskIds: ['t6'] } });
  assert.throws(() => milestone(state, 'acceptMilestone', { milestoneId: id, note: '检查通过' }), status(409));
  state.tasks.find(item => item.id === 't6').status = 'done';
  assert.throws(() => milestone(state, 'acceptMilestone', { milestoneId: id, note: '检查通过' }), status(409));
  assert.throws(() => applyMilestoneAction(state, { type: 'updateMilestone', actorId: 'm0', expectedRevision: 1, milestoneId: id, patch: { title: '旧表单' } }), status(409));
  const original = structuredClone(state);
  assert.throws(() => milestone(state, 'updateMilestone', { milestoneId: id, patch: { taskIds: ['foreign-project-task'] } }), status(400));
  assert.deepEqual(state, original);
});

test('changing milestone criteria or its task membership invalidates the previous sign-off', () => {
  let state = milestone(project(), 'createMilestone', { title: '原型', goal: '检查原型', due: '2026-11-01', acceptanceCriteria: '原型可查看', taskIds: ['t1'] });
  const id = state.milestones[0].id;
  state = milestone(state, 'acceptMilestone', { milestoneId: id, note: '原型已检查' });
  state = milestone(state, 'updateMilestone', { milestoneId: id, patch: { acceptanceCriteria: '原型与移动端都可查看' } });
  assert.equal(state.milestones[0].status, 'open');
  assert.equal(state.milestones[0].acceptanceHistory.length, 1);
  state = milestone(state, 'acceptMilestone', { milestoneId: id, note: '重新检查通过' });
  state = milestone(state, 'updateMilestone', { milestoneId: id, patch: { taskIds: [] } });
  assert.equal(state.milestones[0].status, 'open');
  assert.equal(state.tasks.find(item => item.id === 't1').milestoneId, undefined);
  assert.equal(state.milestones[0].acceptanceHistory.length, 2);
});

test('an applied task must pass its designated recipient before its milestone can be signed off', () => {
  let state = apply(project());
  const task = state.tasks.at(-2), id = task.milestoneId;
  assert.throws(() => milestone(state, 'acceptMilestone', { milestoneId: id, note: '提前验收' }), status(409));
  state = applyAction(state, { type: 'submitArtifact', actorId: task.ownerId, taskId: task.id, name: '接口说明', note: '可核对的接口结果' });
  assert.throws(() => milestone(state, 'acceptMilestone', { milestoneId: id, note: '仍未由接收人确认' }), status(409));
  state = applyAction(state, { type: 'accept', actorId: task.reviewerId, taskId: task.id });
  state = milestone(state, 'acceptMilestone', { milestoneId: id, note: '任务成果已由约定接收人检查' });
  assert.equal(state.milestones.find(item => item.id === id).status, 'accepted');
});

test('missing model configuration reports 503 and never substitutes a generated template', async t => {
  configure(t);
  const state = project(), original = structuredClone(state);
  assert.deepEqual(aiStatus(), { configured: false, provider: 'openai-compatible', model: '', baseUrl: '' });
  await assert.rejects(generatePlan(state, { goal: '完成协作版' }), status(503, /COBUILD_AI_API_KEY/));
  assert.deepEqual(state, original);
});

test('model configuration restricts plaintext HTTP to loopback and never exposes the API key', t => {
  configure(t, fixtureConfig('https://model.example.invalid/v1'));
  assert.equal(aiStatus().configured, true);
  assert.ok(!JSON.stringify(aiStatus()).includes('local-fixture-token'));
  for (const base of ['http://model.example.invalid/v1', 'http://192.168.1.10:8080/v1', 'https://name:secret@model.example.invalid/v1', 'https://model.example.invalid/v1?api_key=secret']) {
    process.env.COBUILD_AI_BASE_URL = base;
    assert.equal(aiStatus().configured, false, base);
    assert.equal(aiStatus().baseUrl, '');
  }
  for (const base of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
    process.env.COBUILD_AI_BASE_URL = base;
    assert.equal(aiStatus().configured, true, base);
  }
});

test('local HTTP model fixture receives bounded structured requests and returns a validated editable draft', async t => {
  const service = await fixture(t, (_, res) => completion(res, draft()));
  configure(t, fixtureConfig(service.baseUrl));
  const state = project(), original = structuredClone(state);
  const result = await generatePlan(state, { goal: '完成协作版', deadline: '2026-11-25', scope: '只做接口与联调', constraints: '不能改变已有成果' });
  assert.deepEqual(state, original);
  assert.equal(result.baseRevision, state.revision);
  assert.equal(result.model, 'fixture-model');
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  const request = service.requests[0];
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer local-fixture-token');
  assert.equal(request.body.max_completion_tokens, 1024);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.store, false);
  assert.equal('thinking' in request.body, false);
  assert.equal(request.body.response_format.json_schema.strict, true);
  const data = JSON.parse(request.body.messages[1].content);
  assert.deepEqual(data.context.members.map(item => item.id), state.members.map(item => item.id));
  assert.equal(data.context.existingTasks[0].artifacts, undefined);
  assert.equal(data.context.members[0].email, undefined);
  result.draft.tasks[0].title = '人工修订后的任务';
  const applied = applyPlanDraft(state, { actorId: 'm0', expectedRevision: result.baseRevision, draft: result.draft });
  assert.equal(applied.tasks.at(-2).title, '人工修订后的任务');
});

test('model planning captures its base revision before the HTTP call completes', async t => {
  const service = await fixture(t, (_, res) => completion(res, draft()));
  configure(t, fixtureConfig(service.baseUrl));
  const state = project(), expected = state.revision;
  const pending = generatePlan(state, { goal: '交付接口与联调' });
  state.revision += 1;
  const result = await pending;
  assert.equal(result.baseRevision, expected);
  assert.throws(() => applyPlanDraft(state, { actorId: 'm0', expectedRevision: result.baseRevision, draft: result.draft }), status(409));
});

test('invalid model output is rejected without partially modifying project state', async t => {
  const invalid = draft(); invalid.tasks[0].ownerId = 'fictional-person';
  const service = await fixture(t, (_, res) => completion(res, invalid));
  configure(t, fixtureConfig(service.baseUrl));
  const state = project(), original = structuredClone(state);
  await assert.rejects(generatePlan(state, { goal: '完成协作版' }), status(502, /草案校验未通过/));
  assert.deepEqual(state, original);
});

test('truncated model completions are rejected even when their content contains parseable JSON', async t => {
  const service = await fixture(t, (_, res) => completion(res, draft(), { finish_reason: 'length' }));
  configure(t, fixtureConfig(service.baseUrl));
  await assert.rejects(generatePlan(project(), { goal: '完成协作版' }), status(502, /不完整/));
});

test('model request timeout and response byte limits terminate local fixture calls', async t => {
  await t.test('timeout', async t => {
    const service = await fixture(t, (_, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(' '); });
    configure(t, fixtureConfig(service.baseUrl, { COBUILD_AI_TIMEOUT_MS: '100' }));
    await assert.rejects(generatePlan(project(), { goal: '完成协作版' }), status(504, /超时/));
  });
  await t.test('byte limit', async t => {
    const service = await fixture(t, (_, res) => { const body = 'x'.repeat(270000); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body); });
    configure(t, fixtureConfig(service.baseUrl));
    await assert.rejects(generatePlan(project(), { goal: '完成协作版' }), status(502, /大小上限/));
  });
});

test('redirects are not followed and provider error bodies are not exposed', async t => {
  await t.test('redirect', async t => {
    const service = await fixture(t, (_, res) => { res.writeHead(302, { Location: '/redirect-target' }); res.end(); });
    configure(t, fixtureConfig(service.baseUrl));
    await assert.rejects(generatePlan(project(), { goal: '完成协作版' }), status(502));
    assert.equal(service.requests.length, 1);
  });
  await t.test('provider error', async t => {
    const service = await fixture(t, (_, res) => { res.writeHead(401); res.end('provider secret local-fixture-token'); });
    configure(t, fixtureConfig(service.baseUrl));
    await assert.rejects(generatePlan(project(), { goal: '完成协作版' }), error => error.status === 502 && /401/.test(error.message) && !error.message.includes('local-fixture-token'));
  });
});
