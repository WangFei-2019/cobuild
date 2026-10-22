import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createApp} from '../server.mjs';

test('真实协作整合：讨论提及→取消→成员离开→换人恢复→重新交付→交接管理权→重启与重新加入',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'cobuild-team-workflow-')),password='team-workflow-fixture-2026';let server,base;
 async function start(){server=createApp({dataDir,publicUrl:''});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;}
 async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await start();t.after(async()=>{await stop();rmSync(dataDir,{recursive:true,force:true});});
 function client(){let cookie='';return async(path,input)=>{const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text()};};}
 const admin=client();assert.equal((await admin('/api/auth/setup',{name:'测试部署管理员',email:'admin@team-workflow.test',password})).status,200);
 const users={},clients={};for(const name of ['owner','worker','reviewer','viewer','outsider']){clients[name]=client();users[name]=(await clients[name]('/api/auth/register',{name,email:name+'@team-workflow.test',password})).data.user;}
 const a=clients.owner,b=clients.worker,c=clients.reviewer,v=clients.viewer,o=clients.outsider;
 let state=(await a('/api/projects',{name:'跨模块交接集成'})).data.state;const projectId=state.project.id;
 async function invite(name,role='member'){const offered=await a('/api/invitations',{projectId,personId:users[name].personId,accessRole:role});assert.equal(offered.status,201);const accepted=await clients[name]('/api/invitations/accept',{token:new URL(offered.data.invitation.url).pathname.split('/').at(-1)});assert.equal(accepted.status,200);return accepted.data.state;}
 state=await invite('worker');state=await invite('reviewer');state=await invite('viewer','viewer');
 const workerId=state.members.find(m=>m.personId===users.worker.personId).id,reviewerId=state.members.find(m=>m.personId===users.reviewer.personId).id;
 state=(await a('/api/action',{projectId,type:'createTask',title:'保留成果、明确接收的任务',ownerId:workerId,reviewerId,deliverable:'有检查步骤的说明',due:'2030-12-15'})).data.state;let task=state.tasks[0];
 state=(await b('/api/action',{projectId,type:'submitArtifact',taskId:task.id,taskUpdatedAt:task.updatedAt,name:'原成员的第一版',file:{name:'handoff.txt',base64:Buffer.from('first preserved document').toString('base64')}})).data.state;task=state.tasks[0];const firstFile=task.artifacts[0].url,firstVersion=task.updatedAt;
 let result=await c('/api/action',{projectId,type:'addDiscussion',taskId:task.id,kind:'question',body:'接收前请说明检查步骤。',mentionIds:[workerId]});assert.equal(result.status,200);state=result.data.state;const question=state.discussions[0];assert.equal(state.tasks[0].updatedAt,firstVersion);
 assert.ok((await b('/api/notifications')).data.items.some(n=>n.type==='mention'&&n.taskId===task.id));
 result=await b('/api/action',{projectId,type:'addDiscussion',taskId:task.id,body:'将在新版本补齐检查步骤。',replyTo:question.id});assert.equal(result.status,200);state=result.data.state;
 assert.ok((await c('/api/notifications')).data.items.some(n=>n.type==='reply'&&n.taskId===task.id));
 for(const request of[v,o])assert.equal((await request('/api/action',{projectId,type:'addDiscussion',taskId:task.id,body:'越权输入'})).status,403);
 state=(await a('/api/action',{projectId,type:'cancelTask',taskId:task.id,taskUpdatedAt:task.updatedAt,reason:'范围调整，稍后重新确认'})).data.state;assert.equal(state.tasks[0].status,'canceled');assert.equal(readdirSync(join(dataDir,'files')).length,1);
 const impact=(await a(`/api/members/impact?projectId=${projectId}&memberId=${workerId}`)).data;assert.equal(impact.responsibilities.tasks.length,0);
 result=await a('/api/members/action',{projectId,expectedRevision:state.revision,type:'removeMember',memberId:workerId});assert.equal(result.status,200);state=result.data.state;assert.equal(state.members.find(m=>m.id===workerId).active,false);
 assert.equal((await b('/api/state?projectId='+projectId)).status,403);assert.equal((await b(firstFile)).status,404);
 result=await a('/api/action',{projectId,type:'restoreTask',taskId:task.id,taskUpdatedAt:state.tasks[0].updatedAt,ownerId:'m0',reviewerId});assert.equal(result.status,200);state=result.data.state;task=state.tasks[0];assert.equal(task.status,'doing');assert.equal(task.needsResubmission,true);assert.equal(task.artifacts[0].submittedBy,workerId);
 assert.ok((await c('/api/notifications')).data.items.some(n=>n.type==='reply'),'historical legitimate reply remains visible to current recipient after author leaves');
 result=await a('/api/members/action',{projectId,expectedRevision:state.revision,type:'transferAdmin',memberId:'m0',replacementMemberId:reviewerId});assert.equal(result.status,200);state=result.data.state;
 assert.equal((await a('/api/action',{projectId,type:'cancelTask',taskId:task.id,taskUpdatedAt:task.updatedAt,reason:'不应有权限'})).status,403);
 state=(await a('/api/action',{projectId,type:'submitArtifact',taskId:task.id,taskUpdatedAt:task.updatedAt,name:'新负责人重交的第二版',note:'明确检查步骤，第一版留存。'})).data.state;
 state=(await c('/api/action',{projectId,type:'accept',taskId:task.id,taskUpdatedAt:state.tasks[0].updatedAt})).data.state;assert.equal(state.tasks[0].status,'done');
 assert.equal((await c('/api/action',{projectId,type:'cancelTask',taskId:task.id,taskUpdatedAt:state.tasks[0].updatedAt,reason:'不能取消已确认成果'})).status,409);
 assert.equal((await c('/api/members/action',{projectId,expectedRevision:state.revision,type:'leaveProject'})).status,409);
 state=(await c('/api/members/action',{projectId,expectedRevision:state.revision,type:'setAccessRole',memberId:'m0',accessRole:'admin'})).data.state;
 assert.equal((await c('/api/members/action',{projectId,expectedRevision:state.revision,type:'leaveProject'})).status,200);
 await stop();await start();state=(await a('/api/state?projectId='+projectId)).data;assert.equal(state.members.find(m=>m.id===workerId).active,false);assert.equal(state.members.find(m=>m.id===reviewerId).active,false);assert.equal(state.tasks[0].artifacts.length,2);assert.equal((await a(firstFile)).data,'first preserved document');assert.equal((await c('/api/state?projectId='+projectId)).status,403);
 state=await invite('worker');const rejoined=state.members.find(m=>m.personId===users.worker.personId&&m.active!==false);assert.notEqual(rejoined.id,workerId);assert.equal(state.members.find(m=>m.id===workerId).active,false);
 const profile=(await a('/api/people/'+users.worker.personId)).data;assert.equal(profile.summary.projectCount,1);assert.equal(profile.projects.length,1);assert.equal(profile.artifacts.filter(f=>f.url===firstFile).length,1);assert.equal(new Set(profile.tasks.map(t=>t.project.id+':'+t.id)).size,profile.tasks.length);
});
