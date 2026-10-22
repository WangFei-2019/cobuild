import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState,applyAction} from '../domain.mjs';
import {extractProjectTemplate,validateProjectTemplate,parseProjectTemplate,instantiateProjectTemplate,previewProjectTemplate,previewTaskBatch,applyTaskBatch,PRODUCTIVITY_LIMITS} from '../productivity.mjs';

function source(){const state=seedState();state.project.color='#225588';state.members.forEach((member,index)=>Object.assign(member,{personId:`private-person-${index}`,accountLinked:true,accessRole:index===0?'admin':'member'}));state.milestones=[{id:'source-phase',title:'第一版',goal:'完成真实交付',due:'2026-10-27',acceptanceCriteria:'逐项核对交付物',status:'accepted',acceptedAt:'secret-accepted',acceptedBy:'m0',acceptanceNote:'私人验收记录'}];state.tasks.forEach(task=>task.milestoneId='source-phase');state.discussions=[{id:'private-discussion',body:'不要复制的讨论'}];return state;}
function target(){return {schemaVersion:1,revision:7,project:{id:'new-project',name:'目标项目',description:'独立背景',goal:'新的目标',deadline:'2027-03-30',color:'#345678'},members:[{id:'owner',name:'当前创建者',role:'项目发起人',accessRole:'admin'},{id:'worker',name:'已确认加入的协作者',accessRole:'member'},{id:'viewer',name:'只读成员',accessRole:'viewer'},{id:'left',name:'已离开成员',accessRole:'member',active:false}],tasks:[],milestones:[],activities:[],decisions:[]};}
const template=()=>extractProjectTemplate(source(),{name:'角色化交付模板',anchorDate:'2026-10-20'});
function request(state=target(),draft=template()){return {actorId:'owner',projectId:state.project.id,expectedRevision:state.revision,template:draft,startDate:'2027-03-01',roleMap:Object.fromEntries(draft.roles.map((role,index)=>[role.id,index%2?'worker':'owner']))};}
function batchState(){let state=seedState();state.members.forEach((member,index)=>member.accessRole=index===0?'admin':'member');return state;}
function batch(state,edits){return {projectId:state.project.id,actorId:'m0',expectedRevision:state.revision,edits:edits.map(([taskId,patch])=>({taskId,taskUpdatedAt:state.tasks.find(task=>task.id===taskId).updatedAt,patch}))};}

test('模板白名单提取角色/相对日程/依赖/验收标准，不携带成员身份、成果、状态或讨论',()=>{
  const state=source(),before=structuredClone(state),draft=template(),serialized=JSON.stringify(draft);
  assert.equal(draft.tasks.length,6);assert.equal(draft.tasks[0].dueOffset,1);assert.equal(draft.project.deadlineOffset,7);assert.equal(draft.milestones[0].acceptanceCriteria,'逐项核对交付物');
  for(const secret of ['private-person','陈知','林夏','secret-accepted','私人验收记录','private-discussion','首轮体验问题清单.md','submittedBy','acceptedAt','accessRole','accountLinked','artifacts','status','m0','t1','source-phase'])assert.equal(serialized.includes(secret),false,secret);
  assert.ok(draft.tasks[1].dependsOn.includes(draft.tasks[0].id));assert.deepEqual(state,before);assert.deepEqual(parseProjectTemplate(serialized),draft);
  const canceled=source();canceled.tasks.find(task=>task.id==='t6').status='canceled';assert.equal(extractProjectTemplate(canceled).tasks.length,5);
  canceled.tasks.find(task=>task.id==='t2').status='canceled';assert.throws(()=>extractProjectTemplate(canceled),/取消或缺失/);
});

test('模板应用显式映射有效目标成员，全部新交付从todo/open开始，目标信息和源对象不变',()=>{
  const state=target(),draft=template(),input=request(state,draft),before=structuredClone(state),sourceBefore=structuredClone(draft);
  const preview=previewProjectTemplate(state,input),next=instantiateProjectTemplate(state,input);
  assert.equal(preview.baseRevision,7);assert.equal(next.revision,8);assert.deepEqual(next.project,state.project);assert.deepEqual(next.members,state.members);
  assert.equal(next.tasks.length,6);assert.equal(next.milestones.length,1);assert.ok(next.tasks.every(task=>task.status==='todo'&&task.artifacts.length===0&&!task.acceptedAt));assert.equal(next.milestones[0].status,'open');assert.equal(next.milestones[0].due,'2027-03-08');
  const first=next.tasks.find(task=>task.title===draft.tasks[0].title),second=next.tasks.find(task=>task.title===draft.tasks[1].title);assert.equal(first.due,'2027-03-02');assert.deepEqual(second.dependsOn,[first.id]);assert.equal(second.ownerId,input.roleMap[draft.tasks[1].ownerRoleId]);
  assert.deepEqual(preview.tasks.map(task=>[task.title,task.ownerId,task.due]),next.tasks.map(task=>[task.title,task.ownerId,task.due]));
  assert.deepEqual(state,before);assert.deepEqual(draft,sourceBefore);assert.equal(next.discussions,undefined);assert.ok(next.activities.every(event=>!event.text.includes('示例资料')));
});

test('同名角色自动增加可读序号且避开现有编号标签，不引入源成员姓名或账号',()=>{
  const state=source();state.members.forEach(member=>member.role='项目协作者');state.members[3].role='项目协作者（1）';const before=structuredClone(state),draft=extractProjectTemplate(state);
  assert.equal(new Set(draft.roles.map(role=>role.label.normalize('NFKC').toLowerCase())).size,draft.roles.length);assert.ok(draft.roles.some(role=>role.label==='项目协作者（1）'));assert.ok(draft.roles.some(role=>role.label==='项目协作者（2）'));assert.ok(draft.roles.some(role=>role.label==='项目协作者（3）'));
  for(const member of state.members){assert.equal(draft.roles.some(role=>role.label.includes(member.name)),false);assert.equal(JSON.stringify(draft).includes(member.personId),false);}assert.deepEqual(state,before);
  const unicode=source();unicode.members.forEach(member=>member.role='协'.repeat(75)+'🙂🙂');const labels=extractProjectTemplate(unicode).roles.map(role=>role.label);assert.equal(new Set(labels).size,labels.length);assert.ok(labels.every(value=>value.length<=80&&value.isWellFormed()));
});

test('模板严格拒绝超限/危险结构/非法日期依赖和伪造身份，不修改目标；不能向非空项目追加',()=>{
  const state=target(),before=structuredClone(state),input=request(state),role=input.template.roles[0].id;
  for(const value of ['viewer','left','person-not-member'])assert.throws(()=>instantiateProjectTemplate(state,{...input,roleMap:{...input.roleMap,[role]:value}}),error=>error.status===403);
  assert.throws(()=>instantiateProjectTemplate(state,{...input,expectedRevision:state.revision-1}),error=>error.status===409);
  assert.throws(()=>instantiateProjectTemplate(state,{...input,actorId:'worker'}),error=>error.status===403);
  assert.throws(()=>instantiateProjectTemplate(state,{...input,startDate:'2027-02-30'}),/日期/);
  assert.throws(()=>instantiateProjectTemplate({...state,tasks:seedState().tasks},input),/空项目/);
  assert.throws(()=>instantiateProjectTemplate(state,{...input,roleMap:{...input.roleMap,extra:'owner'}}),/字段/);
  for(const change of [draft=>draft.tasks[0].dependsOn=['foreign'],draft=>draft.tasks[0].dependsOn=[draft.tasks[1].id],draft=>draft.tasks[0].dueOffset=-1,draft=>draft.tasks[0].ownerRoleId='foreign',draft=>draft.tasks[0].status='done',draft=>draft.project.deadlineOffset=0,draft=>draft.tasks.push(...Array.from({length:80},()=>structuredClone(draft.tasks[0])))]){const draft=template();change(draft);assert.throws(()=>validateProjectTemplate(draft));}
  assert.throws(()=>parseProjectTemplate('{"__proto__":{"admin":true}}'),/不安全/);assert.throws(()=>parseProjectTemplate('x'.repeat(PRODUCTIVITY_LIMITS.templateBytes+1)),/128KB/);
  const tooShort={...state,project:{...state.project,deadline:'2027-03-02'}};assert.throws(()=>instantiateProjectTemplate(tooShort,request(tooShort)),/截止/);assert.deepEqual(state,before);
});

test('批量协调相依日期同时平移，逐项完整验证后一次revision+1，与输入顺序无关',()=>{
  let state=batchState();state.tasks=state.tasks.filter(task=>['t2','t3'].includes(task.id));state.tasks[0].dependsOn=[];state.project.deadline='2026-11-30';
  const before=structuredClone(state),edits=[['t2',{due:'2026-11-05',priority:'low'}],['t3',{due:'2026-11-06'}]],input=batch(state,edits),preview=previewTaskBatch(state,input),next=applyTaskBatch(state,input);
  assert.equal(preview.baseRevision,state.revision);assert.equal(preview.changes.length,2);assert.equal(next.revision,state.revision+1);assert.deepEqual(next.tasks.map(task=>task.due),['2026-11-05','2026-11-06']);
  const reverse=applyTaskBatch(state,batch(state,[...edits].reverse()));assert.deepEqual(reverse.tasks.map(task=>[task.id,task.due,task.priority]),next.tasks.map(task=>[task.id,task.due,task.priority]));assert.deepEqual(next.members,state.members);assert.deepEqual(state,before);
  assert.throws(()=>applyTaskBatch(state,batch(state,[['t2',{due:'2026-11-05'}]])),/后置/);assert.deepEqual(state,before);
});

test('批量换负责人保留原成果与归属，待交接回推进并要求重交；blocked保留受阻事实，期限优先级不重交',()=>{
  const state=batchState(),old=state.tasks.find(task=>task.id==='t6'),input=batch(state,[['t6',{ownerId:'m1',priority:'high'}]]),preview=previewTaskBatch(state,input),next=applyTaskBatch(state,input),updated=next.tasks.find(task=>task.id==='t6');
  assert.equal(preview.changes[0].needsResubmission,true);assert.equal(preview.changes[0].afterStatus,'doing');assert.equal(updated.ownerId,'m1');assert.equal(updated.status,'doing');assert.equal(updated.needsResubmission,true);assert.deepEqual(updated.artifacts,old.artifacts);assert.ok(updated.updatedAt>old.updatedAt);assert.deepEqual(next.tasks.filter(task=>task.id!=='t6'),state.tasks.filter(task=>task.id!=='t6'));
  assert.throws(()=>applyAction(next,{type:'setStatus',actorId:'m1',taskId:'t6',status:'review'}),/重新提交/);
  const blocked=structuredClone(state);Object.assign(blocked.tasks.find(task=>task.id==='t6'),{status:'blocked',blocker:'等待明确外部条件'});const after=applyTaskBatch(blocked,batch(blocked,[['t6',{ownerId:'m1'}]])).tasks.find(task=>task.id==='t6');assert.equal(after.status,'blocked');assert.equal(after.blocker,'等待明确外部条件');assert.equal(after.needsResubmission,true);
  const priority=applyTaskBatch(state,batch(state,[['t6',{priority:'high'}]])).tasks.find(task=>task.id==='t6');assert.equal(priority.status,'review');assert.equal(Boolean(priority.needsResubmission),false);
});

test('批量ACL/版本/字段/容量均封口，任一项失败零部分写入，禁止完成/取消/验收/依赖等混入',()=>{
  const state=batchState(),before=structuredClone(state);
  const forbidden=[{status:'done'},{reviewerId:'m0'},{dependsOn:[]},{deliverable:'偷偷改约定'},{}];for(const patch of forbidden)assert.throws(()=>applyTaskBatch(state,batch(state,[['t2',patch]])));
  for(const taskId of ['t1','missing'])assert.throws(()=>applyTaskBatch(state,{...batch(state,[['t2',{priority:'high'}]]),edits:[{taskId,taskUpdatedAt:'wrong',patch:{priority:'low'}}]}));
  const canceled=structuredClone(state);canceled.tasks[1].status='canceled';assert.throws(()=>applyTaskBatch(canceled,batch(canceled,[['t2',{priority:'high'}]])),/取消/);
  assert.throws(()=>applyTaskBatch(state,{...batch(state,[['t2',{priority:'low'}]]),expectedRevision:0}),error=>error.status===409);
  const stale=batch(state,[['t2',{priority:'low'}]]);stale.edits[0].taskUpdatedAt='old';assert.throws(()=>applyTaskBatch(state,stale),error=>error.status===409);
  assert.throws(()=>applyTaskBatch(state,{...batch(state,[['t2',{priority:'low'}],['t3',{priority:'low'}]]),actorId:'m2'}),error=>error.status===403);
  assert.throws(()=>applyTaskBatch(state,batch(state,[['t2',{priority:'low'}],['t3',{due:'2026-02-30'}]])),/日期/);
  const viewer=structuredClone(state);viewer.members.find(member=>member.id==='m1').accessRole='viewer';assert.throws(()=>applyTaskBatch(viewer,batch(viewer,[['t2',{ownerId:'m1'}]])),error=>error.status===403);
  assert.throws(()=>applyTaskBatch(state,batch(state,[['t2',{priority:'high'}]])),/没有实际变化/);
  assert.throws(()=>applyTaskBatch(state,batch(state,Array.from({length:51},()=>['t2',{priority:'low'}]))),/50/);
  assert.deepEqual(state,before);
});

test('普通负责人只能批量更新自己的任务，任何一项非本人任务则整个请求拒绝',()=>{
  const state=batchState(),own={...batch(state,[['t2',{priority:'low'}],['t6',{priority:'high'}]]),actorId:'m2'},next=applyTaskBatch(state,own);
  assert.equal(next.tasks.find(task=>task.id==='t2').priority,'low');assert.equal(next.tasks.find(task=>task.id==='t6').priority,'high');
  assert.throws(()=>applyTaskBatch(state,{...batch(state,[['t2',{priority:'low'}],['t3',{priority:'low'}]]),actorId:'m2'}),error=>error.status===403);
});
