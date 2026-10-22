import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { createWorkspace } from '../workspace.mjs';
import { sampleProjectInput, buildSampleState, markSampleState } from '../sample.mjs';

const password = 'sample-isolated-fixture-2026';
async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(),'cobuild-samples-'));
  let server, base;
  async function start() {
    server=createApp({dataDir,publicUrl:'',setupToken:''}); server.listen(0,'127.0.0.1'); await once(server,'listening');
    base=`http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  await start(); t.after(async()=>{await stop();rmSync(dataDir,{recursive:true,force:true});});
  function client() {
    let cookie='';
    return async (path,input,extra={})=>{
      const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'}),...extra},...(input===undefined?{}:{body:JSON.stringify(input)})});
      if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
      const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text();
      return {status:response.status,data};
    };
  }
  const admin=client(); assert.equal((await admin('/api/auth/setup',{name:'样例管理员',email:'admin@samples.test',password})).status,200);
  const register=async name=>{const request=client(),response=await request('/api/auth/register',{name,email:`${name}@samples.test`,password});assert.equal(response.status,200);return {request,user:response.data.user};};
  const database=fn=>{const db=new DatabaseSync(join(dataDir,'identity.sqlite'));try{return fn(db);}finally{db.close();}};
  const identityRows=()=>database(db=>Object.fromEntries(['people','accounts','project_members','invitations','metadata'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const bytes=()=>[readFileSync(join(dataDir,'workspace.json'),'utf8'),...readdirSync(join(dataDir,'projects')).sort().map(file=>[file,readFileSync(join(dataDir,'projects',file),'utf8')])];
  return {dataDir,admin,client,register,database,identityRows,bytes,restart:async()=>{await stop();await start();}};
}

test('样例模板使用真实交接与里程碑规则，合成虚拟伙伴不产生账号，默认空白工作区保持不变',t=>{
  const dir=mkdtempSync(join(tmpdir(),'cobuild-template-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const workspace=createWorkspace(dir);assert.deepEqual(workspace.allStates(),[]);
  const base=workspace.create(sampleProjectInput('本人')).state;
  const state=buildSampleState(base,{today:'2026-10-22'});
  assert.deepEqual(state.tasks.map(task=>task.status),['done','todo','review','blocked']);
  assert.deepEqual(state.milestones.map(item=>item.status),['accepted','open']);
  assert.equal(state.members[1].virtual,true);assert.ok(state.tasks[0].acceptedAt);
  assert.equal(state.tasks[1].ownerId,'m0');assert.equal(state.tasks[2].reviewerId,'m0');
  assert.equal(state.project.deadline,'2026-10-29');assert.deepEqual(base.tasks,[]);
  assert.throws(()=>buildSampleState(base,{today:'2026-99-22'}),/日期/);
});

test('并发创建最多一个专属样例；可信归属不公开、不允许客户端伪造或授权真实伙伴',async t=>{
  const {admin,register,identityRows,bytes}=await fixture(t),a=await register('a'),b=await register('b');
  const created=await Promise.all([a.request('/api/samples',{}),a.request('/api/samples',{})]);
  assert.deepEqual(created.map(result=>result.status).sort(),[200,201]);
  const sample=created[0].data.state,id=sample.project.id;
  assert.equal(created[1].data.state.project.id,id);assert.equal(created.filter(result=>result.data.reused).length,1);
  assert.deepEqual(sample.sample,{version:1,canArchive:true});assert.equal(sample.currentMemberId,'m0');assert.equal(sample.permissions.manageMembers,false);
  assert.equal(sample.members[0].personId,a.user.personId);assert.equal(sample.members[1].virtual,true);assert.equal(sample.members[1].accountLinked,false);
  assert.equal(identityRows().accounts.length,3);assert.equal(JSON.stringify(created).includes('ownerAccountId'),false);
  assert.equal((await b.request(`/api/state?projectId=${id}`)).status,403);
  const adminView=await admin(`/api/state?projectId=${id}`);assert.equal(adminView.status,200);assert.equal(adminView.data.currentMemberId,null);assert.equal(adminView.data.permissions.readOnly,true);assert.equal(adminView.data.members.length,2);
  const virtualDetail=(await admin(`/api/people/${sample.members[1].personId}`)).data;
  assert.equal(virtualDetail.person.permissions.editProfile,false);assert.equal(virtualDetail.permissions.editProfile,false);
  const before=identityRows(),disk=bytes();
  for(const [path,input] of [
    ['/api/samples',{ownerAccountId:b.user.id}],['/api/projects',{name:'伪造样例',sample:{ownerAccountId:a.user.id}}],
    ['/api/samples/archive',{projectId:id,expectedRevision:sample.revision,accountId:a.user.id}],
    ['/api/invitations',{projectId:id,email:'b@samples.test'}],
    ['/api/project-members',{projectId:id,personId:b.user.personId}],
    ['/api/action',{projectId:id,type:'addMember',name:'新伙伴'}],
    ['/api/action',{projectId:id,type:'updateMember',memberId:'m1',expectedRevision:sample.revision,patch:{role:'修改'}}],
    ['/api/projects',{name:'带走虚拟人',members:[{personId:sample.members[1].personId}]}]
  ]) assert.ok((await a.request(path,input)).status>=400,path);
  assert.equal((await b.request('/api/samples/archive',{projectId:id,expectedRevision:sample.revision})).status,403);
  assert.equal((await admin('/api/samples/archive',{projectId:id,expectedRevision:sample.revision})).status,403);
  assert.deepEqual(identityRows(),before);assert.deepEqual(bytes(),disk);
});

test('完成实际交接后归档隐藏深链/文件/汇总/虚拟档案，恢复保留全部修改与成果原字节',async t=>{
  const {admin,register,dataDir,identityRows,restart}=await fixture(t),a=await register('a');
  let state=(await a.request('/api/samples',{})).data.state;const id=state.project.id,virtualId=state.members[1].personId;
  const todo=state.tasks.find(task=>task.status==='todo'),review=state.tasks.find(task=>task.status==='review');
  let result=await a.request('/api/action',{projectId:id,type:'submitArtifact',taskId:todo.id,taskUpdatedAt:todo.updatedAt,name:'本人练习成果',file:{name:'practice.txt',base64:Buffer.from('my saved sample result').toString('base64')}});
  assert.equal(result.status,200);state=result.data.state;const fileUrl=state.tasks.find(task=>task.id===todo.id).artifacts[0].url;
  assert.equal((await a.request('/api/action',{projectId:id,type:'accept',taskId:review.id,taskUpdatedAt:review.updatedAt})).status,200);
  state=(await a.request('/api/action',{projectId:id,type:'updateProject',patch:{name:'我修改过的示例'}})).data.state;
  const file=join(dataDir,'projects',`${id}.json`),saved=readFileSync(file),rows=identityRows();
  assert.equal((await a.request('/api/samples/archive',{projectId:id,expectedRevision:state.revision-1})).status,409);
  assert.equal((await a.request(fileUrl)).data,'my saved sample result');
  const archived=await a.request('/api/samples/archive',{projectId:id,expectedRevision:state.revision});assert.equal(archived.status,200);
  assert.equal(archived.data.workspace.projects.length,0);assert.equal(archived.data.workspace.defaultProjectId,null);
  assert.equal(archived.data.workspace.archivedSamples[0].id,id);assert.equal(archived.data.workspace.archivedSamples[0].name,'我修改过的示例');
  assert.deepEqual(readFileSync(file),saved);assert.deepEqual(identityRows(),rows);
  assert.equal((await a.request('/api/samples/archive',{projectId:id,expectedRevision:state.revision})).data.alreadyArchived,true);
  for(const path of [`/api/state?projectId=${id}`,`/api/export?projectId=${id}`,`/api/report?projectId=${id}`,fileUrl,`/api/people/${virtualId}`])assert.equal((await a.request(path)).status,404,path);
  assert.equal((await admin(`/api/people/${virtualId}`)).status,404);
  assert.equal((await admin('/api/people')).data.people.some(person=>person.id===virtualId),false);
  assert.equal((await a.request('/api/dashboard')).status,200);
  assert.equal(JSON.stringify((await a.request('/api/dashboard?q=示例')).data).includes(id),false);
  assert.equal((await a.request('/api/people')).data.people.find(person=>person.id===a.user.personId).projectCount,0);
  await restart();
  assert.equal((await a.request('/api/workspace')).data.archivedSamples[0].id,id);
  result=await a.request('/api/samples',{});assert.equal(result.status,200);assert.equal(result.data.restored,true);assert.equal(result.data.reused,false);assert.equal(result.data.state.project.id,id);
  assert.deepEqual(readFileSync(file),saved);assert.equal((await a.request(fileUrl)).data,'my saved sample result');
  const workspace=(await a.request('/api/workspace')).data;
  result=await a.request('/api/samples/restore',{projectId:id});assert.equal(result.data.reused,true);assert.equal(result.data.restored,false);
  assert.deepEqual((await a.request('/api/workspace')).data,workspace);assert.deepEqual(readFileSync(file),saved);
  assert.ok((await a.request('/api/report?projectId='+id)).data.includes('我修改过的示例'));
});

test('真实项目不可用示例端点归档，索引写入失败的归档/恢复均不改变内存或项目字节',async t=>{
  const {admin,dataDir,identityRows,bytes}=await fixture(t);
  const real=(await admin('/api/projects',{name:'真实项目'})).data.state;
  assert.equal((await admin('/api/samples/archive',{projectId:real.project.id,expectedRevision:real.revision})).status,403);
  const sample=(await admin('/api/samples',{})).data.state,id=sample.project.id,index=join(dataDir,'workspace.json');
  const blockIndex=()=>{renameSync(index,index+'.saved');mkdirSync(index);};
  const unblockIndex=()=>{rmSync(index,{recursive:true});renameSync(index+'.saved',index);};
  const before=bytes(),rows=identityRows();blockIndex();
  try{assert.equal((await admin('/api/samples/archive',{projectId:id,expectedRevision:sample.revision})).status,500);assert.equal((await admin(`/api/state?projectId=${id}`)).status,200);}finally{unblockIndex();}
  assert.deepEqual(bytes(),before);assert.deepEqual(identityRows(),rows);
  assert.equal((await admin('/api/samples/archive',{projectId:id,expectedRevision:sample.revision})).status,200);
  const archived=bytes();blockIndex();
  try{assert.equal((await admin('/api/samples/restore',{projectId:id})).status,500);assert.equal((await admin(`/api/state?projectId=${id}`)).status,404);}finally{unblockIndex();}
  assert.deepEqual(bytes(),archived);assert.deepEqual(identityRows(),rows);
});

test('样例创建identity事务失败完整回滚新文件/索引/人物，重试和重启仍只有一份',async t=>{
  const {admin,database,identityRows,bytes,restart}=await fixture(t),before=bytes(),rows=identityRows();
  database(db=>db.exec("CREATE TRIGGER sample_fail BEFORE INSERT ON project_members BEGIN SELECT RAISE(ABORT,'fixture membership failure'); END"));
  assert.equal((await admin('/api/samples',{})).status,500);assert.deepEqual(bytes(),before);assert.deepEqual(identityRows(),rows);
  assert.deepEqual((await admin('/api/workspace')).data.projects,[]);
  database(db=>db.exec('DROP TRIGGER sample_fail'));
  const created=await admin('/api/samples',{});assert.equal(created.status,201);const id=created.data.state.project.id;
  await restart();const reopened=await admin('/api/samples',{});assert.equal(reopened.data.reused,true);assert.equal(reopened.data.state.project.id,id);
  assert.equal(identityRows().accounts.length,1);assert.equal(identityRows().people.length,2);
});

test('示例创建索引已落盘但身份映射未写入的中断可在启动恢复，m0仍绑定真实创建者',async t=>{
  const {admin,dataDir,identityRows,restart}=await fixture(t),session=(await admin('/api/auth/session')).data;
  // Simulate a process stopping after the JSON/index commit but before the
  // SQLite identity transaction. Never derive the owner from a display name.
  const workspace=createWorkspace(dataDir);
  const created=workspace.create(sampleProjectInput(session.user.name),{decorate(state){Object.assign(state,markSampleState(buildSampleState(state),session.user.id));}}).state;
  assert.equal(identityRows().project_members.length,0);
  await restart();
  const result=await admin(`/api/state?projectId=${created.project.id}`);assert.equal(result.status,200);
  assert.equal(result.data.members[0].personId,session.user.personId);assert.equal(result.data.currentMemberId,'m0');
  assert.equal(identityRows().people.length,2);assert.equal(identityRows().accounts.length,1);
});

test('示例归属按稳定账号判断，认领历史档案更换person后仍可归档/恢复；虚拟伙伴不成为可选真人',async t=>{
  const {admin,register}=await fixture(t),a=await register('a');
  const sample=(await a.request('/api/samples',{})).data.state,id=sample.project.id,virtualId=sample.members[1].personId;
  const real=(await admin('/api/projects',{name:'有待认领分工的真实项目',members:[{name:'受邀认领后昵称'}]})).data.state;
  const member=real.members.find(item=>item.name==='受邀认领后昵称');
  const offer=await admin('/api/invitations',{projectId:real.project.id,memberId:member.id}),token=new URL(offer.data.invitation.url).pathname.split('/').at(-1);
  const accepted=await a.request('/api/invitations/accept',{token});assert.equal(accepted.status,200);
  assert.notEqual(accepted.data.session.user.personId,a.user.personId);
  const current=(await a.request(`/api/state?projectId=${id}`)).data;assert.equal(current.currentMemberId,'m0');assert.equal(current.sample.canArchive,true);
  const own=(await a.request('/api/projects',{name:'真实人员选择测试'})).data.state;
  const selectable=(await a.request(`/api/people?selectableForProject=${own.project.id}`)).data;
  assert.equal(selectable.people.some(person=>person.id===virtualId),false);
  assert.equal((await a.request('/api/samples/archive',{projectId:id,expectedRevision:current.revision})).status,200);
  assert.equal((await a.request('/api/samples/restore',{projectId:id})).data.state.sample.canArchive,true);
});

test('项目级模型能力可供普通项目管理员查询，只读/未授权受限且不泄露部署细节',async t=>{
  const {admin,register}=await fixture(t),a=await register('a'),b=await register('b');
  const project=(await a.request('/api/projects',{name:'普通账号自己的项目'})).data.state,id=project.project.id;
  assert.equal((await a.request('/api/ai/status')).status,403);
  let result=await a.request(`/api/ai/capabilities?projectId=${id}`);assert.equal(result.status,200);assert.deepEqual(Object.keys(result.data).sort(),['canGenerate','configured','samplePlanning']);
  assert.equal(result.data.samplePlanning,false);assert.equal(result.data.canGenerate,result.data.configured);
  assert.equal((await b.request(`/api/ai/capabilities?projectId=${id}`)).status,403);
  const offer=await a.request('/api/invitations',{projectId:id,personId:b.user.personId,accessRole:'viewer'}),token=new URL(offer.data.invitation.url).pathname.split('/').at(-1);
  assert.equal((await b.request('/api/invitations/accept',{token})).status,200);
  result=await b.request(`/api/ai/capabilities?projectId=${id}`);assert.equal(result.status,200);assert.equal(result.data.canGenerate,false);
  assert.equal((await admin('/api/ai/status')).status,200);
});
