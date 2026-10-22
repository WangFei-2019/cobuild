import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMailer,mailStatus,mailDiagnostics } from '../mail.mjs';

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

test('QQ SMTP配置强制TLS、独立授权码和匹配发件人，诊断不含凭据',()=>{
 const env={COBUILD_MAIL_TRANSPORT:'smtp',COBUILD_MAIL_SMTP_USER:'sender@fixture.test',COBUILD_MAIL_SMTP_PASSWORD:'fixture-smtp-authorization-only',COBUILD_MAIL_FROM:'共建 <sender@fixture.test>'},publicUrl='https://cobuild.fixture.test';
 assert.equal(mailStatus({env,publicUrl}).configured,true);assert.equal(JSON.stringify(mailDiagnostics({env,publicUrl})).includes(env.COBUILD_MAIL_SMTP_PASSWORD),false);
 for(const patch of [{COBUILD_MAIL_SMTP_PASSWORD:''},{COBUILD_MAIL_SMTP_PORT:'25'},{COBUILD_MAIL_FROM:'other@fixture.test'},{COBUILD_MAIL_SMTP_HOST:'smtp.qq.com/invalid'},{COBUILD_MAIL_SMTP_PASSWORD:'x\r\nheader'}])assert.equal(mailStatus({env:{...env,...patch},publicUrl}).configured,false);
});
test('SMTP测试邮件仅用固定文本，校验接收确认且传输错误不暴露授权码',async()=>{
 const env={COBUILD_MAIL_TRANSPORT:'smtp',COBUILD_MAIL_SMTP_USER:'sender@fixture.test',COBUILD_MAIL_SMTP_PASSWORD:'fixture-smtp-authorization-only'},sent=[];let fail=false,closed=0;
 const mailer=createMailer({env,publicUrl:'https://cobuild.fixture.test',smtpFactory:options=>{assert.equal(options.port,465);assert.equal(options.secure,true);assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.auth.pass,env.COBUILD_MAIL_SMTP_PASSWORD);return {sendMail:async message=>{sent.push(message);if(fail)throw Error(env.COBUILD_MAIL_SMTP_PASSWORD);return {accepted:[message.to]};},close:()=>{closed++;}};}});
 assert.deepEqual(await mailer.sendTest({email:'self@fixture.test',requestId:'test-1'}),{accepted:true});assert.equal(sent[0].to,'self@fixture.test');assert.match(sent[0].subject,/连接测试/);assert.equal(sent[0].text.includes('token='),false);assert.equal(sent[0].disableUrlAccess,true);fail=true;await assert.rejects(mailer.sendTest({email:'self@fixture.test',requestId:'test-2'}),error=>error.code==='MAIL_DELIVERY_FAILED'&&!error.message.includes(env.COBUILD_MAIL_SMTP_PASSWORD));assert.equal(closed,2);mailer.close();
});
