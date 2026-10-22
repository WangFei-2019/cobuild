import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
const password='account-fixture-password-2026',newPassword='account-fixture-new-password-2026';
const envKeys=['COBUILD_MAIL_API_KEY','COBUILD_MAIL_API_URL','COBUILD_MAIL_FROM','COBUILD_MAIL_TIMEOUT_MS'];
const digest=value=>createHash('sha256').update(value).digest('hex');
async function until(fn){for(let i=0;i<200;i++){const value=fn();if(value)return value;await delay(5);}throw new Error('fixture did not settle');}
async function fixture(t,{configured=true}={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'cobuild-account-')),previous=new Map(envKeys.map(key=>[key,process.env[key]]));
  const mails=[];let providerStatus=200,server,base;
  const transport=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);mails.push({headers:req.headers,body:JSON.parse(Buffer.concat(chunks))});res.writeHead(providerStatus,{'Content-Type':'application/json'});res.end(JSON.stringify(providerStatus===200?{id:`fixture-${mails.length}`}:{error:'provider-body-must-not-leak'}));});
  transport.listen(0,'127.0.0.1');await once(transport,'listening');
  for(const key of envKeys)delete process.env[key];
  if(configured)Object.assign(process.env,{COBUILD_MAIL_API_KEY:'fixture-only-mail-key',COBUILD_MAIL_API_URL:`http://127.0.0.1:${transport.address().port}/emails`,COBUILD_MAIL_FROM:'共建测试 <noreply@fixture.test>',COBUILD_MAIL_TIMEOUT_MS:'1000'});
  async function start(){server=createApp({dataDir,publicUrl:configured?'http://localhost:43210':'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
  async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await start();t.after(async()=>{await stop();transport.closeAllConnections();await new Promise(resolve=>transport.close(resolve));for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(dataDir,{recursive:true,force:true});});
  function client(){let cookie='';return async(path,input,options={})=>{const response=await fetch(base+path,{method:options.method||(input===undefined?'GET':'POST'),headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'}),...options.headers},...(input===undefined?{}:{body:JSON.stringify(input)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:await response.json(),headers:response.headers};};}
  const admin=client(),setup=await admin('/api/auth/setup',{name:'账号管理员',email:'admin@account.test',password});assert.equal(setup.status,200);
  const database=fn=>{const db=new DatabaseSync(join(dataDir,'identity.sqlite'));try{return fn(db);}finally{db.close();}};
  const tokens=()=>database(db=>db.prepare('SELECT * FROM account_tokens ORDER BY rowid').all());
  const projects=()=>[readFileSync(join(dataDir,'workspace.json'),'utf8'),...readdirSync(join(dataDir,'projects')).sort().map(file=>[file,readFileSync(join(dataDir,'projects',file),'utf8')])];
  const rows=()=>database(db=>Object.fromEntries(['accounts','people','project_members','sessions','account_email_verification'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const register=async name=>{const request=client(),result=await request('/api/auth/register',{name,email:`${name}@account.test`,password});assert.equal(result.status,200);return{request,user:result.data.user};};
  const mailToken=mail=>{const url=new URL(mail.body.text.match(/https?:\/\/\S+/)[0]);assert.equal(url.search,'');return {url,token:new URLSearchParams(url.hash.slice(1)).get('token')};};
  const settle=()=>until(()=>!tokens().some(token=>token.status==='pending'));
  const clearCooldown=address=>database(db=>db.prepare('UPDATE login_attempts SET windowStart=0 WHERE key=?').run(digest(`mail:cooldown:${address}`)));
  return{dataDir,admin,setup,client,register,database,tokens,rows,projects,mails,mailToken,settle,clearCooldown,rejectMail:()=>{providerStatus=422;},restart:async()=>{await stop();await start();}};
}

test('旧账号无验证元数据时默认false、旧会话有效，未配邮件不假发送且不改原账号/项目',async t=>{
  const f=await fixture(t,{configured:false}),project=(await f.admin('/api/projects',{name:'旧项目'})).data.state;
  const rows=f.rows(),bytes=f.projects();f.database(db=>db.exec('DROP TABLE account_email_verification; DROP TABLE account_tokens;'));await f.restart();
  const session=(await f.admin('/api/auth/session')).data;assert.equal(session.user.id,f.setup.data.user.id);assert.equal(session.user.emailVerified,false);assert.equal(session.capabilities.mailConfigured,false);
  const account=await f.admin('/api/account');assert.equal(account.status,200);assert.equal(account.data.account.emailVerifiedAt,'');assert.equal(account.data.account.name,'账号管理员');
  for(const [path,input]of[['/api/account/email-verification',{}],['/api/auth/forgot-password',{email:'admin@account.test'}],['/api/auth/forgot-password',{email:'missing@account.test'}]]){const result=await f.admin(path,input);assert.equal(result.status,503);assert.equal(result.data.code,'MAIL_NOT_CONFIGURED');}
  assert.deepEqual(f.rows(),rows);assert.deepEqual(f.projects(),bytes);assert.deepEqual(f.mails,[]);assert.equal((await f.admin(`/api/state?projectId=${project.project.id}`)).status,200);
});

test('本人档案可自助维护且昵称全局唯一，并发碰撞仅一次成功，显示同步而交付历史原字节不变',async t=>{
  const f=await fixture(t),a=await f.register('alice'),b=await f.register('bob');
  const project=(await a.request('/api/projects',{name:'权威本人档案显示'})).data.state;
  const offer=(await a.request('/api/invitations',{projectId:project.project.id,personId:b.user.personId})).data.invitation;
  assert.equal((await b.request('/api/invitations/accept',{token:new URL(offer.url).pathname.split('/').at(-1)})).status,200);
  const bytes=f.projects(),before=f.rows();
  for(const input of [{email:'other@account.test'},{workspaceRole:'admin'},{personId:a.user.personId},{name:'alice'}]){const result=await b.request('/api/account',input,{method:'PATCH'});assert.ok(result.status>=400);}
  assert.deepEqual(f.rows(),before);
  let result=await b.request('/api/account',{name:'伙伴新昵称',bio:'真实账号自行维护的简介',color:'#aabbcc'},{method:'PATCH'});assert.equal(result.status,200);assert.equal(result.data.session.user.name,'伙伴新昵称');
  assert.equal((await a.request(`/api/state?projectId=${project.project.id}`)).data.members.find(member=>member.personId===b.user.personId).name,'伙伴新昵称');assert.deepEqual(f.projects(),bytes);
  const concurrent=await Promise.all([a.request('/api/account',{name:' Shared '},{method:'PATCH'}),b.request('/api/account',{name:'ＳＨＡＲＥＤ'},{method:'PATCH'})]);assert.deepEqual(concurrent.map(value=>value.status).sort(),[200,409]);assert.equal(concurrent.find(value=>value.status===409).data.code,'NAME_TAKEN');
  const anonymous=f.client();assert.equal((await anonymous('/api/account')).status,401);assert.equal((await anonymous('/api/account',{name:'越权'},{method:'PATCH'})).status,401);
});

test('验证邮件按Resend协议发送到当前账号、hash链接不进query、仅摘要持久化且单次消费后跨重启保留',async t=>{
  const f=await fixture(t),a=await f.register('alice'),anonymous=f.client();
  let result=await a.request('/api/account/email-verification',{});assert.equal(result.status,200);assert.equal(f.mails.length,1);
  const mail=f.mails[0],{token,url}=f.mailToken(mail);assert.equal(url.origin,'http://localhost:43210');assert.equal(url.pathname,'/verify-email');assert.deepEqual(mail.body.to,['alice@account.test']);assert.equal(mail.headers.authorization,'Bearer fixture-only-mail-key');assert.ok(mail.headers['idempotency-key']);
  assert.equal(f.tokens()[0].tokenHash,digest(token));assert.equal(JSON.stringify(f.tokens()).includes(token),false);assert.equal((await a.request('/api/account')).data.account.emailVerified,false);
  assert.equal((await anonymous('/api/auth/reset-password',{token,password:newPassword})).data.code,'TOKEN_INVALID');
  const before=f.projects();result=await anonymous('/api/auth/verify-email',{token});assert.equal(result.status,200);assert.equal(result.data.session.user,null);
  assert.equal((await a.request('/api/auth/session')).data.user.emailVerified,true);assert.equal((await anonymous('/api/auth/verify-email',{token})).data.code,'TOKEN_INVALID');
  const mailCount=f.mails.length;assert.equal((await a.request('/api/account/email-verification',{})).data.alreadyVerified,true);assert.equal(f.mails.length,mailCount);assert.deepEqual(f.projects(),before);
  await f.restart();assert.equal((await a.request('/api/account')).data.account.emailVerified,true);
});

test('忘记密码不枚举账号；重置令牌有时限、用途与并发单次限制，并撤销全部旧会话且保留项目',async t=>{
  const f=await fixture(t),a=await f.register('alice'),second=f.client(),visitor=f.client();
  assert.equal((await second('/api/auth/login',{email:'alice@account.test',password})).status,200);
  const project=(await a.request('/api/projects',{name:'密码重置保留'})).data.state,bytes=f.projects();
  const known=await visitor('/api/auth/forgot-password',{email:' ALICE@ACCOUNT.TEST '}),unknown=await visitor('/api/auth/forgot-password',{email:'missing@account.test'});assert.equal(known.status,202);assert.equal(unknown.status,202);assert.deepEqual(known.data,unknown.data);
  await until(()=>f.mails.length===1);await f.settle();const {token,url}=f.mailToken(f.mails[0]);assert.equal(url.pathname,'/reset-password');
  assert.equal((await visitor('/api/auth/verify-email',{token})).data.code,'TOKEN_INVALID');
  const candidates=[newPassword,newPassword+'-other'],results=await Promise.all(candidates.map(value=>visitor('/api/auth/reset-password',{token,password:value})));assert.deepEqual(results.map(value=>value.status).sort(),[200,400]);
  assert.equal(results.find(value=>value.status===400).data.code,'TOKEN_INVALID');assert.equal((await a.request('/api/auth/session')).data.user,null);assert.equal((await second('/api/auth/session')).data.user,null);assert.ok((await f.admin('/api/auth/session')).data.user);
  assert.equal((await visitor('/api/auth/reset-password',{token,password:newPassword})).data.code,'TOKEN_INVALID');
  const winner=candidates[results.findIndex(value=>value.status===200)];assert.equal((await visitor('/api/auth/login',{email:'alice@account.test',password})).status,401);assert.equal((await visitor('/api/auth/login',{email:'alice@account.test',password:winner})).status,200);
  assert.deepEqual(f.projects(),bytes);assert.equal((await visitor(`/api/state?projectId=${project.project.id}`)).status,200);assert.equal((await visitor('/api/account')).data.account.emailVerified,false);
});

test('密码重置SQL失败不消耗令牌/改密码/撤销会话，过期与重新发信会让旧令牌不可用',async t=>{
  const f=await fixture(t),a=await f.register('alice'),visitor=f.client();
  await visitor('/api/auth/forgot-password',{email:'alice@account.test'});await until(()=>f.mails.length===1);await f.settle();let {token}=f.mailToken(f.mails[0]);const before=f.rows(),stored=f.tokens();
  f.database(db=>db.exec("CREATE TRIGGER fail_password BEFORE UPDATE OF passwordHash ON accounts BEGIN SELECT RAISE(ABORT,'fixture credential failure'); END"));
  assert.equal((await visitor('/api/auth/reset-password',{token,password:newPassword})).status,500);assert.deepEqual(f.rows(),before);assert.deepEqual(f.tokens(),stored);assert.ok((await a.request('/api/auth/session')).data.user);
  f.database(db=>db.exec('DROP TRIGGER fail_password'));
  f.database(db=>db.prepare('UPDATE account_tokens SET expiresAt=?').run('2000-01-01T00:00:00.000Z'));assert.equal((await visitor('/api/auth/reset-password',{token,password:newPassword})).data.code,'TOKEN_INVALID');
  f.clearCooldown('alice@account.test');await visitor('/api/auth/forgot-password',{email:'alice@account.test'});await until(()=>f.mails.length===2);await f.settle();const second=f.mailToken(f.mails[1]).token;
  f.clearCooldown('alice@account.test');await visitor('/api/auth/forgot-password',{email:'alice@account.test'});await until(()=>f.mails.length===3);await f.settle();token=f.mailToken(f.mails[2]).token;
  assert.equal((await visitor('/api/auth/reset-password',{token:second,password:newPassword})).data.code,'TOKEN_INVALID');assert.equal((await visitor('/api/auth/reset-password',{token,password:newPassword})).status,200);
});

test('改密码要求当前密码、严格当前身份、成功全设备退出且撤销未使用重置链接',async t=>{
  const f=await fixture(t),a=await f.register('alice'),second=f.client(),visitor=f.client();
  await second('/api/auth/login',{email:'alice@account.test',password});await visitor('/api/auth/forgot-password',{email:'alice@account.test'});await until(()=>f.mails.length===1);await f.settle();const {token}=f.mailToken(f.mails[0]);
  const before=f.rows();let result=await a.request('/api/account/password',{currentPassword:'wrong',newPassword});assert.equal(result.status,403);assert.equal(result.data.code,'CURRENT_PASSWORD_INVALID');assert.equal(result.data.field,'currentPassword');assert.deepEqual(f.rows(),before);
  assert.equal((await a.request('/api/account/password',{currentPassword:password,newPassword,accountId:f.setup.data.user.id})).status,400);
  result=await a.request('/api/account/password',{currentPassword:password,newPassword});assert.equal(result.status,200);assert.equal(result.data.session.user,null);assert.match(result.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await second('/api/auth/session')).data.user,null);assert.equal((await visitor('/api/auth/reset-password',{token,password:newPassword+'!'})).data.code,'TOKEN_INVALID');assert.equal((await visitor('/api/auth/login',{email:'alice@account.test',password:newPassword})).status,200);
});

test('投递失败不假装验证成功、forgot保持统一回执，不保留可用或pending令牌',async t=>{
  const f=await fixture(t),a=await f.register('alice'),visitor=f.client();f.rejectMail();
  let result=await a.request('/api/account/email-verification',{});assert.equal(result.status,502);assert.equal(result.data.code,'MAIL_DELIVERY_FAILED');assert.equal(JSON.stringify(result.data).includes('provider-body'),false);assert.deepEqual(f.tokens(),[]);assert.equal((await a.request('/api/account')).data.account.emailVerified,false);
  f.clearCooldown('alice@account.test');result=await visitor('/api/auth/forgot-password',{email:'alice@account.test'});assert.equal(result.status,202);await until(()=>f.mails.length===2);await f.settle();assert.deepEqual(f.tokens(),[]);
});

test('邮件冷却和IP/邮箱配额持久化，不信任XFF；跨站、超大及客户端身份参数拒绝',async t=>{
  const f=await fixture(t),visitor=f.client();
  const sent=await visitor('/api/auth/forgot-password',{email:'unknown@account.test'});assert.equal(sent.status,202);
  let limited=await visitor('/api/auth/forgot-password',{email:'unknown@account.test'},{headers:{'X-Forwarded-For':'192.0.2.1'}});assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
  await f.restart();assert.equal((await visitor('/api/auth/forgot-password',{email:'unknown@account.test'})).status,429);
  for(let i=0;i<29;i++)assert.equal((await visitor('/api/auth/forgot-password',{email:`unknown${i}@account.test`})).status,202);
  assert.equal((await visitor('/api/auth/forgot-password',{email:'outside-quota@account.test'},{headers:{'X-Forwarded-For':'198.51.100.2'}})).status,429);assert.deepEqual(f.mails,[]);
  const before=f.rows();assert.equal((await f.admin('/api/account',{bio:'cross-site'},{method:'PATCH',headers:{Origin:'https://unrelated.example'}})).status,403);
  assert.equal((await f.admin('/api/account/email-verification',{email:'other@account.test'})).status,400);assert.equal((await visitor('/api/auth/verify-email',{token:'x'.repeat(43),accountId:f.setup.data.user.id})).status,400);
  assert.equal((await f.admin('/api/account',{bio:'x'.repeat(17000)},{method:'PATCH'})).status,413);assert.deepEqual(f.rows(),before);
});

test('邮箱每小时申请配额与密码失败限流跨重启保留，成功改密不能绕过已到上限的失败窗口',async t=>{
  const f=await fixture(t),a=await f.register('alice'),visitor=f.client(),email='unknown@account.test';
  for(let i=0;i<5;i++){f.clearCooldown(email);assert.equal((await visitor('/api/auth/forgot-password',{email})).status,202);}
  f.clearCooldown(email);assert.equal((await visitor('/api/auth/forgot-password',{email})).status,429);assert.deepEqual(f.mails,[]);
  for(let i=0;i<5;i++)assert.equal((await a.request('/api/account/password',{currentPassword:'incorrect',newPassword})).status,403);
  assert.equal((await a.request('/api/account/password',{currentPassword:password,newPassword})).status,429);
  const before=f.rows();await f.restart();f.clearCooldown(email);
  assert.equal((await visitor('/api/auth/forgot-password',{email})).status,429);
  assert.equal((await a.request('/api/account/password',{currentPassword:password,newPassword},{headers:{'X-Forwarded-For':'192.0.2.55'}})).status,429);assert.deepEqual(f.rows(),before);
});
