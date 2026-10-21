import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState, applyAction, analyzeUpdate, projectReport} from '../domain.mjs';

test('报告完成不等于交付，规则只建议、不修改项目', () => {
  const state = seedState();
  const before = structuredClone(state);
  const result = analyzeUpdate(state, {actorId:'m2',taskId:'t2',text:'接口已经完成了，可以验收。'});
  assert.equal(result.mode, 'local-rules');
  assert.equal(result.status, 'doing');
  assert.ok(result.missing.some(v => v.includes('尚未提交')));
  assert.deepEqual(result.affectedTaskIds, ['t3']);
  assert.deepEqual(state, before);
  assert.throws(() => applyAction(state, {type:'setStatus',actorId:'m2',taskId:'t2',status:'done'}), /接收人确认/);
  assert.throws(() => applyAction(state, {type:'setStatus',actorId:'m2',taskId:'t2',status:'review'}), /提交交付物/);
});

test('否定、部分完成与计划表达不会误判为已交付', () => {
  const state = seedState();
  for (const text of ['还没完成，今天继续处理', '完成了80%，还在补充文档', '完成50%', '预计明天完成', '尚未做好接口说明']) {
    const value = analyzeUpdate(state, {actorId:'m2',taskId:'t2',text});
    assert.notEqual(value.status, 'review', text);
    assert.deepEqual(value.missing, [], text);
  }
  const value = analyzeUpdate(state, {actorId:'m3',taskId:'t3',text:'等待接口字段确认，现在无法继续联调。'});
  assert.equal(value.status, 'blocked');
  assert.ok(value.blocker.includes('等待接口字段'));
  assert.deepEqual(value.affectedTaskIds, ['t5']);
  for (const text of ['接口已经受阻，无法继续。', '已解决一部分，但仍在等待接口。']) {
    assert.equal(analyzeUpdate(state,{actorId:'m3',taskId:'t3',text}).status,'blocked',text);
  }
  assert.equal(analyzeUpdate(state,{actorId:'m3',taskId:'t3',text:'不用等接口了，可以继续开发。'}).status,'doing');
});

test('交付约定或接收人变化，不套用旧的交接确认', () => {
  let state = seedState();
  state = applyAction(state,{type:'updateTask',actorId:'m1',taskId:'t1',patch:{deliverable:'新增移动端完整实现'}});
  let t = state.tasks.find(t=>t.id==='t1');
  assert.equal(t.status,'doing');
  assert.equal(t.acceptedAt,'');
  assert.throws(()=>applyAction(state,{type:'setStatus',actorId:'m1',taskId:'t1',status:'review'}),/重新提交/);
  state = applyAction(state,{type:'submitArtifact',actorId:'m1',taskId:'t1',name:'移动端实现',note:'符合新约定的成果说明。'});
  state = applyAction(state,{type:'accept',actorId:'m0',taskId:'t1'});
  state = applyAction(state,{type:'updateTask',actorId:'m0',taskId:'t1',patch:{reviewerId:'m3'}});
  t = state.tasks.find(t=>t.id==='t1');
  assert.equal(t.status,'review');
  assert.equal(t.acceptedAt,'');
});

test('完整交接：提交、不能越权接收、退回、重提、接收', () => {
  let state = seedState();
  state = applyAction(state, {type:'submitArtifact',actorId:'m2',taskId:'t2',name:'接口说明 v1',note:'任务字段与示例已经整理在这里。'});
  assert.equal(state.tasks.find(t => t.id==='t2').status, 'review');
  assert.throws(() => applyAction(state, {type:'accept',actorId:'m0',taskId:'t2'}), /只有约定接收人/);
  assert.throws(() => applyAction(state, {type:'accept',actorId:'m2',taskId:'t2'}), /只有约定接收人/);
  state = applyAction(state, {type:'requestChanges',actorId:'m3',taskId:'t2',reason:'请补充错误响应和示例 JSON。'});
  assert.equal(state.tasks.find(t => t.id==='t2').status, 'doing');
  assert.ok(state.activities[0].text.includes('错误响应'));
  state = applyAction(state, {type:'submitArtifact',actorId:'m2',taskId:'t2',name:'接口说明 v2',url:'https://example.com/docs',note:'补充错误响应及 JSON。'});
  state = applyAction(state, {type:'accept',actorId:'m3',taskId:'t2'});
  const t = state.tasks.find(t => t.id==='t2');
  assert.equal(t.status, 'done');
  assert.equal(t.artifacts.length, 2);
  assert.ok(t.acceptedAt);
  assert.throws(() => applyAction(state, {type:'accept',actorId:'m3',taskId:'t2'}), /尚未提交可接收/);
  assert.equal(seedState().revision, 1);
});

test('任务操作的角色与输入检查', () => {
  const state = seedState();
  assert.throws(() => applyAction(state, {type:'addUpdate',actorId:'m1',taskId:'t2',text:'我替别人更新'}), /任务负责人/);
  assert.throws(() => applyAction(state, {type:'submitArtifact',actorId:'m2',taskId:'t2',name:'测试',url:'javascript:alert(1)'}), /http/);
  assert.throws(() => applyAction(state, {type:'submitArtifact',actorId:'m2',taskId:'t2',name:'测试',url:'https://user:secret@example.com/'}), /有效/);
  assert.throws(() => applyAction(state, {type:'setStatus',actorId:'m2',taskId:'t2',status:'blocked'}), /受阻原因/);
  assert.throws(() => applyAction(state, {type:'addUpdate',actorId:'nobody',taskId:'t2',text:'test'}), /有效团队成员/);
  assert.throws(() => applyAction(state, {type:'updateTask',actorId:'m2',taskId:'t2',patch:{status:'done'}}), /不支持修改/);
  assert.throws(() => analyzeUpdate(state, null), /格式/);
});

test('依赖不能成环，日期有效，创建任务有明确交付约定', () => {
  let state = seedState();
  assert.throws(() => applyAction(state, {type:'updateTask',actorId:'m0',taskId:'t1',patch:{dependsOn:['t3']}}), /循环依赖/);
  assert.throws(() => applyAction(state, {type:'updateTask',actorId:'m2',taskId:'t2',patch:{dependsOn:['t2']}}), /依赖自己/);
  const input = {type:'createTask',actorId:'m0',title:'新任务',ownerId:'m1',reviewerId:'m2',deliverable:'交付一份测试报告',due:'2026-10-23',dependsOn:['t1']};
  assert.throws(() => applyAction(state, {...input,due:'2026-02-30'}), /有效日期/);
  assert.throws(() => applyAction(state, {...input,deliverable:''}), /交付约定/);
  state = applyAction(state, input);
  assert.equal(state.tasks.at(-1).code, 'CB-107');
  assert.equal(state.tasks.at(-1).status, 'todo');
});

test('手动日期变更不能破坏项目、前后置任务或里程碑约束，失败不改原任务', () => {
  const state = seedState(), before = structuredClone(state);
  const create = { type: 'createTask', actorId: 'm0', title: '手动计划', ownerId: 'm1', reviewerId: 'm2', deliverable: '明确成果' };
  assert.throws(() => applyAction(state, { ...create, due: '2026-10-28' }), /项目截止/);
  assert.throws(() => applyAction(state, { ...create, due: '2026-10-21', dependsOn: ['t2'] }), /前置任务/);
  assert.throws(() => applyAction(state, { ...create, dependsOn: ['t2'] }), /截止日期/);
  assert.throws(() => applyAction(state, { ...create, due: false }), /日期格式/);
  assert.throws(() => applyAction(state, { type: 'updateTask', actorId: 'm0', taskId: 't2', patch: { due: '2026-10-25' } }), /后置任务/);
  assert.throws(() => applyAction(state, { type: 'updateTask', actorId: 'm0', taskId: 't3', patch: { due: '2026-10-21' } }), /前置任务/);
  assert.throws(() => applyAction(state, { type: 'updateTask', actorId: 'm0', taskId: 't2', patch: { due: '' } }), /明确截止日期/);
  assert.throws(() => applyAction(state, { type: 'updateProject', actorId: 'm0', patch: { deadline: '2026-10-23' } }), /现有任务或里程碑/);
  const withMilestone = structuredClone(state);
  withMilestone.milestones = [{ id: 'phase', title: '阶段', due: '2026-10-20' }];
  assert.throws(() => applyAction(withMilestone, { type: 'updateTask', actorId: 'm0', taskId: 't2', patch: { milestoneId: 'phase' } }), /所属里程碑/);
  assert.deepEqual(state, before);
});

test('历史空日期和不一致计划仍可编辑无关字段，新依赖不能利用空日期绕过校验', () => {
  const state = seedState(); state.project.deadline = '2026-10-01'; state.tasks[1].due = '';
  state.tasks[1].milestoneId = 'legacy-phase'; state.milestones = [{ id: 'legacy-phase', due: '2026-09-30' }];
  const result = applyAction(state, { type: 'updateTask', actorId: 'm2', taskId: 't2', patch: { title: '只修改名称' } });
  const original = state.tasks[1], updated = result.tasks[1];
  assert.deepEqual({ ...updated, title: original.title, updatedAt: original.updatedAt }, original);
  assert.deepEqual(result.tasks.filter(value => value.id !== 't2'), state.tasks.filter(value => value.id !== 't2'));
  assert.equal(applyAction(state, { type: 'updateProject', actorId: 'm0', patch: { description: '仅补充背景' } }).project.deadline, '2026-10-01');
  state.project.deadline = '';
  assert.throws(() => applyAction(state, { type: 'createTask', actorId: 'm0', title: '新依赖', ownerId: 'm0', reviewerId: 'm1',
    due: '2026-10-26', dependsOn: ['t2'], deliverable: '成果' }), /相关任务填写截止日期/);
  const independent = applyAction(state, { type: 'createTask', actorId: 'm0', title: '暂未排期', ownerId: 'm0', reviewerId: 'm1', deliverable: '成果' });
  assert.equal(independent.tasks.at(-1).due, '');
});

test('新增成员、项目约定、冲突检查和原文保留', () => {
  let state = seedState();
  assert.throws(() => applyAction(state, {type:'addMember',actorId:'m1',name:'新成员'}), /发起人/);
  state = applyAction(state, {type:'addMember',actorId:'m0',name:'赵可',role:'体验测试'});
  assert.equal(state.members.at(-1).name, '赵可');
  const revision = state.revision;
  assert.throws(() => applyAction(state, {type:'updateProject',actorId:'m0',patch:{goal:'新版目标'},expectedRevision:revision-1}), e => e.status===409);
  state = applyAction(state, {type:'updateProject',actorId:'m0',patch:{goal:'新版目标'},expectedRevision:revision});
  const raw = '看板完成了一部分，字段\n需要核对。';
  state = applyAction(state, {type:'addUpdate',actorId:'m3',taskId:'t3',text:raw});
  assert.equal(state.activities[0].text, raw);
  assert.ok(projectReport(state).includes('新版目标'));
  assert.ok(projectReport(state).includes('本地规则'));
});

test('并发保护：旧任务编辑不能覆盖已更新的日期，冲突保留最新数据', t => {
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,21,10)});
  let state = seedState();
  const displayed = structuredClone(state.tasks.find(task => task.id==='t2'));
  state = applyAction(state, {type:'updateTask',actorId:'m2',taskId:'t2',taskUpdatedAt:displayed.updatedAt,patch:{due:'2026-10-23'}});
  const latest = structuredClone(state);
  assert.notEqual(state.tasks.find(task => task.id==='t2').updatedAt,displayed.updatedAt);
  // The old form still contains the previous due date, along with a new description.
  assert.throws(() => applyAction(state, {type:'updateTask',actorId:'m2',taskId:'t2',taskUpdatedAt:displayed.updatedAt,patch:{due:displayed.due,description:'旧表单的说明'}}), error => error.status===409 && error.message==='任务已有更新，请核对最新内容后重新操作');
  assert.deepEqual(state,latest);
  assert.equal(state.tasks.find(task => task.id==='t2').due,'2026-10-23');
  // Refreshing the snapshot permits the edit without restoring the obsolete date.
  state = applyAction(state, {type:'updateTask',actorId:'m2',taskId:'t2',taskUpdatedAt:latest.tasks.find(task => task.id==='t2').updatedAt,patch:{description:'核对最新内容后的说明'}});
  assert.equal(state.tasks.find(task => task.id==='t2').due,'2026-10-23');
  assert.equal(state.tasks.find(task => task.id==='t2').description,'核对最新内容后的说明');
});

test('并发保护：旧成果快照不能接收或退回新版成果，最新快照才可交接', t => {
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,21,11)});
  let state = applyAction(seedState(), {type:'submitArtifact',actorId:'m2',taskId:'t2',name:'接口说明 v1',note:'第一版成果。'});
  const displayed = structuredClone(state.tasks.find(task => task.id==='t2'));
  t.mock.timers.tick(1000);
  state = applyAction(state, {type:'submitArtifact',actorId:'m2',taskId:'t2',taskUpdatedAt:displayed.updatedAt,name:'接口说明 v2',note:'负责人刚刚重新提交的成果。'});
  const latest = structuredClone(state);
  assert.notEqual(state.tasks.find(task => task.id==='t2').updatedAt,displayed.updatedAt);
  for (const action of [{type:'accept'},{type:'requestChanges',reason:'针对第一版的旧意见'}]) {
    assert.throws(() => applyAction(state, {...action,actorId:'m3',taskId:'t2',taskUpdatedAt:displayed.updatedAt}), error => error.status===409);
    assert.deepEqual(state,latest);
  }
  const pending = state.tasks.find(task => task.id==='t2');
  assert.equal(pending.status,'review');
  assert.equal(pending.artifacts[0].name,'接口说明 v2');
  assert.equal(pending.acceptedAt,'');
  state = applyAction(state, {type:'accept',actorId:'m3',taskId:'t2',taskUpdatedAt:pending.updatedAt});
  assert.equal(state.tasks.find(task => task.id==='t2').status,'done');
  assert.equal(state.tasks.find(task => task.id==='t2').artifacts[0].name,'接口说明 v2');
});

test('并发保护：新项目旧版本不能覆盖新简介，冲突不新增动态或修改目标', () => {
  const original = seedState();
  let state = {
    ...original,
    project:{id:'project-new',name:'空白新项目',description:'最初简介',goal:'',deadline:'',stage:'项目启动'},
    members:[original.members[0]],tasks:[],activities:[],decisions:[]
  };
  const displayedRevision = state.revision;
  state = applyAction(state, {type:'updateProject',actorId:'m0',expectedRevision:displayedRevision,patch:{description:'另一标签刚保存的新简介'}});
  const latest = structuredClone(state);
  assert.throws(() => applyAction(state, {type:'updateProject',actorId:'m0',expectedRevision:displayedRevision,patch:{description:'旧表单覆盖的简介',goal:'过时的目标'}}), error => error.status===409);
  assert.deepEqual(state,latest);
  assert.equal(state.project.description,'另一标签刚保存的新简介');
  assert.equal(state.project.goal,'');
  assert.equal(state.revision,displayedRevision+1);
  assert.equal(state.activities.length,1);
  state = applyAction(state, {type:'updateProject',actorId:'m0',expectedRevision:latest.revision,patch:{goal:'核对后补充的新目标'}});
  assert.equal(state.project.description,'另一标签刚保存的新简介');
  assert.equal(state.project.goal,'核对后补充的新目标');
});

test('任务可关联本项目里程碑，未知归属和超期修改均不写入状态', () => {
  let state = seedState();
  state.milestones = [{id:'phase-one',title:'第一轮交付',due:'2026-10-24'}];
  const input = {type:'createTask',actorId:'m0',title:'里程碑内任务',ownerId:'m1',reviewerId:'m2',deliverable:'可检查成果',due:'2026-10-23',milestoneId:'phase-one'};
  assert.throws(() => applyAction(state,{...input,milestoneId:'other-project-phase'}),error => error.status===400);
  assert.throws(() => applyAction(state,{...input,due:'2026-10-25'}),error => error.status===400);
  state = applyAction(state,input);
  const created = state.tasks.at(-1), original = structuredClone(state);
  assert.equal(created.milestoneId,'phase-one');
  assert.throws(() => applyAction(state,{type:'updateTask',actorId:'m0',taskId:created.id,patch:{due:'2026-10-25'}}),error => error.status===400);
  assert.deepEqual(state,original);
  state = applyAction(state,{type:'updateTask',actorId:'m0',taskId:created.id,patch:{milestoneId:'',due:'2026-10-25'}});
  assert.equal(state.tasks.at(-1).milestoneId,'');
});
