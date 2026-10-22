import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError} from './domain.mjs';
import {validateProjectTemplate} from './productivity.mjs';

export const TEMPLATE_STORE_LIMITS=Object.freeze({active:50,total:100});
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>!keys.includes(key)))throw new AppError('模板库请求包含不支持字段');}
function identifier(value,label){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))throw new AppError(`${label}不正确`);return value;}
function expected(value,record){if(!Number.isSafeInteger(value)||value<1)throw new AppError('请提供模板当前版本');if(value!==record.revision)throw new AppError('模板库已有更新，请重新读取后操作',409);}

/** Private account partition. The HTTP layer must derive accountId from session. */
export function createTemplateStore(dataDir){
 const path=join(dataDir,'templates.sqlite'),db=new DatabaseSync(path);let closed=false;
 try{chmodSync(path,0o600);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,accountId TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,archivedAt TEXT NOT NULL DEFAULT \'\'); CREATE INDEX IF NOT EXISTS templates_account ON templates(accountId,archivedAt,updatedAt,id);');}
 catch(error){db.close();throw error;}
 const account=value=>identifier(value,'账号标识');
 function decode(row){let template;try{template=validateProjectTemplate(JSON.parse(row.body));}catch{throw new Error('保存的项目模板无法读取，已保留原记录，请检查模板数据库');}return {id:row.id,name:template.name,description:template.description,template,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,archivedAt:row.archivedAt};}
 function read(accountId,id){const row=db.prepare('SELECT * FROM templates WHERE accountId=? AND id=?').get(account(accountId),identifier(id,'模板标识'));if(!row)throw new AppError('没有找到这份私有模板',404);return row;}
 function transaction(action){db.exec('BEGIN IMMEDIATE');try{const result=action();db.exec('COMMIT');return result;}catch(error){try{db.exec('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'模板库保存失败且事务恢复未完成');}throw error;}}
 function count(accountId,activeOnly=false){return db.prepare(`SELECT COUNT(*) AS count FROM templates WHERE accountId=?${activeOnly?" AND archivedAt=''":''}`).get(accountId).count;}
 function transition(accountId,input,restore){
  account(accountId);object(input,['id','expectedRevision']);
  return transaction(()=>{const row=read(accountId,input.id);expected(input.expectedRevision,row);
   if(restore?!row.archivedAt:Boolean(row.archivedAt))return decode(row);
   if(restore&&count(accountId,true)>=TEMPLATE_STORE_LIMITS.active)throw new AppError('活跃模板已达 50 份，请先归档部分模板',409);
   const at=new Date(Math.max(Date.now(),Date.parse(row.updatedAt)+1)).toISOString(),archivedAt=restore?'':at;
   db.prepare('UPDATE templates SET archivedAt=?,revision=revision+1,updatedAt=? WHERE accountId=? AND id=?').run(archivedAt,at,accountId,row.id);return decode({...row,archivedAt,revision:row.revision+1,updatedAt:at});
  });
 }
 return {
  list(accountId,options={}){account(accountId);object(options,['archived']);if(options.archived!==undefined&&typeof options.archived!=='boolean')throw new AppError('模板归档筛选不正确');return db.prepare(`SELECT * FROM templates WHERE accountId=? AND archivedAt${options.archived?"<>''":"=''"} ORDER BY updatedAt DESC,id DESC`).all(accountId).map(decode);},
  get(accountId,id){return decode(read(accountId,id));},
  save(accountId,input){account(accountId);object(input,['template']);const template=validateProjectTemplate(input.template);return transaction(()=>{
   if(count(accountId)>=TEMPLATE_STORE_LIMITS.total)throw new AppError('模板总量已达 100 份（含归档），请勿继续重复保存',409);
   if(count(accountId,true)>=TEMPLATE_STORE_LIMITS.active)throw new AppError('活跃模板已达 50 份，请先归档部分模板',409);
   const at=new Date().toISOString(),row={id:`template-${randomUUID()}`,body:JSON.stringify(template),revision:1,createdAt:at,updatedAt:at,archivedAt:''};
   db.prepare('INSERT INTO templates VALUES(?,?,?,?,?,?,?)').run(row.id,accountId,row.body,row.revision,row.createdAt,row.updatedAt,row.archivedAt);return decode(row);
  });},
  archive(accountId,input){return transition(accountId,input,false);},
  restore(accountId,input){return transition(accountId,input,true);},
  close(){if(!closed){closed=true;db.close();}}
 };
}
