import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server.mjs';

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(),'cobuild-test-'));
  const server = createApp({dataDir,authRequired:false,seedDemo:true});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dataDir,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(`${base}${path}`);
  const post = (path, value, headers = {}) => fetch(`${base}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
  return {base,server,dataDir,get,post};
}

test('不同客户端读取同一份更新，持久化包含原始进展', async t => {
  const {get,post,dataDir} = await fixture(t);
  const before = await (await get('/api/state')).json();
  const raw = '已完成接口字段整理，接着补充样例。';
  const res = await post('/api/action',{type:'addUpdate',actorId:'m2',taskId:'t2',text:raw});
  assert.equal(res.status,200);
  const clientA = (await res.json()).state;
  const clientB = await (await get('/api/state')).json();
  assert.equal(clientB.revision,before.revision+1);
  assert.deepEqual(clientB,clientA);
  const disk = JSON.parse(readFileSync(join(dataDir,'project.json'),'utf8'));
  assert.equal(disk.activities[0].text,raw);
  const reopened = createApp({dataDir,authRequired:false,seedDemo:true});
  reopened.listen(0,'127.0.0.1'); await once(reopened,'listening');
  try {
    const saved = await (await fetch(`http://127.0.0.1:${reopened.address().port}/api/state`)).json();
    assert.deepEqual(saved,clientB);
  } finally { await new Promise(resolve => reopened.close(resolve)); }
});

test('真实文件上传、下载和接收，错误提交不改项目', async t => {
  const {get,post} = await fixture(t);
  const content = Buffer.from('接口说明：GET /api/state\nUTF-8 成果样例','utf8');
  let response = await post('/api/action',{type:'submitArtifact',actorId:'m2',taskId:'t2',name:'接口说明',file:{name:'接口说明.md',type:'text/markdown',base64:content.toString('base64')}});
  assert.equal(response.status,200);
  const state = (await response.json()).state;
  const target = state.tasks.find(t => t.id==='t2');
  assert.equal(target.status,'review');
  const download = await get(target.artifacts[0].url);
  assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),content);
  response = await post('/api/action',{type:'accept',actorId:'m0',taskId:'t2'});
  assert.equal(response.status,403);
  assert.equal((await (await get('/api/state')).json()).revision,state.revision);
  response = await post('/api/action',{type:'accept',actorId:'m3',taskId:'t2'});
  assert.equal(response.status,200);
  assert.equal((await response.json()).state.tasks.find(t=>t.id==='t2').status,'done');
});

test('无效Unicode文件名和截断base64在写入前拒绝，不留下不可下载成果或孤儿文件', async t => {
  const { get, post, dataDir } = await fixture(t);
  const before = await (await get('/api/state')).json();
  for (const file of [{ name: '\ud800.txt', base64: 'YQ==' }, { name: '带\u0000控制符.txt', base64: 'YQ==' },
    { name: 'truncated.txt', base64: 'YQ' }, { name: 'padding.txt', base64: 'YR==' }]) {
    const result = await post('/api/action', { type: 'submitArtifact', actorId: 'm2', taskId: 't2', name: '不能保存损坏成果', file });
    assert.equal(result.status, 400);
  }
  assert.deepEqual(await (await get('/api/state')).json(), before);
  assert.deepEqual(readdirSync(join(dataDir, 'files')), []);
});

test('本地分析和导出，坏输入及跨站请求有明确错误', async t => {
  const {get,post,base} = await fixture(t);
  let response = await post('/api/analyze',{actorId:'m3',taskId:'t3',text:'等待接口确认。'});
  assert.equal(response.status,200);
  assert.equal((await response.json()).analysis.status,'blocked');
  for (const path of ['/api/action','/api/analyze']) {
    response = await post(path,null); assert.equal(response.status,400,path);
  }
  response = await post('/api/action',{type:'addUpdate',actorId:'m3',taskId:'t3',text:'test'},{Origin:'https://unrelated.example'});
  assert.equal(response.status,403);
  response = await fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});
  assert.equal(response.status,415);
  response = await get('/api/report'); assert.equal(response.status,200); assert.ok((await response.text()).includes('任务与交接'));
  response = await get('/api/export'); assert.ok(response.headers.get('content-disposition').includes('attachment')); assert.equal((await response.json()).members.length,4);
  response = await get('/domain.mjs'); assert.equal(response.status,404);
  response = await get('/%2e%2e%2fserver.mjs'); assert.equal(response.status,404);
});

test('重置示例保留递增版本，让所有客户端刷新', async t => {
  const {get,post} = await fixture(t);
  await post('/api/action',{type:'addMember',actorId:'m0',name:'测试成员'});
  const before = await (await get('/api/state')).json();
  const response = await post('/api/reset',{});
  assert.equal(response.status,200);
  const state = (await response.json()).state;
  assert.equal(state.members.length,4);
  assert.equal(state.revision,before.revision+1);
});
