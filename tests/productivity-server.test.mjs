import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server.mjs';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cobuild-productivity-http-')),password='productivity-http-fixture-2026';let server,base;
 async function start(){server=createApp({dataDir:dir,publicUrl:'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await start();t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
 function client(){let cookie='';return async(path,input)=>{const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text()};};}
 const admin=client();assert.equal((await admin('/api/auth/setup',{name:'部署者',email:'admin@productivity.test',password})).status,200);
 async function register(name){const request=client(),result=await request('/api/auth/register',{name,email:`${name}@productivity.test`,password});assert.equal(result.status,200);return {request,user:result.data.user};}
 const owner=await register('owner'),worker=await register('worker'),viewer=await register('viewer');
 const database=action=>{const db=new DatabaseSync(join(dir,'identity.sqlite'));try{return action(db);}finally{db.close();}};
 const snapshot=()=>({index:readFileSync(join(dir,'workspace.json'),'utf8'),projects:readdirSync(join(dir,'projects')).sort().map(path=>[path,readFileSync(join(dir,'projects',path),'utf8')]),files:readdirSync(join(dir,'files')).sort(),journals:existsSync(join(dir,'.transactions'))?readdirSync(join(dir,'.transactions')).sort():[],identity:database(db=>Object.fromEntries(['accounts','people','sessions','project_members','project_member_history','invitations','metadata'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))) });
 async function invite(projectId,person,accessRole='member'){const offer=await owner.request('/api/invitations',{projectId,personId:person.user.personId,accessRole});assert.equal(offer.status,201,JSON.stringify(offer.data));const accepted=await person.request('/api/invitations/accept',{token:new URL(offer.data.invitation.url).pathname.split('/').at(-1)});assert.equal(accepted.status,200);return accepted.data.state;}
 const state=async projectId=>(await owner.request(`/api/state?projectId=${projectId}`)).data;
 return {dir,owner,worker,viewer,invite,state,database,snapshot,restart:async()=>{await stop();await start();}};
}
async function sourceTemplate(f){
 let state=(await f.owner.request('/api/projects',{name:'真实源项目',goal:'按真实成员交付，不复制历史',deadline:'2030-12-31'})).data.state,id=state.project.id;
 state=await f.invite(id,f.worker);const workerId=state.members.find(member=>member.personId===f.worker.user.personId).id;
 let result=await f.owner.request('/api/milestones/action',{projectId:id,expectedRevision:state.revision,type:'createMilestone',title:'交付阶段',goal:'逐项核对',due:'2030-12-15',acceptanceCriteria:'所有有效任务完成交接'});assert.equal(result.status,200);state=result.data.state;const milestoneId=state.milestones[0].id;
 result=await f.owner.request('/api/action',{projectId:id,type:'createTask',title:'伙伴的交付',ownerId:workerId,reviewerId:'m0',due:'2030-12-05',milestoneId,deliverable:'明确的检查说明'});assert.equal(result.status,200);const first=result.data.state.tasks[0];
 result=await f.owner.request('/api/action',{projectId:id,type:'createTask',title:'集成交付',ownerId:'m0',reviewerId:workerId,due:'2030-12-10',milestoneId,dependsOn:[first.id],deliverable:'依赖前一项后核对'});assert.equal(result.status,200);
 result=await f.worker.request('/api/action',{projectId:id,type:'submitArtifact',taskId:first.id,taskUpdatedAt:first.updatedAt,name:'原始私有交付',file:{name:'do-not-copy.txt',base64:Buffer.from('do not copy artifact history').toString('base64')}});assert.equal(result.status,200);
 result=await f.owner.request('/api/action',{projectId:id,type:'accept',taskId:first.id,taskUpdatedAt:result.data.state.tasks[0].updatedAt});assert.equal(result.status,200);
 assert.equal((await f.worker.request('/api/action',{projectId:id,type:'addDiscussion',taskId:first.id,body:'不要复制源项目的讨论'})).status,200);
 const before=f.snapshot(),extract=await f.owner.request('/api/templates/extract',{projectId:id,name:'私有角色模板',anchorDate:'2030-12-01'});assert.equal(extract.status,200);assert.deepEqual(f.snapshot(),before);
 const saved=await f.owner.request('/api/templates',{template:extract.data.template});assert.equal(saved.status,201);return {id,template:extract.data.template,record:saved.data.template};
}
function roleMap(template,owner='m0',worker=owner){return Object.fromEntries(template.roles.map((role,index)=>[role.id,index===0?worker:owner]));}

test('默认鉴权HTTP模板旅程：源提取无写、账号私库隔离、空项目映射预览/应用、新建仅本人且不克隆历史',async t=>{
 const f=await fixture(t),source=await sourceTemplate(f),sourceBytes=readFileSync(join(f.dir,'projects',`${source.id}.json`),'utf8');
 assert.equal((await f.owner.request('/api/templates')).data.templates.length,1);assert.deepEqual((await f.worker.request('/api/templates')).data.templates,[]);
 const beforeAccess=f.snapshot();assert.equal((await f.worker.request('/api/templates/create',{templateId:source.record.id,name:'不能用他人模板',startDate:'2030-12-01',roleMap:roleMap(source.template)})).status,404);assert.equal((await f.worker.request('/api/templates/extract',{projectId:source.id,name:'非管理员不能提取'})).status,403);assert.deepEqual(f.snapshot(),beforeAccess);
 let target=(await f.owner.request('/api/projects',{name:'已邀请的空项目',goal:'目标背景保留',deadline:'2030-12-31'})).data.state;target=await f.invite(target.project.id,f.worker);const workerId=target.members.find(member=>member.personId===f.worker.user.personId).id;
 const input={projectId:target.project.id,expectedRevision:target.revision,templateId:source.record.id,startDate:'2030-12-01',roleMap:roleMap(source.template,'m0',workerId)},before=f.snapshot(),preview=await f.owner.request('/api/templates/preview',input);
 assert.equal(preview.status,200,JSON.stringify(preview.data));assert.deepEqual(f.snapshot(),before);assert.equal(preview.data.preview.tasks.length,2);assert.equal(preview.data.preview.tasks[0].ownerId,workerId);
 const applied=await f.owner.request('/api/templates/apply',input);assert.equal(applied.status,200,JSON.stringify(applied.data));target=applied.data.state;assert.equal(target.revision,input.expectedRevision+1);assert.equal(target.project.goal,'目标背景保留');assert.ok(target.tasks.every(task=>task.status==='todo'&&!task.artifacts.length));assert.equal(target.milestones[0].status,'open');assert.equal(target.discussions,undefined);
 const create={templateId:source.record.id,name:'本人承担角色的新项目',startDate:'2031-01-01',roleMap:roleMap(source.template)},created=await f.owner.request('/api/templates/create',create);assert.equal(created.status,201,JSON.stringify(created.data));const fresh=created.data.state;assert.equal(fresh.members.length,1);assert.equal(fresh.members[0].personId,f.owner.user.personId);assert.equal(fresh.currentMemberId,'m0');assert.ok(fresh.tasks.every(task=>task.ownerId==='m0'&&task.reviewerId==='m0'&&task.status==='todo'&&!task.artifacts.length));assert.equal(fresh.tasks[0].due,'2031-01-05');assert.equal(fresh.discussions,undefined);
 assert.equal(readFileSync(join(f.dir,'projects',`${source.id}.json`),'utf8'),sourceBytes);const count=f.snapshot().files.length;assert.equal(count,1,'only original source upload exists');
 await f.restart();assert.equal((await f.owner.request('/api/templates')).data.templates[0].id,source.record.id);assert.equal((await f.state(fresh.project.id)).tasks.length,2);assert.equal((await f.worker.request(`/api/state?projectId=${fresh.project.id}`)).status,403);
});

test('HTTP模板版本/归档/非法映射封口，SQL最终COMMIT失败补偿JSON与身份，不留新项目且可重试',async t=>{
 const f=await fixture(t),source=await sourceTemplate(f);let target=(await f.owner.request('/api/projects',{name:'版本校验目标'})).data.state;
 const input={projectId:target.project.id,expectedRevision:target.revision,templateId:source.record.id,startDate:'2030-12-01',roleMap:roleMap(source.template)};
 assert.equal((await f.owner.request('/api/templates/preview',input)).status,200);assert.equal((await f.owner.request('/api/action',{projectId:target.project.id,type:'updateProject',expectedRevision:target.revision,patch:{goal:'有意修改后的目标'}})).status,200);const stale=f.snapshot();assert.equal((await f.owner.request('/api/templates/apply',input)).status,409);assert.deepEqual(f.snapshot(),stale);
 const create={templateId:source.record.id,name:'需回滚的新项目',startDate:'2031-01-01',roleMap:roleMap(source.template)};
 const bad=f.snapshot();assert.equal((await f.owner.request('/api/templates/create',{...create,roleMap:roleMap(source.template,'other-account')})).status,400);assert.equal((await f.owner.request('/api/templates/create',{...create,actorId:'m0'})).status,400);assert.deepEqual(f.snapshot(),bad);
 f.database(db=>db.exec("CREATE TABLE productivity_fk_parent(id INTEGER PRIMARY KEY); CREATE TABLE productivity_fk_child(parentId INTEGER REFERENCES productivity_fk_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER productivity_fail_commit AFTER INSERT ON project_members BEGIN INSERT INTO productivity_fk_child VALUES(999); END;"));
 const before=f.snapshot();assert.equal((await f.owner.request('/api/templates/create',create)).status,500);assert.deepEqual(f.snapshot(),before);f.database(db=>{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM productivity_fk_child').get().n,0);db.exec('DROP TRIGGER productivity_fail_commit; DROP TABLE productivity_fk_child; DROP TABLE productivity_fk_parent;');});
 await f.restart();assert.deepEqual(f.snapshot(),before);const retried=await f.owner.request('/api/templates/create',create);assert.equal(retried.status,201);assert.equal((await f.owner.request('/api/workspace')).data.projects.filter(project=>project.name===create.name).length,1);
 const archived=await f.owner.request('/api/templates/archive',{id:source.record.id,expectedRevision:source.record.revision});assert.equal(archived.status,200);const afterArchive=f.snapshot();assert.equal((await f.owner.request('/api/templates/create',create)).status,409);assert.deepEqual(f.snapshot(),afterArchive);assert.equal((await f.owner.request('/api/templates?archived=true')).data.templates.length,1);
});

test('HTTP批量预览不写、依赖日程整组移动、逐项ACL与版本/字段严格校验，换人重交且失败整批不写',async t=>{
 const f=await fixture(t),source=await sourceTemplate(f);let target=(await f.owner.request('/api/projects',{name:'批量编辑目标',deadline:'2030-12-31'})).data.state;target=await f.invite(target.project.id,f.worker);target=await f.invite(target.project.id,f.viewer,'viewer');const id=target.project.id,workerId=target.members.find(member=>member.personId===f.worker.user.personId).id;
 const applied=await f.owner.request('/api/templates/apply',{projectId:id,expectedRevision:target.revision,templateId:source.record.id,startDate:'2030-12-01',roleMap:roleMap(source.template,'m0',workerId)});assert.equal(applied.status,200);target=applied.data.state;
 const first=target.tasks[0],second=target.tasks[1];target=(await f.worker.request('/api/action',{projectId:id,type:'submitArtifact',taskId:first.id,taskUpdatedAt:first.updatedAt,name:'保留的第一版',note:'新负责人仍应重交'})).data.state;
 function input(edits){return {projectId:id,expectedRevision:target.revision,edits:edits.map(([taskId,patch])=>({taskId,taskUpdatedAt:target.tasks.find(task=>task.id===taskId).updatedAt,patch}))};}
 const shift=input([[first.id,{due:'2030-12-11',ownerId:'m0'}],[second.id,{due:'2030-12-12'}]]),before=f.snapshot();
 assert.equal((await f.viewer.request('/api/tasks/batch/preview',shift)).status,403);assert.equal((await f.worker.request('/api/tasks/batch',shift)).status,403);assert.equal((await f.owner.request('/api/tasks/batch',{...shift,actorId:'m0'})).status,403);
 const illegal=input([[first.id,{priority:'low'}],[second.id,{due:'2030-02-30'}]]);assert.equal((await f.owner.request('/api/tasks/batch',illegal)).status,400);const status=input([[first.id,{status:'done'}]]);assert.equal((await f.owner.request('/api/tasks/batch',status)).status,400);assert.deepEqual(f.snapshot(),before);
 const preview=await f.owner.request('/api/tasks/batch/preview',shift);assert.equal(preview.status,200,JSON.stringify(preview.data));assert.deepEqual(f.snapshot(),before);assert.equal(preview.data.preview.changes.length,2);assert.equal(preview.data.preview.changes[0].needsResubmission,true);assert.equal('artifacts' in preview.data.preview.changes[0],false);
 const result=await f.owner.request('/api/tasks/batch',shift);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.state.revision,target.revision+1);const updated=result.data.state.tasks.find(task=>task.id===first.id);assert.equal(updated.status,'doing');assert.equal(updated.needsResubmission,true);assert.deepEqual(updated.artifacts,target.tasks[0].artifacts);assert.equal(result.data.state.tasks[1].due,'2030-12-12');
 const after=f.snapshot();assert.equal((await f.owner.request('/api/tasks/batch',shift)).status,409);assert.deepEqual(f.snapshot(),after);
});
