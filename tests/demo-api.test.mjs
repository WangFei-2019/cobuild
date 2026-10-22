import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoAPI, DEMO_MODEL, DEMO_STORAGE_KEY } from '../src/demo-api.js';

function memoryStorage() {
  const values = new Map([['unrelated-real-app-key', 'must stay untouched']]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const time = () => new Date('2030-03-01T16:30:00.000Z');
const taskInput = state => ({ projectId: state.project.id, type: 'createTask', title: '浏览器离线新增任务', ownerId: state.currentMemberId,
  reviewerId: state.currentMemberId, deliverable: '本地可检查成果' });

test('显式演示不请求服务，跨项目映射与相对日期完整，写入重载和未知项目隔离', async t => {
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { externalCalls++; throw new Error('demo must not fetch'); });
  const storage = memoryStorage(), demo = createDemoAPI({ storage, now: time });
  const session = await demo.request('/api/auth/session');
  assert.equal(session.demo, true); assert.equal(session.user.name, '演示体验者');
  const dashboard = await demo.request('/api/dashboard');
  assert.equal(dashboard.today, '2030-03-02');
  assert.deepEqual(dashboard.summary, { todo: 4, toReview: 1, blocked: 1, dueSoon: 4 });
  assert.equal(dashboard.sections.blocked[0].isOverdue, true);
  assert.ok(dashboard.sections.todo.some(task => task.status === 'doing'));
  assert.ok(dashboard.sections.todo.some(task => task.status === 'todo' && !task.isDueSoon && !task.isOverdue));
  const profile = await demo.request(`/api/people/${session.user.personId}`);
  assert.equal(profile.projects.length, 2);
  assert.equal(new Set(profile.projects.map(item => item.project.color)).size, 2);
  assert.equal(new Set(profile.projects.map(item => item.memberId)).size, 2);
  const unrelated = await demo.request('/api/dashboard?q=CB-105');
  assert.equal(unrelated.search.tasks[0].relation, null);
  const before = await demo.request('/api/state');
  assert.equal(before.milestones.find(item => item.id === 'demo-scope').status, 'accepted');
  const created = await demo.request('/api/projects', { name: '空白离线项目', description: '本地体验', goal: '' });
  assert.equal(created.state.tasks.length, 0);
  const updated = await demo.request('/api/action', taskInput(created.state));
  const reopened = createDemoAPI({ storage, now: () => new Date('2030-04-02T00:00:00Z') });
  assert.deepEqual(await reopened.request(`/api/state?projectId=${created.state.project.id}`), updated.state);
  assert.deepEqual(await reopened.request('/api/state'), before, 'reload must preserve original shifted dates rather than rebuilding the seed');
  const bytes = storage.values.get(DEMO_STORAGE_KEY);
  await assert.rejects(reopened.request('/api/action', { ...taskInput(created.state), projectId: 'missing' }), error => error.status === 404);
  await assert.rejects(reopened.request('/api/action', { ...taskInput(created.state), actorId: 'm0' }), error => error.status === 403);
  await assert.rejects(reopened.request('/api/invitations', { projectId: before.project.id }), error => error.status === 501 && error.code === 'DEMO_UNAVAILABLE');
  await assert.rejects(reopened.request('/api/auth/register', {}), error => error.status === 501);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY), bytes);
  assert.equal(externalCalls, 0);
});

test('演示提交与验收、附件Blob和报告导出离线可用，重置只作用专用浏览器键', async () => {
  const storage = memoryStorage(), demo = createDemoAPI({ storage, now: time });
  let state = await demo.request('/api/state');
  const own = state.tasks.find(task => task.id === 't2');
  const fileText = '浏览器本地成果，不发送至服务器。', base64 = Buffer.from(fileText).toString('base64');
  const submitted = await demo.request('/api/action', { type: 'submitArtifact', taskId: own.id, taskUpdatedAt: own.updatedAt, name: '演示附件', file: { name: '本地成果.txt', base64 } });
  state = submitted.state; const artifact = state.tasks.find(task => task.id === own.id).artifacts[0];
  assert.equal(artifact.submittedBy, state.currentMemberId);
  const download = await createDemoAPI({ storage }).download(artifact.url);
  assert.equal(download.filename, '本地成果.txt'); assert.equal(await download.blob.text(), fileText);
  const accepted = await demo.request('/api/action', { type: 'accept', taskId: own.id, taskUpdatedAt: state.tasks.find(task => task.id === own.id).updatedAt });
  assert.equal(accepted.state.tasks.find(task => task.id === own.id).status, 'done');
  assert.match(await (await demo.download('/api/report')).blob.text(), /演示附件/);
  assert.equal(JSON.parse(await (await demo.download('/api/export')).blob.text()).project.id, state.project.id);
  assert.match(await (await demo.download('/samples/brief.md')).blob.text(), /内置演示/);
  const before = storage.values.get(DEMO_STORAGE_KEY);
  await assert.rejects(demo.request('/api/action', { type: 'submitArtifact', taskId: 't4', name: '过大附件', file: { name: 'large.txt', base64: Buffer.alloc(501 * 1024).toString('base64') } }), error => error.status === 400);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY), before);
  await demo.request('/api/demo/reset', {});
  assert.equal(storage.values.get('unrelated-real-app-key'), 'must stay untouched');
  await assert.rejects(demo.download(artifact.url), error => error.status === 404);
  assert.equal((await demo.request('/api/state')).tasks.find(task => task.id === own.id).status, 'doing');
});

test('固定示例明确非AI，规划与重规划复用版本和保护规则，预览不写入且与应用ID一致', async () => {
  const storage = memoryStorage(), demo = createDemoAPI({ storage, now: time });
  const status = await demo.request('/api/ai/status');
  assert.equal(status.configured, false); assert.equal(status.samplePlanning, true); assert.equal(status.model, DEMO_MODEL);
  const original = await demo.request('/api/state');
  assert.deepEqual(await demo.request(`/api/ai/capabilities?projectId=${original.project.id}`),{configured:false,samplePlanning:true,canGenerate:true});
  await assert.rejects(demo.request('/api/ai/capabilities?projectId=missing'),error=>error.status===404);
  await assert.rejects(demo.request(`/api/ai/capabilities?projectId=${original.project.id}&projectId=${original.project.id}`),error=>error.status===400);
  const protectedTask = structuredClone(original.tasks.find(task => task.id === 't1'));
  const protectedMilestone = structuredClone(original.milestones.find(item => item.id === 'demo-scope'));
  const generated = await demo.request('/api/ai/replan', { goal: '示例调整剩余工作' });
  assert.equal(generated.model, DEMO_MODEL); assert.equal(generated.samplePlanning, true);
  const bytes = storage.values.get(DEMO_STORAGE_KEY);
  await demo.request('/api/plans/preview', { expectedRevision: generated.baseRevision, draft: generated.draft });
  assert.equal(storage.values.get(DEMO_STORAGE_KEY), bytes);
  const illegal = structuredClone(generated.draft); illegal.tasks[0].existingTaskId = protectedTask.id;
  await assert.rejects(demo.request('/api/plans/replan', { expectedRevision: generated.baseRevision, draft: illegal }), error => error.status === 400);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY), bytes);
  const applied = await demo.request('/api/plans/replan', { expectedRevision: generated.baseRevision, draft: generated.draft });
  assert.deepEqual(applied.state.tasks.find(task => task.id === protectedTask.id), protectedTask);
  assert.deepEqual(applied.state.milestones.find(item => item.id === protectedMilestone.id), protectedMilestone);
  await assert.rejects(demo.request('/api/plans/replan', { expectedRevision: generated.baseRevision, draft: generated.draft }), error => error.status === 409);
  const created = await demo.request('/api/projects', { name: '从空白体验示例规划' }), projectId = created.state.project.id;
  const initial = await demo.request('/api/ai/plan', { projectId, goal: '体验固定样例' });
  assert.equal(initial.model, DEMO_MODEL);
  const normalPlan = await demo.request('/api/plans/apply', { projectId, expectedRevision: initial.baseRevision, draft: initial.draft });
  assert.equal(normalPlan.state.tasks.length, 2); assert.equal(normalPlan.state.milestones.length, 1);
  const empty = await demo.request('/api/projects', { name: '空白调整示例' });
  const replan = await demo.request('/api/ai/replan', { projectId: empty.state.project.id, goal: '演示先预览再确认' });
  const preview = await demo.request('/api/plans/preview', { projectId: empty.state.project.id, expectedRevision: replan.baseRevision, draft: replan.draft });
  const result = await demo.request('/api/plans/replan', { projectId: empty.state.project.id, expectedRevision: replan.baseRevision, draft: replan.draft });
  const ids = preview.changes.items.filter(item => item.operation === 'create').map(item => item.entityId).sort();
  assert.deepEqual([...result.state.tasks, ...result.state.milestones].map(item => item.id).sort(), ids);
});

test('存储配额失败保留旧数据，损坏数据不被静默覆盖，显式reset可恢复', async () => {
  const storage = memoryStorage(), demo = createDemoAPI({ storage, now: time });
  const state = await demo.request('/api/state'), bytes = storage.values.get(DEMO_STORAGE_KEY), setItem = storage.setItem;
  storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  await assert.rejects(demo.request('/api/action', taskInput(state)), error => error.status === 507);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY), bytes);
  storage.setItem = setItem;
  storage.values.set(DEMO_STORAGE_KEY, '{broken');
  await assert.rejects(demo.request('/api/workspace'), error => error.status === 500);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY), '{broken');
  await demo.request('/api/demo/reset', {});
  assert.equal((await demo.request('/api/auth/session')).demo, true);
  assert.equal(storage.values.get('unrelated-real-app-key'), 'must stay untouched');
});

test('演示指引兼容旧数据、跨适配器持久化且完成为终态，不改变项目或工作区版本', async t => {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('onboarding must stay local');});
  const storage=memoryStorage(),demo=createDemoAPI({storage,now:time});
  assert.deepEqual((await demo.request('/api/auth/session')).onboarding,{version:1,status:'pending'});
  const legacy=JSON.parse(storage.values.get(DEMO_STORAGE_KEY)); delete legacy.onboarding;
  const legacyBytes=JSON.stringify(legacy); storage.values.set(DEMO_STORAGE_KEY,legacyBytes);
  assert.deepEqual((await demo.request('/api/auth/session')).onboarding,{version:1,status:'pending'});
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),legacyBytes,'reading legacy state must not rewrite project data');
  const before=await demo.request('/api/workspace'),projects=await Promise.all(before.projects.map(project=>demo.request('/api/state?projectId='+project.id)));
  assert.deepEqual(await demo.request('/api/auth/onboarding',{status:'dismissed'}),{onboarding:{version:1,status:'dismissed'}});
  const reopened=createDemoAPI({storage,now:time});
  assert.deepEqual((await reopened.request('/api/auth/session')).onboarding,{version:1,status:'dismissed'});
  const dismissedBytes=storage.values.get(DEMO_STORAGE_KEY);
  await reopened.request('/api/auth/onboarding',{status:'dismissed'});
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),dismissedBytes,'idempotent dismissal must not write');
  assert.deepEqual(await reopened.request('/api/auth/onboarding',{status:'completed'}),{onboarding:{version:1,status:'completed'}});
  const completedBytes=storage.values.get(DEMO_STORAGE_KEY);
  for(const status of ['completed','dismissed'])assert.deepEqual(await demo.request('/api/auth/onboarding',{status}),{onboarding:{version:1,status:'completed'}});
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),completedBytes,'completed cannot be downgraded or rewritten');
  assert.deepEqual((await reopened.request('/api/auth/logout',{})).onboarding,{version:1,status:'completed'});
  assert.deepEqual(await reopened.request('/api/workspace'),before);
  for(let i=0;i<projects.length;i++)assert.deepEqual(await reopened.request('/api/state?projectId='+projects[i].project.id),projects[i]);
  const reset=await reopened.request('/api/demo/reset',{});
  assert.deepEqual(reset.onboarding,{version:1,status:'pending'});
  assert.equal(storage.values.get('unrelated-real-app-key'),'must stay untouched');
});

test('演示指引严格限定当前本机体验身份，存储失败保留原状态且不伪造保存成功', async () => {
  const storage=memoryStorage(),demo=createDemoAPI({storage,now:time});
  const session=await demo.request('/api/auth/session'),before=storage.values.get(DEMO_STORAGE_KEY);
  for(const payload of [{},{status:'pending'},{status:'unknown'},{status:'completed',accountId:'someone-else'},{status:'completed',personId:session.user.personId},{status:'completed',version:2},null,[]]) {
    await assert.rejects(demo.request('/api/auth/onboarding',payload),error=>error.status===400);
    assert.equal(storage.values.get(DEMO_STORAGE_KEY),before);
  }
  await assert.rejects(demo.request('/api/auth/onboarding'),error=>error.status===404);
  const originalSet=storage.setItem; storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError');};
  await assert.rejects(demo.request('/api/auth/onboarding',{status:'completed'}),error=>error.status===507);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),before);
  assert.deepEqual((await demo.request('/api/auth/session')).onboarding,{version:1,status:'pending'});
  storage.setItem=originalSet;
  await demo.request('/api/auth/onboarding',{status:'completed'});
  storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError');};
  assert.deepEqual(await demo.request('/api/auth/onboarding',{status:'dismissed'}),{onboarding:{version:1,status:'completed'}},'idempotent terminal updates need no storage write');
  assert.equal((await demo.request('/api/auth/session')).user.id,session.user.id);
});

test('可移除示例复用正式模板且只有一份，完整交接/阶段验收后移除恢复保留全部记录和附件', async t => {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('sample must stay local');});
  const storage=memoryStorage(),demo=createDemoAPI({storage,now:time});
  const original=await demo.request('/api/state');
  await demo.request('/api/auth/onboarding',{status:'completed'});
  const [created,reused]=await Promise.all([demo.request('/api/samples',{}),demo.request('/api/samples',{})]);
  assert.equal(created.reused,false);assert.equal(created.restored,false);assert.equal(reused.reused,true);
  assert.equal(created.state.project.id,reused.state.project.id);
  let state=created.state;const projectId=state.project.id,virtual=state.members.find(member=>member.virtual);
  assert.deepEqual(state.sample,{version:1,canArchive:true});assert.equal(state.permissions.manageMembers,false);
  assert.deepEqual((await demo.request('/api/export?projectId='+projectId)).sample,{version:1,canArchive:true});
  assert.equal((await (await demo.download('/api/export?projectId='+projectId)).blob.text()).includes('ownerAccountId'),false);
  assert.equal(state.members.length,2);assert.equal(virtual.accountLinked,false);assert.equal(state.currentMemberId,'m0');
  assert.deepEqual(state.tasks.map(task=>task.status).sort(),['blocked','done','review','todo']);
  assert.equal(state.milestones.filter(item=>item.status==='accepted').length,1);
  const own=state.tasks.find(task=>task.status==='todo');
  const progress=await demo.request('/api/analyze',{projectId,taskId:own.id,text:'我已完成整理，需要提交核对'});
  assert.ok(progress.analysis);assert.deepEqual(await demo.request('/api/state?projectId='+projectId),state,'analysis must not change progress automatically');
  async function act(input){const current=state.tasks.find(task=>task.id===input.taskId);state=(await demo.request('/api/action',{projectId,...input,taskUpdatedAt:current?.updatedAt})).state;return state;}
  await act({type:'setStatus',taskId:own.id,status:'doing'});
  await act({type:'submitArtifact',taskId:own.id,name:'本人实践成果',file:{name:'proof.txt',base64:Buffer.from('sample lifecycle proof').toString('base64')}});
  const fileURL=state.tasks.find(task=>task.id===own.id).artifacts[0].url;
  await act({type:'accept',taskId:own.id});
  await act({type:'accept',taskId:state.tasks.find(task=>task.status==='review').id});
  const blocked=state.tasks.find(task=>task.status==='blocked');
  await act({type:'setStatus',taskId:blocked.id,status:'doing'});
  await act({type:'submitArtifact',taskId:blocked.id,name:'解除阻碍说明',note:'已补充检查步骤，内容可以核对。'});
  await act({type:'accept',taskId:blocked.id});
  state=(await demo.request('/api/milestones/action',{projectId,type:'acceptMilestone',milestoneId:state.milestones.find(item=>item.status!=='accepted').id,expectedRevision:state.revision,note:'逐项核对实践成果'})).state;
  assert.ok(state.tasks.every(task=>task.status==='done'));assert.ok(state.milestones.every(item=>item.status==='accepted'));
  assert.deepEqual(state.sample,{version:1,canArchive:true},'domain writes must preserve trusted sample identity');
  assert.match(await (await demo.download('/api/report?projectId='+projectId)).blob.text(),/本人实践成果/);
  const exported=JSON.parse(await (await demo.download('/api/export?projectId='+projectId)).blob.text());
  assert.equal(exported.tasks.length,4);assert.equal(exported.revision,state.revision);
  assert.equal(await (await demo.download(fileURL)).blob.text(),'sample lifecycle proof');
  const beforeArchive=structuredClone(state),beforeBytes=storage.values.get(DEMO_STORAGE_KEY);
  await assert.rejects(demo.request('/api/samples/archive',{projectId,expectedRevision:state.revision-1}),error=>error.status===409);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),beforeBytes);
  const removed=await demo.request('/api/samples/archive',{projectId,expectedRevision:state.revision});
  assert.equal(removed.alreadyArchived,false);assert.ok(!removed.workspace.projects.some(item=>item.id===projectId));
  assert.deepEqual(removed.archivedSample.sample,{version:1,canRestore:true});assert.equal(removed.archivedSample.revision,state.revision);
  assert.ok(!(await demo.request('/api/dashboard?q=本人实践成果')).search.tasks.some(task=>task.project.id===projectId));
  assert.ok(!(await demo.request('/api/people')).people.some(person=>person.id===virtual.personId),'orphan virtual profiles must not clutter the active directory');
  for(const endpoint of ['state','export','report'])await assert.rejects(demo.request('/api/'+endpoint+'?projectId='+projectId),error=>error.status===404);
  await assert.rejects(demo.download(fileURL),error=>error.status===404);
  const archivedBytes=storage.values.get(DEMO_STORAGE_KEY);
  assert.equal((await demo.request('/api/samples/archive',{projectId,expectedRevision:state.revision})).alreadyArchived,true);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),archivedBytes);
  const reopened=createDemoAPI({storage,now:time});
  assert.equal((await reopened.request('/api/workspace')).archivedSamples[0].id,projectId);
  const restored=await reopened.request('/api/samples',{});
  assert.equal(restored.restored,true);assert.equal(restored.reused,false);assert.deepEqual(restored.state,beforeArchive);
  assert.equal(await (await reopened.download(fileURL)).blob.text(),'sample lifecycle proof');
  assert.ok((await reopened.request('/api/people')).people.some(person=>person.id===virtual.personId));
  assert.deepEqual((await reopened.request('/api/auth/session')).onboarding,{version:1,status:'completed'});
  const activeBytes=storage.values.get(DEMO_STORAGE_KEY);
  const again=await reopened.request('/api/samples/restore',{projectId});assert.equal(again.reused,true);assert.equal(again.restored,false);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),activeBytes);
  await reopened.request('/api/samples/archive',{projectId,expectedRevision:state.revision});
  assert.deepEqual((await reopened.request('/api/samples/restore',{projectId})).state,beforeArchive);
  assert.deepEqual(await reopened.request('/api/state?projectId='+original.project.id),original);
});

test('示例生命周期拒绝普通项目/伪造元信息与修改固定成员，任何存储失败均不留下半成品', async () => {
  const storage=memoryStorage(),demo=createDemoAPI({storage,now:time});
  const original=await demo.request('/api/state'),normal=(await demo.request('/api/projects',{name:'协作流程示例'})).state;
  const before=storage.values.get(DEMO_STORAGE_KEY);
  for(const input of [{projectId:normal.project.id},{ownerAccountId:'someone-else'},{sample:{version:1}},{members:[]}])await assert.rejects(demo.request('/api/samples',input),error=>error.status===400);
  await assert.rejects(demo.request('/api/projects',{name:'伪造示例',sample:{version:1}}),error=>error.status===400);
  await assert.rejects(demo.request('/api/samples/archive',{projectId:normal.project.id,expectedRevision:normal.revision}),error=>error.status===403);
  await assert.rejects(demo.request('/api/samples/restore',{projectId:original.project.id}),error=>error.status===403);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),before);
  const originalSet=storage.setItem;storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError');};
  await assert.rejects(demo.request('/api/samples',{}),error=>error.status===507);assert.equal(storage.values.get(DEMO_STORAGE_KEY),before);
  storage.setItem=originalSet;let writes=0;storage.setItem=(key,value)=>{writes++;return originalSet(key,value);};
  const created=await demo.request('/api/samples',{}),state=created.state,projectId=state.project.id;assert.equal(writes,1,'sample creation must be one atomic localStorage write');
  const virtualId=state.members.find(member=>member.virtual).personId;
  assert.equal((await demo.request('/api/people')).people.find(person=>person.id===virtualId).permissions.editProfile,false);
  const virtualDetail=await demo.request(`/api/people/${virtualId}`);
  assert.equal(virtualDetail.permissions.editProfile,false);
  assert.equal(virtualDetail.person.permissions.editProfile,false);
  assert.ok(!(await demo.request(`/api/people?selectableForProject=${normal.project.id}`)).people.some(person=>person.id===virtualId));
  const active=storage.values.get(DEMO_STORAGE_KEY);
  for(const request of [
    ['/api/action',{projectId,type:'addMember',name:'真实伙伴',role:'协作'}],
    ['/api/action',{projectId,type:'updateMember',memberId:'m1',role:'改分工',expectedRevision:state.revision}],
    ['/api/project-members',{projectId,personId:original.members[0].personId,role:'协作'}],
    ['/api/project-members',{projectId:normal.project.id,personId:virtualId,role:'协作'}],
    ['/api/projects',{name:'虚拟发起人',ownerPersonId:virtualId}],
    ['/api/projects',{name:'虚拟成员迁入',members:[{personId:virtualId,role:'协作'}]}],
    [`/api/people/${virtualId}`,{expectedRevision:virtualDetail.revision,patch:{name:'伪装真实人员'}}]
  ])await assert.rejects(demo.request(...request),error=>error.status===403);
  assert.equal(storage.values.get(DEMO_STORAGE_KEY),active);
  storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError');};
  await assert.rejects(demo.request('/api/samples/archive',{projectId,expectedRevision:state.revision}),error=>error.status===507);assert.equal(storage.values.get(DEMO_STORAGE_KEY),active);
  storage.setItem=originalSet;await demo.request('/api/samples/archive',{projectId,expectedRevision:state.revision});const archived=storage.values.get(DEMO_STORAGE_KEY);
  await assert.rejects(demo.request(`/api/people/${virtualId}`),error=>error.status===404);
  storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError');};
  await assert.rejects(demo.request('/api/samples/restore',{projectId}),error=>error.status===507);assert.equal(storage.values.get(DEMO_STORAGE_KEY),archived);
  storage.setItem=originalSet;
  const altered=JSON.parse(archived);altered.archivedSamples[0].state.sample.ownerAccountId='other-account';storage.values.set(DEMO_STORAGE_KEY,JSON.stringify(altered));
  await assert.rejects(demo.request('/api/samples/restore',{projectId}),error=>error.status===403);
});

test('只有一个样例时移除可得到空工作区，默认项目回退及恢复不生成新档案', async () => {
  const storage=memoryStorage(),demo=createDemoAPI({storage,now:time});
  const session=await demo.request('/api/auth/session'),empty=JSON.parse(storage.values.get(DEMO_STORAGE_KEY));
  empty.projects=[];empty.bindings={};empty.defaultProjectId=null;empty.people=empty.people.filter(person=>person.id===session.user.personId);storage.values.set(DEMO_STORAGE_KEY,JSON.stringify(empty));
  const made=await demo.request('/api/samples',{}),projectId=made.state.project.id;
  assert.equal(made.workspace.defaultProjectId,projectId);
  const names=JSON.parse(storage.values.get(DEMO_STORAGE_KEY)).people;
  const removed=await demo.request('/api/samples/archive',{projectId,expectedRevision:made.state.revision});
  assert.deepEqual(removed.workspace.projects,[]);assert.equal(removed.workspace.defaultProjectId,null);
  await assert.rejects(createDemoAPI({storage}).request('/api/state'),error=>error.status===404);
  const normal=(await demo.request('/api/projects',{name:'真实空白项目'})).state;
  assert.equal((await demo.request('/api/workspace')).defaultProjectId,normal.project.id);
  const restored=await demo.request('/api/samples/restore',{projectId});
  assert.equal(restored.workspace.defaultProjectId,normal.project.id);assert.equal(restored.state.project.id,projectId);
  assert.deepEqual(JSON.parse(storage.values.get(DEMO_STORAGE_KEY)).people,names);
});

test('演示报告与JSON导出使用最新权威人员姓名，原始项目历史不被档案改名重写',async()=>{
  const storage=memoryStorage(),demo=createDemoAPI({storage,now:time});
  const state=(await demo.request('/api/samples',{})).state,projectId=state.project.id,personId=state.members.find(member=>member.id==='m0').personId;
  const before=structuredClone(JSON.parse(storage.values.get(DEMO_STORAGE_KEY)).projects.find(item=>item.project.id===projectId));
  const directory=await demo.request('/api/people');
  await demo.request('/api/people/'+personId,{expectedRevision:directory.revision,patch:{name:'已更新的真实显示名'}});
  const report=await demo.request('/api/report?projectId='+projectId),downloadedReport=await(await demo.download('/api/report?projectId='+projectId)).blob.text();
  assert.match(report,/已更新的真实显示名/);assert.equal(downloadedReport,report);
  const exported=await demo.request('/api/export?projectId='+projectId),downloadedExport=JSON.parse(await(await demo.download('/api/export?projectId='+projectId)).blob.text());
  assert.equal(exported.members.find(member=>member.id==='m0').name,'已更新的真实显示名');assert.deepEqual(downloadedExport,exported);
  assert.deepEqual(JSON.parse(storage.values.get(DEMO_STORAGE_KEY)).projects.find(item=>item.project.id===projectId),before);
});
