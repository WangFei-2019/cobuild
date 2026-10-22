import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createTemplateStore} from '../template-store.mjs';
import {extractProjectTemplate} from '../productivity.mjs';
import {seedState} from '../domain.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'cobuild-templates-'));let store=createTemplateStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,get store(){return store;},restart(){store.close();store=createTemplateStore(dir);}};}
const template=()=>extractProjectTemplate(seedState(),{name:'项目交付模板'});

test('模板库按账号私有隔离、仅存白名单且跨重启持久，数据库600，不泄漏存储账号',t=>{
 const f=fixture(t),source=template(),before=structuredClone(source),saved=f.store.save('account-a',{template:source});
 assert.equal(saved.revision,1);assert.equal(saved.archivedAt,'');assert.equal(Object.hasOwn(saved,'accountId'),false);assert.equal(f.store.list('account-b').length,0);assert.deepEqual(f.store.get('account-a',saved.id),saved);assert.throws(()=>f.store.get('account-b',saved.id),error=>error.status===404);
 source.name='不应变更已保存模板';assert.deepEqual(f.store.get('account-a',saved.id).template,before);f.restart();assert.deepEqual(f.store.list('account-a'),[saved]);assert.deepEqual(f.store.get('account-a',saved.id),saved);assert.equal(statSync(join(f.dir,'templates.sqlite')).mode&0o777,0o600);
 const db=new DatabaseSync(join(f.dir,'templates.sqlite'));assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();
});

test('模板软归档/恢复按版本，重复幂等与跨账号404，无永久删除并完整保留结构',t=>{
 const f=fixture(t),saved=f.store.save('a',{template:template()}),before=f.store.list('a');
 for(const method of ['archive','restore'])assert.throws(()=>f.store[method]('b',{id:saved.id,expectedRevision:saved.revision}),error=>error.status===404);
 assert.throws(()=>f.store.archive('a',{id:saved.id,expectedRevision:0}),error=>error.status===400);assert.deepEqual(f.store.list('a'),before);
 const archived=f.store.archive('a',{id:saved.id,expectedRevision:1});assert.equal(archived.revision,2);assert.ok(archived.archivedAt);assert.equal(f.store.list('a').length,0);assert.deepEqual(f.store.list('a',{archived:true}),[archived]);assert.deepEqual(f.store.archive('a',{id:saved.id,expectedRevision:2}),archived);
 assert.throws(()=>f.store.restore('a',{id:saved.id,expectedRevision:1}),error=>error.status===409);f.restart();const restored=f.store.restore('a',{id:saved.id,expectedRevision:2});assert.equal(restored.revision,3);assert.equal(restored.createdAt,saved.createdAt);assert.deepEqual(restored.template,saved.template);assert.equal(restored.archivedAt,'');assert.deepEqual(f.store.restore('a',{id:saved.id,expectedRevision:3}),restored);
});

test('模板库50活跃/100总量配额在事务内执行，归档不删除历史，恢复不能突破活跃配额',t=>{
 const f=fixture(t),draft=template(),records=[];for(let i=0;i<50;i++)records.push(f.store.save('a',{template:draft}));
 assert.throws(()=>f.store.save('a',{template:draft}),error=>error.status===409);assert.equal(f.store.list('a').length,50);
 for(const record of records)f.store.archive('a',{id:record.id,expectedRevision:record.revision});for(let i=0;i<50;i++)f.store.save('a',{template:draft});
 assert.throws(()=>f.store.restore('a',{id:records[0].id,expectedRevision:2}),error=>error.status===409);assert.equal(f.store.get('a',records[0].id).revision,2);
 const active=f.store.list('a')[0];f.store.archive('a',{id:active.id,expectedRevision:active.revision});assert.throws(()=>f.store.save('a',{template:draft}),error=>error.status===409);assert.equal(f.store.list('a').length+f.store.list('a',{archived:true}).length,100);assert.equal(f.store.save('b',{template:draft}).revision,1);
});

test('验证失败和SQL中途失败不写部分模板/版本；只接受模板封套，不接受客户端跨账号参数',t=>{
 const f=fixture(t),saved=f.store.save('a',{template:template()}),before=f.store.list('a'),bad=template();bad.tasks[0].status='done';
 assert.throws(()=>f.store.save('a',{template:bad}));assert.throws(()=>f.store.save('a',{template:template(),accountId:'b'}));assert.throws(()=>f.store.archive('a',{id:saved.id,expectedRevision:1,accountId:'b'}));assert.deepEqual(f.store.list('a'),before);
 const db=new DatabaseSync(join(f.dir,'templates.sqlite'));db.exec("CREATE TRIGGER fail_template_update BEFORE UPDATE ON templates BEGIN SELECT RAISE(ABORT,'fixture template update failure'); END;");assert.throws(()=>f.store.archive('a',{id:saved.id,expectedRevision:1}),/fixture/);assert.deepEqual(f.store.list('a'),before);
 db.exec('DROP TRIGGER fail_template_update; CREATE TRIGGER fail_template_insert AFTER INSERT ON templates BEGIN SELECT RAISE(ABORT,\'fixture template insert failure\'); END;');assert.throws(()=>f.store.save('a',{template:template()}),/fixture/);assert.deepEqual(f.store.list('a'),before);db.close();f.restart();assert.deepEqual(f.store.list('a'),before);
});
