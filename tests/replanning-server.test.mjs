import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const configKeys = ['COBUILD_AI_BASE_URL','COBUILD_AI_API_KEY','COBUILD_AI_MODEL','COBUILD_AI_TIMEOUT_MS','COBUILD_AI_MAX_TOKENS','COBUILD_AI_RESPONSE_FORMAT','COBUILD_AI_TOKEN_PARAMETER'];
const password = 'replanning-fixture-password-2026';

async function fixture(t) {
  const previous = new Map(configKeys.map(key=>[key,process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  const dataDir = mkdtempSync(join(tmpdir(),'cobuild-replanning-server-'));
  const servers = [];
  let base,app;
  async function listen(server) {
    servers.push(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function start() {
    // Production authentication is deliberately left enabled.
    app = createApp({dataDir,publicUrl:'',setupToken:'',seedDemo:true});
    base = await listen(app);
  }
  await start();
  t.after(async()=>{
    try {
      for (const server of [...servers].reverse()) {
        if (!server.listening) continue;
        server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
      }
    } finally {
      for (const [key,value] of previous) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
      rmSync(dataDir,{recursive:true,force:true});
    }
  });
  function client() {
    let cookie='';
    async function request(path,value) {
      const response=await fetch(base+path,{method:value===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(value===undefined?{}:{'Content-Type':'application/json'})},...(value===undefined?{}:{body:JSON.stringify(value)})});
      if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
      return response;
    }
    return {request,json:async path=>(await request(path)).json()};
  }
  const admin=client();
  const setup=await admin.request('/api/auth/setup',{name:'重规划管理员',email:'replan-admin@example.test',password});
  assert.equal(setup.status,200);
  async function successful(client,path,input) {
    const response=await client.request(path,input), result=await response.json();
    assert.ok(response.status===200||response.status===201,`${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  async function model(handler) {
    const requests=[];
    const server=http.createServer(async(req,res)=>{
      try {
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({path:req.url,authorization:req.headers.authorization,payload});
        const draft=await handler(payload);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]}));
      } catch { res.writeHead(500,{'Content-Type':'application/json'}); res.end('{"error":"fixture failure"}'); }
    });
    const origin=await listen(server);
    Object.assign(process.env,{COBUILD_AI_BASE_URL:origin+'/v1',COBUILD_AI_API_KEY:'replan-fixture-only-token',COBUILD_AI_MODEL:'replan-fixture',COBUILD_AI_TIMEOUT_MS:'3000',COBUILD_AI_MAX_TOKENS:'4096'});
    return requests;
  }
  const restart=async()=>{await new Promise(resolve=>app.close(resolve)); await start();};
  return {dataDir,admin,client,successful,model,restart};
}

async function projectWithWork(f) {
  const {admin,successful,dataDir}=f;
  const {state:initial}=await successful(admin,'/api/projects',{name:'保留成果的重规划测试',goal:'旧目标：完成首轮交付',deadline:'2026-12-30'});
  const projectId=initial.project.id,actorId=initial.currentMemberId;
  let state=initial;
  async function action(input) { state=(await successful(admin,'/api/action',{projectId,...input})).state; return state; }
  async function milestone(title,due) {
    state=(await successful(admin,'/api/milestones/action',{projectId,type:'createMilestone',expectedRevision:state.revision,title,goal:'完成'+title,due,acceptanceCriteria:'交付成果经过指定接收人核对'})).state;
    return state.milestones.at(-1).id;
  }
  async function task(title,due,milestoneId,dependsOn=[]) {
    await action({type:'createTask',title,ownerId:actorId,reviewerId:actorId,deliverable:'原交付约定',due,milestoneId,dependsOn});
    return state.tasks.at(-1).id;
  }
  const acceptedMilestoneId=await milestone('已验收阶段','2026-12-10');
  const doneId=await task('已经完成的成果','2026-12-08',acceptedMilestoneId);
  const bytes=Buffer.from('重规划后应完整保留的已验收文件');
  await action({type:'submitArtifact',taskId:doneId,name:'已完成文件',file:{name:'completed.txt',base64:bytes.toString('base64')}});
  await action({type:'accept',taskId:doneId});
  state=(await successful(admin,'/api/milestones/action',{projectId,type:'acceptMilestone',milestoneId:acceptedMilestoneId,expectedRevision:state.revision,note:'此阶段已经完成验收'})).state;
  const openProtectedMilestoneId=await milestone('含交付成果的阶段','2026-12-15');
  const reviewId=await task('待接收成果','2026-12-13',openProtectedMilestoneId);
  await action({type:'submitArtifact',taskId:reviewId,name:'待接收说明',note:'尚未接收但已有成果。'});
  const artifactId=await task('退回修改但已有成果','2026-12-14',openProtectedMilestoneId);
  await action({type:'submitArtifact',taskId:artifactId,name:'历史提交',note:'应保留其成果版本。'});
  await action({type:'requestChanges',taskId:artifactId,reason:'还需补充细节'});
  const editableMilestoneId=await milestone('剩余交付阶段','2026-12-23');
  const editableId=await task('相同标题','2026-12-20',editableMilestoneId,[doneId]);
  await action({type:'setStatus',taskId:editableId,status:'blocked',blocker:'等待业务输入'});
  await action({type:'addUpdate',taskId:editableId,text:'已经整理一半，保留这段真实进展。'});
  const keptMilestoneId=await milestone('未引用的阶段','2026-12-19');
  const keptId=await task('相同标题','2026-12-18',keptMilestoneId,[doneId]);
  const file=join(dataDir,'projects',projectId+'.json');
  const draft={
    title:'调整剩余计划',summary:'保留现有成果，重排剩余工作并增加一次核对。',projectGoal:'新目标：完成剩余工作与追加核对',assumptions:['已完成成果继续有效'],risks:['业务输入尚未到齐'],questions:[],
    milestones:[
      {id:'phase-update',existingMilestoneId:editableMilestoneId,title:'调整后的剩余交付',goal:'补齐剩余工作',due:'2026-12-23',acceptanceCriteria:'剩余成果交接完成'},
      {id:'phase-new',existingMilestoneId:'',title:'追加核对',goal:'检查新增范围',due:'2026-12-26',acceptanceCriteria:'追加核对说明被接收'}
    ],
    tasks:[
      {id:'work-update',existingTaskId:editableId,title:'重新安排剩余工作',description:'在原进展基础上补充',ownerId:actorId,reviewerId:actorId,due:'2026-12-22',deliverable:'调整后的交付说明',dependsOn:[doneId],milestoneId:'phase-update'},
      {id:'work-new',existingTaskId:'',title:'增加一轮核对',description:'核对新范围',ownerId:actorId,reviewerId:actorId,due:'2026-12-25',deliverable:'追加核对说明',dependsOn:['work-update'],milestoneId:'phase-new'}
    ]
  };
  return {projectId,actorId,state,file,draft,bytes,doneId,reviewId,artifactId,editableId,keptId,acceptedMilestoneId,openProtectedMilestoneId,editableMilestoneId,keptMilestoneId};
}

test('默认鉴权HTTP重规划先生成预览再确认，保护成果不变、明确ID更新、未引用保留并重启恢复',async t=>{
  const f=await fixture(t),work=await projectWithWork(f);
  const {admin,successful,model,restart}=f;
  const before=work.state,diskBefore=readFileSync(work.file,'utf8');
  const requests=await model(()=>work.draft);
  const generated=await successful(admin,'/api/ai/replan',{projectId:work.projectId,goal:work.draft.projectGoal,deadline:'2026-12-30',scope:'剩余交付及追加核对',constraints:'保留已完成与已提交成果'});
  assert.equal(generated.baseRevision,before.revision);
  assert.equal(generated.draft.projectGoal,work.draft.projectGoal);
  assert.equal(generated.changes.counts.updatedTasks,1);
  assert.equal(requests.length,1);
  assert.equal(requests[0].path,'/v1/chat/completions');
  assert.ok(JSON.stringify(requests[0].payload).includes(work.doneId));
  assert.deepEqual(await admin.json(`/api/state?projectId=${work.projectId}`),before);
  assert.equal(readFileSync(work.file,'utf8'),diskBefore);
  const input={projectId:work.projectId,expectedRevision:generated.baseRevision,draft:generated.draft};
  const preview=await successful(admin,'/api/plans/preview',input);
  assert.equal(preview.baseRevision,before.revision);
  assert.equal(preview.changes.counts.newTasks,1);
  assert.equal(preview.changes.counts.updatedTasks,1);
  assert.equal(preview.changes.counts.newMilestones,1);
  assert.equal(preview.changes.counts.updatedMilestones,1);
  assert.equal(preview.changes.counts.protectedTasks,3);
  assert.equal(preview.changes.counts.protectedMilestones,2);
  assert.ok(preview.changes.items.some(item=>item.kind==='project'&&item.fields.some(field=>field.after===work.draft.projectGoal)));
  assert.deepEqual(await admin.json(`/api/state?projectId=${work.projectId}`),before);
  assert.equal(readFileSync(work.file,'utf8'),diskBefore);
  const applied=(await successful(admin,'/api/plans/replan',input)).state;
  assert.equal(applied.revision,before.revision+1);
  assert.equal(applied.project.goal,work.draft.projectGoal);
  for(const id of [work.doneId,work.reviewId,work.artifactId,work.keptId]) assert.deepEqual(applied.tasks.find(task=>task.id===id),before.tasks.find(task=>task.id===id));
  for(const id of [work.acceptedMilestoneId,work.openProtectedMilestoneId,work.keptMilestoneId]) assert.deepEqual(applied.milestones.find(item=>item.id===id),before.milestones.find(item=>item.id===id));
  const updated=applied.tasks.find(task=>task.id===work.editableId),previous=before.tasks.find(task=>task.id===work.editableId);
  assert.equal(updated.title,'重新安排剩余工作');
  for(const key of ['id','code','status','blocker','acceptedAt']) assert.equal(updated[key],previous[key]);
  assert.equal(updated.status,'blocked');
  assert.deepEqual(updated.dependsOn,[work.doneId]);
  assert.notEqual(updated.updatedAt,previous.updatedAt);
  assert.ok(applied.activities.some(item=>item.taskId===work.editableId&&item.text==='已经整理一半，保留这段真实进展。'));
  const newTask=applied.tasks.find(task=>!before.tasks.some(old=>old.id===task.id));
  assert.equal(newTask.status,'todo');
  assert.deepEqual(newTask.dependsOn,[work.editableId]);
  assert.equal(applied.activities[0].actorId,work.actorId);
  const download=await admin.request(before.tasks.find(task=>task.id===work.doneId).artifacts[0].url);
  assert.equal(download.status,200); assert.deepEqual(Buffer.from(await download.arrayBuffer()),work.bytes);
  const disk=JSON.parse(readFileSync(work.file,'utf8'));
  assert.equal(disk.tasks.length,before.tasks.length+1);
  assert.ok(disk.members.every(member=>!Object.hasOwn(member,'accessRole')));
  await restart();
  assert.deepEqual(await admin.json(`/api/state?projectId=${work.projectId}`),applied);
  assert.equal((await admin.request('/api/plans/replan',input)).status,409);
});

test('HTTP重规划拒绝伪造身份、普通成员、保护对象及跨项目引用，失败不改内存或磁盘',async t=>{
  const f=await fixture(t),work=await projectWithWork(f),{admin,client,successful}=f;
  const created=(await successful(admin,'/api/invitations',{projectId:work.projectId,email:'replan-member@example.test',accessRole:'member'})).invitation;
  const member=client();
  await successful(member,'/api/auth/register',{name:'普通参与者',email:'replan-member@example.test',password,inviteToken:new URL(created.url).pathname.split('/').at(-1)});
  const before=await admin.json(`/api/state?projectId=${work.projectId}`),diskBefore=readFileSync(work.file,'utf8');
  const request={projectId:work.projectId,expectedRevision:before.revision,draft:work.draft};
  const generate={projectId:work.projectId,goal:work.draft.projectGoal};
  for(const path of ['/api/ai/replan','/api/plans/preview','/api/plans/replan']) {
    const body=path==='/api/ai/replan'?generate:request;
    assert.equal((await client().request(path,body)).status,401,path);
    assert.equal((await member.request(path,body)).status,403,path);
    assert.equal((await admin.request(path,{...body,actorId:work.actorId})).status,403,path);
  }
  assert.equal((await admin.request('/api/ai/replan',generate)).status,503,'no configured model must not manufacture a plan');
  const other=(await successful(admin,'/api/projects',{name:'另一个项目',deadline:'2026-12-30'})).state;
  const anotherTask=(await successful(admin,'/api/action',{projectId:other.project.id,type:'createTask',title:'相同标题',ownerId:other.currentMemberId,reviewerId:other.currentMemberId,due:'2026-12-20',deliverable:'其他项目成果'})).state.tasks[0];
  const invalid=[
    ['completed task',draft=>{draft.tasks[0].existingTaskId=work.doneId;}],
    ['pending review',draft=>{draft.tasks[0].existingTaskId=work.reviewId;}],
    ['artifact in progress',draft=>{draft.tasks[0].existingTaskId=work.artifactId;}],
    ['accepted milestone',draft=>{draft.milestones[0].existingMilestoneId=work.acceptedMilestoneId;}],
    ['milestone with protected work',draft=>{draft.milestones[0].existingMilestoneId=work.openProtectedMilestoneId;}],
    ['new work inside protected milestone',draft=>{draft.tasks[1].milestoneId=work.acceptedMilestoneId;}],
    ['foreign existing task',draft=>{draft.tasks[0].existingTaskId=anotherTask.id;}],
    ['foreign dependency',draft=>{draft.tasks[0].dependsOn=[anotherTask.id];}]
  ];
  for(const [label,change] of invalid) {
    const draft=structuredClone(work.draft); change(draft);
    for(const path of ['/api/plans/preview','/api/plans/replan']) assert.equal((await admin.request(path,{...request,draft})).status,400,`${label}: ${path}`);
    assert.deepEqual(await admin.json(`/api/state?projectId=${work.projectId}`),before,label);
    assert.equal(readFileSync(work.file,'utf8'),diskBefore,label);
  }
  for(const path of ['/api/plans/preview','/api/plans/replan']) {
    assert.equal((await admin.request(path,{...request,expectedRevision:before.revision-1})).status,409,path);
    assert.equal((await admin.request(path,{...request,projectId:'missing'})).status,404,path);
  }
  assert.deepEqual(await admin.json(`/api/state?projectId=${work.projectId}`),before);
  assert.equal(readFileSync(work.file,'utf8'),diskBefore);
});

test('HTTP生成锁定原版本，人类修改后旧预览和确认均409且不覆盖最新范围',async t=>{
  const f=await fixture(t),work=await projectWithWork(f),{admin,successful,model}=f;
  let received,release;
  const pending=new Promise(resolve=>{received=resolve;});
  const respond=new Promise(resolve=>{release=resolve;});
  const requests=await model(async()=>{received();await respond;return work.draft;});
  const before=await admin.json(`/api/state?projectId=${work.projectId}`);
  const generating=admin.request('/api/ai/replan',{projectId:work.projectId,goal:work.draft.projectGoal});
  await pending;
  const after=(await successful(admin,'/api/action',{projectId:work.projectId,type:'updateProject',patch:{description:'模型工作期间，人类重新明确了项目范围。'}})).state;
  release();
  const response=await generating;
  assert.equal(response.status,200);
  const generated=await response.json();
  assert.equal(generated.baseRevision,before.revision);
  assert.ok(after.revision>generated.baseRevision);
  assert.equal(requests.length,1);
  const input={projectId:work.projectId,expectedRevision:generated.baseRevision,draft:generated.draft};
  const disk=readFileSync(work.file,'utf8');
  for(const path of ['/api/plans/preview','/api/plans/replan']) assert.equal((await admin.request(path,input)).status,409,path);
  assert.deepEqual(await admin.json(`/api/state?projectId=${work.projectId}`),after);
  assert.equal(readFileSync(work.file,'utf8'),disk);
});
