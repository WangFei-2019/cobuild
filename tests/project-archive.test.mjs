import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {createWorkspace} from '../workspace.mjs';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cobuild-archive-'));let server,base;
 async function start(){server=createApp({dataDir:dir,publicUrl:'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await start();t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
 function client(){let cookie='';return async(path,input)=>{const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text()};};}
 const password='archive-isolated-test-password',admin=client();assert.equal((await admin('/api/auth/setup',{name:'部署管理员',email:'admin@archive.test',password})).status,200);
 async function register(name){const request=client(),r=await request('/api/auth/register',{name,email:name+'@archive.test',password});assert.equal(r.status,200);return {request,user:r.data.user};}
 return {dir,admin,register,client,restart:async()=>{await stop();await start();}};
}

test('真实项目归档按管理权限，普通成员可见归档但不可恢复，原文件/成果保存且正常入口全部隐藏',async t=>{
 const {dir,admin,register,restart}=await fixture(t),owner=await register('owner'),worker=await register('worker'),outsider=await register('outsider');
 let state=(await owner.request('/api/projects',{name:'真实归档验证'})).data.state;const id=state.project.id;
 const offer=(await owner.request('/api/invitations',{projectId:id,personId:worker.user.personId})).data.invitation,token=new URL(offer.url).pathname.split('/').at(-1);
 state=(await worker.request('/api/invitations/accept',{token})).data.state;const workerId=state.members.find(member=>member.personId===worker.user.personId).id;
 state=(await owner.request('/api/action',{projectId:id,type:'createTask',title:'需要伙伴交付',ownerId:workerId,reviewerId:'m0',due:'2030-01-01',deliverable:'核对文件'})).data.state;
 const task=state.tasks[0];state=(await worker.request('/api/action',{projectId:id,type:'submitArtifact',taskId:task.id,name:'实际成果',file:{name:'proof.txt',base64:Buffer.from('preserved').toString('base64')}})).data.state;
 const url=state.tasks[0].artifacts[0].url,bytes=readFileSync(join(dir,'projects',id+'.json'));
 assert.equal((await owner.request('/api/notifications')).data.items.filter(item=>item.type==='review').length,1);
 assert.equal((await outsider.request('/api/projects/archive',{projectId:id,expectedRevision:state.revision})).status,403);
 assert.equal((await worker.request('/api/projects/archive',{projectId:id,expectedRevision:state.revision})).status,403);
 assert.equal((await owner.request('/api/projects/archive',{projectId:id,expectedRevision:state.revision-1})).status,409);
 let r=await owner.request('/api/projects/archive',{projectId:id,expectedRevision:state.revision});assert.equal(r.status,200);assert.equal(r.data.archivedProject.canRestore,true);assert.equal(r.data.workspace.projects.length,0);
 assert.deepEqual(readFileSync(join(dir,'projects',id+'.json')),bytes);
 for(const path of [`/api/state?projectId=${id}`,`/api/report?projectId=${id}`,`/api/export?projectId=${id}`,url])assert.equal((await owner.request(path)).status,404,path);
 assert.equal((await owner.request('/api/notifications')).data.total,0);assert.equal((await owner.request('/api/dashboard?q=伙伴')).data.search.total,0);
 const workerArchive=(await worker.request('/api/workspace')).data.archivedProjects;assert.equal(workerArchive.length,1);assert.equal(workerArchive[0].canRestore,false);
 assert.equal((await outsider.request('/api/workspace')).data.archivedProjects.length,0);assert.equal((await worker.request('/api/projects/restore',{projectId:id})).status,403);
 await restart();r=await owner.request('/api/projects/restore',{projectId:id});assert.equal(r.status,200);assert.equal(r.data.restored,true);assert.deepEqual(readFileSync(join(dir,'projects',id+'.json')),bytes);
 assert.equal((await worker.request(url)).data,'preserved');assert.equal((await owner.request('/api/projects/restore',{projectId:id})).data.reused,true);
 // The platform governance administrator may manage real projects, while sample ownership stays separate.
 const governed=(await admin(`/api/state?projectId=${id}`)).data;
 assert.equal((await admin('/api/projects/archive',{projectId:id,expectedRevision:governed.revision})).status,200);
 assert.equal((await admin('/api/projects/restore',{projectId:id})).status,200);
 const sample=(await owner.request('/api/samples',{})).data.state;
 assert.equal((await admin('/api/projects/archive',{projectId:sample.project.id,expectedRevision:sample.revision})).status,403);
 assert.equal((await admin('/api/samples/archive',{projectId:sample.project.id,expectedRevision:sample.revision})).status,403);
});

test('站内已读仅当前账号持久，归档/失权ID不能借read写入，未登录401',async t=>{
 const {register,client,restart}=await fixture(t),owner=await register('owner'),other=await register('other');
 const sample=(await owner.request('/api/samples',{})).data.state;
 const before=(await owner.request('/api/notifications')).data;assert.ok(before.unreadCount>0);assert.equal((await other.request('/api/notifications')).data.total,0);
 assert.equal((await client()('/api/notifications')).status,401);
 const item=before.items[0];let r=await owner.request('/api/notifications/read',{ids:[item.id]});assert.equal(r.status,200);assert.equal(r.data.unreadCount,before.unreadCount-1);
 assert.equal((await other.request('/api/notifications/read',{ids:[item.id]})).status,404);
 await restart();assert.equal((await owner.request('/api/notifications')).data.unreadCount,before.unreadCount-1);
 assert.equal((await owner.request('/api/notifications/read',{all:true})).data.unreadCount,0);
 await owner.request('/api/samples/archive',{projectId:sample.project.id,expectedRevision:sample.revision});
 assert.equal((await owner.request('/api/notifications/read',{ids:[item.id]})).status,404);
 await owner.request('/api/samples/restore',{projectId:sample.project.id});assert.equal((await owner.request('/api/notifications')).data.unreadCount,0);
});

test('历史project.json也能归档并重开恢复，项目revision及原字节保持不变',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cobuild-archive-legacy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let ws=createWorkspace(dir,{seedDemo:true}),state=ws.allStates()[0],bytes=readFileSync(join(dir,'project.json'));
 ws.archiveProject(state.project.id,{expectedRevision:state.revision});ws=createWorkspace(dir);
 assert.equal(ws.allStates().length,0);assert.equal(ws.archivedEntries().length,1);assert.deepEqual(readFileSync(join(dir,'project.json')),bytes);
 ws.restoreProject(state.project.id);assert.equal(ws.state().revision,state.revision);assert.deepEqual(readFileSync(join(dir,'project.json')),bytes);
});
