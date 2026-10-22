import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cobuild-discussions-http-'));let server,base;
 async function start(){server=createApp({dataDir:dir,publicUrl:'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;}
 async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await start();t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
 function client(){let cookie='';return async(path,input)=>{const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text()};};}
 const password='discussions-isolated-fixture-2026',admin=client();assert.equal((await admin('/api/auth/setup',{name:'部署者',email:'admin@discussions.test',password})).status,200);
 async function register(name){const request=client(),result=await request('/api/auth/register',{name,email:name+'@discussions.test',password});assert.equal(result.status,200);return{request,user:result.data.user};}
 const owner=await register('owner'),receiver=await register('receiver'),viewer=await register('viewer'),foreign=await register('foreign');
 let state=(await owner.request('/api/projects',{name:'讨论与取消流程'})).data.state;const projectId=state.project.id;
 for(const [target,accessRole]of [[receiver,'member'],[viewer,'viewer']]){const offer=(await owner.request('/api/invitations',{projectId,personId:target.user.personId,accessRole})).data.invitation;assert.equal((await target.request('/api/invitations/accept',{token:new URL(offer.url).pathname.split('/').at(-1)})).status,200);}
 state=(await owner.request('/api/state?projectId='+projectId)).data;const reviewerId=state.members.find(member=>member.personId===receiver.user.personId).id;
 state=(await owner.request('/api/action',{projectId,type:'createTask',title:'需要接收人先澄清',ownerId:'m0',reviewerId,deliverable:'核对说明',due:'2030-12-15'})).data.state;
 return {owner,receiver,viewer,foreign,projectId,task:state.tasks[0],restart:async()=>{await stop();await start();}};
}

test('普通接收人可澄清/回复而非修改进度，viewer/外人/伪造作者被拒；讨论及通知重启后保留',async t=>{
 const {owner,receiver,viewer,foreign,projectId,task,restart}=await fixture(t);
 const comment={projectId,type:'addDiscussion',taskId:task.id,body:'请解释交付检查步骤',kind:'question',mentionIds:['m0']};
 for(const who of [viewer,foreign])assert.equal((await who.request('/api/action',comment)).status,403);
 assert.equal((await receiver.request('/api/action',{...comment,actorId:'m0'})).status,403);
 let result=await receiver.request('/api/action',comment);assert.equal(result.status,200);let state=result.data.state;const question=state.discussions[0];assert.equal(state.tasks[0].updatedAt,task.updatedAt);
 assert.equal((await owner.request('/api/notifications')).data.items.some(item=>item.type==='mention'&&item.taskId===task.id),true);
 result=await owner.request('/api/action',{projectId,type:'addDiscussion',taskId:task.id,body:'我会补上明确的核对方法',replyTo:question.id});assert.equal(result.status,200);
 assert.ok((await receiver.request('/api/notifications')).data.items.some(item=>item.type==='reply'&&item.taskId===task.id));
 result=await receiver.request('/api/action',{projectId,type:'resolveDiscussion',discussionId:question.id});assert.equal(result.status,200);assert.ok(result.data.state.discussions[0].resolved);
 await restart();state=(await receiver.request('/api/state?projectId='+projectId)).data;assert.equal(state.discussions.length,2);assert.equal(state.tasks[0].updatedAt,task.updatedAt);assert.ok(state.discussions[0].resolved);
 assert.match((await owner.request('/api/report?projectId='+projectId)).data,/任务讨论与问题/);
});

test('取消和恢复由真实管理权限限制，取消隐藏日常事项但保留讨论/成果与恢复历史',async t=>{
 const {owner,receiver,viewer,projectId,task,restart}=await fixture(t);
 for(const who of[receiver,viewer])assert.equal((await who.request('/api/action',{projectId,type:'cancelTask',taskId:task.id,taskUpdatedAt:task.updatedAt,reason:'越权取消'})).status,403);
 assert.equal((await owner.request('/api/action',{projectId,type:'cancelTask',taskId:task.id,reason:'没有快照'})).status,409);
 let result=await owner.request('/api/action',{projectId,type:'cancelTask',taskId:task.id,taskUpdatedAt:task.updatedAt,reason:'范围明确取消，保留原始约定'});assert.equal(result.status,200);let state=result.data.state;
 assert.equal((await owner.request('/api/workspace')).data.projects.find(item=>item.id===projectId).taskCount,0);
 assert.equal((await owner.request('/api/notifications')).data.items.some(item=>item.taskId===task.id),false);
 assert.equal((await owner.request('/api/dashboard?q=澄清')).data.search.total,0);
 assert.equal((await receiver.request('/api/action',{projectId,type:'addDiscussion',taskId:task.id,body:'取消原因已理解'})).status,200);
 assert.equal((await owner.request('/api/action',{projectId,type:'setStatus',taskId:task.id,status:'doing'})).status,409);
 await restart();state=(await owner.request('/api/state?projectId='+projectId)).data;assert.equal(state.tasks[0].status,'canceled');assert.equal(state.discussions.length,1);
 result=await owner.request('/api/action',{projectId,type:'restoreTask',taskId:task.id,taskUpdatedAt:state.tasks[0].updatedAt});assert.equal(result.status,200);assert.equal(result.data.state.tasks[0].status,'todo');assert.ok(result.data.state.tasks[0].cancelHistory[0].restoredAt);
});
