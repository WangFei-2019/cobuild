export const VIEW_DEFAULTS={dashboard:{mode:'owned',projectId:'',timeFilter:'any',view:'grouped',sort:'due'},tasks:{ownerId:'',scope:'active',mode:'table',status:'all',sort:'due'}};
const oneOf=(value,choices,fallback)=>choices.includes(value)?value:fallback;
export function normalizePersonalView(kind,input={},context={}){
 if(!VIEW_DEFAULTS[kind])throw new Error('不支持的个人视图');
 const sort=oneOf(input.sort,['due','priority','title','updated'],'due');
 if(kind==='dashboard')return {mode:oneOf(input.mode,['owned','review','blocked','related'],'owned'),projectId:typeof input.projectId==='string'&&(!context.projectIds||context.projectIds.includes(input.projectId))?input.projectId:'',timeFilter:oneOf(input.timeFilter,['any','overdue','week','undated'],'any'),view:oneOf(input.view,['grouped','table'],'grouped'),sort};
 const scope=oneOf(input.scope,['active','canceled','all'],'active'),status=oneOf(input.status,['all','todo','doing','blocked','review','done','canceled'],'all');
 return {ownerId:typeof input.ownerId==='string'&&(!context.memberIds||context.memberIds.includes(input.ownerId))?input.ownerId:'',scope,mode:oneOf(input.mode,['table','board'],'table'),status:scope==='canceled'?'all':scope==='active'&&status==='canceled'?'all':status,sort};
}
export function personalViewKey({accountId,namespace='formal',kind,projectId=''}){if(!accountId||!VIEW_DEFAULTS[kind]||kind==='tasks'&&!projectId)throw new Error('个人视图缺少账号或项目');return 'cobuild:views:v1:'+JSON.stringify([namespace,accountId,kind,kind==='tasks'?projectId:'']);}
export function createViewPreferences(storage){return {
 read(scope,context){const raw=storage.getItem(personalViewKey(scope));if(!raw)return normalizePersonalView(scope.kind,{},context);try{const value=JSON.parse(raw);return normalizePersonalView(scope.kind,value.format===1?value.values:{},context);}catch{return normalizePersonalView(scope.kind,{},context);}},
 save(scope,values,context){const next=normalizePersonalView(scope.kind,values,context);storage.setItem(personalViewKey(scope),JSON.stringify({format:1,values:next}));return next;},
 reset(scope){storage.removeItem(personalViewKey(scope));return normalizePersonalView(scope.kind);}
};}
export function sortViewTasks(tasks,sort='due'){
 const priority={high:0,medium:1,low:2};return [...tasks].sort((a,b)=>(sort==='priority'?(priority[a.priority]??1)-(priority[b.priority]??1):sort==='title'?String(a.title).localeCompare(String(b.title),'zh-CN'):sort==='updated'?String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')):String(a.due||'9999').localeCompare(String(b.due||'9999')))||String(a.code||'').localeCompare(String(b.code||''))||String(a.id).localeCompare(String(b.id)));
}
