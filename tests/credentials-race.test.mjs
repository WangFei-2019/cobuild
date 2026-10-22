import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('真实HTTP旧密码登录在改密或重置COMMIT后才完成scrypt时，不能重新创建已撤销会话',async()=>{
  const serverModule=new URL('../server.mjs',import.meta.url).href;
  const source=`import assert from 'node:assert/strict';
    import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';
    import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';import {DatabaseSync} from 'node:sqlite';
    const original=crypto.scrypt;let holdNext=false,release,notify;
    crypto.scrypt=function(...args){const callback=args.pop(),held=holdNext;holdNext=false;return original(...args,(error,key)=>{if(held){release=()=>callback(error,key);notify();}else callback(error,key);});};
    syncBuiltinESMExports();const {createApp}=await import(${JSON.stringify(serverModule)});
    const dataDir=mkdtempSync(join(tmpdir(),'cobuild-credential-race-')),server=createApp({dataDir,publicUrl:'',setupToken:''});
    server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
    function client(){let cookie='';return async(path,input)=>{const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};};}
    const account=client(),visitor=client(),email='race@fixture.test',first='race-original-password-2026',second='race-changed-password-2026',third='race-reset-password-2026';
    const db=new DatabaseSync(join(dataDir,'identity.sqlite'));
    try{
      const setup=await account('/api/auth/setup',{name:'并发账号',email,password:first});assert.equal(setup.status,200);const accountId=setup.data.user.id;
      let reached=new Promise(resolve=>{notify=resolve;});holdNext=true;
      let staleLogin=visitor('/api/auth/login',{email,password:first});await reached;
      assert.equal((await account('/api/account/password',{currentPassword:first,newPassword:second})).status,200);
      release();let result=await staleLogin;assert.equal(result.status,401);assert.equal(result.cookie,null);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE accountId=?').get(accountId).n,0);
      assert.equal((await account('/api/auth/login',{email,password:second})).status,200);
      const token=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(token).digest('hex');
      db.prepare('INSERT INTO account_tokens VALUES(?,?,?,?,?,?,?)').run(hash,'reset-password',accountId,email,new Date().toISOString(),new Date(Date.now()+60000).toISOString(),'active');
      reached=new Promise(resolve=>{notify=resolve;});holdNext=true;staleLogin=visitor('/api/auth/login',{email,password:second});await reached;
      assert.equal((await visitor('/api/auth/reset-password',{token,password:third})).status,200);
      release();result=await staleLogin;assert.equal(result.status,401);assert.equal(result.cookie,null);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE accountId=?').get(accountId).n,0);
      assert.equal((await account('/api/auth/session')).data.user,null);
      assert.equal((await visitor('/api/auth/login',{email,password:third})).status,200);
    }finally{db.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});}`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe'],env:{...process.env,COBUILD_MAIL_API_KEY:'',COBUILD_MAIL_FROM:'',COBUILD_PUBLIC_URL:''}});
  let output='';for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
  const [code,signal]=await once(child,'exit');assert.equal(code,0,`race fixture failed (${signal||'exit'}): ${output}`);
});
