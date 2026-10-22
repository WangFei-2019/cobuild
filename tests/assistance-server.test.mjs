import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';

test('真实账号三工具：手动额度→有来源生成不写项目→逐选原子建待办，权限/原文/版本与人工验收隔离',async t=>{
  const keys=['COBUILD_AI_BASE_URL','COBUILD_AI_API_KEY','COBUILD_AI_MODEL','COBUILD_AI_RESPONSE_FORMAT','COBUILD_AI_TOKEN_PARAMETER','COBUILD_AI_TIMEOUT_MS','COBUILD_AI_THINKING','COBUILD_AI_MAX_TOKENS'];
  const previous=new Map(keys.map(key=>[key,process.env[key]])),requests=[];
  const fixture=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks).toString()),context=JSON.parse(payload.messages[1].content);requests.push(context);
    const ref=source=>({sourceId:source.id,quote:source.text.slice(0,60)});let result;
    if(context.request.mode==='weekly')result={title:'测试区间周报草稿',sections:['completed','progress','blocked','next','decisions'].map(key=>({key,items:key==='progress'&&context.sources[0]?[{text:'当前任务有待核对的交付资料。',sourceRefs:[ref(context.sources[0])]}]:[]})),unknowns:['没有记录的工作不推断']};
    else if(context.request.mode==='actions'){const source=context.sources[0],item={id:'candidate-a',title:'补充回归说明',description:'列出失败请求检查步骤',ownerId:'',ownerName:'待确认',reviewerId:'',reviewerName:'待确认',due:'',deliverable:'回归检查说明',dependsOn:[],milestoneId:'',sourceRefs:[ref(source)],questions:['确认负责人、接收人与日期']};result={title:'讨论行动候选',items:[item,{...item,id:'candidate-b',title:'核对回归说明',dependsOn:['candidate-a']}],questions:[]};}
    else result={taskId:context.request.taskId,summary:'附件内容需要接收人实际检查',checks:context.criteria.map(criterion=>({criterionId:criterion.id,status:'unverifiable',explanation:'只有元信息，未阅读二进制或运行功能',sourceRefs:[]})),limitations:['本检查不代表成果验收']};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  });
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  Object.assign(process.env,{COBUILD_AI_BASE_URL:'http://127.0.0.1:'+fixture.address().port+'/v1',COBUILD_AI_API_KEY:'http-test-key-no-external',COBUILD_AI_MODEL:'QA-FIXTURE-NOT-AI',COBUILD_AI_RESPONSE_FORMAT:'json_object',COBUILD_AI_TOKEN_PARAMETER:'max_tokens',COBUILD_AI_TIMEOUT_MS:'3000',COBUILD_AI_MAX_TOKENS:'1024',COBUILD_AI_THINKING:''});
  const dir=mkdtempSync(join(tmpdir(),'cobuild-assistance-http-')),server=createApp({dataDir:dir,publicUrl:''});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));rmSync(dir,{recursive:true,force:true});for(const [key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  function client(){let cookie='';return async(path,body)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:await response.json()};};}
  const password='only-isolated-assistance-2026',admin=client();assert.equal((await admin('/api/auth/setup',{name:'部署管理员',email:'admin@assistance.test',password})).status,200);
  const users={},clients={};for(const name of ['manager','worker','viewer','bystander','outsider']){clients[name]=client();const result=await clients[name]('/api/auth/register',{name,email:name+'@assistance.test',password});assert.equal(result.status,200);users[name]=result.data.user;}
  const manager=clients.manager,worker=clients.worker;let state=(await manager('/api/projects',{name:'AI协作助手隔离验证',deadline:'2030-02-01'})).data.state;const projectId=state.project.id;
  for(const name of ['worker','viewer','bystander']){const offered=await manager('/api/invitations',{projectId,personId:users[name].personId,accessRole:name==='viewer'?'viewer':'member'});assert.equal(offered.status,201);const accepted=await clients[name]('/api/invitations/accept',{token:new URL(offered.data.invitation.url).pathname.split('/').at(-1)});assert.equal(accepted.status,200);state=accepted.data.state;}
  const workerId=state.members.find(member=>member.personId===users.worker.personId).id;
  state=(await manager('/api/action',{projectId,type:'createTask',title:'核对可执行回归材料',ownerId:workerId,reviewerId:'m0',due:'2030-01-08',deliverable:'回归说明和实际检查记录'})).data.state;const taskId=state.tasks[0].id;
  state=(await worker('/api/action',{projectId,type:'submitArtifact',taskId,taskUpdatedAt:state.tasks[0].updatedAt,name:'待检查压缩包',file:{name:'checks.zip',base64:Buffer.from('fixture binary, not actually read by AI').toString('base64')}})).data.state;
  state=(await worker('/api/action',{projectId,type:'addDiscussion',taskId,body:'需要补充失败请求的回归说明，并明确接收人与日期。'})).data.state;const discussionId=state.discussions[0].id;
  assert.equal((await worker('/api/ai/access?projectId='+projectId)).data.canGenerate,false);
  assert.equal((await worker('/api/ai/assistance',{projectId,mode:'actions',discussionIds:[discussionId],minutes:''})).status,403);assert.equal(requests.length,0);
  for(const name of ['manager','worker'])assert.equal((await admin('/api/admin/ai/access',{accountId:users[name].id,expectedRevision:0,enabled:true,limit:20})).status,200);
  assert.equal((await worker('/api/ai/access?projectId='+projectId)).data.canGenerate,true);
  for(const name of ['viewer','outsider'])assert.equal((await clients[name]('/api/ai/assistance',{projectId,mode:'weekly',from:'2030-01-01',to:'2030-01-07'})).status,403);
  async function generate(request,who=worker){const before=(await manager('/api/state?projectId='+projectId)).data,result=await who('/api/ai/assistance',{projectId,...request});assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual((await manager('/api/state?projectId='+projectId)).data,before,'生成不能改项目任何字段');return result.data;}
  const weekly=await generate({mode:'weekly',from:'2030-01-01',to:'2030-01-07'});assert.equal(weekly.mode,'weekly');assert.equal(weekly.result.sections[0].items.length,0);
  const generation=await generate({mode:'actions',discussionIds:[discussionId],minutes:''}),draft=generation.result;assert.equal(draft.items[0].ownerId,'');assert.equal(generation.sources.length,1);assert.equal(generation.sources[0].discussionId,discussionId);
  await generate({mode:'check',taskId});await generate({mode:'check',taskId},manager);
  assert.equal((await clients.bystander('/api/ai/assistance',{projectId,mode:'check',taskId})).status,403);
  let current=(await manager('/api/state?projectId='+projectId)).data;assert.equal(current.tasks[0].status,'review');assert.equal(current.tasks[0].acceptedAt,'');
  assert.equal((await worker('/api/assistance/apply',{projectId,expectedRevision:draft.baseRevision,draft,selectedIds:['candidate-a']})).status,400,'未映射的候选不能应用');
  const edited=structuredClone(draft);edited.items=edited.items.map((item,index)=>({...item,ownerId:workerId,ownerName:'worker',reviewerId:'m0',reviewerName:'manager',due:index?'2030-01-07':'2030-01-06',questions:[]}));
  const tampered=structuredClone(edited);tampered.items[0].sourceRefs[0].sourceId='discussion:another-project';assert.equal((await worker('/api/assistance/apply',{projectId,expectedRevision:edited.baseRevision,draft:tampered,selectedIds:['candidate-a']})).status,400);
  const invalid=structuredClone(edited);invalid.items[1].due='2030-12-01';assert.equal((await worker('/api/assistance/apply',{projectId,expectedRevision:edited.baseRevision,draft:invalid,selectedIds:['candidate-a','candidate-b']})).status,400);assert.deepEqual((await manager('/api/state?projectId='+projectId)).data,current,'后项失败不留下前项新任务');
  for(const name of ['viewer','outsider'])assert.equal((await clients[name]('/api/assistance/apply',{projectId,expectedRevision:edited.baseRevision,draft:edited,selectedIds:['candidate-a']})).status,403);
  const applied=await worker('/api/assistance/apply',{projectId,expectedRevision:edited.baseRevision,draft:edited,selectedIds:['candidate-a']});assert.equal(applied.status,200,JSON.stringify(applied.data));assert.equal(applied.data.state.tasks.length,current.tasks.length+1);assert.equal(applied.data.state.tasks.at(-1).status,'todo');assert.deepEqual(applied.data.state.tasks[0],current.tasks[0]);assert.equal(applied.data.state.tasks.some(task=>task.title==='核对回归说明'),false);
  assert.equal((await worker('/api/assistance/apply',{projectId,expectedRevision:applied.data.state.revision,draft:edited,selectedIds:['candidate-a']})).status,409);
  assert.equal(JSON.stringify(requests).includes('base64'),false);assert.equal(JSON.stringify(requests).includes('fixture binary'),false);assert.equal(JSON.stringify(generation).includes('http-test-key-no-external'),false);
});
