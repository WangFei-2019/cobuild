import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../domain.mjs';
import { applyPlanDraft, applyReplanDraft } from '../planning.mjs';
import { buildPlanningPrompt, importPlanningDraft, MAX_IMPORT_BYTES, PLANNING_EXCHANGE_FORMAT } from '../ai-exchange.mjs';

function project() { const state = seedState(); state.project.deadline = '2026-12-31'; return state; }
function initialDraft() {
  return { title: '外部草案：交付与核对', summary: '用户自选AI返回的草案，仅导入和校验，不自动执行。', assumptions: [], risks: ['需要人工核对内容'], questions: [],
    milestones: [{ id: 'draft-phase', title: '可核对交付', goal: '提供可检查成果', due: '2026-11-20', acceptanceCriteria: '成果已由指定接收人核对' }],
    tasks: [{ id: 'draft-first', title: '准备交付说明', description: '', ownerId: 'm2', reviewerId: 'm3', due: '2026-11-15', deliverable: '交付说明与检查步骤', dependsOn: [], milestoneId: 'draft-phase' },
      { id: 'draft-second', title: '核对交付流程', description: '', ownerId: 'm3', reviewerId: 'm2', due: '2026-11-18', deliverable: '核对记录', dependsOn: ['draft-first'], milestoneId: 'draft-phase' }] };
}
function remainingProject() {
  const state = project();
  state.milestones = [
    { id: 'locked', title: '已验收阶段', goal: '完成首版范围', due: '2026-10-21', acceptanceCriteria: '原成果已核对', status: 'accepted', acceptedAt: '2026-10-21T10:00:00Z', acceptedBy: 'm0', acceptanceNote: '保留原确认' },
    { id: 'remaining', title: '剩余交付', goal: '完成后续工作', due: '2026-11-20', acceptanceCriteria: '剩余成果交接', status: 'open' },
    { id: 'review-phase', title: '已有成果待确认', goal: '检查反馈', due: '2026-11-20', acceptanceCriteria: '反馈可核对', status: 'open' }
  ];
  for (const task of state.tasks) task.milestoneId = task.id === 't1' ? 'locked' : task.id === 't6' ? 'review-phase' : 'remaining';
  return state;
}
function remainingDraft(state) {
  const original = state.tasks.find(task => task.id === 't2');
  return { title: '外部调整草案', summary: '保留既有成果，补充剩余交付要求。', projectGoal: '完成后续交付并保留已验收结果', assumptions: [], risks: [], questions: [],
    milestones: [{ id: 'phase-alias', existingMilestoneId: 'remaining', title: '剩余交付与检查', goal: '完成后续工作', due: '2026-11-20', acceptanceCriteria: '剩余成果交接' }],
    tasks: [{ id: 'work-alias', existingTaskId: original.id, title: original.title, description: original.description, ownerId: original.ownerId, reviewerId: original.reviewerId,
      due: original.due, deliverable: '接口说明及错误响应检查清单', dependsOn: original.dependsOn, milestoneId: 'phase-alias' }] };
}
const options = mode => ({ mode, actorId: 'm0' });
const exchange = (state, draft, mode = 'initial', patch = {}) => JSON.stringify({ format: PLANNING_EXCHANGE_FORMAT, projectId: state.project.id, baseRevision: state.revision, mode, draft, ...patch });

test('初始JSON与单个json围栏可导入并严格正规化，确认应用前不改项目也不调用模型', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('import must not fetch'); });
  const state = project(), before = structuredClone(state), raw = initialDraft(); raw.title = `  ${raw.title}  `;
  const result = importPlanningDraft(state, exchange(state, raw), options('initial'));
  assert.equal(result.draft.title, raw.title.trim()); assert.equal(result.baseRevision, state.revision);
  assert.deepEqual(importPlanningDraft(state, '```json\n' + exchange(state, raw) + '\n```', options('initial')), result);
  assert.deepEqual(state, before);
  const applied = applyPlanDraft(state, { actorId: 'm0', expectedRevision: result.baseRevision, draft: result.draft });
  assert.equal(applied.tasks.length, state.tasks.length + 2);
  const added = applied.tasks.slice(-2);
  assert.deepEqual(added[1].dependsOn, [added[0].id]); assert.notEqual(added[0].id, raw.tasks[0].id);
  assert.deepEqual(state, before);
});

test('初始导入拒绝未知成员、非法日期、未知关联与循环依赖，均不改原状态', () => {
  const state = project(), before = structuredClone(state);
  const changes = [draft => { draft.tasks[0].ownerId = 'not-a-member'; }, draft => { draft.tasks[0].due = '2026-02-30'; },
    draft => { draft.tasks[0].milestoneId = 'foreign-phase'; }, draft => { draft.tasks[0].dependsOn = ['t1']; },
    draft => { draft.tasks[0].dependsOn = ['draft-second']; }, draft => { draft.tasks[0].due = '2027-01-01'; }];
  for (const change of changes) {
    const draft = initialDraft(); change(draft);
    assert.throws(() => importPlanningDraft(state, exchange(state, draft), options('initial')), error => error.status === 400 || error.status === 403);
    assert.deepEqual(state, before);
  }
});

test('真实剩余草案导入仅作预览，应用保留保护任务/阶段，重复旧版本409', () => {
  const state = remainingProject(), before = structuredClone(state), raw = remainingDraft(state);
  const result = importPlanningDraft(state, exchange(state, raw, 'replan'), options('replan'));
  assert.equal(result.baseRevision, state.revision); assert.equal(result.changes.counts.updatedTasks, 1);
  assert.deepEqual(state, before);
  const applied = applyReplanDraft(state, { actorId: 'm0', expectedRevision: result.baseRevision, draft: result.draft });
  assert.deepEqual(applied.tasks.find(task => task.id === 't1'), before.tasks.find(task => task.id === 't1'));
  assert.deepEqual(applied.tasks.find(task => task.id === 't6'), before.tasks.find(task => task.id === 't6'));
  assert.deepEqual(applied.milestones.find(item => item.id === 'locked'), before.milestones.find(item => item.id === 'locked'));
  assert.throws(() => importPlanningDraft(applied, exchange(state, raw, 'replan'), { ...options('replan'), expectedRevision: result.baseRevision }), error => error.status === 409);
});

test('剩余导入拒绝保护项、跨项目ID、新任务迁入保护阶段及与旧后置任务相反的日期', () => {
  const state = remainingProject(), before = structuredClone(state);
  const changes = [draft => { draft.tasks[0].existingTaskId = 't1'; }, draft => { draft.milestones[0].existingMilestoneId = 'locked'; },
    draft => { draft.tasks[0].existingTaskId = 'foreign-task'; }, draft => { draft.tasks[0].existingTaskId = ''; draft.tasks[0].milestoneId = 'locked'; },
    draft => { draft.tasks[0].due = '2026-10-25'; }];
  for (const change of changes) {
    const draft = remainingDraft(state); change(draft);
    assert.throws(() => importPlanningDraft(state, exchange(state, draft, 'replan'), options('replan')), error => error.status === 400);
    assert.deepEqual(state, before);
  }
});

test('导入不执行文本，拒额外解释/多代码块/危险结构/超限UTF-8，保护输入对象', () => {
  const state = project(), before = structuredClone(state), source = exchange(state, initialDraft());
  for (const invalid of [`说明如下\n${source}`, '```json\n' + source + '\n```\n后续说明', '```json\n' + source + '\n```\n```json\n{}\n```',
    '[]', '{"__proto__":{"polluted":true}}', '{"title":{"constructor":{"prototype":{"polluted":true}}}}', '```javascript\n' + source + '\n```']) {
    assert.throws(() => importPlanningDraft(state, invalid, options('initial')), error => error.status === 400);
  }
  const large = initialDraft(); large.summary = '字'.repeat(45000); const encoded = exchange(state, large);
  assert.ok(encoded.length < MAX_IMPORT_BYTES);
  assert.throws(() => importPlanningDraft(state, encoded, options('initial')), error => error.status === 413);
  const inert = initialDraft(); inert.summary = '<script>globalThis.__cobuildImportExecuted = true</script>';
  assert.equal(importPlanningDraft(state, exchange(state, inert), options('initial')).draft.summary, inert.summary);
  assert.equal(globalThis.__cobuildImportExecuted, undefined); assert.equal({}.polluted, undefined);
  assert.deepEqual(state, before);
});

test('导入遵守当前真实成员管理权限，支持工作区管理员的有效管理权限但不冒充其他人', () => {
  const state = project(); state.currentMemberId = 'm2'; state.members = state.members.map(member => ({ ...member, accessRole: 'member' }));
  state.permissions = { manageProject: false, createTask: true, readOnly: false };
  assert.throws(() => importPlanningDraft(state, exchange(state, initialDraft())), error => error.status === 403);
  state.permissions.manageProject = true;
  const before = structuredClone(state);
  assert.equal(importPlanningDraft(state, exchange(state, initialDraft())).baseRevision, state.revision);
  assert.throws(() => importPlanningDraft(state, exchange(state, initialDraft()), { actorId: 'm0' }), error => error.status === 403);
  assert.deepEqual(state, before);
});

test('AI交换提示只输出白名单事实与准确关联规则，省略成果正文、凭据及额外资料', () => {
  const state = remainingProject(), before = structuredClone(state);
  state.project.description = '资料 https://user:private-password@example.test/path?token=private-query api_key=private-key';
  state.project.apiKey = 'private-project-config'; state.members[0].email = 'private-mail@example.test';
  state.tasks[0].artifacts[0].note = 'private-artifact-body'; state.tasks[0].artifacts[0].base64 = 'private-file-content';
  const result = buildPlanningPrompt(state, { mode: 'replan', today: '2026-10-21', request: { goal: '调整剩余范围', apiKey: 'private-request-key' } });
  for (const secret of ['private-password', 'private-query', 'private-key', 'private-project-config', 'private-mail', 'private-artifact-body', 'private-file-content', 'private-request-key']) assert.ok(!result.includes(secret), secret);
  for (const required of [PLANNING_EXCHANGE_FORMAT, 'existingTaskId', 'existingMilestoneId', 'protectedTaskIds', 'editableTaskIds', 'protectedMilestoneIds', 'baseRevision', '未引用', '不晚于后续任务', '120KiB']) assert.ok(result.includes(required), required);
  const schema = JSON.parse(result.split('返回交换信封JSON Schema：\n')[1]);
  assert.equal(schema.properties.format.const, PLANNING_EXCHANGE_FORMAT);
  assert.equal(schema.properties.projectId.const, state.project.id);
  assert.equal(schema.properties.baseRevision.const, state.revision);
  assert.equal(schema.properties.mode.const, 'replan');
  assert.ok(schema.properties.draft.properties.tasks.items.required.includes('existingTaskId'));
  assert.ok(result.includes('t1')); assert.ok(result.includes('m2')); assert.ok(result.includes('locked'));
  assert.throws(() => buildPlanningPrompt(state, { mode: 'other' }), error => error.status === 400);
  assert.throws(() => buildPlanningPrompt(state, { today: '2026-02-30' }), error => error.status === 400);
  // The exporter only reads state; injected private values above are retained locally.
  assert.equal(state.project.apiKey, 'private-project-config'); assert.deepEqual(state.tasks[1], before.tasks[1]);
});

test('交换信封拒绝裸草案、跨项目、错误模式和未知版本，过期来源不能用当前窗口版本覆盖', () => {
  const state = project(); state.revision = 4;
  const before = structuredClone(state), draft = initialDraft();
  assert.throws(() => importPlanningDraft(state, JSON.stringify(draft), options('initial')), error => error.status === 400 && /交换信封/.test(error.message));
  for (const patch of [{ format: 'unknown-format' }, { projectId: 'another-project' }, { mode: 'replan' }, { mode: undefined },
    { baseRevision: undefined }, { baseRevision: null }, { baseRevision: '4' }, { baseRevision: 0 }, { baseRevision: 1.5 }, { unexpected: true }]) {
    assert.throws(() => importPlanningDraft(state, exchange(state, draft, 'initial', patch), options('initial')), error => error.status === 400);
    assert.deepEqual(state, before);
  }
  for (const baseRevision of [3, 5]) {
    assert.throws(() => importPlanningDraft(state, exchange(state, draft, 'initial', { baseRevision }), { ...options('initial'), expectedRevision: state.revision }),
      error => error.status === 409 && /来源版本/.test(error.message) && /重新导出/.test(error.message));
    assert.deepEqual(state, before);
  }
  const current = importPlanningDraft(state, exchange(state, draft), options('initial'));
  assert.equal(current.baseRevision, 4);
  assert.deepEqual(Object.keys(current.draft).sort(), ['title', 'summary', 'assumptions', 'risks', 'questions', 'milestones', 'tasks'].sort());
  assert.equal(Object.hasOwn(current.draft, 'format'), false);
  assert.equal(Object.hasOwn(current.draft, 'baseRevision'), false);
  assert.throws(() => importPlanningDraft(state, exchange(state, draft), { ...options('initial'), expectedRevision: 3 }), error => error.status === 409);
  assert.deepEqual(state, before);
});
