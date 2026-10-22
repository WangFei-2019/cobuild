import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const dataDir=mkdtempSync(join(tmpdir(),'cobuild-product-journey-')),password='product-journey-isolated-2026';
  const server=createApp({dataDir,publicUrl:'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});});
  function client() { let cookie='';return async(path,input)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,data:(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text()};
  };}
  const admin=client();assert.equal((await admin('/api/auth/setup',{name:'部署管理员',email:'admin@journey.test',password})).status,200);
  async function register(name) {const request=client(),result=await request('/api/auth/register',{name,email:`${name}@journey.test`,password});assert.equal(result.status,200);return {request,user:result.data.user};}
  const database=fn=>{const db=new DatabaseSync(join(dataDir,'identity.sqlite'));try{return fn(db);}finally{db.close();}};
  const snapshot=()=>({files:[readFileSync(join(dataDir,'workspace.json'),'utf8'),...readdirSync(join(dataDir,'projects')).sort().map(file=>[file,readFileSync(join(dataDir,'projects',file),'utf8')])],uploads:readdirSync(join(dataDir,'files')).sort(),journals:existsSync(join(dataDir,'.transactions'))?readdirSync(join(dataDir,'.transactions')).sort():[],identity:database(db=>Object.fromEntries(['accounts','people','project_members','invitations','metadata','sessions'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])))});
  async function invite(owner,projectId,person,accessRole) {
    const result=await owner('/api/invitations',{projectId,personId:person.user.personId,accessRole});assert.equal(result.status,201);
    const token=new URL(result.data.invitation.url).pathname.split('/').at(-1);
    const accepted=await person.request('/api/invitations/accept',{token});assert.equal(accepted.status,200);return accepted.data.state;
  }
  return {dataDir,admin,register,database,snapshot,invite,client,password};
}

test('真实多人旅程：邀请→受阻→交付退回→新版确认→阶段验收，所有角色与旧快照由服务端约束',async t=>{
  const {register,snapshot,invite}=await fixture(t),a=await register('manager'),b=await register('worker'),c=await register('viewer'),d=await register('outsider');
  let state=(await a.request('/api/projects',{name:'多人交付旅程',goal:'经指定接收人确认后再验收阶段',deadline:'2030-12-20'})).data.state;const id=state.project.id;
  state=await invite(a.request,id,b,'member');state=await invite(a.request,id,c,'viewer');
  const worker=state.members.find(member=>member.personId===b.user.personId).id;
  let result=await a.request('/api/milestones/action',{projectId:id,type:'createMilestone',expectedRevision:state.revision,title:'可检查的交付',goal:'完成两次核对',due:'2030-12-15',acceptanceCriteria:'交付物明确，指定接收人已确认'});assert.equal(result.status,200);state=result.data.state;
  const milestoneId=state.milestones[0].id;
  result=await a.request('/api/action',{projectId:id,type:'createTask',title:'伙伴交付文档',ownerId:worker,reviewerId:'m0',due:'2030-12-10',milestoneId,deliverable:'有检查步骤的说明文件'});assert.equal(result.status,200);state=result.data.state;let task=state.tasks[0];
  result=await b.request('/api/action',{projectId:id,type:'setStatus',taskId:task.id,taskUpdatedAt:task.updatedAt,status:'blocked',blocker:'等待说明补齐'});assert.equal(result.status,200);task=result.data.state.tasks[0];
  assert.equal((await b.request('/api/dashboard')).data.sections.blocked[0].id,task.id);
  const beforeReadonly=snapshot();
  for(const [path,input] of [
    ['/api/action',{projectId:id,type:'submitArtifact',taskId:task.id,name:'越权文件',file:{name:'forbidden.txt',base64:Buffer.from('forbidden').toString('base64')}}],
    ['/api/action',{projectId:id,type:'accept',taskId:task.id}],
    ['/api/milestones/action',{projectId:id,type:'acceptMilestone',milestoneId,expectedRevision:state.revision,note:'不应允许'}],
    ['/api/ai/replan',{projectId:id,goal:'越权改计划'}]
  ]) assert.equal((await c.request(path,input)).status,403,path);
  assert.deepEqual(snapshot(),beforeReadonly);
  result=await b.request('/api/action',{projectId:id,type:'submitArtifact',taskId:task.id,taskUpdatedAt:task.updatedAt,name:'第一版文件',file:{name:'handoff.txt',base64:Buffer.from('version one').toString('base64')}});assert.equal(result.status,200);state=result.data.state;task=state.tasks[0];
  const firstVersion=task.updatedAt,fileUrl=task.artifacts[0].url,beforeWrong=snapshot();
  assert.equal((await b.request('/api/action',{projectId:id,type:'accept',taskId:task.id,taskUpdatedAt:task.updatedAt})).status,403);
  assert.deepEqual(snapshot(),beforeWrong);assert.equal((await c.request(fileUrl)).data,'version one');assert.equal((await d.request(fileUrl)).status,404);
  assert.equal((await d.request(`/api/export?projectId=${id}`)).status,403);
  result=await a.request('/api/action',{projectId:id,type:'requestChanges',taskId:task.id,taskUpdatedAt:task.updatedAt,reason:'补充检查步骤'});assert.equal(result.status,200);task=result.data.state.tasks[0];
  result=await b.request('/api/action',{projectId:id,type:'submitArtifact',taskId:task.id,taskUpdatedAt:task.updatedAt,name:'按意见补齐的第二版',note:'检查步骤已补齐，第一版仍保留追溯。'});assert.equal(result.status,200);state=result.data.state;task=state.tasks[0];
  const beforeStale=snapshot();
  assert.equal((await a.request('/api/action',{projectId:id,type:'accept',taskId:task.id,taskUpdatedAt:firstVersion})).status,409);assert.deepEqual(snapshot(),beforeStale);
  result=await a.request('/api/action',{projectId:id,type:'accept',taskId:task.id,taskUpdatedAt:task.updatedAt});assert.equal(result.status,200);state=result.data.state;
  result=await a.request('/api/milestones/action',{projectId:id,type:'acceptMilestone',milestoneId,expectedRevision:state.revision,note:'已核对最新成果与交接'});assert.equal(result.status,200);state=result.data.state;
  assert.equal(state.milestones[0].status,'accepted');assert.equal(state.tasks[0].status,'done');assert.equal(state.tasks[0].artifacts.length,2);
  assert.equal((await b.request('/api/dashboard')).data.summary.todo,0);assert.equal((await a.request('/api/dashboard')).data.summary.toReview,0);
  const exported=await c.request(`/api/export?projectId=${id}`);assert.equal(exported.status,200);assert.equal(exported.data.tasks[0].artifacts.length,2);
  const report=await b.request(`/api/report?projectId=${id}`);assert.equal(report.status,200);assert.match(report.data,/可检查的交付/);assert.match(report.data,/已核对最新成果与交接/);
  const profile=(await a.request(`/api/people/${b.user.personId}`)).data;assert.equal(profile.artifacts[0].acceptanceStatus,'accepted');assert.equal(profile.artifacts[1].acceptanceStatus,'historical');
});

test('接受邀请时成员SQL写入失败不得留下JSON孤立成员或消耗邀请',async t=>{
  const {register,database,snapshot}=await fixture(t),a=await register('manager'),b=await register('worker');
  const state=(await a.request('/api/projects',{name:'邀请原子性验证'})).data.state,id=state.project.id;
  const offer=await a.request('/api/invitations',{projectId:id,personId:b.user.personId}),token=new URL(offer.data.invitation.url).pathname.split('/').at(-1),before=snapshot();
  database(db=>db.exec("CREATE TRIGGER fail_join BEFORE INSERT ON project_members BEGIN SELECT RAISE(ABORT,'fixture join failure'); END"));
  assert.equal((await b.request('/api/invitations/accept',{token})).status,500);
  assert.deepEqual(snapshot(),before,'failed invite acceptance must restore both JSON/index and SQLite');
  database(db=>db.exec('DROP TRIGGER fail_join'));
  assert.equal((await b.request('/api/invitations/accept',{token})).status,200);
  assert.equal((await a.request(`/api/state?projectId=${id}`)).data.members.length,2);
});

test('SQL最终COMMIT失败补偿已写JSON，邀请注册不留账号/会话；scrypt等待期间其他项目合法更新不被覆盖',async t=>{
  const {register,client,password,database,snapshot}=await fixture(t),a=await register('manager'),b=await register('worker'),visitor=client();
  const state=(await a.request('/api/projects',{name:'提交失败须补偿的项目'})).data.state,id=state.project.id;
  const other=(await a.request('/api/projects',{name:'并发合法编辑的项目'})).data.state;
  const offer=await a.request('/api/invitations',{projectId:id,personId:b.user.personId}),token=new URL(offer.data.invitation.url).pathname.split('/').at(-1);
  const newOffer=await a.request('/api/invitations',{projectId:id,email:'new@journey.test'}),newToken=new URL(newOffer.data.invitation.url).pathname.split('/').at(-1);
  database(db=>db.exec(`CREATE TABLE fixture_deferred(accountId TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_final_commit AFTER UPDATE OF status ON invitations WHEN NEW.status='accepted'
    BEGIN INSERT INTO fixture_deferred VALUES('missing-fixture-account'); END;`));
  const before=snapshot();
  assert.equal((await b.request('/api/invitations/accept',{token})).status,500);
  assert.deepEqual(snapshot(),before,'COMMIT failure must compensate a JSON effect that already succeeded');
  const input={name:'new-user',email:'new@journey.test',password,inviteToken:newToken};
  assert.equal((await visitor('/api/auth/register',input)).status,500);assert.deepEqual(snapshot(),before);
  const [failed,edited]=await Promise.all([visitor('/api/auth/register',input),a.request('/api/action',{projectId:other.project.id,type:'updateProject',patch:{description:'另一项目的合法修改必须保留'}})]);
  assert.equal(failed.status,500);assert.equal(edited.status,200);
  assert.deepEqual(snapshot().identity,before.identity);assert.deepEqual(snapshot().uploads,before.uploads);
  assert.equal((await a.request(`/api/state?projectId=${id}`)).data.members.length,1);
  assert.equal((await a.request(`/api/state?projectId=${other.project.id}`)).data.project.description,'另一项目的合法修改必须保留');
  database(db=>db.exec('DROP TRIGGER fail_final_commit; DROP TABLE fixture_deferred;'));
  assert.equal((await visitor('/api/auth/register',input)).status,200);
  assert.equal((await a.request(`/api/state?projectId=${id}`)).data.members.length,2);
});

test('普通项目创建和添加成员的identity失败同样回滚文件、索引、目录，成功重试不产生重复档案',async t=>{
  const {register,database,snapshot}=await fixture(t),a=await register('manager');
  const before=snapshot();
  database(db=>db.exec("CREATE TRIGGER fail_member BEFORE INSERT ON project_members BEGIN SELECT RAISE(ABORT,'fixture member sync failure'); END"));
  assert.equal((await a.request('/api/projects',{name:'不该留下的项目'})).status,500);assert.deepEqual(snapshot(),before);
  database(db=>db.exec('DROP TRIGGER fail_member'));
  const created=await a.request('/api/projects',{name:'正常项目'});assert.equal(created.status,201);const state=created.data.state,id=state.project.id,existing=snapshot();
  database(db=>db.exec("CREATE TRIGGER fail_member BEFORE INSERT ON project_members BEGIN SELECT RAISE(ABORT,'fixture member sync failure'); END"));
  assert.equal((await a.request('/api/action',{projectId:id,type:'addMember',name:'尚未开户的新分工'})).status,500);assert.deepEqual(snapshot(),existing);
  database(db=>db.exec('DROP TRIGGER fail_member'));
  assert.equal((await a.request('/api/action',{projectId:id,type:'addMember',name:'尚未开户的新分工'})).status,200);
  assert.equal((await a.request(`/api/state?projectId=${id}`)).data.members.length,2);
});
