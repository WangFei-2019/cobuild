import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { seedState } from '../domain.mjs';
import { aiStatus, generateReplan, previewReplan, applyReplanDraft } from '../planning.mjs';

const configKeys = ['COBUILD_AI_BASE_URL', 'COBUILD_AI_API_KEY', 'COBUILD_AI_MODEL', 'COBUILD_AI_TIMEOUT_MS', 'COBUILD_AI_MAX_TOKENS', 'COBUILD_AI_RESPONSE_FORMAT', 'COBUILD_AI_TOKEN_PARAMETER', 'COBUILD_AI_THINKING'];
function project() {
  const state = seedState();
  state.project.deadline = '2026-12-31';
  const base = { goal: '保留约定', due: '2026-12-10', acceptanceCriteria: '按成果逐项检查', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', acceptedAt: '', acceptedBy: '', acceptanceNote: '', acceptanceFingerprint: '', acceptanceHistory: [] };
  state.milestones = [
    { ...structuredClone(base), id: 'milestone-locked', title: '保护阶段', status: 'accepted', acceptedAt: '2026-10-20T11:00:00.000Z', acceptedBy: 'm0', acceptanceNote: '历史验收记录必须原样保留', acceptanceFingerprint: 'historical-fingerprint' },
    { ...structuredClone(base), id: 'milestone-open', title: '剩余开发', status: 'open' },
    { ...structuredClone(base), id: 'milestone-kept', title: '未引用阶段', status: 'open' }
  ];
  for (const task of state.tasks) task.milestoneId = ['t1', 't6'].includes(task.id) ? 'milestone-locked' : ['t2', 't3'].includes(task.id) ? 'milestone-open' : 'milestone-kept';
  const proof = structuredClone(state.tasks.find(item => item.id === 't4'));
  Object.assign(proof, { id: 'proof-task', code: 'CB-107', title: '已有成果但仍在推进', milestoneId: 'milestone-locked', dependsOn: [], artifacts: [{ id: 'proof-artifact', name: '成果', note: '不应进入模型上下文的成果内容', createdAt: base.createdAt }] });
  const accepted = structuredClone(state.tasks.find(item => item.id === 't3'));
  Object.assign(accepted, { id: 'accepted-task', code: 'CB-108', title: '已有接收时间', milestoneId: 'milestone-locked', dependsOn: [], acceptedAt: '2026-10-20T12:00:00.000Z' });
  state.tasks.push(proof, accepted);
  return state;
}
function draft(state = project()) {
  const remaining = state.tasks.find(item => item.id === 't3');
  const phase = state.milestones.find(item => item.id === 'milestone-open');
  return {
    title: '调整后续交付', summary: '更新一项剩余工作，并补充一个验证阶段。', projectGoal: '按新范围交付可核对的协作流程',
    assumptions: ['已验收成果不需要返工'], risks: ['新增验证需要成员协调'], questions: [],
    milestones: [
      { id: 'phase-existing', existingMilestoneId: phase.id, title: phase.title, goal: '按新范围完成后续开发', due: phase.due, acceptanceCriteria: phase.acceptanceCriteria },
      { id: 'phase-new', existingMilestoneId: '', title: '新增验证', goal: '核对新增工作', due: '2026-12-20', acceptanceCriteria: '交付一份验证结果，由接收人检查' }
    ],
    tasks: [
      { id: 'remaining-temp', existingTaskId: remaining.id, title: '完成调整后的联调', description: '根据变更对比推进，不覆盖原进展', ownerId: remaining.ownerId, reviewerId: 'm2', due: remaining.due, deliverable: '包含调整后流程的联调记录', dependsOn: ['t2'], milestoneId: 'phase-existing' },
      { id: 'new-temp', existingTaskId: '', title: '新增验证任务', description: '单独验证新范围', ownerId: 'm2', reviewerId: 'm1', due: '2026-11-20', deliverable: '验证记录与结论', dependsOn: ['remaining-temp'], milestoneId: 'phase-new' }
    ]
  };
}
const input = (state, value = draft(state)) => ({ actorId: 'm0', projectId: state.project.id, expectedRevision: state.revision, draft: value });
const errorStatus = (code, pattern) => error => error.status === code && (!pattern || pattern.test(error.message));

test('preview is pure, maps references to business IDs, and reports the exact fields subsequently applied', () => {
  const state = project(), original = structuredClone(state), value = draft(state), originalDraft = structuredClone(value);
  const preview = previewReplan(state, input(state, value));
  assert.deepEqual(state, original);
  assert.deepEqual(value, originalDraft);
  assert.deepEqual(preview, previewReplan(state, input(state, value)), 'preview IDs and differences must be stable');
  assert.deepEqual(preview.changes.counts, { newTasks: 1, updatedTasks: 1, newMilestones: 1, updatedMilestones: 1, protectedTasks: 4, protectedMilestones: 1, keptTasks: 7 });
  const updated = preview.changes.items.find(item => item.kind === 'task' && item.operation === 'update');
  assert.equal(updated.entityId, 't3');
  assert.ok(!updated.fields.some(item => ['dependsOn', 'milestoneId'].includes(item.field)), 'temporary aliases for unchanged references must not be shown as changes');
  const next = applyReplanDraft(state, input(state, value));
  assert.equal(next.revision, state.revision + 1);
  assert.deepEqual(next.activities[0].changes, preview.changes);
  for (const item of preview.changes.items) {
    const collection = item.kind === 'task' ? 'tasks' : 'milestones';
    const before = item.kind === 'project' ? state.project : state[collection].find(value => value.id === item.entityId);
    const after = item.kind === 'project' ? next.project : next[collection].find(value => value.id === item.entityId);
    for (const field of item.fields) {
      assert.deepEqual(field.before, item.operation === 'create' ? null : before[field.field]);
      assert.deepEqual(field.after, after[field.field], item.kind + ':' + field.field);
    }
  }
});

test('apply preserves protected objects, untouched records, ongoing state, blockers and history', () => {
  const state = project(), next = applyReplanDraft(state, input(state));
  for (const id of ['t1', 't6', 'proof-task', 'accepted-task', 't2', 't4', 't5']) {
    assert.deepEqual(next.tasks.find(item => item.id === id), state.tasks.find(item => item.id === id), id);
  }
  for (const id of ['milestone-locked', 'milestone-kept']) assert.deepEqual(next.milestones.find(item => item.id === id), state.milestones.find(item => item.id === id));
  const old = state.tasks.find(item => item.id === 't3'), changed = next.tasks.find(item => item.id === 't3');
  for (const field of ['id', 'code', 'status', 'blocker', 'artifacts', 'acceptedAt', 'priority', 'tags']) assert.deepEqual(changed[field], old[field]);
  assert.notEqual(changed.updatedAt, old.updatedAt);
  assert.deepEqual(next.activities.slice(1), state.activities);
  const added = next.tasks.find(item => !state.tasks.some(old => old.id === item.id));
  assert.equal(added.status, 'todo');
  assert.deepEqual(added.dependsOn, ['t3']);
  assert.equal(added.artifacts.length, 0);
});

test('explicit empty existing IDs create work even if its title matches a protected or untouched task', () => {
  const state = project(), value = draft(state);
  value.tasks[1].title = state.tasks.find(item => item.id === 't1').title;
  const next = applyReplanDraft(state, input(state, value));
  assert.equal(next.tasks.filter(item => item.title === value.tasks[1].title).length, 2);
  assert.deepEqual(next.tasks.find(item => item.id === 't1'), state.tasks.find(item => item.id === 't1'));
});

test('unchanged references do not manufacture an update and a no-op cannot write a new revision', () => {
  const state = project(), task = state.tasks.find(item => item.id === 't3'), phase = state.milestones.find(item => item.id === task.milestoneId);
  const value = {
    title: '保持现有计划', summary: '没有实质变化', projectGoal: state.project.goal, assumptions: [], risks: [], questions: [],
    milestones: [{ id: 'alias-phase', existingMilestoneId: phase.id, title: phase.title, goal: phase.goal, due: phase.due, acceptanceCriteria: phase.acceptanceCriteria }],
    tasks: [{ id: 'alias-task', existingTaskId: task.id, title: task.title, description: task.description, ownerId: task.ownerId, reviewerId: task.reviewerId, due: task.due, deliverable: task.deliverable, dependsOn: task.dependsOn, milestoneId: 'alias-phase' }]
  };
  assert.deepEqual(previewReplan(state, input(state, value)).changes.items, []);
  assert.throws(() => applyReplanDraft(state, input(state, value)), errorStatus(400, /没有实际变更/));
});

test('goal-only replanning does not implicitly clear tasks or milestones', () => {
  const state = project(), value = draft(state);
  value.tasks = []; value.milestones = [];
  const next = applyReplanDraft(state, input(state, value));
  assert.equal(next.project.goal, value.projectGoal);
  assert.deepEqual(next.tasks, state.tasks);
  assert.deepEqual(next.milestones, state.milestones);
  assert.equal(previewReplan(state, input(state, value)).changes.items.length, 1);
});

test('protection, foreign mappings, duplicate matches and ambiguous reference namespaces reject atomically', () => {
  const cases = [
    ['done task', value => { value.tasks[0].existingTaskId = 't1'; }],
    ['review task', value => { value.tasks[0].existingTaskId = 't6'; }],
    ['artifact task', value => { value.tasks[0].existingTaskId = 'proof-task'; }],
    ['accepted task', value => { value.tasks[0].existingTaskId = 'accepted-task'; }],
    ['protected milestone', value => { value.milestones[0].existingMilestoneId = 'milestone-locked'; }],
    ['insert into protected milestone', value => { value.tasks[1].milestoneId = 'milestone-locked'; }],
    ['move to protected milestone', value => { value.tasks[0].milestoneId = 'milestone-locked'; }],
    ['foreign old task', value => { value.tasks[0].existingTaskId = 'another-project-task'; }],
    ['foreign old milestone', value => { value.milestones[0].existingMilestoneId = 'another-project-phase'; }],
    ['foreign predecessor', value => { value.tasks[0].dependsOn = ['another-project-task']; }],
    ['duplicate task match', value => { value.tasks[1].existingTaskId = 't3'; }],
    ['duplicate milestone match', value => { value.milestones[1].existingMilestoneId = 'milestone-open'; }],
    ['ambiguous task alias', value => { value.tasks[0].id = 't2'; }],
    ['ambiguous phase alias', value => { value.milestones[0].id = 'milestone-kept'; }],
    ['unknown field', value => { value.tasks[0].status = 'done'; }]
  ];
  for (const [label, change] of cases) {
    const state = project(), original = structuredClone(state), value = draft(state);
    change(value);
    assert.throws(() => applyReplanDraft(state, input(state, value)), errorStatus(400), label);
    assert.deepEqual(state, original, label);
  }
});

test('a remaining task already in a protected milestone may keep its membership without modifying that milestone', () => {
  const state = project();
  state.tasks.find(item => item.id === 't3').milestoneId = 'milestone-locked';
  const value = draft(state);
  value.milestones = value.milestones.filter(item => !item.existingMilestoneId);
  value.tasks[0].milestoneId = 'milestone-locked';
  const next = applyReplanDraft(state, input(state, value));
  assert.deepEqual(next.milestones.find(item => item.id === 'milestone-locked'), state.milestones.find(item => item.id === 'milestone-locked'));
  assert.equal(next.tasks.find(item => item.id === 't3').title, value.tasks[0].title);
});

test('existing project dependencies and deadlines are checked after all changes, including untouched work', () => {
  const state = project();
  let value = draft(state);
  value.tasks[0].dependsOn = ['remaining-temp'];
  assert.throws(() => previewReplan(state, input(state, value)), errorStatus(400, /循环/));
  value = draft(state);
  value.tasks[0].dependsOn = ['t5']; value.tasks[0].due = '2026-10-26';
  assert.throws(() => previewReplan(state, input(state, value)), errorStatus(400, /循环/));
  value = draft(state);
  value.tasks[0].due = '2026-10-27';
  assert.throws(() => previewReplan(state, input(state, value)), errorStatus(400, /前置任务/), 'an untouched dependent cannot silently end before its changed predecessor');
  value = draft(state);
  value.tasks[1].due = '2026-12-21';
  assert.throws(() => previewReplan(state, input(state, value)), errorStatus(400, /所属里程碑/));
  value = draft(state);
  value.tasks[1].due = '2027-01-01';
  assert.throws(() => previewReplan(state, input(state, value)), errorStatus(400, /项目截止/));
});

test('mixed draft and business references resolve to the same IDs used during application', () => {
  const state = project(), value = draft(state);
  value.tasks[1].dependsOn = ['remaining-temp', 't1'];
  const preview = previewReplan(state, input(state, value));
  const added = preview.changes.items.find(item => item.kind === 'task' && item.operation === 'create');
  assert.deepEqual(added.fields.find(item => item.field === 'dependsOn').after, ['t3', 't1']);
  const next = applyReplanDraft(state, input(state, value));
  assert.deepEqual(next.tasks.find(item => item.id === added.entityId).dependsOn, ['t3', 't1']);
  value.tasks[1].dependsOn = ['remaining-temp', 't3'];
  assert.throws(() => previewReplan(state, input(state, value)), errorStatus(400, /映射后重复/));
});

test('management and version checks guard both preview and apply without accepting client privilege flags', () => {
  const state = project(), value = draft(state);
  const stale = { ...input(state, value), expectedRevision: state.revision + 1 };
  assert.throws(() => previewReplan(state, stale), errorStatus(409));
  assert.throws(() => applyReplanDraft(state, stale), errorStatus(409));
  assert.throws(() => previewReplan(state, { ...input(state), manageProject: true }), errorStatus(400));
  state.members = state.members.map(item => ({ ...item, accessRole: item.id === 'm2' ? 'admin' : 'member' }));
  assert.throws(() => previewReplan(state, input(state)), errorStatus(403));
  assert.ok(previewReplan(state, { ...input(state), actorId: 'm2' }).changes.items.length > 0);
});

function configure(t, values) {
  const previous = new Map(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function fixture(t, reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply(body)) } }] }));
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
}
function config(baseUrl, extra = {}) {
  return { COBUILD_AI_BASE_URL: baseUrl, COBUILD_AI_API_KEY: 'replan-local-fixture', COBUILD_AI_MODEL: 'deepseek-flash', COBUILD_AI_TIMEOUT_MS: '3000', ...extra };
}

test('optional thinking mode accepts explicit enabled/disabled only and has no implicit provider parameter', t => {
  configure(t, config('https://example.invalid'));
  assert.equal(aiStatus().configured, true);
  for (const value of ['enabled', 'disabled']) { process.env.COBUILD_AI_THINKING = value; assert.equal(aiStatus().configured, true); }
  for (const value of ['', ' ', '\t']) { process.env.COBUILD_AI_THINKING = value; assert.equal(aiStatus().configured, true); }
  for (const value of ['auto', 'true', 'off']) { process.env.COBUILD_AI_THINKING = value; assert.equal(aiStatus().configured, false); }
});

test('blank optional thinking configuration is omitted from provider requests', async t => {
  const state = project(), service = await fixture(t, () => draft(state));
  configure(t, config(service.baseUrl, { COBUILD_AI_THINKING: '  ' }));
  assert.equal(aiStatus().configured, true);
  await generateReplan(state, { goal: '调整后续范围' });
  assert.equal('thinking' in service.requests[0], false);
});

test('local compatibility fixture receives json_object, max_tokens and explicit disabled thinking for replanning', async t => {
  const state = project(), before = structuredClone(state), service = await fixture(t, () => draft(state));
  configure(t, config(service.baseUrl, { COBUILD_AI_RESPONSE_FORMAT: 'json_object', COBUILD_AI_TOKEN_PARAMETER: 'max_tokens', COBUILD_AI_THINKING: 'disabled', COBUILD_AI_MAX_TOKENS: '6000' }));
  const generated = await generateReplan(state, { goal: '调整后续范围', deadline: state.project.deadline, scope: '仅剩余任务', constraints: '保留原成果' });
  assert.deepEqual(state, before);
  assert.equal(generated.model, 'deepseek-flash');
  assert.deepEqual(generated.changes, previewReplan(state, input(state, generated.draft)).changes);
  const request = service.requests[0], context = JSON.parse(request.messages[1].content).context;
  assert.equal(request.model, 'deepseek-flash');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.max_tokens, 6000);
  assert.equal('max_completion_tokens' in request, false);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.ok(context.editableTaskIds.includes('t3'));
  assert.ok(context.protectedTaskIds.includes('t1'));
  assert.ok(context.protectedMilestoneIds.includes('milestone-locked'));
  assert.equal(context.existingTasks.find(item => item.id === 'proof-task').artifactCount, 1);
  assert.ok(!JSON.stringify(context).includes('不应进入模型上下文的成果内容'));
});

test('structured replan schema requires explicit existing IDs and rejects protected model edits', async t => {
  const state = project(), value = draft(state), service = await fixture(t, () => value);
  configure(t, config(service.baseUrl));
  await generateReplan(state, { goal: '调整后续范围' });
  const schema = service.requests[0].response_format.json_schema.schema;
  assert.ok(schema.required.includes('projectGoal'));
  assert.ok(schema.properties.tasks.items.required.includes('existingTaskId'));
  assert.ok(schema.properties.milestones.items.required.includes('existingMilestoneId'));
  value.tasks[0].existingTaskId = 't1';
  const before = structuredClone(state);
  await assert.rejects(generateReplan(state, { goal: '尝试改已完成项' }), errorStatus(502, /草案校验未通过/));
  assert.deepEqual(state, before);
});
