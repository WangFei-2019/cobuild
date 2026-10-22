import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState,applyAction,analyzeUpdate,projectReport} from '../domain.mjs';
import {deriveNotifications} from '../notifications.mjs';
import {dashboardSummary} from '../dashboard.mjs';
import {deriveProjectInsights} from '../insights.mjs';
import {personDetails} from '../people.mjs';
import {applyMilestoneAction,previewReplan,applyReplanDraft} from '../planning.mjs';
import {buildPlanningPrompt} from '../ai-exchange.mjs';

const manager='m0',run=(state,input)=>applyAction(state,{actorId:manager,...input});
const cancel=(state,id='t2')=>run(state,{type:'cancelTask',taskId:id,taskUpdatedAt:state.tasks.find(task=>task.id===id).updatedAt,reason:'当前范围不再需要，保留历史'});
const identity={membership:()=>({memberId:'m2',accessRole:'member'}),member:(projectId,memberId)=>({personId:memberId}),person:id=>({id,name:id,color:'#123456',initial:'人'})};

test('取消是管理者显式决定且必须基于新快照，完成不可取消，记录和成果留存不允许普通状态复活',()=>{
  const original=seedState(),before=structuredClone(original);
  assert.throws(()=>run(original,{type:'cancelTask',taskId:'t2',reason:'缺少快照'}),error=>error.status===409);
  assert.throws(()=>applyAction(original,{actorId:'m2',type:'cancelTask',taskId:'t2',taskUpdatedAt:original.tasks[1].updatedAt,reason:'负责人不能自行免除交付'}),error=>error.status===403);
  assert.throws(()=>cancel(original,'t1'),/已确认/);
  let state=cancel(original,'t6'),task=state.tasks.find(task=>task.id==='t6');
  assert.equal(task.status,'canceled');assert.equal(task.cancellation.previousStatus,'review');assert.equal(task.cancelHistory.length,1);assert.equal(task.artifacts.length,1);
  for(const type of ['setStatus','updateTask','submitArtifact','accept','addUpdate'])assert.throws(()=>run(state,{type,taskId:task.id,status:'doing',patch:{title:'不得绕过'},name:'成果',note:'文本',text:'进展'}),/取消/);
  assert.throws(()=>analyzeUpdate(state,{actorId:'m2',taskId:task.id,text:'全部完成'}),/取消/);
  assert.deepEqual(original,before);
  state=run(state,{type:'restoreTask',taskId:task.id,taskUpdatedAt:task.updatedAt});task=state.tasks.find(task=>task.id==='t6');
  assert.equal(task.status,'review');assert.equal(task.cancellation,undefined);assert.ok(task.cancelHistory[0].restoredAt);assert.equal(task.cancelHistory[0].restoredBy,manager);
  assert.match(projectReport(state),/取消与恢复记录/);assert.match(projectReport(state),/恢复人/);
});

test('恢复必须处理离开成员和最新日期约束，换人后旧成果不代表新分工已交付',()=>{
  let state=cancel(seedState(),'t6'),task=state.tasks.find(task=>task.id==='t6');state.members.find(member=>member.id==='m2').active=false;
  assert.throws(()=>run(state,{type:'restoreTask',taskId:task.id,taskUpdatedAt:task.updatedAt}),/离开/);
  const before=structuredClone(state);state.project.deadline='2026-10-24';
  assert.throws(()=>run(state,{type:'restoreTask',taskId:task.id,taskUpdatedAt:task.updatedAt,ownerId:'m1'}),/项目截止/);
  state=run(state,{type:'restoreTask',taskId:task.id,taskUpdatedAt:task.updatedAt,ownerId:'m1',due:'2026-10-24'});
  task=state.tasks.find(task=>task.id==='t6');assert.equal(task.status,'doing');assert.equal(task.needsResubmission,true);assert.equal(task.artifacts.length,1);assert.equal(before.tasks.find(task=>task.id==='t6').status,'canceled');
  assert.throws(()=>applyAction(state,{actorId:'m2',type:'createTask',title:'离开者发起',ownerId:'m1',reviewerId:'m0',deliverable:'成果'}),/离开/);
});

test('恢复新增依赖要求双方日期，保留既有取消前置但不将其当成完成',()=>{
  let state=run(seedState(),{type:'createTask',title:'新前置',ownerId:'m1',reviewerId:'m0',deliverable:'前置成果'});
  const predecessor=state.tasks.at(-1);state=cancel(state,'t6');
  const task=state.tasks.find(item=>item.id==='t6'),before=structuredClone(state);
  assert.throws(()=>run(state,{type:'restoreTask',taskId:task.id,taskUpdatedAt:task.updatedAt,dependsOn:[predecessor.id]}),/建立依赖前/);
  assert.deepEqual(state,before,'日期校验失败保留取消记录与原依赖');
  state=run(state,{type:'updateTask',taskId:predecessor.id,patch:{due:'2026-10-23'}});
  state=run(state,{type:'restoreTask',taskId:task.id,taskUpdatedAt:task.updatedAt,dependsOn:[predecessor.id]});
  assert.equal(state.tasks.find(item=>item.id===task.id).status,'review');assert.deepEqual(state.tasks.find(item=>item.id===task.id).dependsOn,[predecessor.id]);
  let legacy=cancel(seedState(),'t2');legacy=cancel(legacy,'t3');const dependent=legacy.tasks.find(item=>item.id==='t3');
  legacy=run(legacy,{type:'restoreTask',taskId:dependent.id,taskUpdatedAt:dependent.updatedAt,dependsOn:dependent.dependsOn});
  assert.ok(legacy.tasks.find(item=>item.id==='t3').dependsOn.includes('t2'));
  assert.equal(legacy.tasks.find(item=>item.id==='t2').status,'canceled');
  assert.ok(deriveProjectInsights(legacy,{today:'2026-10-23'}).signals.some(item=>item.taskId==='t3'&&item.type==='dependency_unfinished'&&item.title.includes('取消')));
});

test('取消不计有效进度/个人待办/期限/通知，依赖取消不能当完成，成果历史仍可查询',()=>{
  const state=cancel(seedState(),'t2'),user={id:'account',personId:'m2'},insights=deriveProjectInsights(state,{today:'2026-10-23'});
  assert.equal(insights.counts.total,5);assert.equal(insights.counts.recordedTotal,6);assert.equal(insights.counts.canceled,1);
  assert.ok(insights.signals.some(item=>item.taskId==='t3'&&item.type==='dependency_unfinished'&&item.title.includes('取消')));
  assert.ok(!insights.signals.some(item=>item.taskId==='t2'));assert.match(insights.brief.markdown,/已取消任务/);
  const dashboard=dashboardSummary(identity,[state],user,{query:'接口',now:new Date('2026-10-23T00:00:00Z')});assert.ok(!dashboard.sections.todo.some(task=>task.id==='t2'));assert.ok(!dashboard.search.tasks.some(task=>task.id==='t2'));
  assert.ok(!deriveNotifications(identity,[state],user,{now:new Date('2026-10-23')}).some(item=>item.taskId==='t2'));
  const detail=personDetails(identity,[state],user,'m2');assert.equal(detail.summary.canceledCount,1);assert.equal(detail.summary.taskCount,1);assert.ok(detail.tasks.some(task=>task.id==='t2'));
  const all=seedState();all.tasks=[state.tasks[1]];all.milestones=[];const empty=deriveProjectInsights(all,{today:'2026-10-23'});assert.equal(empty.counts.total,0);assert.equal(empty.health.label,'暂无有效任务');assert.ok(!JSON.stringify(empty).includes('100%'));
});

test('任一在职非只读成员可讨论和回复，讨论不改任务快照，提及必须项目有效成员且文本安全导出',()=>{
  let state=seedState(),snapshot=state.tasks[1].updatedAt;
  state=applyAction(state,{actorId:'m3',type:'addDiscussion',taskId:'t2',kind:'question',body:'验收步骤是什么？<script>x</script> [点击](https://example.invalid)',mentionIds:['m2'],expectedRevision:state.revision});
  const question=state.discussions[0];assert.equal(state.tasks[1].updatedAt,snapshot);assert.equal(question.authorId,'m3');assert.equal(question.resolved,false);
  state=applyAction(state,{actorId:'m2',type:'addDiscussion',taskId:'t2',body:'我会补充核对步骤。',replyTo:question.id,mentionIds:[]});
  assert.equal(state.discussions.length,2);assert.equal(state.tasks[1].updatedAt,snapshot);
  const report=projectReport(state);assert.ok(report.includes('&lt;script&gt;'));assert.ok(!report.includes('<script>'));assert.ok(report.includes('\\[点击\\]'));
  for(const input of [{actorId:'m1',type:'resolveDiscussion',discussionId:question.id},{actorId:'m1',type:'addDiscussion',taskId:'t3',replyTo:question.id,body:'跨任务回复'},{actorId:'m1',type:'addDiscussion',taskId:'t2',body:'跨项目提及',mentionIds:['foreign']}])assert.throws(()=>applyAction(state,input));
  state=applyAction(state,{actorId:'m3',type:'resolveDiscussion',discussionId:question.id});assert.equal(state.discussions[0].resolved.actorId,'m3');assert.equal(state.tasks[1].updatedAt,snapshot);
  const viewer=structuredClone(state);viewer.members.find(member=>member.id==='m1').accessRole='viewer';assert.throws(()=>applyAction(viewer,{actorId:'m1',type:'addDiscussion',taskId:'t2',body:'只读不能说话'}),error=>error.status===403);
  const inactive=structuredClone(state);inactive.members.find(member=>member.id==='m2').active=false;assert.throws(()=>applyAction(inactive,{actorId:'m1',type:'addDiscussion',taskId:'t2',body:'不能提及离开者',mentionIds:['m2']}),error=>error.status===403);
});

test('讨论通知有稳定真实来源，过滤自己/离开收件人/取消任务且保留历史作者，回复与提及定位原任务',()=>{
  let state=applyAction(seedState(),{actorId:'m3',type:'addDiscussion',taskId:'t2',body:'请确认',mentionIds:['m2']});
  const first=deriveNotifications(identity,[state],{id:'account',personId:'m2'}).find(item=>item.type==='mention');assert.ok(first);assert.ok(first.href.includes('tasks?task=t2&discussion='));assert.equal(first.discussionId,state.discussions[0].id);
  state=applyAction(state,{actorId:'m2',type:'addDiscussion',taskId:'t2',body:'自我提及不通知',mentionIds:['m2']});assert.equal(deriveNotifications(identity,[state],{id:'account',personId:'m2'}).filter(item=>item.type==='mention').length,1);
  state.members.find(member=>member.id==='m3').active=false;assert.ok(deriveNotifications(identity,[state],{id:'account',personId:'m2'}).some(item=>item.type==='mention'));
  state.members.find(member=>member.id==='m2').active=false;assert.equal(deriveNotifications(identity,[state],{id:'account',personId:'m2'}).length,0);state.members.find(member=>member.id==='m2').active=true;
  state.members.find(member=>member.id==='m3').active=true;state=cancel(state);assert.ok(!deriveNotifications(identity,[state],{id:'account',personId:'m2'}).some(item=>item.type==='mention'));
});

test('已取消任务不被AI重规划复活或删除，阶段验收排除取消但全取消不能当阶段完成',()=>{
  let state=cancel(seedState()),canceled=structuredClone(state.tasks[1]);
  const draft={title:'调整',summary:'保留历史',projectGoal:'明确下一步',assumptions:[],risks:[],questions:[],milestones:[],tasks:[]};
  const result=applyReplanDraft(state,{actorId:'m0',expectedRevision:state.revision,draft});assert.deepEqual(result.tasks.find(task=>task.id==='t2'),canceled);
  const illegal={...draft,tasks:[{id:'new',existingTaskId:'t2',title:'不准复活',description:'',ownerId:'m0',reviewerId:'m0',due:'2026-10-25',deliverable:'成果',dependsOn:[],milestoneId:'old'}]};
  assert.throws(()=>previewReplan(state,{actorId:'m0',expectedRevision:state.revision,draft:illegal}),/取消/);
  state.members.find(member=>member.id==='m2').active=false;const prompt=buildPlanningPrompt(state,{mode:'replan'});assert.ok(prompt.includes('已取消'));assert.ok(!JSON.parse(prompt.split('项目事实：\n')[1].split('\n\n返回交换')[0]).members.some(member=>member.id==='m2'));
  state.milestones=[{id:'phase',title:'有效交付',goal:'核对',due:'2026-10-27',acceptanceCriteria:'完成有效范围',status:'open'}];state.tasks[0].milestoneId='phase';state.tasks[1].milestoneId='phase';
  state=applyMilestoneAction(state,{actorId:'m0',type:'acceptMilestone',expectedRevision:state.revision,milestoneId:'phase',note:'取消项不冒充完成，核对其余交付'});assert.equal(state.milestones[0].status,'accepted');
  const onlyCanceled={...state,tasks:[state.tasks[1]],milestones:[{...state.milestones[0],status:'open',acceptedAt:''}]};assert.throws(()=>applyMilestoneAction(onlyCanceled,{actorId:'m0',type:'acceptMilestone',expectedRevision:onlyCanceled.revision,milestoneId:'phase',note:'不应通过'}),/至少关联/);
});

test('讨论有严格字段/长度/数量/版本边界，失败不改原记录，旧项目无discussions可直接使用',()=>{
  const original=seedState(),before=structuredClone(original);
  for(const input of [
    {body:'x'.repeat(4001)}, {body:'正常',authorId:'m1'}, {body:'正常',mentionIds:['m1','m1']},
    {body:'正常',mentionIds:Array.from({length:21},()=> 'm1')},{body:'正常',expectedRevision:original.revision-1}
  ])assert.throws(()=>run(original,{type:'addDiscussion',taskId:'t2',...input}));
  assert.deepEqual(original,before);
  const full=seedState();full.discussions=Array.from({length:200},(_,index)=>({id:'discussion-'+index,taskId:'t2',authorId:'m0',body:'已有讨论',kind:'comment',replyTo:null,mentionIds:[],createdAt:'2026-10-22T00:00:00Z',resolved:false}));
  assert.throws(()=>run(full,{type:'addDiscussion',taskId:'t2',body:'第201条'}),/上限/);assert.equal(full.discussions.length,200);
  const departed=seedState();departed.members.push(...Array.from({length:32},(_,index)=>({id:'old-'+index,name:'历史成员'+index,active:false})));
  assert.equal(run(departed,{type:'addMember',name:'新伙伴',role:'设计'}).members.length,37,'历史成员不占32个有效名额');
});
