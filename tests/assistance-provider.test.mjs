import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {seedState} from '../domain.mjs';
import {generateAssistance} from '../assistance.mjs';

const input={actorId:'m0',mode:'actions',minutes:'补充接口失败样例',discussionIds:[]};
const raw={title:'核对行动',items:[{id:'candidate-a',title:'补充失败样例',description:'检查失败请求',ownerId:'',ownerName:'待确认',reviewerId:'',reviewerName:'待确认',due:'',deliverable:'失败样例说明',dependsOn:[],milestoneId:'',sourceRefs:[{sourceId:'minutes:input',quote:'补充接口失败样例'}],questions:['确定负责人和期限']}],questions:[]};
async function fixture(t,handler){const received=[];const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received.push({url:req.url,headers:req.headers,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});await handler(received.at(-1),res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return {received,url:'http://127.0.0.1:'+server.address().port+'/v1'};}
const env=(url,extra={})=>({COBUILD_AI_BASE_URL:url,COBUILD_AI_API_KEY:'only-local-fixture',COBUILD_AI_MODEL:'QA-FIXTURE-NOT-AI',COBUILD_AI_TIMEOUT_MS:'3000',COBUILD_AI_RESPONSE_FORMAT:'json_object',COBUILD_AI_TOKEN_PARAMETER:'max_tokens',COBUILD_AI_MAX_TOKENS:'1024',...extra});
const completion=(res,value=raw,extra={})=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)},...extra}]}));};

test('无模型/无效配置明确503，不使用预置草案或发请求；不允许明文外部地址',async()=>{
  let calls=0;const fake=()=>{calls++;throw Error('must not call');};
  for(const config of [{},env('http://example.invalid/v1'),env('https://example.invalid/v1',{COBUILD_AI_THINKING:'invalid'}),env('https://example.invalid/v1',{COBUILD_AI_TIMEOUT_MS:'-1'}),env('https://example.invalid/v1',{COBUILD_AI_API_KEY:''})])await assert.rejects(()=>generateAssistance(seedState(),input,{env:config,fetch:fake}),error=>error.status===503);
  assert.equal(calls,0);
});

test('真实本机HTTP兼容fixture收到受限结构与显式thinking，生成结果不写项目',async t=>{
  const f=await fixture(t,(_request,res)=>completion(res)),s=seedState(),before=structuredClone(s);
  const result=await generateAssistance(s,input,{env:env(f.url,{COBUILD_AI_THINKING:'disabled'})});
  assert.equal(result.model,'QA-FIXTURE-NOT-AI');assert.equal(result.result.items[0].ownerId,'');assert.deepEqual(s,before);assert.equal(f.received.length,1);
  const request=f.received[0];assert.equal(request.url,'/v1/chat/completions');assert.equal(request.payload.store,false);assert.deepEqual(request.payload.thinking,{type:'disabled'});assert.equal(request.payload.max_tokens,1024);assert.deepEqual(request.payload.response_format,{type:'json_object'});
  const context=JSON.parse(request.payload.messages[1].content);assert.equal(context.project.id,s.project.id);assert.deepEqual(context.sources.map(source=>source.id),['minutes:input']);
  assert.ok(!JSON.stringify(result).includes('only-local-fixture'));
});

test('严格schema与空thinking兼容，截断/refusal/坏JSON/伪来源均拒绝不部分应用',async t=>{
  let response='schema';const f=await fixture(t,(_request,res)=>{
    if(response==='schema')return completion(res);
    if(response==='truncated')return completion(res,raw,{finish_reason:'length'});
    if(response==='refusal')return completion(res,raw,{message:{refusal:'not available'}});
    if(response==='bad')return completion(res,raw,{message:{content:'{broken'}});
    const invalid=structuredClone(raw);invalid.items[0].sourceRefs[0].sourceId='discussion:foreign';return completion(res,invalid);
  });
  const config=env(f.url,{COBUILD_AI_RESPONSE_FORMAT:'json_schema',COBUILD_AI_THINKING:'  '}),s=seedState(),before=structuredClone(s);
  await generateAssistance(s,input,{env:config});assert.equal(f.received[0].payload.response_format.json_schema.strict,true);assert.equal(f.received[0].payload.thinking,undefined);
  for(response of ['truncated','refusal','bad','foreign'])await assert.rejects(()=>generateAssistance(s,input,{env:config}),error=>error.status===502);
  assert.deepEqual(s,before);
});

test('HTTP错误不暴露服务端正文，重定向不追随，超时与响应上限实际中止',async t=>{
  let mode='error';const f=await fixture(t,(_request,res)=>{
    if(mode==='error'){res.writeHead(500);return res.end('SECRET PROVIDER BODY');}
    if(mode==='redirect'){res.writeHead(302,{Location:'/other'});return res.end();}
    if(mode==='timeout')return;
    res.writeHead(200,{'Content-Type':'application/json'});res.end('x'.repeat(262145));
  });
  await assert.rejects(()=>generateAssistance(seedState(),input,{env:env(f.url)}),error=>error.status===502&&!error.message.includes('SECRET'));
  mode='redirect';await assert.rejects(()=>generateAssistance(seedState(),input,{env:env(f.url)}),error=>error.status===502);assert.equal(f.received.length,2);
  mode='timeout';await assert.rejects(()=>generateAssistance(seedState(),input,{env:env(f.url,{COBUILD_AI_TIMEOUT_MS:'100'})}),error=>error.status===504);
  mode='large';await assert.rejects(()=>generateAssistance(seedState(),input,{env:env(f.url)}),error=>error.status===502&&error.message.includes('上限'));
});
