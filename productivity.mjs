import { AppError, applyAction, canManageProject } from './domain.mjs';
import { applyMilestoneAction, reconcileMilestones } from './planning.mjs';

export const PROJECT_TEMPLATE_FORMAT = 'cobuild-project-template-v1';
export const PRODUCTIVITY_LIMITS = Object.freeze({ templateBytes:131072, roles:32, milestones:20, tasks:80, batch:50, offsetDays:3650 });
const priorities=new Set(['high','medium','low']), closed=task=>['done','canceled'].includes(task.status);
const own=(value,key)=>Object.hasOwn(value,key);
function fail(message,status=400){throw new AppError(message,status);}
function safeTree(value,depth=0){
  if(depth>20)fail('内容层级过深');
  if(value&&typeof value==='object'){
    if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)fail('内容必须是普通 JSON 对象');
    for(const key of Object.keys(value)){if(['__proto__','prototype','constructor'].includes(key))fail('内容包含不安全字段');safeTree(value[key],depth+1);}
  }
}
function object(value,label,allowed,required=allowed){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label}必须是对象`);
  if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!own(value,key)))fail(`${label}字段不完整或包含不支持字段`);
}
function text(value,label,max,required=true){
  if(typeof value!=='string'||value.length>max||!value.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label}格式不正确，最多 ${max} 字`);
  const result=value.trim();if(required&&!result)fail(`请填写${label}`);return result;
}
function id(value,label){const result=text(value,label,100);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)||['__proto__','prototype','constructor'].includes(result))fail(`${label}不正确`);return result;}
function date(value,label,required=true){
  if(!required&&value==='')return '';
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail(`${label}应为 YYYY-MM-DD`);
  const time=Date.parse(`${value}T00:00:00Z`);if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail(`${label}不是有效日期`);return value;
}
function offset(value,label,required=false){if(value===null&&!required)return null;if(!Number.isSafeInteger(value)||value<0||value>PRODUCTIVITY_LIMITS.offsetDays)fail(`${label}应为 0 至 ${PRODUCTIVITY_LIMITS.offsetDays} 的天数`);return value;}
function list(value,label,max,min=0){if(!Array.isArray(value)||value.length<min||value.length>max)fail(`${label}需要 ${min} 至 ${max} 项`);return value;}
function unique(items,label){if(new Set(items.map(item=>item.id)).size!==items.length)fail(`${label}标识重复`);}
function size(value){let serialized;try{serialized=JSON.stringify(value);}catch{fail('内容无法解析为 JSON');}if(new TextEncoder().encode(serialized).length>PRODUCTIVITY_LIMITS.templateBytes)fail('模板不能超过 128KB');}
const day=value=>Date.parse(`${value}T00:00:00Z`)/86400000;
function shift(start,value){if(value===null)return '';const result=new Date((day(start)+value)*86400000).toISOString().slice(0,10);return date(result,'实例化日期');}
function stateShape(state){if(!state?.project||!Array.isArray(state.members)||!Array.isArray(state.tasks)||!Array.isArray(state.activities)||!Number.isSafeInteger(state.revision))fail('项目状态不完整');}
function actor(state,actorId,permissions={}){
  const member=state.members.find(item=>item.id===actorId&&item.active!==false);if(!member||member.accessRole==='viewer')fail('当前账号没有有效的项目协作身份',403);
  const manager=permissions.manageProject===undefined?canManageProject(state,actorId):permissions.manageProject===true;
  return {member,manager};
}
function revision(state,expected){if(!Number.isSafeInteger(expected))fail('请提供本次操作所依据的项目版本');if(expected!==state.revision)fail('项目已有更新，请保留输入并重新预览',409);}

/** A portable allowlist, without member/account IDs or historical state. */
export function validateProjectTemplate(raw){
  safeTree(raw);size(raw);
  object(raw,'项目模板',['format','name','description','project','roles','milestones','tasks']);
  if(raw.format!==PROJECT_TEMPLATE_FORMAT)fail('项目模板版本不支持');
  object(raw.project,'模板项目信息',['name','description','goal','color','deadlineOffset']);
  const project={name:text(raw.project.name,'项目名称',100),description:text(raw.project.description,'项目简介',500,false),goal:text(raw.project.goal,'项目目标',1500,false),color:text(raw.project.color,'项目颜色',9),deadlineOffset:offset(raw.project.deadlineOffset,'项目相对截止')};
  if(!/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(project.color))fail('项目颜色不正确');
  const roles=list(raw.roles,'角色',PRODUCTIVITY_LIMITS.roles,1).map(item=>{object(item,'模板角色',['id','label']);return {id:id(item.id,'角色标识'),label:text(item.label,'角色名称',80)};});unique(roles,'角色');
  const roleIds=new Set(roles.map(item=>item.id));
  const milestones=list(raw.milestones,'模板阶段',PRODUCTIVITY_LIMITS.milestones).map(item=>{object(item,'模板阶段',['id','title','goal','dueOffset','acceptanceCriteria']);return {id:id(item.id,'阶段标识'),title:text(item.title,'阶段名称',180),goal:text(item.goal,'阶段目标',1500),dueOffset:offset(item.dueOffset,'阶段相对截止',true),acceptanceCriteria:text(item.acceptanceCriteria,'验收标准',2000)};});unique(milestones,'阶段');
  const milestoneMap=new Map(milestones.map(item=>[item.id,item]));
  const tasks=list(raw.tasks,'模板任务',PRODUCTIVITY_LIMITS.tasks,1).map(item=>{
    object(item,'模板任务',['id','title','description','ownerRoleId','reviewerRoleId','dueOffset','priority','deliverable','dependsOn','milestoneId']);
    const ownerRoleId=id(item.ownerRoleId,'负责人角色'),reviewerRoleId=id(item.reviewerRoleId,'接收人角色');if(!roleIds.has(ownerRoleId)||!roleIds.has(reviewerRoleId))fail('任务引用了不存在的角色');
    const milestoneId=item.milestoneId===''?'':id(item.milestoneId,'所属阶段');if(milestoneId&&!milestoneMap.has(milestoneId))fail('任务引用了不存在的阶段');
    if(!priorities.has(item.priority))fail('任务优先级不正确');
    const dependsOn=list(item.dependsOn,'任务依赖',PRODUCTIVITY_LIMITS.tasks).map(value=>id(value,'依赖标识'));if(new Set(dependsOn).size!==dependsOn.length)fail('任务依赖重复');
    return {id:id(item.id,'任务标识'),title:text(item.title,'任务名称',180),description:text(item.description,'任务说明',3000,false),ownerRoleId,reviewerRoleId,dueOffset:offset(item.dueOffset,'任务相对截止'),priority:item.priority,deliverable:text(item.deliverable,'交付约定',1000),dependsOn,milestoneId};
  });unique(tasks,'任务');
  const taskMap=new Map(tasks.map(item=>[item.id,item])),visiting=new Set(),visited=new Set();
  function visit(item){if(visiting.has(item.id))fail('模板任务形成循环依赖');if(visited.has(item.id))return;visiting.add(item.id);for(const previousId of item.dependsOn){const previous=taskMap.get(previousId);if(!previous)fail('模板依赖必须引用模板内任务');if(previous.dueOffset===null||item.dueOffset===null)fail('有依赖的任务必须明确相对截止日期');if(previous.dueOffset>item.dueOffset)fail('前置任务截止不能晚于后续任务');visit(previous);}visiting.delete(item.id);visited.add(item.id);}
  for(const task of tasks){visit(task);if(task.milestoneId&&(task.dueOffset===null||task.dueOffset>milestoneMap.get(task.milestoneId).dueOffset))fail('阶段内任务需要明确截止且不能晚于阶段');}
  if(project.deadlineOffset!==null&&[...milestones,...tasks].some(item=>item.dueOffset!==null&&item.dueOffset>project.deadlineOffset))fail('阶段或任务不能晚于项目相对截止');
  return {format:PROJECT_TEMPLATE_FORMAT,name:text(raw.name,'模板名称',100),description:text(raw.description,'模板简介',500,false),project,roles,milestones,tasks};
}
export function parseProjectTemplate(value){if(typeof value!=='string'||new TextEncoder().encode(value).length>PRODUCTIVITY_LIMITS.templateBytes)fail('模板 JSON 不能超过 128KB');let parsed;try{parsed=JSON.parse(value);}catch{fail('请粘贴完整的模板 JSON，不包含额外说明');}return validateProjectTemplate(parsed);}

export function extractProjectTemplate(state,{name,anchorDate}={}){
  stateShape(state);
  const selected=state.tasks.filter(task=>task.status!=='canceled');if(!selected.length)fail('项目没有可提取的有效任务');
  if(selected.length>PRODUCTIVITY_LIMITS.tasks)fail('首版模板最多包含 80 项任务，请先缩小项目范围');
  const selectedIds=new Set(selected.map(task=>task.id));
  if(selected.some(task=>task.dependsOn.some(value=>!selectedIds.has(value))))fail('有效任务仍依赖已取消或缺失任务，请先明确调整依赖再保存模板');
  const stages=(state.milestones||[]).filter(stage=>selected.some(task=>task.milestoneId===stage.id));
  if(selected.some(task=>task.milestoneId&&!stages.some(stage=>stage.id===task.milestoneId)))fail('原任务引用了缺失阶段，请先核对阶段关联');
  const dates=[...selected.map(task=>task.due),...stages.map(stage=>stage.due),state.project.deadline].filter(Boolean).sort();
  const anchor=date(anchorDate||dates[0]||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),'日程起点');
  const relative=value=>value?day(date(value,'原项目日期'))-day(anchor):null;
  const used=[...new Set(selected.flatMap(task=>[task.ownerId,task.reviewerId]))],roleMap=new Map(used.map((value,index)=>[value,`role-${index+1}`]));
  const roleBases=used.map((memberId,index)=>{const member=state.members.find(item=>item.id===memberId);if(!member)fail('原任务引用了缺失成员');return text(member.role||`协作角色 ${index+1}`,'角色名称',80);});
  const roleKey=value=>value.normalize('NFKC').toLowerCase(),reserved=new Set(roleBases.map(roleKey)),assigned=new Set();
  const roles=used.map((memberId,index)=>{const base=roleBases[index];let label=base;if(roleBases.filter(value=>roleKey(value)===roleKey(base)).length>1){let number=1;do{const suffix=`（${number++}）`;label=base.slice(0,80-suffix.length).replace(/[\uD800-\uDBFF]$/,'')+suffix;}while(reserved.has(roleKey(label))||assigned.has(roleKey(label)));}assigned.add(roleKey(label));return {id:roleMap.get(memberId),label};});
  const stageMap=new Map(stages.map((stage,index)=>[stage.id,`phase-${index+1}`])),taskMap=new Map(selected.map((task,index)=>[task.id,`task-${index+1}`]));
  return validateProjectTemplate({format:PROJECT_TEMPLATE_FORMAT,name:name||`${state.project.name}模板`.slice(0,100),description:'',project:{name:state.project.name,description:state.project.description||'',goal:state.project.goal||'',color:state.project.color||'#427b68',deadlineOffset:relative(state.project.deadline)},
    roles,
    milestones:stages.map(stage=>({id:stageMap.get(stage.id),title:stage.title,goal:stage.goal,dueOffset:relative(stage.due),acceptanceCriteria:stage.acceptanceCriteria})),
    tasks:selected.map(task=>({id:taskMap.get(task.id),title:task.title,description:task.description||'',ownerRoleId:roleMap.get(task.ownerId),reviewerRoleId:roleMap.get(task.reviewerId),dueOffset:relative(task.due),priority:task.priority||'medium',deliverable:task.deliverable,dependsOn:task.dependsOn.map(value=>taskMap.get(value)),milestoneId:task.milestoneId?stageMap.get(task.milestoneId)||'':''}))});
}

/** Instantiates into an already authorized EMPTY target. Never creates members. */
export function instantiateProjectTemplate(state,input,permissions={}){
  stateShape(state);safeTree(input);object(input,'模板应用',['actorId','expectedRevision','projectId','template','startDate','roleMap'],['actorId','expectedRevision','template','startDate','roleMap']);
  if(input.projectId!==undefined&&input.projectId!==state.project.id)fail('模板目标项目不一致');revision(state,input.expectedRevision);
  const current=actor(state,input.actorId,permissions);if(!current.manager)fail('请由项目管理员应用模板',403);
  if(state.tasks.length||(state.milestones||[]).length||(state.discussions||[]).length)fail('模板只能应用到没有任务和阶段的空项目');
  const template=validateProjectTemplate(input.template),start=date(input.startDate,'日程起点');
  object(input.roleMap,'角色映射',template.roles.map(role=>role.id));
  const assignments=Object.fromEntries(template.roles.map(role=>{const member=state.members.find(item=>item.id===input.roleMap[role.id]&&item.active!==false&&item.accessRole!=='viewer');if(!member)fail(`请为「${role.label}」选择当前项目有效协作者`,403);return [role.id,member.id];}));
  let next=structuredClone(state);
  // A trusted server permission can grant the current active workspace admin
  // project management without ever changing a stored member's access role.
  const originalActor=next.members.find(item=>item.id===input.actorId),hadRole=own(originalActor,'accessRole'),originalRole=originalActor.accessRole;
  originalActor.accessRole='admin';
  const stages=new Map(),tasks=new Map();
  for(const stage of template.milestones){next=applyMilestoneAction(next,{type:'createMilestone',actorId:input.actorId,expectedRevision:next.revision,title:stage.title,goal:stage.goal,due:shift(start,stage.dueOffset),acceptanceCriteria:stage.acceptanceCriteria});stages.set(stage.id,next.milestones.at(-1).id);}
  const pending=new Set(template.tasks.map(task=>task.id));
  while(pending.size)for(const task of template.tasks)if(pending.has(task.id)&&task.dependsOn.every(value=>tasks.has(value))){
    next=applyAction(next,{type:'createTask',actorId:input.actorId,title:task.title,description:task.description,ownerId:assignments[task.ownerRoleId],reviewerId:assignments[task.reviewerRoleId],due:shift(start,task.dueOffset),priority:task.priority,deliverable:task.deliverable,dependsOn:task.dependsOn.map(value=>tasks.get(value)),milestoneId:stages.get(task.milestoneId)||''},{manageProject:true});tasks.set(task.id,next.tasks.at(-1).id);pending.delete(task.id);
  }
  const storedActor=next.members.find(item=>item.id===input.actorId);if(hadRole)storedActor.accessRole=originalRole;else delete storedActor.accessRole;
  next.revision=state.revision+1;
  return reconcileMilestones(next);
}
export function previewProjectTemplate(state,input,permissions={}){
  const next=instantiateProjectTemplate(state,input,permissions),template=validateProjectTemplate(input.template);
  return {baseRevision:state.revision,startDate:input.startDate,roleAssignments:template.roles.map(role=>({roleId:role.id,label:role.label,memberId:input.roleMap[role.id],memberName:state.members.find(member=>member.id===input.roleMap[role.id]).name})),milestones:next.milestones||[],tasks:next.tasks,state:next};
}

function batchPlan(state,input,permissions={}){
  stateShape(state);safeTree(input);object(input,'批量任务编辑',['projectId','actorId','expectedRevision','edits'],['actorId','expectedRevision','edits']);
  if(input.projectId!==undefined&&input.projectId!==state.project.id)fail('批量编辑目标项目不一致');revision(state,input.expectedRevision);const current=actor(state,input.actorId,permissions);
  const ids=new Set(),edits=list(input.edits,'批量编辑',PRODUCTIVITY_LIMITS.batch,1).map(edit=>{
    object(edit,'批量编辑项',['taskId','taskUpdatedAt','patch']);const taskId=id(edit.taskId,'任务标识'),task=state.tasks.find(task=>task.id===taskId);if(!task)fail('批量编辑含不存在的任务',404);if(ids.has(taskId))fail('同一任务只能编辑一次');ids.add(taskId);
    if(closed(task))fail('已完成或已取消任务请逐项明确处理，不能批量修改',409);
    if(typeof edit.taskUpdatedAt!=='string'||edit.taskUpdatedAt!==task.updatedAt)fail('任务已有更新，请保留输入并重新预览',409);
    if(!current.manager&&task.ownerId!==input.actorId)fail(`无权修改「${task.title}」，请由负责人或项目管理员处理`,403);
    object(edit.patch,'批量修改字段',['ownerId','due','priority'],[]);if(!Object.keys(edit.patch).length)fail('请至少修改一个批量字段');
    const patch={};if(own(edit.patch,'ownerId')){const member=state.members.find(member=>member.id===edit.patch.ownerId&&member.active!==false&&member.accessRole!=='viewer');if(!member)fail('新负责人必须是当前项目有效协作者',403);patch.ownerId=member.id;}
    if(own(edit.patch,'due'))patch.due=date(edit.patch.due,'任务截止日期',false);if(own(edit.patch,'priority')){if(!priorities.has(edit.patch.priority))fail('任务优先级不正确');patch.priority=edit.patch.priority;}
    return {task,patch};
  });
  const final=structuredClone(state);for(const {task,patch}of edits)Object.assign(final.tasks.find(item=>item.id===task.id),patch);
  const results=[];
  // Validate each original -> final edit against the complete final schedule,
  // so coordinated dependency-date moves are not sensitive to row order.
  for(const {task,patch}of edits){
    const probe=structuredClone(final),index=probe.tasks.findIndex(item=>item.id===task.id);probe.tasks[index]=structuredClone(task);
    const applied=applyAction(probe,{type:'updateTask',actorId:input.actorId,expectedRevision:state.revision,taskId:task.id,taskUpdatedAt:task.updatedAt,patch},{manageProject:current.manager}),updated=applied.tasks[index];
    const ownerChanged=own(patch,'ownerId')&&patch.ownerId!==task.ownerId,needsResubmission=ownerChanged&&Boolean(task.artifacts?.length);
    if(needsResubmission){updated.needsResubmission=true;updated.acceptedAt='';if(updated.status==='review')updated.status='doing';}
    const changes=Object.fromEntries(Object.keys(patch).filter(field=>task[field]!==updated[field]).map(field=>[field,{before:task[field],after:updated[field]}]));
    if(!Object.keys(changes).length)continue;
    results.push({taskId:task.id,code:task.code,title:task.title,changes,needsResubmission,beforeStatus:task.status,afterStatus:updated.status,task:updated,activity:applied.activities[0]});
  }
  if(!results.length)fail('批量编辑没有实际变化');
  const next=structuredClone(state);for(const result of results){next.tasks[next.tasks.findIndex(task=>task.id===result.taskId)]=result.task;next.activities.unshift({...result.activity,text:`批量编辑：${result.activity.text}${result.needsResubmission?'负责人已变化，历史成果保留，新负责人需重新提交。':''}`});}next.revision=state.revision+1;
  return {state:reconcileMilestones(next),baseRevision:state.revision,changes:results.map(({task,activity,...result})=>result)};
}
export function previewTaskBatch(state,input,permissions={}){const {state:next,...preview}=batchPlan(state,input,permissions);return preview;}
export function applyTaskBatch(state,input,permissions={}){return batchPlan(state,input,permissions).state;}
