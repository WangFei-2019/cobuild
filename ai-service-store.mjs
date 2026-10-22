import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {AppError} from './domain.mjs';
import {aiStatus} from './planning.mjs';

const object=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new AppError('模型设置字段不正确');};
const account=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new AppError('账号标识不正确');return value;};
const conflict=()=>new AppError('模型配置或额度已有变化，请刷新后重试',409);

/** Account-scoped credentials are encrypted at rest; public configuration views never return the key. */
export function createAIServiceStore(dataDir,{env=()=>process.env,now=()=>new Date()}={}){
 const path=join(dataDir,'ai-service.sqlite'),vault=join(dataDir,'.ai-vault-key');
 const db=new DatabaseSync(path);chmodSync(path,0o600);
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS personal_ai(accountId TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS platform_ai_grants(accountId TEXT PRIMARY KEY,enabled INTEGER NOT NULL,callLimit INTEGER NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS platform_ai_usage(accountId TEXT NOT NULL,period TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(accountId,period));');
 let key;
 try{
  if(!existsSync(vault)){
   if(db.prepare('SELECT COUNT(*) count FROM personal_ai').get().count)throw new Error('模型凭据加密文件缺失，请从完整备份恢复');
   writeFileSync(vault,randomBytes(32),{mode:0o600,flag:'wx'});
  }
  key=readFileSync(vault);if(key.length!==32)throw new Error('模型凭据加密文件格式不正确，请检查完整备份');chmodSync(vault,0o600);
 }catch(error){db.close();throw error;}
 const stamp=()=>now().toISOString();
 const period=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(now());
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
 function encrypt(id,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(id));const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
 function personal(id){const row=db.prepare('SELECT * FROM personal_ai WHERE accountId=?').get(account(id));if(!row)return null;if(!row.data)return {...row,value:null};try{const bytes=Buffer.from(row.data,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from(id));decipher.setAuthTag(bytes.subarray(12,28));return {...row,value:JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'))};}catch{throw new AppError('个人模型凭据无法读取，请重新配置或联系管理员恢复完整备份',503);}}
 function config(id){let row;try{row=personal(id);}catch{const raw=db.prepare('SELECT revision,updatedAt FROM personal_ai WHERE accountId=?').get(account(id));return {provider:'deepseek',model:'deepseek-flash',enabled:false,hasKey:true,unreadable:true,revision:raw?.revision||0,updatedAt:raw?.updatedAt||''};}return {provider:'deepseek',model:row?.value?.model||'deepseek-flash',enabled:Boolean(row?.value?.enabled),hasKey:Boolean(row?.value?.apiKey),revision:row?.revision||0,updatedAt:row?.updatedAt||''};}
 function grant(id,isAdmin=false){const row=db.prepare('SELECT * FROM platform_ai_grants WHERE accountId=?').get(account(id));return {enabled:row?Boolean(row.enabled):isAdmin,limit:row?.callLimit??(isAdmin?200:0),revision:row?.revision||0,updatedAt:row?.updatedAt||''};}
 function platformAccess(id,{isAdmin=false}={}){const value=grant(id,isAdmin),used=db.prepare('SELECT used FROM platform_ai_usage WHERE accountId=? AND period=?').get(id,period())?.used||0;return {...value,configured:aiStatus(env()).configured,used,remaining:Math.max(0,value.limit-used),period:period()};}
 function access(id,{isAdmin=false}={}){
  const own=config(id),platform=platformAccess(id,{isAdmin}),used=platform.used;
  const platformConfigured=platform.configured,personalReady=own.enabled&&own.hasKey;
  const ready=!own.unreadable&&(personalReady||platformConfigured&&platform.enabled&&used<platform.limit);
  return {configured:ready,canGenerate:ready,source:own.unreadable||personalReady?'personal':platformConfigured&&platform.enabled?'platform':'none',personal:own,platform:{...platform,configured:platformConfigured,used,remaining:Math.max(0,platform.limit-used),period:period()},remaining:personalReady?null:Math.max(0,platform.limit-used),billing:'manual-entitlement',message:own.unreadable?'个人模型凭据无法读取，请填写新 Key 重新保存或移除个人凭据；不会自动转用平台额度。':personalReady?'使用你自己的 DeepSeek 凭据，费用由对应模型账户承担。':!platform.enabled?'配置自己的 DeepSeek，或联系管理员开通平台调用额度。':!platformConfigured?'平台模型尚未就绪，可先配置自己的 DeepSeek。':used>=platform.limit?'本月平台调用额度已用完，可联系管理员调整或使用自己的 DeepSeek。':'使用管理员开通的平台额度；此处不处理在线支付。'};
 }
 return {
  close(){db.close();key.fill(0);},config,access,platformAccess,
  savePersonal(id,input){account(id);object(input,['expectedRevision','enabled','model','apiKey']);if(typeof input.enabled!=='boolean'||!['deepseek-flash','deepseek-v4-pro'].includes(input.model))throw new AppError('请选择有效的 DeepSeek 模型及启用状态');return transaction(()=>{const row=db.prepare('SELECT revision FROM personal_ai WHERE accountId=?').get(id);if(input.expectedRevision!==(row?.revision||0))throw conflict();const nextKey=input.apiKey===undefined||input.apiKey===''?personal(id)?.value?.apiKey:input.apiKey;if(typeof nextKey!=='string'||nextKey.length<8||nextKey.length>8192||/[\r\n\0]/.test(nextKey)||nextKey!==nextKey.trim())throw new AppError('请填写有效的模型 API Key');const data=encrypt(id,{model:input.model,enabled:input.enabled,apiKey:nextKey});db.prepare('INSERT INTO personal_ai VALUES(?,?,?,?) ON CONFLICT(accountId) DO UPDATE SET data=excluded.data,revision=excluded.revision,updatedAt=excluded.updatedAt').run(id,data,(row?.revision||0)+1,stamp());return config(id);});},
  clearPersonal(id,input){account(id);object(input,['expectedRevision']);return transaction(()=>{const row=db.prepare('SELECT revision FROM personal_ai WHERE accountId=?').get(id);if(input.expectedRevision!==(row?.revision||0))throw conflict();db.prepare('INSERT INTO personal_ai VALUES(?,?,?,?) ON CONFLICT(accountId) DO UPDATE SET data=excluded.data,revision=excluded.revision,updatedAt=excluded.updatedAt').run(id,'',(row?.revision||0)+1,stamp());return config(id);});},
  grant(id,input){account(id);object(input,['enabled','limit','expectedRevision']);if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.limit)||input.limit<0||input.limit>10000)throw new AppError('月调用额度应为 0 至 10000 的整数');return transaction(()=>{const row=db.prepare('SELECT revision FROM platform_ai_grants WHERE accountId=?').get(id);if(input.expectedRevision!==(row?.revision||0))throw conflict();db.prepare('INSERT INTO platform_ai_grants VALUES(?,?,?,?,?) ON CONFLICT(accountId) DO UPDATE SET enabled=excluded.enabled,callLimit=excluded.callLimit,revision=excluded.revision,updatedAt=excluded.updatedAt').run(id,input.enabled?1:0,input.limit,(row?.revision||0)+1,stamp());return grant(id);});},
  reserve(id,options={}){
   return transaction(()=>{const current=access(id,options);if(!current.canGenerate){const error=new AppError(current.message,current.personal.unreadable?503:!current.platform.enabled?403:!current.platform.configured?503:429);error.code='AI_ACCESS_REQUIRED';throw error;}
    if(current.source==='personal'){const own=personal(id).value;return {source:'personal',env:{...env(),COBUILD_AI_BASE_URL:'https://api.deepseek.com',COBUILD_AI_MODEL:own.model,COBUILD_AI_API_KEY:own.apiKey,COBUILD_AI_RESPONSE_FORMAT:'json_object',COBUILD_AI_TOKEN_PARAMETER:'max_tokens',COBUILD_AI_THINKING:'disabled'}};}
    db.prepare('INSERT INTO platform_ai_usage VALUES(?,?,1) ON CONFLICT(accountId,period) DO UPDATE SET used=used+1').run(id,period());return {source:'platform',env:{...env()}};
   });
  }
 };
}
