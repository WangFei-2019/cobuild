import test from 'node:test';
import assert from 'node:assert/strict';
import {canAutoOpenGuide,guideProjectModel,mergeOnboardingSession} from '../src/onboarding-model.js';

test('自动指引只在安全概览出现，深链任务、设置和登录邀请流程不会被打断',()=>{
 for(const route of [{kind:'dashboard'},{kind:'projects'},{kind:'project',tab:'overview'}])assert.equal(canAutoOpenGuide(route),true);
 for(const route of [null,{kind:'login'},{kind:'register'},{kind:'setup'},{kind:'invite'},{kind:'settings'},{kind:'person'},
  {kind:'project',tab:'tasks'},{kind:'project',tab:'members'},{kind:'project',tab:'milestones'},
  {kind:'project',tab:'settings'},{kind:'project',tab:'overview',taskId:'task-with-a-draft'}])assert.equal(canAutoOpenGuide(route),false,JSON.stringify(route));
});

test('管理员、成员和只读用户分别看到可执行的分工入口与查看说明',()=>{
 const manager=guideProjectModel({permissions:{manageProject:true,createTask:true,readOnly:false}});
 assert.equal(manager.manager,true);assert.equal(manager.canCreateTask,true);
 assert.match(manager.actions.find(action=>action.key==='members').label,/邀请/);
 assert.match(manager.actions.find(action=>action.key==='milestones').label,/制定/);
 const member=guideProjectModel({permissions:{manageProject:false,createTask:true,readOnly:false}});
 assert.equal(member.manager,false);assert.equal(member.canCreateTask,true);
 assert.match(member.actions.find(action=>action.key==='members').label,/查看/);
 assert.match(member.actions.find(action=>action.key==='milestones').label,/查看/);
 const viewer=guideProjectModel({permissions:{manageProject:false,createTask:false,readOnly:true}});
 assert.equal(viewer.readOnly,true);assert.equal(viewer.canCreateTask,false);
 assert.ok(viewer.actions.every(action=>action.label.startsWith('查看')));
 const contradictory=guideProjectModel({permissions:{manageProject:true,createTask:true,readOnly:true}});
 assert.equal(contradictory.manager,false);assert.equal(contradictory.canCreateTask,false);
 assert.deepEqual(manager.actions.map(action=>action.tab),['tasks','members','milestones']);
});

test('尚无项目不生成行动模型，未知正式权限保守处理，演示明确区分本地人员与真实邀请',()=>{
 assert.equal(guideProjectModel(null),null);
 const unknown=guideProjectModel({id:'project-without-permissions'});
 assert.equal(unknown.readOnly,true);assert.equal(unknown.manager,false);assert.equal(unknown.canCreateTask,false);
 const demo=guideProjectModel({id:'local-project'},{demo:true});
 assert.equal(demo.manager,true);assert.equal(demo.canCreateTask,true);
 assert.match(demo.actions.find(action=>action.key==='members').label,/本地人员/);
 assert.match(demo.actions.find(action=>action.key==='members').description,/不产生真实账号/);
});

test('迟到保存结果不能覆盖已退出或切换账号的会话，也不能把已了解状态降级',()=>{
 const pending={version:1,status:'pending'},dismissed={version:1,status:'dismissed'},completed={version:1,status:'completed'};
 const accountA={user:{id:'account-a'},onboarding:pending},accountB={user:{id:'account-b'},onboarding:pending};
 const updated=mergeOnboardingSession(accountA,'account-a',dismissed);
 assert.deepEqual(updated.onboarding,dismissed);assert.deepEqual(accountA.onboarding,pending);
 assert.equal(mergeOnboardingSession(accountB,'account-a',completed),accountB);
 const loggedOut={user:null,onboarding:null};assert.equal(mergeOnboardingSession(loggedOut,'account-a',completed),loggedOut);
 const finished={user:{id:'account-a'},onboarding:completed};
 assert.deepEqual(mergeOnboardingSession(finished,'account-a',dismissed).onboarding,completed);
});
