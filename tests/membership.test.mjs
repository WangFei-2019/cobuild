import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes,createHash } from 'node:crypto';
import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';

const password='membership-isolated-password-2026';
async function fixture(t) {
  const dataDir=mkdtempSync(join(tmpdir(),'cobuild-membership-'));let server,base;
  async function start(){server=createApp({dataDir,publicUrl:'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
  async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await start();t.after(async()=>{await stop();rmSync(dataDir,{recursive:true,force:true});});
  function client(){let cookie='';return async(path,input,options={})=>{const response=await fetch(base+path,{method:options.method||(input===undefined?'GET':'POST'),headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text()};};}
  const admin=client(),setup=await admin('/api/auth/setup',{name:'平台管理员',email:'admin@membership.test',password});assert.equal(setup.status,200);
  async function register(name){const request=client(),result=await request('/api/auth/register',{name,email:`${name}@membership.test`,password});assert.equal(result.status,200);return{request,user:result.data.user};}
  const database=fn=>{const db=new DatabaseSync(join(dataDir,'identity.sqlite'));try{return fn(db);}finally{db.close();}};
  const snapshot=()=>({files:[readFileSync(join(dataDir,'workspace.json'),'utf8'),...readdirSync(join(dataDir,'projects')).sort().map(file=>[file,readFileSync(join(dataDir,'projects',file),'utf8')])],identity:database(db=>Object.fromEntries(['accounts','people','project_members','project_member_history','invitations','metadata'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))),uploads:readdirSync(join(dataDir,'files')).sort()});
  const state=async(request,id)=>{const result=await request(`/api/state?projectId=${id}`);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
  async function invite(owner,id,person,accessRole='member'){const result=await owner('/api/invitations',{projectId:id,personId:person.user.personId,accessRole});assert.equal(result.status,201,JSON.stringify(result.data));const token=new URL(result.data.invitation.url).pathname.split('/').at(-1);const accepted=await person.request('/api/invitations/accept',{token});assert.equal(accepted.status,200,JSON.stringify(accepted.data));return accepted.data.state.members.find(member=>member.personId===person.user.personId&&member.active!==false).id;}
  const action=async(request,id,type,fields={})=>request('/api/members/action',{projectId:id,expectedRevision:(await state(request,id)).revision,type,...fields});
  return{dataDir,admin,setup,register,client,database,snapshot,state,invite,action,restart:async()=>{await stop();await start();}};
}

test('最后真实管理员不能降级或退出，管理权只交给linked active协作者，self-target/readonly/版本严格校验',async t=>{
  const f=await fixture(t),a=await f.register('owner'),b=await f.register('successor'),c=await f.register('viewer');
  const project=(await a.request('/api/projects',{name:'管理员交接',members:[{name:'未绑定的分工'}]})).data.state,id=project.project.id;
  const bid=await f.invite(a.request,id,b),cid=await f.invite(a.request,id,c,'viewer');
  const before=f.snapshot();
  for(const input of[{type:'leaveProject'},{type:'setAccessRole',memberId:'m0',accessRole:'member'},{type:'setAccessRole',memberId:'m0',accessRole:'viewer',replacementMemberId:bid}]){const result=await f.action(a.request,id,input.type,input);assert.equal(result.status,409);assert.equal(result.data.code,'LAST_PROJECT_ADMIN');}
  assert.equal((await f.action(a.request,id,'setAccessRole',{memberId:'m1',accessRole:'admin'})).status,400);
  assert.equal((await f.action(a.request,id,'transferAdmin',{memberId:'m0',replacementMemberId:cid})).status,400);
  assert.equal((await f.action(c.request,id,'setAccessRole',{memberId:'m0',accessRole:'viewer'})).status,403);
  assert.equal((await f.action(a.request,id,'removeMember',{memberId:'m0'})).status,400);
  assert.equal((await f.action(b.request,id,'leaveProject',{memberId:'m0'})).status,403);assert.deepEqual(f.snapshot(),before);
  const impact=await a.request(`/api/members/impact?projectId=${id}&memberId=m0`);assert.equal(impact.data.lastAdmin,true);assert.equal(impact.data.adminCount,1);
  assert.equal(impact.data.replacements.find(member=>member.id===bid).eligibleForAdmin,true);assert.equal(impact.data.replacements.some(member=>member.id===cid),false);assert.equal(impact.data.replacements.find(member=>member.id==='m1').eligibleForAdmin,false);
  let result=await f.action(a.request,id,'transferAdmin',{memberId:'m0',replacementMemberId:bid});assert.equal(result.status,200);assert.equal(result.data.state.members.find(member=>member.id==='m0').accessRole,'member');assert.equal(result.data.state.permissions.manageProject,false);
  assert.equal((await f.action(b.request,id,'leaveProject')).data.code,'LAST_PROJECT_ADMIN');
  const stale=await b.request('/api/members/action',{projectId:id,expectedRevision:impact.data.revision,type:'removeMember',memberId:'m0'});assert.equal(stale.status,409);
  result=await f.action(a.request,id,'leaveProject');assert.equal(result.status,200);assert.equal(result.data.state,null);assert.equal((await a.request(`/api/state?projectId=${id}`)).status,403);
  await f.restart();assert.equal((await a.request(`/api/state?projectId=${id}`)).status,403);assert.equal((await f.state(b.request,id)).members.find(member=>member.id==='m0').active,false);
});

test('移除将全部未结束责任原子交给协作者，done/canceled及历史成果原样保留，旧表单失效且移出后文件不可读',async t=>{
  const f=await fixture(t),a=await f.register('owner'),b=await f.register('worker'),d=await f.register('replacement'),v=await f.register('viewer');
  const id=(await a.request('/api/projects',{name:'有成果的人员离开'})).data.state.project.id,bid=await f.invite(a.request,id,b),did=await f.invite(a.request,id,d),vid=await f.invite(a.request,id,v,'viewer');
  async function task(title,ownerId,reviewerId){const result=await a.request('/api/action',{projectId:id,type:'createTask',title,ownerId,reviewerId,deliverable:'可核对的交付说明'});assert.equal(result.status,200);return result.data.state.tasks.at(-1);}
  let owned=await task('待新负责人处理',bid,'m0');let result=await b.request('/api/action',{projectId:id,type:'submitArtifact',taskId:owned.id,name:'离开前文件',file:{name:'history.txt',base64:Buffer.from('historical bytes').toString('base64')}});assert.equal(result.status,200);owned=result.data.state.tasks.find(task=>task.id===owned.id);const url=owned.artifacts[0].url;
  let reviewed=await task('待新接收人核对','m0',bid);result=await a.request('/api/action',{projectId:id,type:'submitArtifact',taskId:reviewed.id,name:'已准备的说明',note:'负责人未变，仅更换接收人。'});reviewed=result.data.state.tasks.find(task=>task.id===reviewed.id);
  let done=await task('已完成不迁移',bid,bid);result=await b.request('/api/action',{projectId:id,type:'submitArtifact',taskId:done.id,name:'已完成成果',note:'保留原提交人'});done=result.data.state.tasks.find(task=>task.id===done.id);result=await b.request('/api/action',{projectId:id,type:'accept',taskId:done.id,taskUpdatedAt:done.updatedAt});done=result.data.state.tasks.find(task=>task.id===done.id);
  let canceled=await task('已取消不迁移',bid,bid),current=await f.state(a.request,id);result=await a.request('/api/action',{projectId:id,type:'cancelTask',taskId:canceled.id,taskUpdatedAt:canceled.updatedAt,expectedRevision:current.revision,reason:'范围变化'});assert.equal(result.status,200);canceled=result.data.state.tasks.find(task=>task.id===canceled.id);
  const impact=(await a.request(`/api/members/impact?projectId=${id}&memberId=${bid}`)).data;assert.equal(impact.responsibilities.tasks.length,2);
  const before=f.snapshot();assert.equal((await f.action(a.request,id,'removeMember',{memberId:bid})).status,400);assert.equal((await f.action(a.request,id,'removeMember',{memberId:bid,replacementMemberId:vid})).status,400);assert.deepEqual(f.snapshot(),before);
  result=await f.action(a.request,id,'removeMember',{memberId:bid,replacementMemberId:did});assert.equal(result.status,200);current=result.data.state;
  const left=current.members.find(member=>member.id===bid);assert.equal(left.active,false);assert.ok(left.leftAt);assert.equal(left.lastAccessRole,'member');
  const transferred=current.tasks.find(task=>task.id===owned.id);assert.equal(transferred.ownerId,did);assert.equal(transferred.status,'doing');assert.equal(transferred.needsResubmission,true);assert.deepEqual(transferred.artifacts,owned.artifacts);
  assert.equal(current.tasks.find(task=>task.id===reviewed.id).reviewerId,did);assert.equal(current.tasks.find(task=>task.id===reviewed.id).status,'review');assert.deepEqual(current.tasks.find(task=>task.id===done.id),done);assert.deepEqual(current.tasks.find(task=>task.id===canceled.id),canceled);
  const after=f.snapshot();assert.equal((await d.request('/api/action',{projectId:id,type:'accept',taskId:reviewed.id,taskUpdatedAt:reviewed.updatedAt})).status,409);assert.deepEqual(f.snapshot(),after);
  for(const path of[`/api/state?projectId=${id}`,`/api/export?projectId=${id}`,`/api/report?projectId=${id}`])assert.equal((await b.request(path)).status,403);assert.equal((await b.request(url)).status,404);assert.equal((await a.request(url)).data,'historical bytes');
  await b.request('/api/account',{name:'离开后新昵称'},{method:'PATCH'});current=await f.state(a.request,id);assert.equal(current.members.find(member=>member.id===bid).name,'worker');
  const newId=await f.invite(a.request,id,b,'viewer');assert.notEqual(newId,bid);current=await f.state(a.request,id);assert.equal(current.members.find(member=>member.id===bid).active,false);assert.equal(current.members.find(member=>member.id===newId).name,'离开后新昵称');assert.equal((await b.request(url)).status,200);
  await f.restart();current=await f.state(a.request,id);assert.equal(current.members.filter(member=>member.personId===b.user.personId&&member.active!==false).length,1);assert.equal(current.members.find(member=>member.id===bid).active,false);
});

test('降只读必须交接责任，过期邀请不能恢复权限；被降管理员发出的待接受邀请同步撤销',async t=>{
  const f=await fixture(t),a=await f.register('owner'),b=await f.register('worker'),d=await f.register('replacement');
  const id=(await a.request('/api/projects',{name:'权限及邀请撤销'})).data.state.project.id,bid=await f.invite(a.request,id,b,'admin'),did=await f.invite(a.request,id,d);
  const issued=await b.request('/api/invitations',{projectId:id,email:'future@membership.test'});assert.equal(issued.status,201);const token=new URL(issued.data.invitation.url).pathname.split('/').at(-1);
  const task=(await a.request('/api/action',{projectId:id,type:'createTask',title:'不能留给只读成员',ownerId:bid,reviewerId:bid,deliverable:'说明'})).data.state.tasks[0];
  const before=f.snapshot();assert.equal((await f.action(a.request,id,'setAccessRole',{memberId:bid,accessRole:'viewer'})).status,400);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.action(a.request,id,'setAccessRole',{memberId:bid,accessRole:'viewer',replacementMemberId:did})).status,200);
  assert.equal((await b.request('/api/action',{projectId:id,type:'addUpdate',taskId:task.id,text:'越过只读'})).status,403);
  assert.equal((await f.client()('/api/invitations/resolve?token='+token)).status,410);
  assert.equal((await f.client()('/api/auth/register',{name:'不能用旧授权注册',email:'future@membership.test',password,inviteToken:token})).status,410);
  assert.equal((await a.request('/api/invitations',{projectId:id,email:'worker@membership.test',accessRole:'admin'})).status,409);
  const legacyToken=randomBytes(32).toString('base64url');f.database(db=>db.prepare('INSERT INTO invitations(id,tokenHash,projectId,email,accessRole,createdBy,createdAt,expiresAt,status) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-v9-invite',createHash('sha256').update(legacyToken).digest('hex'),id,'worker@membership.test','admin',a.user.id,new Date().toISOString(),new Date(Date.now()+60000).toISOString(),'pending'));
  const stable=f.snapshot();assert.equal((await b.request('/api/invitations/accept',{token:legacyToken})).status,409);assert.deepEqual(f.snapshot(),stable);assert.equal((await f.state(b.request,id)).members.find(member=>member.id===bid).accessRole,'viewer');
});

test('明确退出的全局管理员不被ensureAdmin复活，保留只读治理和成员治理能力，不能冒充历史actor写普通任务',async t=>{
  const f=await fixture(t),b=await f.register('successor'),c=await f.register('futureadmin');
  const id=(await f.admin('/api/projects',{name:'治理与参与分离'})).data.state.project.id,bid=await f.invite(f.admin,id,b),cid=await f.invite(f.admin,id,c);
  assert.equal((await f.action(f.admin,id,'transferAdmin',{memberId:'m0',replacementMemberId:bid})).status,200);
  const left=await f.action(f.admin,id,'leaveProject');assert.equal(left.status,200);assert.equal(left.data.state.currentMemberId,null);assert.equal(left.data.state.permissions.manageProject,false);assert.equal(left.data.state.permissions.manageMembers,true);assert.equal(left.data.state.permissions.governance,true);
  const before=f.snapshot();for(let i=0;i<2;i++)await f.admin('/api/workspace');await f.restart();assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.admin('/api/action',{projectId:id,type:'createTask',title:'不能冒充退出前的我',ownerId:bid,reviewerId:bid,deliverable:'说明'})).status,403);
  const promoted=await f.action(f.admin,id,'setAccessRole',{memberId:cid,accessRole:'admin'});assert.equal(promoted.status,200);assert.equal(promoted.data.state.currentMemberId,null);assert.match(promoted.data.state.activities[0].text,/工作区管理员/);assert.equal(promoted.data.state.activities[0].actorId,'');
  assert.equal(f.database(db=>db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE projectId=? AND personId=?').get(id,f.setup.data.user.personId).n),0);
});

test('成员SQL或最终COMMIT失败回滚角色、历史映射、责任、邀请和JSON；恢复后不重建已离开的档案',async t=>{
  const f=await fixture(t),a=await f.register('owner'),b=await f.register('worker'),d=await f.register('replacement');
  const id=(await a.request('/api/projects',{name:'成员失败原子性'})).data.state.project.id,bid=await f.invite(a.request,id,b),did=await f.invite(a.request,id,d);
  await a.request('/api/action',{projectId:id,type:'createTask',title:'事务中的责任',ownerId:bid,reviewerId:bid,deliverable:'说明'});const before=f.snapshot();
  f.database(db=>db.exec("CREATE TRIGGER fail_leave BEFORE DELETE ON project_members BEGIN SELECT RAISE(ABORT,'fixture member delete failure'); END"));
  assert.equal((await f.action(a.request,id,'removeMember',{memberId:bid,replacementMemberId:did})).status,500);assert.deepEqual(f.snapshot(),before);f.database(db=>db.exec('DROP TRIGGER fail_leave'));
  f.database(db=>db.exec("CREATE TABLE deferred_member(accountId TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER DELETE ON project_members BEGIN INSERT INTO deferred_member VALUES('missing-fixture-account'); END"));
  assert.equal((await f.action(a.request,id,'removeMember',{memberId:bid,replacementMemberId:did})).status,500);assert.deepEqual(f.snapshot(),before);f.database(db=>db.exec('DROP TRIGGER fail_commit; DROP TABLE deferred_member;'));
  assert.equal((await f.action(a.request,id,'removeMember',{memberId:bid,replacementMemberId:did})).status,200);const removed=f.snapshot();await f.restart();assert.deepEqual(f.snapshot(),removed);assert.equal(f.database(db=>db.prepare('SELECT COUNT(*) AS n FROM people').get().n),4);assert.equal((await b.request(`/api/state?projectId=${id}`)).status,403);
});

test('示例成员固定，客户端身份和跨项目成员不能借生命周期接口改权限或交接',async t=>{
  const f=await fixture(t),a=await f.register('owner'),b=await f.register('outsider');
  const sample=(await a.request('/api/samples',{})).data.state,id=sample.project.id,before=f.snapshot();
  for(const type of['setAccessRole','transferAdmin','removeMember','leaveProject'])assert.equal((await f.action(a.request,id,type,{memberId:type==='leaveProject'?'m0':'m1',accessRole:'viewer',replacementMemberId:'m0'})).status,403);
  assert.equal((await b.request(`/api/members/impact?projectId=${id}&memberId=m0`)).status,403);
  assert.equal((await a.request('/api/members/action',{projectId:id,expectedRevision:sample.revision,type:'leaveProject',actorId:'m0'})).status,400);assert.deepEqual(f.snapshot(),before);
});
