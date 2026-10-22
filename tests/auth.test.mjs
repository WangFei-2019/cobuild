import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp, validateServerConfig } from '../server.mjs';
import { seedState } from '../domain.mjs';

const PASSWORD = 'local-test-passphrase-2026';
async function fixture(t,options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(),'cobuild-auth-'));
  let server,base;
  async function start() {
    // This intentionally uses the production default authentication path.
    server = createApp({dataDir,seedDemo:true,...options});
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => { if(server.listening) await new Promise(resolve => server.close(resolve)); rmSync(dataDir,{recursive:true,force:true}); });
  function client() {
    let cookie = '';
    async function request(path,method = 'GET',value,headers = {}) {
      const response = await fetch(`${base}${path}`,{method,headers:{...(cookie ? {Cookie:cookie} : {}),...(value !== undefined ? {'Content-Type':'application/json'} : {}),...headers},...(value !== undefined ? {body:JSON.stringify(value)} : {})});
      const next = response.headers.get('set-cookie');
      if(next) cookie = next.includes('Max-Age=0') ? '' : next.split(';')[0];
      return response;
    }
    return {get:path => request(path),post:(path,value,headers) => request(path,'POST',value,headers),request,cookie:() => cookie,json:async path => (await request(path)).json()};
  }
  async function setup(admin = client()) {
    const response = await admin.post('/api/auth/setup',{name:'真实管理员',email:'admin@example.com',password:PASSWORD,...(options.setupToken ? {setupToken:options.setupToken} : {})});
    assert.equal(response.status,200);
    return {admin,session:await response.json()};
  }
  async function invite(admin,guest,{projectId='p1',memberId,email='guest@example.com',name='参与者',accessRole='member'} = {}) {
    const created = await admin.post('/api/invitations',{projectId,memberId,email,accessRole});
    assert.equal(created.status,201);
    const invitation = (await created.json()).invitation;
    const token = new URL(invitation.url).pathname.split('/').at(-1);
    const registered = await guest.post('/api/auth/register',{name,email,password:PASSWORD,inviteToken:token});
    assert.equal(registered.status,200);
    return {invitation,token,session:await registered.json()};
  }
  const restart = async () => { await new Promise(resolve => server.close(resolve)); await start(); };
  const rawGet = (path,headers) => new Promise((resolve,reject) => {
    const request = http.get(`${base}${path}`,{headers},response => { response.resume(); response.on('end',() => resolve({status:response.statusCode})); });
    request.on('error',reject);
  });
  return {dataDir,client,setup,invite,restart,rawGet};
}

test('默认鉴权、真实管理员身份、持久哈希会话、退出和会话失效；SPA仅白名单刷新',async t => {
  const {dataDir,client,setup,restart} = await fixture(t);
  const anonymous = client();
  assert.equal((await anonymous.json('/api/auth/session')).setupRequired,true);
  for(const path of ['/api/state','/api/workspace','/api/people','/api/export','/api/report','/api/files/aaaaaaaa-bbbb']) assert.equal((await anonymous.get(path)).status,401,path);
  assert.equal((await anonymous.post('/api/action',{type:'addMember',actorId:'m0',name:'冒充者'})).status,401);
  for(const path of ['/projects','/projects/p1/overview','/projects/p1/mine','/people','/people/person-example','/settings','/setup','/login']) assert.equal((await anonymous.get(path)).status,200,path);
  assert.equal((await anonymous.get('/projects/p1/not-a-page')).status,404);
  assert.equal((await anonymous.get('/missing.js')).status,404);
  assert.equal((await anonymous.get('/server.mjs')).status,404);
  const {admin,session} = await setup();
  assert.equal(session.user.workspaceRole,'admin');
  const state = await admin.json('/api/state');
  assert.notEqual(state.currentMemberId,'m0');
  assert.equal(state.members.find(member => member.id===state.currentMemberId).name,'真实管理员');
  assert.deepEqual(state.tasks,seedState().tasks);
  assert.deepEqual(state.permissions,{manageProject:true,createTask:true,readOnly:false});
  assert.equal(state.members.find(member => member.id==='m0').accountLinked,false);
  const unchanged = JSON.parse(readFileSync(join(dataDir,'project.json'),'utf8'));
  assert.equal((await admin.post('/api/action',{type:'accept',taskId:'t6'})).status,403);
  assert.equal((await admin.post('/api/action',{type:'accept',actorId:'m0',taskId:'t6'})).status,403);
  assert.equal((await admin.post('/api/reset',{})).status,403);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir,'project.json'),'utf8')),unchanged);
  assert.equal((await admin.post('/api/auth/setup',{name:'抢管理员',email:'other@example.com',password:PASSWORD})).status,409);
  const rawToken = admin.cookie().split('=')[1];
  const db = new DatabaseSync(join(dataDir,'identity.sqlite'));
  const account = db.prepare('SELECT passwordHash,passwordSalt FROM accounts').get();
  const stored = db.prepare('SELECT tokenHash FROM sessions').get();
  assert.equal(account.passwordHash.length,128); assert.equal(account.passwordSalt.length,32);
  assert.notEqual(account.passwordHash,PASSWORD);
  assert.equal(stored.tokenHash,createHash('sha256').update(rawToken).digest('hex'));
  assert.notEqual(stored.tokenHash,rawToken); db.close();
  await restart();
  assert.equal((await admin.json('/api/auth/session')).user.id,session.user.id);
  const expiredCookie = admin.cookie();
  const logout = await admin.post('/api/auth/logout',{});
  assert.equal(logout.status,200); assert.match(logout.headers.get('set-cookie'),/HttpOnly/); assert.match(logout.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal((await anonymous.request('/api/state','GET',undefined,{Cookie:expiredCookie})).status,401);
  assert.equal((await admin.post('/api/auth/login',{email:'admin@example.com',password:PASSWORD})).status,200);
  const expiryDb = new DatabaseSync(join(dataDir,'identity.sqlite'));
  expiryDb.prepare('UPDATE sessions SET expiresAt=?').run('2000-01-01T00:00:00.000Z'); expiryDb.close();
  assert.equal((await admin.json('/api/auth/session')).user,null);
  assert.equal((await admin.get('/api/state')).status,401);
});

test('邀请认领原成员且不能冒充接收人，两个真实账号完成提交与验收',async t => {
  const {client,setup,invite} = await fixture(t);
  const {admin} = await setup();
  const before = await admin.json('/api/state');
  const unboundId = before.members.find(member => member.id==='m2').personId;
  const author = client(), reviewer = client();
  const joined = await invite(admin,author,{memberId:'m2',email:'author@example.com',name:'周予'});
  assert.equal(joined.session.user.personId,unboundId);
  assert.equal(joined.session.projectId,'p1');
  assert.equal((await author.json('/api/state')).currentMemberId,'m2');
  assert.equal((await author.json('/api/state')).permissions.manageProject,false);
  assert.equal((await author.post('/api/action',{type:'updateProject',patch:{description:'越权'}})).status,403);
  const submitted = await author.post('/api/action',{type:'submitArtifact',taskId:'t2',name:'真实账号成果',note:'已补充可检查的接口说明。'});
  assert.equal(submitted.status,200);
  assert.equal((await submitted.json()).state.tasks.find(task=>task.id==='t2').artifacts[0].submittedBy,'m2');
  assert.equal((await author.post('/api/action',{type:'accept',taskId:'t2'})).status,403);
  assert.equal((await author.post('/api/action',{type:'accept',taskId:'t2',actorId:'m3'})).status,403);
  await invite(admin,reviewer,{memberId:'m3',email:'reviewer@example.com',name:'许言'});
  const reviewed = await reviewer.post('/api/action',{type:'accept',taskId:'t2'});
  assert.equal(reviewed.status,200);
  assert.equal((await reviewed.json()).state.tasks.find(task=>task.id==='t2').status,'done');
  const person = await author.json(`/api/people/${unboundId}`);
  assert.equal(person.artifacts.find(artifact=>artifact.name==='真实账号成果').attribution,'submittedBy');
  assert.equal(person.artifacts.find(artifact=>artifact.name==='真实账号成果').acceptanceStatus,'accepted');
  assert.equal((await author.post('/api/invitations/accept',{token:joined.token})).status,410);
});

test('跨项目ACL覆盖文件/导出/规则分析与人员聚合，已有人员加入保持统一档案',async t => {
  const {client,setup,invite} = await fixture(t);
  const {admin} = await setup();
  const author = client(), outsider = client();
  const joined = await invite(admin,author,{memberId:'m2',email:'author@example.com'});
  const content = Buffer.from('只对项目参与者开放的成果');
  const submitted = await author.post('/api/action',{type:'submitArtifact',taskId:'t2',name:'项目私有文件',file:{name:'private.txt',base64:content.toString('base64')}});
  assert.equal(submitted.status,200);
  const fileURL = (await submitted.json()).state.tasks.find(task=>task.id==='t2').artifacts[0].url;
  const project = (await (await admin.post('/api/projects',{name:'第二个项目',color:'#b47e59'})).json()).state;
  await invite(admin,outsider,{projectId:project.project.id,email:'outsider@example.com'});
  assert.deepEqual((await outsider.json('/api/workspace')).projects.map(project=>project.id),[project.project.id]);
  for(const path of ['/api/state','/api/export','/api/report']) assert.equal((await outsider.get(`${path}?projectId=p1`)).status,403,path);
  assert.equal((await outsider.post('/api/analyze',{projectId:'p1',taskId:'t2',text:'不可访问'})).status,403);
  assert.equal((await outsider.get(fileURL)).status,404);
  assert.equal((await outsider.get(`/api/people/${joined.session.user.personId}`)).status,404);
  assert.deepEqual(Buffer.from(await (await author.get(fileURL)).arrayBuffer()),content);
  assert.equal((await admin.post('/api/project-members',{projectId:project.project.id,personId:joined.session.user.personId,role:'接口负责人'})).status,403);
  const invited = await admin.post('/api/invitations',{projectId:project.project.id,personId:joined.session.user.personId});
  assert.equal(invited.status,201);
  const accepted = await author.post('/api/invitations/accept',{token:new URL((await invited.json()).invitation.url).pathname.split('/').at(-1)});
  assert.equal(accepted.status,200);
  const linked = (await accepted.json()).state.members.find(member=>member.personId===joined.session.user.personId);
  assert.notEqual(linked.id,'m2');
  const person = await author.json(`/api/people/${joined.session.user.personId}`);
  assert.equal(person.projects.length,2);
  assert.deepEqual(new Set(person.projects.map(row=>row.project.color)),new Set(['#427b68','#b47e59']));
  assert.equal(person.projects.find(row=>row.project.id===project.project.id).stats.progress,null);
  assert.equal((await author.get('/api/state?projectId=missing')).status,404);
});

test('邀请邮箱、撤销、到期和只读角色均由服务器执行；同名档案不自动合并',async t => {
  const {client,setup,invite,dataDir} = await fixture(t);
  const {admin} = await setup();
  const viewer = client();
  const created = await admin.post('/api/invitations',{projectId:'p1',memberId:'m1',email:'viewer@example.com',accessRole:'viewer'});
  const invitation = (await created.json()).invitation;
  const token = new URL(invitation.url).pathname.split('/').at(-1);
  const resolved = await viewer.json(`/api/invitations/resolve?token=${token}`);
  assert.equal(resolved.project.id,'p1'); assert.equal(resolved.person.name,'林夏'); assert.equal(resolved.person.accountLinked,false);
  assert.equal((await viewer.post('/api/auth/register',{name:'林夏',email:'wrong@example.com',password:PASSWORD,inviteToken:token})).status,403);
  assert.equal((await viewer.post('/api/auth/register',{name:'林夏',email:'viewer@example.com',password:PASSWORD,inviteToken:token})).status,200);
  assert.deepEqual((await viewer.json('/api/state')).permissions,{manageProject:false,createTask:false,readOnly:true});
  assert.equal((await viewer.post('/api/action',{type:'addUpdate',taskId:'t1',text:'即使原负责人也不能越过只读角色'})).status,403);
  assert.equal((await viewer.post('/api/invitations',{projectId:'p1'})).status,403);
  const revoked = (await (await admin.post('/api/invitations',{projectId:'p1',email:'revoked@example.com'})).json()).invitation;
  assert.equal((await admin.post('/api/invitations/revoke',{id:revoked.id})).status,200);
  assert.equal((await client().get(`/api/invitations/resolve?token=${new URL(revoked.url).pathname.split('/').at(-1)}`)).status,410);
  const expired = (await (await admin.post('/api/invitations',{projectId:'p1',email:'expired@example.com'})).json()).invitation;
  const db = new DatabaseSync(join(dataDir,'identity.sqlite'));
  db.prepare('UPDATE invitations SET expiresAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z',expired.id); db.close();
  assert.equal((await client().get(`/api/invitations/resolve?token=${new URL(expired.url).pathname.split('/').at(-1)}`)).status,410);
  const namesake = client();
  const offered = await admin.post('/api/invitations',{projectId:'p1',email:'namesake@example.com'});
  const nicknameToken = new URL((await offered.json()).invitation.url).pathname.split('/').at(-1);
  const duplicate = await namesake.post('/api/auth/register',{name:'林夏',email:'namesake@example.com',password:PASSWORD,inviteToken:nicknameToken});
  assert.equal(duplicate.status,409); assert.equal((await duplicate.json()).code,'NAME_TAKEN');
  const registered = await namesake.post('/api/auth/register',{name:'林夏的另一位伙伴',email:'namesake@example.com',password:PASSWORD,inviteToken:nicknameToken});
  assert.equal(registered.status,200); assert.notEqual((await registered.json()).user.personId,resolved.person.id);
  assert.equal((await admin.json('/api/people')).people.filter(person=>person.name==='林夏').length,1);
});

test('登录限流持久化，Origin/Host保护，远程初始化口令和Secure Cookie',async t => {
  const {client,setup,restart,rawGet} = await fixture(t);
  const {admin} = await setup();
  assert.equal((await admin.post('/api/action',{type:'addMember',name:'不应添加'},{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await rawGet('/api/state',{Host:'untrusted.example'})).status,403);
  const attacker = client();
  for(let count=0;count<5;count++) assert.equal((await attacker.post('/api/auth/login',{email:'admin@example.com',password:'incorrect-passphrase'})).status,401);
  assert.equal((await attacker.post('/api/auth/login',{email:'admin@example.com',password:PASSWORD})).status,429);
  await restart();
  assert.equal((await attacker.post('/api/auth/login',{email:'admin@example.com',password:PASSWORD})).status,429);
  const remote = await fixture(t,{publicUrl:'https://collaboration.example',setupToken:'one-use-bootstrap-secret'});
  const first = remote.client();
  assert.equal((await first.json('/api/auth/session')).setupTokenRequired,true);
  assert.equal((await first.post('/api/auth/setup',{name:'管理员',email:'owner@example.com',password:PASSWORD})).status,403);
  const response = await first.post('/api/auth/setup',{name:'管理员',email:'owner@example.com',password:PASSWORD,setupToken:'one-use-bootstrap-secret'});
  assert.equal(response.status,200); assert.match(response.headers.get('set-cookie'),/; Secure/);
  const noToken = await fixture(t,{publicUrl:'https://collaboration.example'});
  assert.equal((await noToken.client().post('/api/auth/setup',{name:'管理员',email:'owner@example.com',password:PASSWORD})).status,503);
});

test('工作区管理员以项目普通成员身份仍可规划和验收里程碑，普通成员保持403',async t => {
  const {client,setup,invite,dataDir} = await fixture(t);
  const {admin,session} = await setup();
  const owner = client(), member = client();
  await invite(admin,owner,{email:'project-owner@example.com',name:'第二项目发起人'});
  const created = await owner.post('/api/projects',{name:'其他成员发起的项目',deadline:'2026-11-30'});
  assert.equal(created.status,201);
  const projectId = (await created.json()).state.project.id;
  // The workspace administrator accepts a normal-member invitation while
  // retaining the separate, trusted workspace administration capability.
  const invited = await owner.post('/api/invitations',{projectId,personId:session.user.personId,accessRole:'member'});
  assert.equal(invited.status,201);
  const added = await admin.post('/api/invitations/accept',{token:new URL((await invited.json()).invitation.url).pathname.split('/').at(-1)});
  assert.equal(added.status,200);
  await invite(owner,member,{projectId,email:'ordinary-member@example.com',name:'普通参与者'});
  const before = await admin.json(`/api/state?projectId=${projectId}`);
  const actorId = before.currentMemberId;
  assert.notEqual(actorId,'m0');
  assert.equal(before.members.find(item=>item.id===actorId).accessRole,'member');
  assert.equal(before.permissions.manageProject,true);
  const draft = {
    title:'本轮交付计划',summary:'完成一项可核对成果并确认里程碑。',assumptions:[],risks:[],questions:[],
    milestones:[{id:'draft-phase',title:'首轮交付',goal:'完成真实成果交接',due:'2026-11-10',acceptanceCriteria:'所属任务交付并由指定接收人确认'}],
    tasks:[{id:'draft-task',title:'提交交付说明',description:'整理可检查的交付说明',ownerId:actorId,reviewerId:actorId,due:'2026-11-08',deliverable:'交付说明',dependsOn:[],milestoneId:'draft-phase'}]
  };
  assert.equal((await member.post('/api/plans/apply',{projectId,expectedRevision:before.revision,draft})).status,403);
  const applied = await admin.post('/api/plans/apply',{projectId,expectedRevision:before.revision,draft});
  assert.equal(applied.status,200);
  let state = (await applied.json()).state;
  assert.equal(state.activities[0].actorId,actorId);
  const taskId = state.tasks[0].id, milestoneId = state.milestones[0].id;
  const submitted = await admin.post('/api/action',{projectId,type:'submitArtifact',taskId,name:'已核对的交付说明',note:'提供可检查的成果内容。'});
  assert.equal(submitted.status,200);
  const accepted = await admin.post('/api/action',{projectId,type:'accept',taskId});
  assert.equal(accepted.status,200);
  state = (await accepted.json()).state;
  assert.equal(state.tasks[0].reviewerId,actorId);
  assert.equal(state.tasks[0].artifacts[0].submittedBy,actorId);
  const unchanged = structuredClone(state);
  assert.equal((await member.post('/api/milestones/action',{projectId,type:'acceptMilestone',milestoneId,expectedRevision:state.revision,note:'普通成员不得越权验收'})).status,403);
  assert.deepEqual(await admin.json(`/api/state?projectId=${projectId}`),unchanged);
  const finalized = await admin.post('/api/milestones/action',{projectId,type:'acceptMilestone',milestoneId,expectedRevision:state.revision,note:'已核对所有约定成果'});
  assert.equal(finalized.status,200);
  state = (await finalized.json()).state;
  assert.equal(state.milestones[0].status,'accepted');
  assert.equal(state.milestones[0].acceptedBy,actorId);
  assert.equal(state.activities[0].actorId,actorId);
  // Effective authorization must not rewrite the persisted project membership role.
  const db = new DatabaseSync(join(dataDir,'identity.sqlite'));
  assert.equal(db.prepare('SELECT accessRole FROM project_members WHERE projectId=? AND personId=?').get(projectId,session.user.personId).accessRole,'member');
  db.close();
  const disk = JSON.parse(readFileSync(join(dataDir,'projects',`${projectId}.json`),'utf8'));
  assert.equal(Object.hasOwn(disk.members.find(item=>item.id===actorId),'accessRole'),false);
});

test('正式部署拒绝非回环明文站点，全地址监听必须配置HTTPS且本机开发仍可HTTP',() => {
  for (const publicUrl of ['http://collaboration.example','http://192.168.1.10:4173']) {
    assert.throws(() => validateServerConfig({publicUrl}),/HTTPS/);
  }
  for (const publicUrl of ['', 'http://127.0.0.1:4173']) {
    assert.throws(() => validateServerConfig({host:'0.0.0.0',publicUrl}),/HTTPS/);
  }
  assert.deepEqual(validateServerConfig({host:'0.0.0.0',publicUrl:'https://collaboration.example'}),{host:'0.0.0.0',port:4173,publicUrl:'https://collaboration.example'});
  assert.deepEqual(validateServerConfig({host:'127.0.0.1'}),{host:'127.0.0.1',port:4173,publicUrl:''});
  assert.equal(validateServerConfig({publicUrl:'http://localhost:4173'}).publicUrl,'http://localhost:4173');
  assert.equal(validateServerConfig({publicUrl:'http://127.0.0.2:4173'}).publicUrl,'http://127.0.0.2:4173');
});

test('工作台默认鉴权、真实档案归属和跨项目搜索ACL，未知搜索参数不会泄露任务', async t => {
  const { client, setup, invite } = await fixture(t);
  assert.equal((await client().get('/api/dashboard')).status, 401);
  assert.equal((await client().get('/dashboard')).status, 200);
  const { admin } = await setup();
  const empty = await admin.json('/api/dashboard');
  assert.deepEqual(empty.summary, { todo: 0, toReview: 0, blocked: 0, dueSoon: 0 });
  assert.deepEqual(empty.search.tasks, []);
  const author = client(); await invite(admin, author, { memberId: 'm2', email: 'dashboard@example.com' });
  const mine = await author.json('/api/dashboard');
  assert.equal(mine.summary.todo, 2);
  assert.ok(mine.sections.todo.every(row => row.owner.id === 'm2' && row.currentMemberId === 'm2'));
  const created = await admin.post('/api/projects', { name: '不可见项目' });
  const privateState = (await created.json()).state;
  assert.equal((await admin.post('/api/action', { projectId: privateState.project.id, type: 'createTask',
    title: 'private-dashboard-marker', ownerId: privateState.currentMemberId, reviewerId: privateState.currentMemberId, deliverable: '私有交付物' })).status, 200);
  const privateSearch = await author.json('/api/dashboard?q=private-dashboard-marker');
  assert.equal(privateSearch.search.total, 0);
  assert.deepEqual(privateSearch.summary, mine.summary);
  const visible = await author.json('/api/dashboard?q=CB-102');
  assert.equal(visible.search.total, 1); assert.equal(visible.search.tasks[0].project.id, 'p1');
  assert.equal(Object.hasOwn(visible.search.tasks[0], 'artifacts'), false);
  assert.equal((await author.get(`/api/dashboard?q=${'x'.repeat(121)}`)).status, 400);
  assert.equal((await author.get('/api/dashboard?q=a&q=b')).status, 400);
});
