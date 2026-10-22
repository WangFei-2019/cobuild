import { randomUUID } from 'node:crypto';
import { AppError } from './domain.mjs';

const active = member => member?.active !== false;
const roles = new Set(['admin','member','viewer']);
const closed = task => ['done','canceled'].includes(task.status);
const issue = (message,status=400,code) => {const error=new AppError(message,status);if(code)error.code=code;throw error;};
const link = (state,identity,member) => identity.member(state.project.id,member.id);
function currentMember(state,identity,user) {
  const record=identity.membership(state.project.id,user.personId);
  return state.members.find(member=>member.id===record?.memberId&&active(member))||null;
}
function memberInfo(state,identity,member) {
  const record=link(state,identity,member),profile=active(member)&&record?.personId?identity.person(record.personId):member;
  return {id:member.id,name:profile.name,color:profile.color,active:active(member),accountLinked:Boolean(record?.accountLinked),accessRole:record?.accessRole||'member'};
}
function linkedAdmins(state,identity,changes=[]) {
  return state.members.filter(member=>{
    const change=changes.find(item=>item.memberId===member.id),record=link(state,identity,member);
    return active(member)&&!change?.remove&&record?.active!==false&&record?.accountLinked&&(change?.accessRole||record?.accessRole)==='admin';
  });
}
export function memberImpact(state,identity,user,memberId) {
  const target=state.members.find(member=>member.id===memberId);if(!target)issue('没有找到这个项目成员',404);
  const actor=currentMember(state,identity,user),actorRole=actor?link(state,identity,actor)?.accessRole:null;
  const manager=user.workspaceRole==='admin'||actorRole==='admin',sample=Boolean(state.sample?.kind==='cobuild-sample'||state.sample?.version===1);
  if(!manager&&actor?.id!==target.id)issue('只能查看本人退出影响，或由项目管理者管理成员',403);
  const tasks=state.tasks.filter(task=>!closed(task)&&(task.ownerId===target.id||task.reviewerId===target.id)).map(task=>({id:task.id,code:task.code,title:task.title,status:task.status,owner:task.ownerId===target.id,reviewer:task.reviewerId===target.id}));
  const admins=linkedAdmins(state,identity),info=memberInfo(state,identity,target);
  return {projectId:state.project.id,revision:state.revision,currentMemberId:actor?.id||null,member:info,adminCount:admins.length,lastAdmin:admins.length===1&&admins[0].id===target.id,
    responsibilities:{tasks,ownerCount:tasks.filter(task=>task.owner).length,reviewerCount:tasks.filter(task=>task.reviewer).length},
    replacements:state.members.filter(member=>active(member)&&member.id!==target.id).flatMap(member=>{
      const record=link(state,identity,member);if(!record||record.active===false||!['admin','member'].includes(record.accessRole))return[];
      return[{...memberInfo(state,identity,member),eligibleForAdmin:Boolean(record.accountLinked)}];
    }),permissions:{setAccessRole:!sample&&manager&&info.active,transferAdmin:!sample&&manager&&info.active&&info.accessRole==='admin',removeMember:!sample&&manager&&info.active&&actor?.id!==target.id,leaveProject:!sample&&info.active&&actor?.id===target.id}};
}

// Computes a full plan from trusted current identity mappings. SQL changes and
// the resulting JSON must be committed together by the caller's journaled txn.
export function planMemberAction(state,identity,user,input) {
  const allowed=['projectId','expectedRevision','type','memberId','accessRole','replacementMemberId'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))issue('成员操作包含不支持的字段');
  if(!Number.isSafeInteger(input.expectedRevision))issue('请提供成员操作所依据的项目版本');
  if(input.expectedRevision!==state.revision)issue('项目已有更新，请重新查看成员影响后操作',409,'PROJECT_REVISION_CONFLICT');
  if(!['setAccessRole','transferAdmin','removeMember','leaveProject'].includes(input.type))issue('不支持的成员操作');
  if(state.sample?.kind==='cobuild-sample'||state.sample?.version===1)issue('示例使用固定虚拟成员，真实协作请创建自己的项目',403);
  const actor=currentMember(state,identity,user);
  const targetId=input.type==='leaveProject'?(input.memberId||actor?.id):input.memberId;
  if(input.type==='leaveProject'&&(!actor||targetId!==actor.id))issue('退出项目只能操作当前登录账号本人',403);
  const impact=memberImpact(state,identity,user,targetId),target=state.members.find(member=>member.id===targetId),record=link(state,identity,target);
  if(!impact.member.active||!record||record.active===false)issue('该成员已离开项目',409);
  if(input.type==='removeMember'&&actor?.id===targetId)issue('退出本人请使用退出项目操作');
  if(input.type!=='leaveProject'&&!impact.permissions[input.type])issue('请由项目管理者进行成员操作',403);
  const changes=[],departures=[],at=new Date().toISOString(),next=structuredClone(state);
  let replacement=null,needsHandoff=['removeMember','leaveProject'].includes(input.type),label='';
  if(input.type==='setAccessRole') {
    if(!roles.has(input.accessRole))issue('项目访问角色不正确');
    if(input.accessRole===record.accessRole)issue('访问权限没有变化');
    if(input.accessRole==='admin'&&!record.accountLinked)issue('项目管理员必须是已绑定账号的有效成员');
    needsHandoff=input.accessRole==='viewer';changes.push({memberId:targetId,accessRole:input.accessRole});label=`将${impact.member.name}的项目访问权限调整为${{admin:'管理员',member:'协作者',viewer:'只读'}[input.accessRole]}`;
  } else if(input.type==='transferAdmin') {
    if(record.accessRole!=='admin')issue('请选择当前项目管理员进行交接');
    replacement=impact.replacements.find(member=>member.id===input.replacementMemberId&&member.eligibleForAdmin);
    if(!replacement)issue('请把管理权交给另一位已绑定账号的有效协作者');
    changes.push({memberId:targetId,accessRole:'member'},{memberId:replacement.id,accessRole:'admin'});label=`将${impact.member.name}的项目管理权交给${replacement.name}，原管理员保留协作者权限`;
  } else {
    changes.push({memberId:targetId,remove:true});departures.push({memberId:targetId,personId:record.personId,accessRole:record.accessRole,leftAt:at});
    label=input.type==='leaveProject'?`${impact.member.name}退出了项目`:`将${impact.member.name}移出项目`;
    const frozen=next.members.find(member=>member.id===targetId),profile=identity.person(record.personId);
    Object.assign(frozen,{name:profile.name,color:profile.color,initial:profile.initial,active:false,leftAt:at});
  }
  if(linkedAdmins(state,identity).length&&linkedAdmins(state,identity,changes).length===0)issue('项目需要至少一位已绑定账号的有效管理员，请先交接管理权',409,'LAST_PROJECT_ADMIN');
  if(needsHandoff&&impact.responsibilities.tasks.length) {
    replacement=impact.replacements.find(member=>member.id===input.replacementMemberId);
    if(!replacement)issue('该成员仍有未结束任务，请选择一位可接手全部负责和接收事项的有效协作者',400,'MEMBER_HAS_RESPONSIBILITIES');
    for(const row of impact.responsibilities.tasks) {
      const task=next.tasks.find(item=>item.id===row.id);if(row.owner)task.ownerId=replacement.id;if(row.reviewer)task.reviewerId=replacement.id;
      if(row.owner&&task.artifacts?.length){task.needsResubmission=true;task.acceptedAt='';if(task.status==='review')task.status='doing';}
      const previous=Date.parse(task.updatedAt);task.updatedAt=new Date(Math.max(Date.now(),Number.isFinite(previous)?previous+1:0)).toISOString();
      next.activities.unshift({id:`event-${randomUUID()}`,actorId:actor?.id||'',actorName:user.name,governance:!actor,taskId:task.id,kind:'change',text:`成员交接：将「${task.title}」的${[row.owner?'负责':'',row.reviewer?'接收':''].filter(Boolean).join('与')}事项由${impact.member.name}交给${replacement.name}。${row.owner&&task.artifacts?.length?'已有成果保留，新负责人需重新提交后交接。':''}`,createdAt:at});
    }
  }
  next.activities.unshift({id:`event-${randomUUID()}`,actorId:actor?.id||'',actorName:user.name,governance:!actor,taskId:'',kind:'member',text:`${actor?'':'工作区管理员'+user.name+'：'}${label}。`,createdAt:at});
  next.revision=state.revision+1;
  return {state:next,changes,departures};
}
