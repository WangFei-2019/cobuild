import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '../identity.mjs';
import { createWorkspace } from '../workspace.mjs';
import { createApp } from '../server.mjs';
import { backupData, restoreData } from '../scripts/backup.mjs';

const password='recovery-fixture-password-only-2026';
const identityModule=new URL('../identity.mjs',import.meta.url).href,workspaceModule=new URL('../workspace.mjs',import.meta.url).href;
const journals=dir=>existsSync(join(dir,'.transactions'))?readdirSync(join(dir,'.transactions')).filter(file=>file.endsWith('.json')):[];
async function base(t) {
  const dataDir=mkdtempSync(join(tmpdir(),'cobuild-recovery-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const identity=createIdentity(dataDir),admin=await identity.setup({name:'恢复管理员',email:'admin@recovery.test',password}),worker=await identity.register({name:'真实伙伴',email:'worker@recovery.test',password},()=>{throw new Error('not invited');});
  const workspace=createWorkspace(dataDir),created=workspace.create({name:'原项目',ownerName:admin.user.name},{persist(state,effect){identity.syncProject(state,new Map([['m0',{personId:admin.user.personId,accessRole:'admin'}]]),effect);}});
  const id=created.state.project.id,offer=identity.invite({projectId:id,personId:worker.user.personId,accessRole:'member'},admin.user);
  const bytes=()=>[readFileSync(join(dataDir,'workspace.json'),'utf8'),readFileSync(join(dataDir,'projects',`${id}.json`),'utf8')];
  const original=bytes();identity.close();return {dataDir,admin,worker,id,token:offer.token,bytes,original};
}
async function crashInvite(input,phase) {
  // Kill a real child process at the exact production effect boundary. No
  // testing branch, raw password, or session token is written to its journal.
  const script=`import {createIdentity} from ${JSON.stringify(identityModule)};
    import {createWorkspace} from ${JSON.stringify(workspaceModule)};
    const value=JSON.parse(process.env.COBUILD_RECOVERY_FIXTURE);
    const identity=createIdentity(value.dataDir),workspace=createWorkspace(value.dataDir,{operationCommitted:id=>identity.operationCommitted(id)});
    identity.accept(value.token,identity.user(value.accountId),(projectId,person)=>{
      const state=structuredClone(workspace.state(projectId)),memberId='member-recovery-worker';
      state.members.push({id:memberId,name:person.name,role:'项目协作者',color:person.color,initial:person.initial});state.revision++;
      const effect=workspace.stageSave(projectId,state);
      return {memberId,effect:{commit(opId){effect.commit(opId);if(value.phase==='before-sql-commit')process.kill(process.pid,'SIGKILL');},rollback(){effect.rollback();},finalize(){if(value.phase==='after-sql-commit')process.kill(process.pid,'SIGKILL');effect.finalize();}}};
    });process.exit(42);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,COBUILD_RECOVERY_FIXTURE:JSON.stringify({dataDir:input.dataDir,token:input.token,accountId:input.worker.user.id,phase})},stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',chunk=>{error+=chunk;});
  const [code,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL',`child must reach crash boundary, exit ${code}: ${error}`);
  assert.equal(journals(input.dataDir).length,1);
  const content=readFileSync(join(input.dataDir,'.transactions',journals(input.dataDir)[0]),'utf8');
  assert.equal(content.includes(input.token),false);assert.equal(content.includes(password),false);
}
async function startRecovered(t,dataDir) {
  const server=createApp({dataDir,publicUrl:'',setupToken:''});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return server;
}

test('JSON已写而SQL尚未COMMIT时SIGKILL，启动先恢复原字节再sync，不产生孤立成员或假人员',async t=>{
  const value=await base(t);await crashInvite(value,'before-sql-commit');assert.notDeepEqual(value.bytes(),value.original);
  await startRecovered(t,value.dataDir);assert.deepEqual(value.bytes(),value.original);assert.deepEqual(journals(value.dataDir),[]);
  const identity=createIdentity(value.dataDir);try {
    assert.equal(identity.people().length,2);assert.equal(identity.memberships(value.worker.user.personId).length,0);
    assert.equal(identity.resolveInvitation(value.token).status,'pending');
  }finally{identity.close();}
});

test('SQL已COMMIT而journal未清理时SIGKILL，启动保留合法加入与精确账号映射、仅清日志',async t=>{
  const value=await base(t);await crashInvite(value,'after-sql-commit');const committed=value.bytes();
  await startRecovered(t,value.dataDir);assert.deepEqual(value.bytes(),committed);assert.deepEqual(journals(value.dataDir),[]);
  const identity=createIdentity(value.dataDir);try {
    assert.equal(identity.people().length,2);assert.equal(identity.member(value.id,'member-recovery-worker').personId,value.worker.user.personId);
    assert.equal(identity.invitations(value.id)[0].status,'accepted');
  }finally{identity.close();}
});

test('未提交journal遇到非old/next合法更新时拒绝启动，不盲目恢复旧index或覆写项目',async t=>{
  const value=await base(t);await crashInvite(value,'before-sql-commit');
  const path=join(value.dataDir,'projects',`${value.id}.json`),modified=JSON.parse(readFileSync(path));modified.project.description='不能被旧恢复快照覆盖';modified.revision++;
  writeFileSync(path,JSON.stringify(modified));const before=value.bytes();
  assert.throws(()=>createApp({dataDir:value.dataDir,publicUrl:'',setupToken:''}),/恢复失败/);
  assert.deepEqual(value.bytes(),before);assert.equal(journals(value.dataDir).length,1);
});

test('正常完成清理日志，stale commit和late rollback均拒绝覆盖另一项目的合法更新',async t=>{
  const value=await base(t),identity=createIdentity(value.dataDir),workspace=createWorkspace(value.dataDir,{operationCommitted:id=>identity.operationCommitted(id)});
  t.after(()=>identity.close());assert.deepEqual(journals(value.dataDir),[]);
  const other=workspace.create({name:'另一个项目',ownerName:'恢复管理员'}).state;
  let next=structuredClone(workspace.state(value.id));next.project.description='尚未提交';next.revision++;
  const stale=workspace.stageSave(value.id,next),updated=structuredClone(other);updated.project.description='合法修改';updated.revision++;workspace.save(other.project.id,updated);
  assert.throws(()=>stale.commit(),error=>error.status===409);assert.equal(workspace.state(other.project.id).project.description,'合法修改');assert.equal(workspace.state(value.id).project.description,'');
  const effect=workspace.stageSave(value.id,next);effect.commit();
  const newer=structuredClone(updated);newer.project.description='后来修改';newer.revision++;workspace.save(other.project.id,newer);
  const before=readFileSync(join(value.dataDir,'workspace.json'));
  assert.throws(()=>effect.rollback(),/回滚快照已变化/);assert.deepEqual(readFileSync(join(value.dataDir,'workspace.json')),before);assert.equal(workspace.state(other.project.id).project.description,'后来修改');
});

test('新项目JSON/index已写但身份未提交时中断，恢复删除唯一新文件且保留原项目和真实账号',async t=>{
  const value=await base(t);
  const script=`import {createIdentity} from ${JSON.stringify(identityModule)};
    import {createWorkspace} from ${JSON.stringify(workspaceModule)};
    const value=JSON.parse(process.env.COBUILD_RECOVERY_FIXTURE),identity=createIdentity(value.dataDir),workspace=createWorkspace(value.dataDir,{operationCommitted:id=>identity.operationCommitted(id)});
    workspace.create({name:'中断的新项目',ownerName:value.name,members:[{name:'尚未真正建立的分工'}]},
      {persist(state,effect){identity.syncProject(state,new Map([['m0',{personId:value.personId,accessRole:'admin'}]]),
        {commit(opId){effect.commit(opId);process.kill(process.pid,'SIGKILL');},rollback(){effect.rollback();},finalize(){effect.finalize();}});}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,COBUILD_RECOVERY_FIXTURE:JSON.stringify({dataDir:value.dataDir,name:value.admin.user.name,personId:value.admin.user.personId})},stdio:'ignore'});
  const [,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL');assert.equal(readdirSync(join(value.dataDir,'projects')).length,2);
  assert.equal(JSON.parse(readFileSync(join(value.dataDir,'.transactions',journals(value.dataDir)[0]),'utf8')).previousProject,null);
  await startRecovered(t,value.dataDir);assert.deepEqual(value.bytes(),value.original);assert.equal(readdirSync(join(value.dataDir,'projects')).length,1);assert.deepEqual(journals(value.dataDir),[]);
  const identity=createIdentity(value.dataDir);try{assert.equal(identity.people().length,2);}finally{identity.close();}
});

test('现有离线备份保留隐藏恢复journal和SQLite提交判据，恢复副本仍能安全恢复未提交操作',async t=>{
  const value=await base(t);await crashInvite(value,'before-sql-commit');
  const root=mkdtempSync(join(tmpdir(),'cobuild-recovery-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const backup=join(root,'snapshot'),restored=join(root,'restored');
  assert.equal(backupData({dataDir:value.dataDir,output:backup,offline:true}).ok,true);
  assert.equal(restoreData({backupDir:backup,output:restored,offline:true}).ok,true);
  assert.equal(journals(restored).length,1);await startRecovered(t,restored);assert.deepEqual(journals(restored),[]);
  assert.equal(readFileSync(join(restored,'workspace.json'),'utf8'),value.original[0]);
  assert.equal(readFileSync(join(restored,'projects',`${value.id}.json`),'utf8'),value.original[1]);
});
