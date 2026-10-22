import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMailer,mailStatus } from '../mail.mjs';

const configured={COBUILD_MAIL_API_KEY:'fixture-private-key',COBUILD_MAIL_FROM:'共建 <noreply@fixture.test>'};
test('Resend纯配置能力不联网且严查URL/凭据/超时，公开结果只有configured',()=>{
  assert.deepEqual(mailStatus({env:{}}),{configured:false});
  assert.deepEqual(mailStatus({env:configured,publicUrl:'https://cobuild.fixture.test'}),{configured:true});
  for(const patch of[{COBUILD_MAIL_API_URL:'http://remote.fixture.test/emails'},{COBUILD_MAIL_API_URL:'https://user:pass@provider.test/emails'},{COBUILD_MAIL_FROM:'a@b.test\r\nBcc: injected@fixture.test'},{COBUILD_MAIL_API_KEY:'private\r\nheader'},{COBUILD_MAIL_TIMEOUT_MS:'0'},{COBUILD_MAIL_TIMEOUT_MS:'16000'}])assert.deepEqual(mailStatus({env:{...configured,...patch},publicUrl:'https://cobuild.fixture.test'}),{configured:false});
  for(const publicUrl of['','http://remote.fixture.test','https://user:pass@site.test','https://site.test/?token=secret'])assert.equal(mailStatus({env:configured,publicUrl}).configured,false);
});
test('邮件请求拒重定向、不转发Bearer/token；错误正文和密钥不进入业务错误',async t=>{
  let leaked=0;const target=http.createServer((req,res)=>{leaked++;res.end('{}');});target.listen(0,'127.0.0.1');await once(target,'listening');
  const redirect=http.createServer((req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:'+target.address().port});res.end();});redirect.listen(0,'127.0.0.1');await once(redirect,'listening');
  t.after(async()=>{for(const server of[redirect,target]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
  const mailer=createMailer({env:{...configured,COBUILD_MAIL_API_URL:'http://127.0.0.1:'+redirect.address().port+'/emails'},publicUrl:'https://cobuild.fixture.test'});
  await assert.rejects(mailer.send({email:'test@fixture.test',purpose:'verify-email',token:'x'.repeat(43)}),error=>error.code==='MAIL_DELIVERY_FAILED'&&!error.message.includes('fixture-private-key'));assert.equal(leaked,0);mailer.close();
});
test('邮件提供方超大响应或超时均有限失败，关闭后不再发请求',async t=>{
  let mode='oversize',count=0;const server=http.createServer((req,res)=>{count++;if(mode==='oversize'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'x'.repeat(20000)}));}});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const mailer=createMailer({env:{...configured,COBUILD_MAIL_API_URL:'http://127.0.0.1:'+server.address().port+'/emails',COBUILD_MAIL_TIMEOUT_MS:'1000'},publicUrl:'https://cobuild.fixture.test'}),input={email:'test@fixture.test',purpose:'reset-password',token:'x'.repeat(43)};
  await assert.rejects(mailer.send(input),error=>error.code==='MAIL_DELIVERY_FAILED');mode='timeout';const start=Date.now();await assert.rejects(mailer.send(input),error=>error.code==='MAIL_DELIVERY_FAILED');assert.ok(Date.now()-start<2500);mailer.close();await assert.rejects(mailer.send(input),error=>error.code==='MAIL_NOT_CONFIGURED');assert.equal(count,2);
});
