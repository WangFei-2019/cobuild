export const DRAFT_TTL_MS=7*24*60*60*1000;
export const DRAFT_PREFIX='cobuild:drafts:v1:';
export const DRAFT_GENERATION_PREFIX='cobuild:draft-generation:v1:';
const FORMS=new Set(['task-edit','task-new','progress','artifact','discussion','plan-initial','plan-replan','brief','ai-request','assistance']);
const FIELDS={
 'task-edit':['title','description','ownerId','reviewerId','due','priority','deliverable','dependsOn','milestoneId'],
 'task-new':['title','description','ownerId','reviewerId','due','priority','deliverable','dependsOn','milestoneId'],
 progress:['text'],artifact:['name','url','note','fileNames'],discussion:['body','kind','mentionIds','replyTo'],
 'plan-initial':['values','generation','prompt','source'],'plan-replan':['values','generation','prompt','source'],brief:['text'],'ai-request':['text','mode'],assistance:['mode','request','values','result','brief','edited','selected','baseRevision']
};
const FORBIDDEN=/^(?:password|currentPassword|newPassword|confirmPassword|token|inviteToken|setupToken|apiKey|api_key|secret|authorization|accessToken|refreshToken|privateKey|modelKey|base64|originFileObj|file|files|preview|changes|rawImportText)$/i;
function clean(value,depth=0){if(depth>15)throw new Error('草稿内容过于复杂，未写入浏览器。');if(value===null||typeof value==='boolean'||typeof value==='number')return value;if(typeof value==='string')return value;if(Array.isArray(value))return value.map(item=>clean(item,depth+1));if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return Object.fromEntries(Object.entries(value).filter(([key])=>!FORBIDDEN.test(key)&&!['__proto__','constructor','prototype'].includes(key)).map(([key,item])=>[key,clean(item,depth+1)]));return undefined;}
export function sanitizeDraftData(form,data){if(!FORMS.has(form))throw new Error('这类表单不支持本机草稿。');if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('草稿格式不正确。');return clean(Object.fromEntries(FIELDS[form].filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]])));}
export function draftKey({accountId,projectId,taskId='',form,namespace='formal'}){if(!accountId||!projectId||!FORMS.has(form))throw new Error('草稿缺少账号、项目或表单标识。');return DRAFT_PREFIX+[namespace,accountId,projectId,taskId,form].map(value=>encodeURIComponent(value)).join(':');}
export function createDraftStore({storage,now=()=>Date.now(),ttl=DRAFT_TTL_MS}={}){
 const generationKey=(scope,project=false)=>DRAFT_GENERATION_PREFIX+JSON.stringify([scope.namespace||'formal',scope.accountId,...(project?[scope.projectId]:[])]);
 const accountEpoch=scope=>storage.getItem(generationKey(scope))||'0',projectEpoch=scope=>storage.getItem(generationKey(scope,true))||'0';
 const recordKey=(scope,account,project)=>draftKey(scope)+':generation:'+encodeURIComponent(account)+':'+encodeURIComponent(project);
 function isCurrent(scope,session){return Boolean(session&&session.accountId===scope.accountId&&session.namespace===(scope.namespace||'formal')&&session.epoch===accountEpoch(scope)&&(scope.accountEpoch===undefined||scope.accountEpoch===session.epoch)&&(scope.projectEpoch===undefined||scope.projectEpoch===projectEpoch(scope)));}
 function keys(){return Array.from({length:storage.length},(_,index)=>storage.key(index)).filter(Boolean);}
 function invalidate(scope){const prefix=DRAFT_PREFIX+[scope.namespace||'formal',scope.accountId].map(value=>encodeURIComponent(value)).join(':')+':';for(const key of keys())if(key.startsWith(prefix)&&(!scope.projectId||key.startsWith(prefix+encodeURIComponent(scope.projectId)+':')))storage.removeItem(key);}
 function rotate(scope,project=false){const key=generationKey(scope,project),value=globalThis.crypto?.randomUUID?.()||`${now()}-${Math.random().toString(36).slice(2)}`;try{storage.setItem(key,value);}catch{invalidate(scope);storage.setItem(key,value);}invalidate(scope);}
 return {
  session(accountId,namespace='formal'){return {accountId,namespace,epoch:accountEpoch({accountId,namespace})};},
  isCurrent,
  clearAccount(accountId,namespace='formal'){rotate({accountId,namespace});},
  projectEpoch,
  clearProject(scope){rotate(scope,true);},
  remove(scope){storage.removeItem(recordKey(scope,scope.accountEpoch??accountEpoch(scope),scope.projectEpoch??projectEpoch(scope)));storage.removeItem(draftKey(scope));},
  read(scope){const account=accountEpoch(scope),project=projectEpoch(scope);if(scope.accountEpoch!==undefined&&scope.accountEpoch!==account||scope.projectEpoch!==undefined&&scope.projectEpoch!==project)return null;let key=recordKey(scope,account,project),raw=storage.getItem(key);if(!raw&&account==='0'&&project==='0'){key=draftKey(scope);raw=storage.getItem(key);}if(!raw)return null;let record;try{record=JSON.parse(raw);}catch{storage.removeItem(key);return null;}if(record.format!==1||record.accountId!==scope.accountId||record.projectId!==scope.projectId||record.taskId!==(scope.taskId||'')||record.form!==scope.form||!Number.isFinite(record.expiresAt)||record.expiresAt<=now()||record.accountGeneration!==undefined&&record.accountGeneration!==account||record.projectGeneration!==undefined&&record.projectGeneration!==project){storage.removeItem(key);return null;}return {...record,data:sanitizeDraftData(scope.form,record.data)};},
  write(scope,data,baseVersion,session){if(!isCurrent(scope,session))return false;const account=session.epoch,project=scope.projectEpoch??projectEpoch(scope),key=recordKey(scope,account,project),record={format:1,accountId:scope.accountId,projectId:scope.projectId,taskId:scope.taskId||'',form:scope.form,accountGeneration:account,projectGeneration:project,baseVersion:baseVersion??null,updatedAt:now(),expiresAt:now()+ttl,data:sanitizeDraftData(scope.form,data)};const raw=JSON.stringify(record);if(raw.length>512*1024)throw new Error('草稿超过本机容量限制，请复制内容另存。');storage.setItem(key,raw);if(!isCurrent({...scope,projectEpoch:project},session)){storage.removeItem(key);return false;}return record;}
 };
}
let browserStore;
export function getDraftStore(){if(!browserStore)browserStore=createDraftStore({storage:window.localStorage});return browserStore;}
export function clearAccountDrafts(accountId,namespace=typeof __COBUILD_DEMO__!=='undefined'&&__COBUILD_DEMO__?'demo':'formal'){try{if(accountId)getDraftStore().clearAccount(accountId,namespace);return true;}catch{return false;}}
export function clearProjectDrafts(accountId,projectId,namespace=typeof __COBUILD_DEMO__!=='undefined'&&__COBUILD_DEMO__?'demo':'formal'){try{if(accountId&&projectId)getDraftStore().clearProject({accountId,projectId,namespace});return true;}catch{return false;}}
