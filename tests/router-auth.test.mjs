import test from 'node:test';
import assert from 'node:assert/strict';

const originalLocation=globalThis.location,originalHistory=globalThis.history;
globalThis.location=new URL('https://cobuild.example/login');
globalThis.history={state:null,replaceState(state){this.state=state;}};
const {parseRoute,safeNextPath,authHref}=await import('../src/router.js');
if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;
if(originalHistory===undefined)delete globalThis.history;else globalThis.history=originalHistory;

test('independent registration has its own route and rejects extra path segments',()=>{
 assert.deepEqual(parseRoute(new URL('https://cobuild.example/register')),{kind:'register',next:null});
 assert.equal(parseRoute(new URL('https://cobuild.example/register/extra')).kind,'404');
});

test('login and registration links retain the exact invitation return path',()=>{
 const invited='/invite/token-ABC_123';
 const login=parseRoute(new URL(authHref('login',invited),'https://cobuild.example'));
 const registration=parseRoute(new URL(authHref('register',login.next),'https://cobuild.example'));
 const backToLogin=parseRoute(new URL(authHref('login',registration.next),'https://cobuild.example'));
 assert.equal(login.kind,'login');
 assert.equal(registration.kind,'register');
 assert.equal(backToLogin.next,invited);
 assert.deepEqual(parseRoute(new URL(safeNextPath(registration.next),'https://cobuild.example')),{kind:'invite',token:'token-ABC_123'});
});

test('protected project task return paths survive login and registration',()=>{
 const destination='/projects/project%20one/tasks?task=t1&filter=open';
 const registration=parseRoute(new URL(authHref('register',destination),'https://cobuild.example'));
 assert.equal(registration.next,destination);
 assert.equal(safeNextPath(registration.next),destination);
 assert.equal(authHref('login','/dashboard'),'/login');
});

test('authentication return paths reject external destinations and auth loops',()=>{
 for(const value of [undefined,'https://evil.example/path','//evil.example/path','/\\evil.example/path','/projects\n/one','javascript:alert(1)','/login','/register?next=/invite/x','/setup/','/projects/../login']){
  assert.equal(safeNextPath(value),'/dashboard',String(value));
 }
 assert.equal(safeNextPath('//evil.example','/projects'),'/projects');
 assert.equal(parseRoute(new URL(authHref('register','//evil.example'),'https://cobuild.example')).next,null);
});

test('验证与恢复邮件使用fragment令牌，认证回跳不会进入恢复循环',()=>{
 const token='fixture-token-do-not-persist';
 for(const kind of ['reset-password','verify-email']){
  const route=parseRoute(new URL('https://cobuild.example/'+kind+'#token='+token));
  assert.equal(route.kind,kind);assert.equal(route.token,token);
  assert.equal(safeNextPath('/'+kind+'#token='+token),'/dashboard');
 }
 assert.equal(safeNextPath('/forgot-password?email=private@example.test'),'/dashboard');
 assert.equal(safeNextPath('/account'),'/account');
 assert.equal(parseRoute(new URL('https://cobuild.example/notifications')).kind,'notifications');
});
